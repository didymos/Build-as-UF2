import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toUf2 } from '../src/convert';
import type { Artifact } from '../src/artifacts';
import type { BoardMapping } from '../src/boards';

const fx = (n: string): string => path.join(__dirname, 'fixtures', n);
const art = (kind: Artifact['kind'], p: string): Artifact => ({ kind, path: p, mtimeMs: 0 });

test('hex mapping → identical to uf2conv.py fixture', () => {
  const m: BoardMapping = { chip: 'NRF52840', input: 'hex', familyId: 0xada52840, source: '' };
  const c = toUf2(art('hex', fx('app.hex')), m);
  assert.deepEqual(c.data, fs.readFileSync(fx('app.hex.0xada52840.uf2')));
  assert.equal(c.info.blockCount, 4);
});

test('bin mapping → identical to uf2conv.py fixture', () => {
  const m: BoardMapping = { chip: 'SAMD21', input: 'bin', familyId: 0x68ed2b88, baseAddress: 0x2000, source: '' };
  assert.deepEqual(toUf2(art('bin', fx('app.bin')), m).data, fs.readFileSync(fx('app.bin.0x68ed2b88.uf2')));
});

test('uf2 passthrough: unchanged, family verified when known', () => {
  const p = fx('app.hex.0xada52840.uf2');
  const ok = toUf2(art('uf2', p), { chip: 'x', input: 'uf2', source: '' });
  assert.deepEqual(ok.data, fs.readFileSync(p));
  assert.doesNotThrow(() => toUf2(art('uf2', p), { chip: 'x', input: 'hex', familyId: 0xada52840, source: '' }));
  assert.throws(() => toUf2(art('uf2', p), { chip: 'x', input: 'hex', familyId: 0x68ed2b88, source: '' }), /family mismatch/);
});

test('broken inputs throw instead of producing a file', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uf2c-'));
  const bad = path.join(d, 'bad.uf2');
  fs.writeFileSync(bad, Buffer.alloc(700));
  assert.throws(() => toUf2(art('uf2', bad), { chip: 'x', input: 'uf2', source: '' }), /invalid UF2/);
  assert.throws(() => toUf2(art('hex', fx('app.hex')), { chip: 'x', input: 'hex', source: '' }), /familyId/);
  assert.throws(() => toUf2(art('bin', fx('app.bin')), { chip: 'x', input: 'bin', familyId: 1, source: '' }), /baseAddress/);
});
