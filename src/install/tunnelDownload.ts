import crypto from "node:crypto";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { DOWNLOAD_HOST, TUNNEL_ASSETS, type TunnelAsset } from "./chatgptTunnel.js";

/**
 * Downloads one pinned tunnel-client archive for `npm run chatgpt -- setup`. This is the setup command, not the
 * server: the server's guarded client and its host allowlist (`src/core/http.ts`) are untouched and never reach this
 * host. Rules here: only a URL of the pinned table, https on the default port, only DOWNLOAD_HOST, no redirect
 * followed (the official URL answers 200 directly, checked on 2026-11-06), never more bytes than the pinned size, a
 * total deadline, and the SHA-256 compared with the pinned one before anything is written or extracted.
 */

export class DownloadError extends Error {}

/** `https.get`, injectable so that tests never touch the network. */
export type HttpsGet = (
  url: string,
  options: https.RequestOptions,
  onResponse: (res: IncomingMessage) => void,
) => {
  on(event: "error" | "timeout", listener: (e?: Error) => void): unknown;
  destroy(e?: Error): void;
};

export interface DownloadOptions {
  get?: HttpsGet;
  /** Whole download, default 10 minutes. */
  deadlineMs?: number;
  /** Called with the bytes received so far. */
  progress?: (received: number, total: number) => void;
}

/** Throws unless the URL is exactly one of the pinned table and points to the official host over https. */
export function assertPinnedUrl(asset: TunnelAsset): void {
  const pinned = TUNNEL_ASSETS.find(
    (a) => a.url === asset.url && a.sha256 === asset.sha256 && a.size === asset.size,
  );
  if (!pinned) throw new DownloadError("Refusing a download that is not in the pinned table.");
  const u = new URL(asset.url);
  if (u.protocol !== "https:" || u.hostname !== DOWNLOAD_HOST || u.port !== "" || u.username)
    throw new DownloadError(`Refusing ${asset.url}: only https://${DOWNLOAD_HOST}/ is allowed.`);
}

export function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Throws unless the bytes are the pinned archive (size and SHA-256). */
export function verifyArchive(asset: TunnelAsset, data: Buffer): void {
  if (data.length !== asset.size)
    throw new DownloadError(
      `The archive has ${data.length} bytes instead of ${asset.size}: nothing was installed.`,
    );
  const got = sha256(data);
  if (got !== asset.sha256)
    throw new DownloadError(
      `The archive's SHA-256 is ${got}, not the pinned ${asset.sha256}: nothing was installed.`,
    );
}

export function downloadPinned(asset: TunnelAsset, options: DownloadOptions = {}): Promise<Buffer> {
  assertPinnedUrl(asset);
  const get: HttpsGet = options.get ?? (https.get as unknown as HttpsGet);
  const deadlineMs = options.deadlineMs ?? 10 * 60_000;
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let received = 0;
    const finish = (error: Error | null, data?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(data as Buffer);
    };
    const req = get(
      asset.url,
      { headers: { "user-agent": "sc-copilot-mcp (npm run chatgpt -- setup)" }, timeout: 60_000 },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.resume();
          finish(
            new DownloadError(
              status >= 300 && status < 400
                ? `The download server answered with a redirect (${status}); this command follows none.`
                : `The download server answered HTTP ${status}.`,
            ),
          );
          return;
        }
        const declared = res.headers["content-length"];
        if (declared !== undefined && Number(declared) !== asset.size) {
          res.destroy();
          finish(
            new DownloadError(
              `The server announces ${declared} bytes instead of ${asset.size}: download stopped.`,
            ),
          );
          return;
        }
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > asset.size) {
            res.destroy();
            finish(new DownloadError(`More than ${asset.size} bytes received: download stopped.`));
            return;
          }
          chunks.push(chunk);
          options.progress?.(received, asset.size);
        });
        res.on("end", () => finish(null, Buffer.concat(chunks)));
        res.on("error", (e: Error) => finish(new DownloadError(`Download failed: ${e.message}`)));
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error("deadline"));
      finish(new DownloadError("The download took too long and was stopped."));
    }, deadlineMs);
    req.on("error", (e?: Error) =>
      finish(new DownloadError(`Download failed: ${e?.message ?? "error"}`)),
    );
    req.on("timeout", () => {
      req.destroy(new Error("idle"));
      finish(new DownloadError("The download stalled for a minute and was stopped."));
    });
  });
}
