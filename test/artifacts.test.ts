import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArtifactError, boardIdOf, newestSourceMtime, pickArtifact, sketchNameOf } from '../src/artifacts';
import type { BoardMapping } from '../src/boards';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'uf2t-'));
const touch = (dir: string, name: string): void => fs.writeFileSync(path.join(dir, name), 'x');
const hexMap: BoardMapping = { chip: 'X', input: 'hex', familyId: 1, source: '' };

test('prefers a core-built .uf2, then the mapped format; ignores bootloader/merged variants', () => {
  const d = tmp();
  for (const f of ['s.ino.hex', 's.ino.with_bootloader.hex', 's.ino.merged.hex', 's.ino.bin', 's.ino.elf']) touch(d, f);
  assert.equal(path.basename(pickArtifact(d, 's', hexMap).path), 's.ino.hex');
  touch(d, 's.ino.uf2');
  assert.equal(pickArtifact(d, 's', hexMap).kind, 'uf2');
});

test('bin mapping never falls back to hex; missing input is a clear error', () => {
  const d = tmp();
  touch(d, 's.ino.hex');
  assert.throws(() => pickArtifact(d, 's', { ...hexMap, input: 'bin', baseAddress: 0 }), (e: unknown) => e instanceof ArtifactError && /no \.bin output/.test(e.message));
});

test('ambiguous outputs are refused, single foreign name is accepted', () => {
  const d = tmp();
  touch(d, 'a.hex');
  touch(d, 'b.hex');
  assert.throws(() => pickArtifact(d, 's', hexMap), /ambiguous/);
  const e = tmp();
  touch(e, 'other.ino.hex');
  assert.equal(path.basename(pickArtifact(e, 's', hexMap).path), 'other.ino.hex');
});

test('sketchNameOf follows the .ino, boardIdOf sanitises', () => {
  const d = path.join(tmp(), 'folder');
  fs.mkdirSync(d);
  touch(d, 'folder.ino');
  assert.equal(sketchNameOf(d), 'folder');
  assert.equal(boardIdOf('DiMo_PCBs:nrf52:gloveV2xiaonRF52840Plus:opt=1'), 'gloveV2xiaonRF52840Plus');
  assert.equal(boardIdOf('a:b:we ird/id'), 'we_ird_id');
});

test('newestSourceMtime sees sources, skips the build folder', () => {
  const d = tmp();
  touch(d, 'a.ino');
  fs.mkdirSync(path.join(d, 'build'));
  touch(path.join(d, 'build'), 'z.cpp');
  const old = new Date(2020, 0, 1);
  fs.utimesSync(path.join(d, 'a.ino'), old, old);
  const future = new Date(2099, 0, 1);
  fs.utimesSync(path.join(d, 'build', 'z.cpp'), future, future);
  assert.equal(newestSourceMtime(d), old.getTime());
});
