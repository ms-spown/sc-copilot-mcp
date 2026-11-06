/**
 * Reads one secret line without showing it: in a terminal, raw mode with no echo at all (not even stars, so the
 * length is not shown either); from a pipe (`Get-Clipboard | npm run chatgpt -- key`), the first line of the input.
 * Nothing here writes the value anywhere; the caller decides where it goes.
 */

export interface SecretInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  on(event: "end" | "error", listener: (e?: Error) => void): unknown;
  removeAllListeners(event?: string): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface SecretOutput {
  write(text: string): unknown;
}

export class SecretCancelled extends Error {
  constructor() {
    super("Cancelled: nothing was saved.");
  }
}

export function readSecret(
  input: SecretInput,
  output: SecretOutput,
  prompt: string,
  maxLength = 4096,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    let done = false;
    const tty = input.isTTY === true && typeof input.setRawMode === "function";
    const finish = (error: Error | null) => {
      if (done) return;
      done = true;
      input.removeAllListeners("data");
      input.removeAllListeners("end");
      input.removeAllListeners("error");
      if (tty) {
        input.setRawMode?.(false);
        output.write("\n");
      }
      input.pause();
      if (error) reject(error);
      else resolve(value);
    };
    input.setEncoding("utf8");
    if (tty) {
      output.write(prompt);
      input.setRawMode?.(true);
      input.on("data", (chunk) => {
        for (const ch of String(chunk)) {
          if (ch === "\r" || ch === "\n") return finish(null);
          if (ch === "\u0003" || ch === "\u001a") return finish(new SecretCancelled());
          if (ch === "\u0008" || ch === "\u007f") value = value.slice(0, -1);
          else if (ch >= " " && value.length < maxLength) value += ch;
        }
      });
    } else {
      input.on("data", (chunk) => {
        value += String(chunk);
        const nl = value.search(/\r?\n/);
        if (nl >= 0) {
          value = value.slice(0, nl);
          finish(null);
        } else if (value.length > maxLength) finish(new Error("The input is too long for a key."));
      });
    }
    input.on("end", () => finish(null));
    input.on("error", (e) => finish(e ?? new Error("Could not read the input.")));
    input.resume();
  });
}
