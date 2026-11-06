import zlib from "node:zlib";

/**
 * A small, strict reader for the one kind of archive this project downloads: OpenAI's tunnel-client release zip
 * (a few files at the root, stored or deflated, no ZIP64, no encryption). No dependency, no file system: it takes
 * the bytes and returns the files, so a test can hand it any hostile archive.
 *
 * It refuses rather than guesses: a name with a folder, a drive, "..", a control character or an unusual
 * character (no zip-slip: nothing can land outside the target folder), a Windows device name (CON, NUL, COM1...) or a
 * name ending in a dot or a space (Windows would open a device or drop the end), a duplicate name (case-insensitive, as on
 * Windows), a method other than stored or deflate, an encrypted entry, ZIP64, a size or a count over the limits, an
 * inflated size that is not the declared one, and a CRC-32 that does not match.
 */

export interface ZipFile {
  name: string;
  data: Buffer;
}

export interface ZipLimits {
  /** At most this many entries. */
  maxEntries: number;
  /** At most this many bytes once every entry is inflated. */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 32, maxTotalBytes: 256 * 1024 * 1024 };

export class ZipError extends Error {
  constructor(message: string) {
    super(`Archive refused: ${message}`);
    this.name = "ZipError";
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Reserved device names of Windows, with or without an extension (`NUL.txt` opens the device, not a file). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function findEndOfCentralDirectory(buf: Buffer): number {
  // The record is 22 bytes plus a comment of at most 65535 bytes, at the very end.
  const lowest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === EOCD && i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  throw new ZipError("no end-of-central-directory record (not a zip file, or truncated).");
}

/** Every file of the archive, checked; throws ZipError on anything unexpected. */
export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipFile[] {
  if (buf.length < 22) throw new ZipError("too short to be a zip file.");
  const eocd = findEndOfCentralDirectory(buf);
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesHere = buf.readUInt16LE(eocd + 8);
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== entries)
    throw new ZipError("multi-part archives are not supported.");
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new ZipError("ZIP64 archives are not supported.");
  if (entries === 0) throw new ZipError("the archive is empty.");
  if (entries > limits.maxEntries)
    throw new ZipError(`${entries} entries, more than the ${limits.maxEntries} expected.`);
  if (cdOffset + cdSize > eocd) throw new ZipError("the central directory is out of bounds.");

  const files: ZipFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CENTRAL)
      throw new ZipError("a central directory entry is malformed.");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameEnd = p + 46 + nameLength;
    if (nameEnd > eocd) throw new ZipError("an entry name is out of bounds.");
    const name = buf.toString("latin1", p + 46, nameEnd);
    p = nameEnd + extraLength + commentLength;

    if (!SAFE_NAME.test(name) || /[. ]$/.test(name) || WINDOWS_DEVICE.test(name))
      throw new ZipError(
        `unexpected entry name ${JSON.stringify(name)} (only plain file names at the root).`,
      );
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ZipError(`the entry ${name} appears twice.`);
    seen.add(key);
    if (flags & 0x1) throw new ZipError(`the entry ${name} is encrypted.`);
    if (method !== 0 && method !== 8)
      throw new ZipError(`the entry ${name} uses compression method ${method}.`);
    if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff)
      throw new ZipError("ZIP64 entries are not supported.");
    total += size;
    if (total > limits.maxTotalBytes)
      throw new ZipError(`more than ${limits.maxTotalBytes} bytes once inflated.`);

    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== LOCAL)
      throw new ZipError(`the local header of ${name} is malformed.`);
    const localName = buf.readUInt16LE(localOffset + 26);
    const localExtra = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    if (buf.toString("latin1", localOffset + 30, localOffset + 30 + localName) !== name)
      throw new ZipError(`the local header of ${name} names another file.`);
    if (start + compressed > cdOffset) throw new ZipError(`the data of ${name} is out of bounds.`);
    const raw = buf.subarray(start, start + compressed);

    let data: Buffer;
    if (method === 0) {
      if (compressed !== size) throw new ZipError(`the stored entry ${name} has two sizes.`);
      data = Buffer.from(raw);
    } else {
      try {
        // maxOutputLength stops a "zip bomb" at the declared size; one more byte proves the declaration wrong.
        data = zlib.inflateRawSync(raw, { maxOutputLength: size + 1 });
      } catch {
        throw new ZipError(`the entry ${name} does not inflate to its declared size.`);
      }
    }
    if (data.length !== size)
      throw new ZipError(`the entry ${name} does not inflate to its declared size.`);
    if (zlib.crc32(data) >>> 0 !== crc) throw new ZipError(`the CRC-32 of ${name} does not match.`);
    files.push({ name, data });
  }
  return files;
}
