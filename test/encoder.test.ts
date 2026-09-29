import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  convertBin, convertHex, isHex, isUf2, parseUf2Info,
  UF2_BLOCK_SIZE, UF2_MAGIC_START0, UF2_MAGIC_START1, UF2_MAGIC_END,
} from '../src/uf2/encoder';
import families from '../src/uf2/families.json';

const fx = (n: string): Buffer => readFileSync(join(__dirname, 'fixtures', n));
const family = (short: string): number => {
  const f = families.find((x) => x.short_name === short);
  assert.ok(f, `family ${short} missing from families.json`);
  return Number(f.id);
};

// Expected outputs in test/fixtures were produced by uf2conv.py (see make_fixtures.py).

test('.bin → uf2 is byte-identical to uf2conv.py (SAMD21, base 0x2000)', () => {
  const out = convertBin(fx('app.bin'), 0x2000, family('SAMD21'));
  assert.equal(family('SAMD21'), 0x68ed2b88);
  assert.deepEqual(out, fx('app.bin.0x68ed2b88.uf2'));
});

test('.bin → uf2 without family: no family flag, byte-identical', () => {
  assert.deepEqual(convertBin(fx('app.bin'), 0x4000, 0), fx('app.bin.0x0.uf2'));
});

test('.hex → uf2 is byte-identical to uf2conv.py (NRF52840, gaps, 04 records, other bank)', () => {
  const out = convertHex(fx('app.hex').toString('latin1'), family('NRF52840'));
  assert.deepEqual(out, fx('app.hex.0xada52840.uf2'));
});

test('.hex with extended segment address (type 02) is byte-identical (RP2040)', () => {
  const out = convertHex(fx('seg.hex').toString('latin1'), family('RP2040'));
  assert.deepEqual(out, fx('seg.hex.0xe48bff56.uf2'));
});

test('block layout: header fields, 256-byte payload, zero padding, end magic', () => {
  const out = convertBin(Buffer.alloc(300, 0xab), 0x10000, 0x55114460);
  assert.equal(out.length, 2 * UF2_BLOCK_SIZE);
  assert.equal(out.readUInt32LE(0), UF2_MAGIC_START0);
  assert.equal(out.readUInt32LE(4), UF2_MAGIC_START1);
  assert.equal(out.readUInt32LE(8), 0x2000);
  assert.equal(out.readUInt32LE(12), 0x10000);
  assert.equal(out.readUInt32LE(16), 256);
  assert.equal(out.readUInt32LE(20), 0);
  assert.equal(out.readUInt32LE(24), 2);
  assert.equal(out.readUInt32LE(28), 0x55114460);
  assert.equal(out.readUInt32LE(508), UF2_MAGIC_END);
  assert.equal(out.readUInt32LE(UF2_BLOCK_SIZE + 12), 0x10100);
  assert.ok(out.subarray(UF2_BLOCK_SIZE + 32 + 44, UF2_BLOCK_SIZE + 32 + 256).every((b) => b === 0));
  assert.ok(out.subarray(288, 508).every((b) => b === 0));
});

test('parseUf2Info reports family, start address, counts', () => {
  const info = parseUf2Info(fx('app.hex.0xada52840.uf2'));
  assert.deepEqual(info.errors, []);
  assert.equal(info.blockCount, 4);
  assert.equal(info.size, 2048);
  assert.equal(info.allFlagsEqual, true);
  assert.deepEqual(info.families, [
    { familyId: 0xada52840, startAddress: 0x27000, blocks: 4, payloadBytes: 1024 },
  ]);
});

test('parseUf2Info flags corrupt files', () => {
  const bad = Buffer.from(fx('app.bin.0x68ed2b88.uf2'));
  bad.writeUInt32LE(0, 1024 + 508); // kill end magic of block 2
  assert.match(parseUf2Info(bad).errors.join('\n'), /block 2: bad magic/);
  assert.match(parseUf2Info(bad.subarray(0, 700)).errors.join('\n'), /multiple of 512/);
});

test('detectors', () => {
  assert.equal(isUf2(fx('app.bin.0x0.uf2')), true);
  assert.equal(isUf2(fx('app.bin')), false);
  assert.equal(isHex(fx('app.hex')), true);
  assert.equal(isHex(fx('app.bin')), false);
});

test('HEX errors: checksum, garbage, empty, unsupported type, 32-bit overflow', () => {
  const good = ':0400000001020304F2\n:00000001FF\n';
  assert.doesNotThrow(() => convertHex(good, 0));
  assert.throws(() => convertHex(':0400000001020304F3\n:00000001FF\n', 0), /checksum/);
  assert.throws(() => convertHex(':04000000010203\n', 0), /does not match record size/);
  assert.throws(() => convertHex(':0400ZZ\n', 0), /malformed/);
  assert.throws(() => convertHex(':00000001FF\n', 0), /no data records/);
  assert.throws(() => convertHex(':00000006FA\n:00000001FF\n', 0), /unsupported record type/);
  assert.throws(() => convertBin(Buffer.alloc(1), 0xffffff80, 0), /32-bit/);
  assert.throws(() => convertBin(Buffer.alloc(0), 0, 0), /empty/);
});

test('HEX out-of-order input: pages merged and emitted ascending (documented deviation)', () => {
  const hex = ':0100100001EE\n:0100000002FD\n:00000001FF\n';
  const info = parseUf2Info(convertHex(hex, 0));
  assert.equal(info.blockCount, 1);
});

test('family IDs used by the seed table exist in vendored families.json', () => {
  assert.equal(family('RP2040'), 0xe48bff56); // NOT 0xe48bb36e from the task brief
  assert.equal(family('RP2350_ARM_S'), 0xe48bff59);
  assert.equal(family('SAMD51'), 0x55114460);
  assert.equal(family('NRF52840'), 0xada52840);
  assert.equal(family('ESP32S2'), 0xbfdd4eee);
  assert.equal(family('ESP32S3'), 0xc47e5767);
});
