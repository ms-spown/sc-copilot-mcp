import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { readSecret, SecretCancelled } from "./secretPrompt.js";

function fakeInput(tty: boolean) {
  const e = new EventEmitter();
  const modes: boolean[] = [];
  return Object.assign(e, {
    isTTY: tty,
    setRawMode: tty ? (m: boolean) => modes.push(m) : undefined,
    setEncoding: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    modes,
  });
}

function fakeOutput() {
  const written: string[] = [];
  return { write: (t: string) => written.push(t), written };
}

describe("Feature: the key is read without being shown", () => {
  it("Given a terminal, When the player pastes, corrects and presses Enter, Then the value comes back and nothing of it was echoed", async () => {
    const input = fakeInput(true);
    const output = fakeOutput();
    const p = readSecret(input, output, "Key: ");
    input.emit("data", "sk-proj-SECRETX");
    input.emit("data", "\u007f");
    input.emit("data", "VALUE\r");
    await expect(p).resolves.toBe("sk-proj-SECRETVALUE");
    expect(output.written).toEqual(["Key: ", "\n"]);
    expect(input.modes).toEqual([true, false]);
  });

  it("Given a terminal, When the player presses Ctrl+C, Then it is cancelled and raw mode is restored", async () => {
    const input = fakeInput(true);
    const p = readSecret(input, fakeOutput(), "Key: ");
    input.emit("data", "sk-partial\u0003");
    await expect(p).rejects.toBeInstanceOf(SecretCancelled);
    expect(input.modes).toEqual([true, false]);
  });

  it("Given a pipe (Get-Clipboard | npm run chatgpt -- key), Then the first line is taken and no prompt is written", async () => {
    const input = fakeInput(false);
    const output = fakeOutput();
    const p = readSecret(input, output, "Key: ");
    input.emit("data", "sk-proj-PIPED");
    input.emit("data", "VALUE\r\nsecond line\n");
    await expect(p).resolves.toBe("sk-proj-PIPEDVALUE");
    expect(output.written).toEqual([]);
  });

  it("Given a pipe that ends without a new line, Then what came is taken", async () => {
    const input = fakeInput(false);
    const p = readSecret(input, fakeOutput(), "Key: ");
    input.emit("data", "sk-proj-NOEOL");
    input.emit("end");
    await expect(p).resolves.toBe("sk-proj-NOEOL");
  });
});
