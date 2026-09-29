import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseFqbn, familyByName, InvalidOverrideError, parseFlashOrigin, resolveBoard, UnknownBoardError } from '../src/boards';

// Measured on a real Arduino IDE 2.x session (custom core DiMo_PCBs:nrf52, Adafruit-derived).
const DIMO_NRF = {
  'build.mcu': 'cortex-m4',
  'build.arch': 'NRF52',
  'build.extra_flags': `-DNRF52840_XXAA -DUSBCON -DUSE_TINYUSB -DUSB_VID=0x2886 -DUSB_PID=0x8044 '-DUSB_MANUFACTURER="Seeed"'`,
  'build.ldscript': 'nrf52840_s140_v7.ld',
  'upload.tool': 'nrfutil',
  'recipe.objcopy.zip.pattern': '"/x/tools/adafruit-nrfutil/macos/adafruit-nrfutil" dfu genpkg --dev-type 0x0052 --sd-req 0x0123',
};
const DIMO_FQBN = 'DiMo_PCBs:nrf52:gloveV2xiaonRF52840Plus';

test('custom nRF52840 core is recognised by evidence, not by vendor name', () => {
  const m = resolveBoard({ fqbn: DIMO_FQBN, buildProperties: DIMO_NRF });
  assert.equal(m.input, 'hex');
  assert.equal(m.familyId, 0xada52840);
  assert.equal(m.baseAddress, undefined);
  assert.equal(m.chip, 'NRF52840');
});

test('options in the FQBN do not matter', () => {
  const m = resolveBoard({ fqbn: `${DIMO_FQBN}:softdevice=s140v6,debug=l0`, buildProperties: DIMO_NRF });
  assert.equal(m.familyId, 0xada52840);
});

test('build.mcu=cortex-m4 alone is not enough (unknown, names the FQBN)', () => {
  assert.throws(
    () => resolveBoard({ fqbn: 'x:y:z', buildProperties: { 'build.mcu': 'cortex-m4' } }),
    (e: unknown) => e instanceof UnknownBoardError && e.message.startsWith('FQBN x:y:z has no UF2 mapping; add it in boards.ts'),
  );
});

test('nRF52840 without nrfutil lineage is refused', () => {
  const { 'upload.tool': _u, 'recipe.objcopy.zip.pattern': _z, ...rest } = DIMO_NRF;
  assert.throws(() => resolveBoard({ fqbn: DIMO_FQBN, buildProperties: rest }), UnknownBoardError);
});

test('arduino-pico: uf2 passthrough via build.chip and via FQBN alone', () => {
  const a = resolveBoard({ fqbn: 'rp2040:rp2040:rpipico', buildProperties: { 'build.chip': 'rp2040', 'build.mcu': 'cortex-m0plus' } });
  assert.equal(a.input, 'uf2');
  assert.equal(a.familyId, undefined);
  const b = resolveBoard({ fqbn: 'rp2040:rp2040:rpipico2', buildProperties: {} });
  assert.equal(b.input, 'uf2');
  const c = resolveBoard({ fqbn: 'foo:bar:pico', buildProperties: { 'build.chip': 'rp2350' } });
  assert.equal(c.input, 'uf2');
});

const M0_LD = `MEMORY\n{\n  FLASH (rx) : ORIGIN = 0x00000000+0x2000, LENGTH = 0x00040000-0x2000 /* First 8KB used by bootloader */\n  RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 0x00008000\n}`;
const M4_LD = M0_LD.replace('0x2000, LENGTH = 0x00040000-0x2000', '0x4000, LENGTH = 0x00080000-0x4000');
const SAMD21 = { 'build.extra_flags': '-D__SAMD21G18A__ -DADAFRUIT_FEATHER_M0', 'build.ldscript': 'linker_scripts/gcc/flash_with_bootloader.ld', 'build.variant.path': '/v' };
const SAMD51 = { 'build.extra_flags': '-D__SAMD51J19A__ -D__SAMD51__ -mfpu=fpv4-sp-d16', 'build.ldscript': 'linker_scripts/gcc/flash_with_bootloader.ld', 'build.variant.path': '/v' };

test('adafruit:samd SAMD21 → bin @0x2000 verified against linker script', () => {
  const m = resolveBoard({ fqbn: 'adafruit:samd:adafruit_feather_m0', buildProperties: SAMD21, readFile: () => M0_LD });
  assert.deepEqual([m.input, m.familyId, m.baseAddress], ['bin', 0x68ed2b88, 0x2000]);
  assert.match(m.source, /verified/);
});

test('adafruit:samd SAMD51 → bin @0x4000', () => {
  const m = resolveBoard({ fqbn: 'adafruit:samd:adafruit_metro_m4', buildProperties: SAMD51, readFile: () => M4_LD });
  assert.deepEqual([m.input, m.familyId, m.baseAddress], ['bin', 0x55114460, 0x4000]);
});

test('SAMD: linker origin mismatch, wrong linker script, SAME51 and arduino:samd are refused', () => {
  assert.throws(() => resolveBoard({ fqbn: 'adafruit:samd:x', buildProperties: SAMD21, readFile: () => M4_LD }), /origin 0x4000 != expected 0x2000/);
  assert.throws(() => resolveBoard({ fqbn: 'adafruit:samd:x', buildProperties: { ...SAMD21, 'build.ldscript': 'flash_without_bootloader.ld' } }), /flash_with_bootloader/);
  assert.throws(() => resolveBoard({ fqbn: 'adafruit:samd:x', buildProperties: { ...SAMD51, 'build.extra_flags': '-D__SAME51J19A__ -D__SAMD51__' } }), /SAME51/);
  assert.throws(() => resolveBoard({ fqbn: 'arduino:samd:mkrzero', buildProperties: SAMD21 }), UnknownBoardError);
});

test('overrides win and are validated', () => {
  const overrides = { [DIMO_FQBN]: { familyId: '0x68ED2B88', baseAddress: '0x2000' } };
  const m = resolveBoard({ fqbn: `${DIMO_FQBN}:opt=1`, buildProperties: DIMO_NRF, overrides });
  assert.deepEqual([m.input, m.familyId, m.baseAddress], ['bin', 0x68ed2b88, 0x2000]);
  assert.equal(resolveBoard({ fqbn: 'a:b:c', buildProperties: {}, overrides: { 'a:b:c': { familyId: 'ESP32S3', input: 'hex' } } }).familyId, familyByName('ESP32S3'));
  assert.equal(resolveBoard({ fqbn: 'a:b:c', buildProperties: {}, overrides: { 'a:b:c': { input: 'uf2' } } }).input, 'uf2');
  const bad = (o: object) => () => resolveBoard({ fqbn: 'a:b:c', buildProperties: {}, overrides: { 'a:b:c': o } });
  assert.throws(bad({ input: 'hex' }), InvalidOverrideError);
  assert.throws(bad({ input: 'bin', familyId: 1 }), /baseAddress/);
  assert.throws(bad({ familyId: 'NOPE' }), /unknown family name/);
  assert.throws(bad({ familyId: 1, baseAddress: -1 }), /baseAddress/);
});

test('helpers', () => {
  assert.equal(baseFqbn('a:b:c:x=1,y=2'), 'a:b:c');
  assert.equal(parseFlashOrigin(M0_LD), 0x2000);
  assert.equal(parseFlashOrigin('nothing'), undefined);
});
