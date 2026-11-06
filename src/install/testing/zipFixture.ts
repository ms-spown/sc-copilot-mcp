import zlib from "node:zlib";

/** One entry of a hand-made test archive; the overrides build broken or hostile archives on purpose. */
export interface FixtureEntry {
  name: string;
  data: Buffer | string;
  method?: 0 | 8;
  flags?: number;
  /** Declared uncompressed size, instead of the real one. */
  size?: number;
  /** Declared CRC-32, instead of the real one. */
  crc?: number;
  /** Method number written in the headers, instead of `method`. */
  declaredMethod?: number;
}

/** A minimal zip writer for tests: local headers, data, central directory, end record. No ZIP64. */
export function makeZip(entries: FixtureEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const method = e.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(e.name, "latin1");
    const crc = e.crc ?? zlib.crc32(data) >>> 0;
    const size = e.size ?? data.length;
    const declaredMethod = e.declaredMethod ?? method;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(declaredMethod, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(e.flags ?? 0, 8);
    c.writeUInt16LE(declaredMethod, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** A stand-in for the Windows tunnel-client archive: the same names, tiny fake contents (no real program). */
export function fakeTunnelArchive(platform = "win32"): Buffer {
  const exe = platform === "win32" ? ".exe" : "";
  return makeZip([
    { name: `tunnel-client${exe}`, data: "fake tunnel-client binary for tests" },
    { name: `cloudflared${exe}`, data: "fake cloudflared binary for tests" },
    { name: "cloudflared-manifest.json", data: "{}" },
    { name: "LICENSE", data: "Apache License 2.0 (test stand-in)" },
    { name: "NOTICE", data: "test notice" },
  ]);
}
