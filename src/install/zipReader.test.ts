import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { makeZip } from "./testing/zipFixture.js";
import { readZip, ZipError } from "./zipReader.js";

describe("Feature: the tunnel-client archive is read strictly", () => {
  it("Given a deflated and a stored file at the root, When read, Then both come back intact", () => {
    const zip = makeZip([
      { name: "tunnel-client.exe", data: "binary".repeat(100) },
      { name: "LICENSE", data: "text", method: 0 },
    ]);
    const files = readZip(zip);
    expect(files.map((f) => f.name)).toEqual(["tunnel-client.exe", "LICENSE"]);
    expect(files[0].data.toString()).toBe("binary".repeat(100));
    expect(files[1].data.toString()).toBe("text");
  });

  it.each([
    ["a folder", "bin/tunnel-client.exe"],
    ["a parent folder", "../evil.exe"],
    ["a Windows separator", "..\\evil.exe"],
    ["a drive", "C:evil.exe"],
    ["an absolute path", "/etc/passwd"],
    ["a dot file", ".bashrc"],
    ["a space", "tunnel client.exe"],
    ["a control character", "a\u0001.exe"],
    ["an empty name", ""],
  ])("Given an entry name with %s, When read, Then the archive is refused", (_why, name) => {
    expect(() => readZip(makeZip([{ name, data: "x" }]))).toThrow(ZipError);
  });

  it.each(["CON", "nul", "Aux", "PRN.txt", "COM1", "com9.dll", "LPT1", "lpt0.exe", "NUL.tar.gz"])(
    "Given the Windows device name %s, When read, Then the archive is refused",
    (name) => {
      expect(() => readZip(makeZip([{ name, data: "x" }]))).toThrow(ZipError);
    },
  );

  it.each(["tunnel-client.exe.", "LICENSE.", "a "])(
    "Given the name %j ending in a dot or a space (Windows drops it), When read, Then the archive is refused",
    (name) => {
      expect(() => readZip(makeZip([{ name, data: "x" }]))).toThrow(ZipError);
    },
  );

  it("Given ordinary names that only look like devices, When read, Then they are accepted", () => {
    const zip = makeZip([
      { name: "console.txt", data: "a" },
      { name: "COM10", data: "b" },
      { name: "nullish", data: "c" },
    ]);
    expect(readZip(zip).map((f) => f.name)).toEqual(["console.txt", "COM10", "nullish"]);
  });

  it("Given the same name twice in different cases, When read, Then it is refused (Windows would merge them)", () => {
    const zip = makeZip([
      { name: "LICENSE", data: "a" },
      { name: "license", data: "b" },
    ]);
    expect(() => readZip(zip)).toThrow(/twice/);
  });

  it("Given a wrong CRC-32, When read, Then it is refused", () => {
    expect(() => readZip(makeZip([{ name: "a", data: "hello", crc: 1234 }]))).toThrow(/CRC/);
  });

  it("Given a declared size smaller than the real one (a zip bomb), When read, Then it stops at the declared size and refuses", () => {
    const big = Buffer.alloc(1024 * 1024, 0x41);
    expect(() => readZip(makeZip([{ name: "a", data: big, size: 10 }]))).toThrow(/declared size/);
  });

  it("Given an encrypted entry or another compression method, When read, Then it is refused", () => {
    expect(() => readZip(makeZip([{ name: "a", data: "x", flags: 1 }]))).toThrow(/encrypted/);
    expect(() => readZip(makeZip([{ name: "a", data: "x", declaredMethod: 12 }]))).toThrow(
      /method 12/,
    );
  });

  it("Given more entries or more bytes than the limits, When read, Then it is refused", () => {
    const many = makeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: "x" })));
    expect(() => readZip(many, { maxEntries: 4, maxTotalBytes: 1000 })).toThrow(/entries/);
    const heavy = makeZip([{ name: "a", data: Buffer.alloc(2000) }]);
    expect(() => readZip(heavy, { maxEntries: 4, maxTotalBytes: 1000 })).toThrow(/bytes/);
  });

  it("Given bytes that are not a zip, or a truncated zip, When read, Then it is refused", () => {
    expect(() => readZip(Buffer.from("not a zip at all, just some text"))).toThrow(ZipError);
    const zip = makeZip([{ name: "a", data: "hello" }]);
    expect(() => readZip(zip.subarray(0, zip.length - 5))).toThrow(ZipError);
    expect(() => readZip(zlib.deflateRawSync(Buffer.from("x")))).toThrow(ZipError);
  });
});
