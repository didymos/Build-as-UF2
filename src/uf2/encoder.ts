/*
 * TypeScript port of the conversion logic in microsoft/uf2 utils/uf2conv.py.
 * Copyright (c) Microsoft Corporation. MIT License, see NOTICE.
 *
 * Pure functions, no `vscode` import.
 *
 * Deliberate deviations from uf2conv.py (all only affect inputs where the
 * Python tool misbehaves; well-formed monotonic input is byte-identical):
 *  - Intel HEX: record checksums are verified, malformed records throw.
 *  - Intel HEX: pages are merged and emitted in ascending address order
 *    (Python emits a duplicate block whenever the input jumps between pages).
 *  - Empty HEX (no data records) throws instead of yielding an empty file.
 *  - Address ranges beyond 32 bit throw.
 *  Gaps inside a HEX page are padded with 0xFF (as uf2conv.py does), the
 *  erased-flash value; a trailing partial .bin page is padded with 0x00.
 */

export const UF2_MAGIC_START0 = 0x0a324655;
export const UF2_MAGIC_START1 = 0x9e5d5157;
export const UF2_MAGIC_END = 0x0ab16f30;

export const UF2_BLOCK_SIZE = 512;
export const UF2_PAYLOAD_SIZE = 256;
const DATA_AREA_SIZE = 476;

export const FLAG_NOT_MAIN_FLASH = 0x00000001;
export const FLAG_FILE_CONTAINER = 0x00001000;
export const FLAG_FAMILY_ID_PRESENT = 0x00002000;
export const FLAG_MD5_PRESENT = 0x00004000;
export const FLAG_EXTENSION_TAGS = 0x00008000;

const U32_MAX = 0xffffffff;

function assertU32(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new RangeError(`${what} must be an integer in 0..0xFFFFFFFF, got ${value}`);
  }
}

function encodeBlock(
  targetAddr: number,
  payload: Uint8Array,
  blockNo: number,
  numBlocks: number,
  familyId: number,
): Buffer {
  const block = Buffer.alloc(UF2_BLOCK_SIZE); // zero-filled: data-area padding is 0x00
  const flags = familyId !== 0 ? FLAG_FAMILY_ID_PRESENT : 0;
  block.writeUInt32LE(UF2_MAGIC_START0, 0);
  block.writeUInt32LE(UF2_MAGIC_START1, 4);
  block.writeUInt32LE(flags, 8);
  block.writeUInt32LE(targetAddr, 12);
  block.writeUInt32LE(UF2_PAYLOAD_SIZE, 16);
  block.writeUInt32LE(blockNo, 20);
  block.writeUInt32LE(numBlocks, 24);
  block.writeUInt32LE(familyId, 28);
  block.set(payload.subarray(0, UF2_PAYLOAD_SIZE), 32);
  block.writeUInt32LE(UF2_MAGIC_END, UF2_BLOCK_SIZE - 4);
  return block;
}

/** Port of `convert_to_uf2`: raw binary at a fixed base address. */
export function convertBin(buf: Uint8Array, baseAddress: number, familyId: number): Buffer {
  assertU32(baseAddress, 'baseAddress');
  assertU32(familyId, 'familyId');
  if (buf.length === 0) {
    throw new Error('input .bin is empty');
  }
  const numBlocks = Math.ceil(buf.length / UF2_PAYLOAD_SIZE);
  if (baseAddress + numBlocks * UF2_PAYLOAD_SIZE - 1 > U32_MAX) {
    throw new RangeError('image does not fit into the 32-bit address space at the given base');
  }
  const out: Buffer[] = [];
  for (let blockNo = 0; blockNo < numBlocks; blockNo++) {
    const ptr = blockNo * UF2_PAYLOAD_SIZE;
    const payload = Buffer.alloc(UF2_PAYLOAD_SIZE); // 0x00 padding of the last chunk
    payload.set(buf.subarray(ptr, ptr + UF2_PAYLOAD_SIZE));
    out.push(encodeBlock(baseAddress + ptr, payload, blockNo, numBlocks, familyId));
  }
  return Buffer.concat(out);
}

/** True if `buf` looks like Intel HEX text (port of `is_hex`). */
export function isHex(buf: Uint8Array): boolean {
  if (buf.length === 0 || buf[0] !== 0x3a) {
    return false;
  }
  for (const b of buf) {
    const ok =
      b === 0x3a || b === 0x0d || b === 0x0a || (b >= 0x30 && b <= 0x39) ||
      (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
    if (!ok) {
      return false;
    }
  }
  return true;
}

/** True if `buf` starts with the UF2 magic numbers (port of `is_uf2`). */
export function isUf2(buf: Uint8Array): boolean {
  if (buf.length < 8) {
    return false;
  }
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  return b.readUInt32LE(0) === UF2_MAGIC_START0 && b.readUInt32LE(4) === UF2_MAGIC_START1;
}

/** Port of `convert_from_hex_to_uf2`. Record types 00, 01, 02, 04 are applied; 03 and 05 are ignored. */
export function convertHex(text: string, familyId: number): Buffer {
  assertU32(familyId, 'familyId');
  const pages = new Map<number, Buffer>();
  let upper = 0;
  let sawData = false;
  let sawEof = false;

  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length && !sawEof; ln++) {
    const line = (lines[ln] ?? '').trim();
    if (line === '' || line[0] !== ':') {
      continue; // uf2conv.py skips lines that do not start with ':'
    }
    const hex = line.slice(1);
    if (hex.length < 10 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error(`HEX line ${ln + 1}: malformed record`);
    }
    const rec = Buffer.from(hex, 'hex');
    const len = rec[0] as number;
    if (rec.length !== len + 5) {
      throw new Error(`HEX line ${ln + 1}: length field ${len} does not match record size`);
    }
    let sum = 0;
    for (const b of rec) {
      sum = (sum + b) & 0xff;
    }
    if (sum !== 0) {
      throw new Error(`HEX line ${ln + 1}: checksum mismatch`);
    }
    const offset = rec.readUInt16BE(1);
    const type = rec[3] as number;
    switch (type) {
      case 0x00: {
        let addr = upper + offset;
        for (let i = 0; i < len; i++, addr++) {
          if (addr > U32_MAX) {
            throw new RangeError(`HEX line ${ln + 1}: address beyond 32 bit`);
          }
          const pageAddr = addr - (addr % UF2_PAYLOAD_SIZE);
          let page = pages.get(pageAddr);
          if (!page) {
            page = Buffer.alloc(UF2_PAYLOAD_SIZE, 0xff);
            pages.set(pageAddr, page);
          }
          page[addr % UF2_PAYLOAD_SIZE] = rec[4 + i] as number;
        }
        if (len > 0) {
          sawData = true;
        }
        break;
      }
      case 0x01:
        sawEof = true;
        break;
      case 0x02:
        if (len !== 2) throw new Error(`HEX line ${ln + 1}: bad extended segment address record`);
        upper = rec.readUInt16BE(4) * 16;
        break;
      case 0x04:
        if (len !== 2) throw new Error(`HEX line ${ln + 1}: bad extended linear address record`);
        upper = rec.readUInt16BE(4) * 0x10000;
        break;
      case 0x03:
      case 0x05:
        break; // start address records: irrelevant for the flash image
      default:
        throw new Error(`HEX line ${ln + 1}: unsupported record type 0x${type.toString(16)}`);
    }
  }
  if (!sawData) {
    throw new Error('HEX file contains no data records');
  }
  const addrs = [...pages.keys()].sort((a, b) => a - b);
  const out: Buffer[] = addrs.map((a, i) =>
    encodeBlock(a, pages.get(a) as Buffer, i, addrs.length, familyId),
  );
  return Buffer.concat(out);
}

export interface Uf2FamilyInfo {
  familyId: number;
  /** Lowest target address seen for this family. */
  startAddress: number;
  blocks: number;
  payloadBytes: number;
}

export interface Uf2Info {
  blockCount: number;
  size: number;
  /** Families in order of first appearance; blocks without the family flag are grouped under 0. */
  families: Uf2FamilyInfo[];
  allFlagsEqual: boolean;
  /** Human-readable structural problems; empty when the file is well-formed. */
  errors: string[];
}

/** Structural parse for validation and tests (cf. `convert_from_uf2` info output). */
export function parseUf2Info(buf: Uint8Array): Uf2Info {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const errors: string[] = [];
  if (b.length === 0 || b.length % UF2_BLOCK_SIZE !== 0) {
    errors.push(`size ${b.length} is not a positive multiple of ${UF2_BLOCK_SIZE}`);
  }
  const blockCount = Math.floor(b.length / UF2_BLOCK_SIZE);
  const fams = new Map<number, Uf2FamilyInfo>();
  let firstFlags: number | undefined;
  let allFlagsEqual = true;
  for (let i = 0; i < blockCount; i++) {
    const o = i * UF2_BLOCK_SIZE;
    const magic0 = b.readUInt32LE(o);
    const magic1 = b.readUInt32LE(o + 4);
    const flags = b.readUInt32LE(o + 8);
    const addr = b.readUInt32LE(o + 12);
    const size = b.readUInt32LE(o + 16);
    const blockNo = b.readUInt32LE(o + 20);
    const numBlocks = b.readUInt32LE(o + 24);
    const fam = b.readUInt32LE(o + 28);
    const magicEnd = b.readUInt32LE(o + UF2_BLOCK_SIZE - 4);
    if (magic0 !== UF2_MAGIC_START0 || magic1 !== UF2_MAGIC_START1 || magicEnd !== UF2_MAGIC_END) {
      errors.push(`block ${i}: bad magic`);
      continue;
    }
    if (size > DATA_AREA_SIZE) errors.push(`block ${i}: payload size ${size} > ${DATA_AREA_SIZE}`);
    if (blockNo !== i) errors.push(`block ${i}: blockNo is ${blockNo}`);
    if (numBlocks !== blockCount) errors.push(`block ${i}: numBlocks is ${numBlocks}, file has ${blockCount}`);
    firstFlags ??= flags;
    if (flags !== firstFlags) allFlagsEqual = false;
    if (flags & FLAG_NOT_MAIN_FLASH) continue;
    const key = flags & FLAG_FAMILY_ID_PRESENT ? fam : 0;
    const cur = fams.get(key);
    if (cur) {
      cur.blocks++;
      cur.payloadBytes += size;
      cur.startAddress = Math.min(cur.startAddress, addr);
    } else {
      fams.set(key, { familyId: key, startAddress: addr, blocks: 1, payloadBytes: size });
    }
  }
  return { blockCount, size: b.length, families: [...fams.values()], allFlagsEqual, errors };
}
