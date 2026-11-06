import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { selectAsset, type TunnelAsset } from "./chatgptTunnel.js";
import {
  assertPinnedUrl,
  DownloadError,
  downloadPinned,
  sha256,
  verifyArchive,
  type HttpsGet,
} from "./tunnelDownload.js";

const asset = selectAsset("win32", "x64") as TunnelAsset;

/** A fake https.get: answers with the given status, headers and chunks, records the URLs asked for. */
function fakeGet(status: number, headers: Record<string, string>, chunks: Buffer[]) {
  const urls: string[] = [];
  const get: HttpsGet = (url, _options, onResponse) => {
    urls.push(url);
    const req = Object.assign(new EventEmitter(), { destroy: () => undefined });
    const res = Object.assign(new EventEmitter(), {
      statusCode: status,
      headers,
      resume: () => undefined,
      destroy: () => undefined,
    });
    setImmediate(() => {
      onResponse(res as never);
      for (const c of chunks) res.emit("data", c);
      res.emit("end");
    });
    return req;
  };
  return { get, urls };
}

describe("Feature: the downloader only takes the pinned archive", () => {
  it("Given an asset that is not in the table, When checked, Then it is refused before any request", () => {
    const { get, urls } = fakeGet(200, {}, []);
    const forged = { ...asset, url: "https://example.com/tunnel-client.zip" };
    expect(() => assertPinnedUrl(forged)).toThrow(DownloadError);
    expect(() => downloadPinned(forged, { get })).toThrow(DownloadError);
    expect(() => assertPinnedUrl({ ...asset, sha256: "0".repeat(64) })).toThrow(DownloadError);
    expect(urls).toEqual([]);
  });

  it("Given the pinned asset, When downloaded, Then it asks the official URL and returns the bytes", async () => {
    const { get, urls } = fakeGet(200, {}, [Buffer.from("abc"), Buffer.from("def")]);
    const small = { ...asset };
    // The real size is checked by verifyArchive afterwards; here the stream is shorter than the cap.
    await expect(downloadPinned(small, { get })).resolves.toEqual(Buffer.from("abcdef"));
    expect(urls).toEqual([asset.url]);
  });

  it("Given a redirect, When downloaded, Then it is not followed", async () => {
    const { get, urls } = fakeGet(302, { location: "https://elsewhere.example/x.zip" }, []);
    await expect(downloadPinned(asset, { get })).rejects.toThrow(/redirect/);
    expect(urls).toHaveLength(1);
  });

  it("Given an announced size that is not the pinned one, When downloaded, Then it stops", async () => {
    const { get } = fakeGet(200, { "content-length": "12" }, [Buffer.from("x")]);
    await expect(downloadPinned(asset, { get })).rejects.toThrow(/announces/);
  });

  it("Given more bytes than the pinned size, When downloaded, Then it stops", async () => {
    const { get } = fakeGet(200, {}, [Buffer.alloc(asset.size), Buffer.alloc(1)]);
    await expect(downloadPinned(asset, { get })).rejects.toThrow(/More than/);
  });

  it("Given an HTTP error, When downloaded, Then it fails with the status", async () => {
    const { get } = fakeGet(404, {}, []);
    await expect(downloadPinned(asset, { get })).rejects.toThrow(/404/);
  });
});

describe("Feature: the archive is verified against the pinned size and SHA-256", () => {
  const data = Buffer.from("some archive");
  const local: TunnelAsset = { ...asset, size: data.length, sha256: sha256(data) };

  it("Given the right bytes, Then it passes", () => {
    expect(() => verifyArchive(local, data)).not.toThrow();
  });

  it("Given one byte changed, Then it is refused and says nothing was installed", () => {
    const tampered = Buffer.from(data);
    tampered[0] ^= 1;
    expect(() => verifyArchive(local, tampered)).toThrow(/SHA-256.*nothing was installed/);
  });

  it("Given another size, Then it is refused", () => {
    expect(() => verifyArchive(local, Buffer.concat([data, Buffer.from("!")]))).toThrow(/bytes/);
  });
});
