import './helpers/fake-vscode';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fake } from './helpers/fake-vscode';
import { runExport } from '../src/ui';

const fx = (n: string): Buffer => fs.readFileSync(path.join(__dirname, 'fixtures', n));
const FQBN = 'DiMo_PCBs:nrf52:gloveV2xiaonRF52840Plus';
const NRF = {
  name: 'Heated Glove', 'build.extra_flags': '-DNRF52840_XXAA', 'build.ldscript': 'nrf52840_s140_v7.ld', 'upload.tool': 'nrfutil',
};

const ctx = { workspaceState: { store: {} as Record<string, unknown>, get(k: string, d: unknown) { return this.store[k] ?? d; }, async update(k: string, v: unknown) { this.store[k] = v; } } };
const out = { appendLine() {}, show() {} };
const run = (): Promise<void> => runExport(ctx as never, out as never);
const mk = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'uf2f-'));

let sketch: string, buildDir: string, target: string;
beforeEach(() => {
  fake.reset();
  ctx.workspaceState.store = {};
  sketch = path.join(mk(), 'demo');
  fs.mkdirSync(sketch);
  fs.writeFileSync(path.join(sketch, 'demo.ino'), 'void setup(){}');
  buildDir = mk();
  target = mk();
  fake.api = {
    sketchPath: sketch, fqbn: FQBN,
    boardDetails: { fqbn: FQBN, buildProperties: NRF, configOptions: [] },
    compileSummary: undefined,
    onDidChange: () => () => ({ dispose() {} }),
  };
  fake.openDialog = async () => [{ fsPath: target }];
  fake.execute = async (id: string) => {
    assert.equal(id, 'arduino-verify-sketch');
    fs.writeFileSync(path.join(buildDir, 'demo.ino.hex'), fx('app.hex'));
    fake.api.compileSummary = { buildPath: buildDir, buildProperties: NRF };
    return { ok: true };
  };
});

test('build and convert writes the byte-exact uf2 named <sketch>.<board>.uf2', async () => {
  fake.modalAnswers = ['Build and convert'];
  await run();
  const file = path.join(target, 'demo.gloveV2xiaonRF52840Plus.uf2');
  assert.deepEqual(fs.readFileSync(file), fx('app.hex.0xada52840.uf2'));
  assert.deepEqual(fake.errors, []);
  assert.deepEqual(fs.readdirSync(target), ['demo.gloveV2xiaonRF52840Plus.uf2']);
  assert.equal((ctx.workspaceState.store['uf2export.lastFolder'] as Record<string, string>)[sketch], target);
});

test('unknown board: error names the FQBN, no dialog is shown, nothing written', async () => {
  fake.api.boardDetails = { fqbn: 'a:b:c', buildProperties: { 'build.mcu': 'cortex-m4' }, configOptions: [] };
  fake.api.fqbn = 'a:b:c';
  await run();
  assert.equal(fake.dialogCalls, 0);
  assert.match(fake.errors[0] ?? '', /FQBN a:b:c has no UF2 mapping/);
});

test('no board selected: clear error, no dialog', async () => {
  fake.api.fqbn = undefined;
  await run();
  assert.equal(fake.dialogCalls, 0);
  assert.match(fake.errors[0] ?? '', /No board selected/);
});

test('folder dialog cancel and modal cancel: silent, no file', async () => {
  fake.openDialog = async () => undefined;
  await run();
  assert.deepEqual(fake.errors, []);
  fake.openDialog = async () => [{ fsPath: target }];
  fake.modalAnswers = [undefined];
  await run();
  assert.deepEqual(fake.errors, []);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('IDE build failure (command returns undefined): error, no partial file', async () => {
  fake.execute = async () => undefined;
  fake.modalAnswers = ['Build and convert'];
  await run();
  assert.match(fake.errors[0] ?? '', /did not report a successful build/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('convert only without a build offers to build; declining writes nothing', async () => {
  fake.modalAnswers = ['Convert only', undefined];
  await run();
  assert.match(fake.warnings[0] ?? '', /No build output found\. Build first\?/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('convert only with a fresh build converts without invoking the IDE', async () => {
  fs.writeFileSync(path.join(buildDir, 'demo.ino.hex'), fx('app.hex'));
  fake.api.compileSummary = { buildPath: buildDir, buildProperties: NRF };
  const old = new Date(2020, 0, 1);
  fs.utimesSync(path.join(sketch, 'demo.ino'), old, old);
  fake.execute = async () => { throw new Error('must not build'); };
  fake.modalAnswers = ['Convert only'];
  await run();
  assert.deepEqual(fake.errors, []);
  assert.equal(fs.readdirSync(target).length, 1);
});

test('stale build warns; existing target needs overwrite confirmation', async () => {
  fs.writeFileSync(path.join(buildDir, 'demo.ino.hex'), fx('app.hex'));
  fake.api.compileSummary = { buildPath: buildDir, buildProperties: NRF };
  const old = new Date(2020, 0, 1);
  fs.utimesSync(path.join(buildDir, 'demo.ino.hex'), old, old);
  fake.modalAnswers = ['Convert only', undefined];
  await run();
  assert.match(fake.warnings[0] ?? '', /older than the sketch sources/);

  const existing = path.join(target, 'demo.gloveV2xiaonRF52840Plus.uf2');
  fs.writeFileSync(existing, 'KEEP');
  fake.modalAnswers = ['Build and convert', undefined];
  await run();
  assert.equal(fs.readFileSync(existing, 'utf8'), 'KEEP');
  fake.modalAnswers = ['Build and convert', 'Overwrite'];
  await run();
  assert.deepEqual(fs.readFileSync(existing), fx('app.hex.0xada52840.uf2'));
});
