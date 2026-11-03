/**
 * Protobuf wire format, reduced to what the telemetry stream needs. No dependency.
 *
 * Errors never carry payload bytes: only a field number or a wire type, so a decoding failure can be logged
 * without leaking the pilot's state or balance.
 */

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LEN = 2;
export const WIRE_START_GROUP = 3;
export const WIRE_END_GROUP = 4;
export const WIRE_FIXED32 = 5;

/** A message that cannot be decoded (cut short, bad varint, groups). */
export class WireError extends Error {}

export interface RawField {
  num: number;
  wire: number;
  /** varint: number (up to 2^53) or bigint; fixed32/64: the bytes; len: the bytes. */
  varint?: bigint;
  bytes?: Uint8Array;
}

/** Read one varint at `pos`. Returns the value and the next position. */
function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new WireError("varint cut short");
    const byte = buf[pos++]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [BigInt.asUintN(64, result), pos];
    shift += 7n;
  }
  throw new WireError("varint longer than 10 bytes");
}

/** Every field of one message, in order. Throws WireError when the bytes are not a well-formed message. */
export function* readFields(buf: Uint8Array): Generator<RawField> {
  let pos = 0;
  while (pos < buf.length) {
    let key: bigint;
    [key, pos] = readVarint(buf, pos);
    const num = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (num < 1 || num > 0x1fffffff) throw new WireError("invalid field number");
    switch (wire) {
      case WIRE_VARINT: {
        let value: bigint;
        [value, pos] = readVarint(buf, pos);
        yield { num, wire, varint: value };
        break;
      }
      case WIRE_FIXED64: {
        if (pos + 8 > buf.length) throw new WireError(`field ${num}: fixed64 cut short`);
        yield { num, wire, bytes: buf.subarray(pos, pos + 8) };
        pos += 8;
        break;
      }
      case WIRE_FIXED32: {
        if (pos + 4 > buf.length) throw new WireError(`field ${num}: fixed32 cut short`);
        yield { num, wire, bytes: buf.subarray(pos, pos + 4) };
        pos += 4;
        break;
      }
      case WIRE_LEN: {
        let len: bigint;
        [len, pos] = readVarint(buf, pos);
        if (len > BigInt(buf.length - pos))
          throw new WireError(`field ${num}: length beyond the message`);
        const n = Number(len);
        yield { num, wire, bytes: buf.subarray(pos, pos + n) };
        pos += n;
        break;
      }
      default:
        // Groups (3, 4) were removed from proto3, and 6, 7 do not exist: the stream is not what we expect.
        throw new WireError(`field ${num}: unsupported wire type ${wire}`);
    }
  }
}

/** A little-endian IEEE-754 float from 4 bytes. */
export function float32(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true);
}
