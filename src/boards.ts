import families from './uf2/families.json';

/**
 * Board → UF2 mapping.
 *
 * Nothing here is guessed. Every rule below records where its values come from,
 * and unknown boards fail with an explicit error. The vendor part of the FQBN is
 * NOT trusted for custom cores (e.g. `DiMo_PCBs:nrf52:*` is an Adafruit-derived
 * core); chips are recognised from build properties, and `uf2export.overrides`
 * covers everything else.
 *
 * Verified against (2026-09):
 *  - microsoft/uf2 utils/uf2families.json: NRF52840 0xada52840, SAMD21 0x68ed2b88,
 *    SAMD51 0x55114460 (looked up by short_name at load time, see `family()`).
 *  - adafruit/Adafruit_nRF52_Arduino boards.txt: `build.extra_flags` carries
 *    `-DNRF52840_XXAA`; platform.txt emits `.hex` (bin recipe is commented out) and
 *    a `.zip` via adafruit-nrfutil (`recipe.objcopy.zip.pattern`).
 *  - adafruit/ArduinoCore-samd boards.txt: `-D__SAMD21…__` / `-D__SAMD51__` in
 *    `build.extra_flags`; every board links with `flash_with_bootloader.ld`, whose
 *    FLASH origin is 0x0+0x2000 (variants/feather_m0) and 0x0+0x4000 (feather_m4).
 *    platform.txt emits `.bin` and `.hex`.
 *  - earlephilhower/arduino-pico boards.txt: `build.chip=rp2040|rp2350…`;
 *    platform.txt builds `.uf2` through picotool (`recipe.objcopy.uf2.pattern`), so
 *    the family comes from the produced file, not from a table.
 *  - measured on a real IDE 2.x session (custom `DiMo_PCBs:nrf52:*`): `build.mcu` is
 *    `cortex-m4`, i.e. useless to tell nRF52840 from nRF52832 – hence the macro check.
 *  - ESP32-S2/S3 are intentionally NOT seeded: the app offset depends on the
 *    partition scheme / TinyUF2 layout of the individual board. Use overrides.
 */

export type InputKind = 'uf2' | 'hex' | 'bin';

export interface BoardMapping {
  /** Human-readable chip / family label, for logs. */
  chip: string;
  input: InputKind;
  /** Required for `hex`/`bin`. For `uf2` passthrough, when set it is verified against the file. */
  familyId?: number;
  /** Required for `bin`. */
  baseAddress?: number;
  /** Evidence used for this decision, for logs. */
  source: string;
}

export interface BoardOverride {
  familyId?: number | string;
  baseAddress?: number | string;
  input?: InputKind;
}

export interface BoardQuery {
  fqbn: string;
  buildProperties: Readonly<Record<string, string>>;
  overrides?: Readonly<Record<string, BoardOverride>>;
  /** Optional file reader to cross-check linker scripts; must return undefined if unreadable. */
  readFile?: (path: string) => string | undefined;
}

export class UnknownBoardError extends Error {
  constructor(fqbn: string, reason?: string) {
    super(
      `FQBN ${fqbn} has no UF2 mapping; add it in boards.ts or set uf2export.overrides` +
        (reason ? ` (${reason})` : ''),
    );
    this.name = 'UnknownBoardError';
  }
}

export class InvalidOverrideError extends Error {
  constructor(fqbn: string, reason: string) {
    super(`uf2export.overrides["${fqbn}"]: ${reason}`);
    this.name = 'InvalidOverrideError';
  }
}

/** Look up a family ID by `short_name` in the vendored uf2families.json. */
export function familyByName(shortName: string): number {
  const f = families.find((x) => x.short_name.toUpperCase() === shortName.toUpperCase());
  if (!f) {
    throw new Error(`family ${shortName} not found in uf2families.json`);
  }
  return Number(f.id);
}

const FAMILY_NRF52840 = familyByName('NRF52840');
const FAMILY_SAMD21 = familyByName('SAMD21');
const FAMILY_SAMD51 = familyByName('SAMD51');

/** `vendor:arch:board[:options]` → `vendor:arch:board`. */
export function baseFqbn(fqbn: string): string {
  return fqbn.split(':').slice(0, 3).join(':');
}

function parseU32(value: number | string, fqbn: string, what: string): number {
  const n = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new InvalidOverrideError(fqbn, `${what} must be an integer 0..0xFFFFFFFF (got ${String(value)})`);
  }
  return n;
}

function parseFamily(value: number | string, fqbn: string): number {
  if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(value.trim())) {
    try {
      return familyByName(value.trim());
    } catch {
      throw new InvalidOverrideError(fqbn, `unknown family name "${value}" (see uf2families.json short_name)`);
    }
  }
  return parseU32(value, fqbn, 'familyId');
}

function fromOverride(fqbn: string, o: BoardOverride): BoardMapping {
  const input: InputKind = o.input ?? (o.baseAddress !== undefined ? 'bin' : 'hex');
  const familyId = o.familyId !== undefined ? parseFamily(o.familyId, fqbn) : undefined;
  const baseAddress = o.baseAddress !== undefined ? parseU32(o.baseAddress, fqbn, 'baseAddress') : undefined;
  if (input !== 'uf2' && familyId === undefined) {
    throw new InvalidOverrideError(fqbn, 'familyId is required unless input is "uf2"');
  }
  if (input === 'bin' && baseAddress === undefined) {
    throw new InvalidOverrideError(fqbn, 'baseAddress is required for input "bin"');
  }
  return { chip: 'override', input, familyId, baseAddress, source: `uf2export.overrides["${fqbn}"]` };
}

/** FLASH origin of a GNU ld script, e.g. `ORIGIN = 0x00000000+0x2000` → 0x2000. */
export function parseFlashOrigin(ld: string): number | undefined {
  const m = /FLASH\s*\([^)]*\)\s*:\s*ORIGIN\s*=\s*(0x[0-9a-fA-F]+)\s*(?:\+\s*(0x[0-9a-fA-F]+))?/.exec(ld);
  if (!m) {
    return undefined;
  }
  return Number(m[1]) + (m[2] !== undefined ? Number(m[2]) : 0);
}

export function resolveBoard(q: BoardQuery): BoardMapping {
  const fqbn = baseFqbn(q.fqbn);
  const bp = q.buildProperties;

  // 1) user overrides win.
  const override = q.overrides?.[fqbn] ?? q.overrides?.[q.fqbn];
  if (override) {
    return fromOverride(fqbn, override);
  }

  const extra = bp['build.extra_flags'] ?? '';
  const ldscript = bp['build.ldscript'] ?? '';
  const chip = bp['build.chip'] ?? '';
  const [vendor = '', arch = ''] = fqbn.split(':');

  // 2) Raspberry Pi RP2xxx (arduino-pico): the core builds a .uf2 with the correct family.
  if (/^rp2\d+/i.test(chip) || (vendor === 'rp2040' && arch === 'rp2040')) {
    return {
      chip: chip || 'rp2xxx',
      input: 'uf2',
      source: chip ? `build.chip=${chip}` : `FQBN ${vendor}:${arch}`,
    };
  }

  // 3) Nordic nRF52840 with an Adafruit-nrfutil (Adafruit bootloader lineage) toolchain.
  if (/(^|\s)-DNRF52840_XXAA(\s|$)/.test(extra) || /^nrf52840/i.test(ldscript)) {
    const lineage =
      /nrfutil/i.test(bp['upload.tool'] ?? '') || /adafruit-nrfutil/i.test(bp['recipe.objcopy.zip.pattern'] ?? '');
    if (!lineage) {
      throw new UnknownBoardError(q.fqbn, 'nRF52840 without Adafruit-nrfutil bootloader lineage; UF2 support unknown');
    }
    return {
      chip: 'NRF52840',
      input: 'hex',
      familyId: FAMILY_NRF52840,
      source: `build.extra_flags/build.ldscript (${ldscript || '-DNRF52840_XXAA'}) + nrfutil upload tool`,
    };
  }

  // 4) Adafruit SAMD (UF2 bootloader, app after 8 KiB / 16 KiB).
  if (vendor === 'adafruit' && arch === 'samd') {
    if (/-D__SAME51/.test(extra)) {
      throw new UnknownBoardError(q.fqbn, 'SAME51 has no verified family mapping');
    }
    let mapping: BoardMapping | undefined;
    if (/-D__SAMD21[A-Z0-9]*__/.test(extra)) {
      mapping = { chip: 'SAMD21', input: 'bin', familyId: FAMILY_SAMD21, baseAddress: 0x2000, source: 'adafruit:samd + -D__SAMD21…__' };
    } else if (/-D__SAMD51__/.test(extra)) {
      mapping = { chip: 'SAMD51', input: 'bin', familyId: FAMILY_SAMD51, baseAddress: 0x4000, source: 'adafruit:samd + -D__SAMD51__' };
    }
    if (!mapping) {
      throw new UnknownBoardError(q.fqbn, 'no -D__SAMD21…__ / -D__SAMD51__ in build.extra_flags');
    }
    if (!/flash_with_bootloader\.ld$/.test(ldscript)) {
      throw new UnknownBoardError(q.fqbn, `linker script "${ldscript}" is not flash_with_bootloader.ld`);
    }
    const ldPath = bp['build.variant.path'] ? `${bp['build.variant.path']}/${ldscript}` : undefined;
    const ld = ldPath ? q.readFile?.(ldPath) : undefined;
    if (ld !== undefined) {
      const origin = parseFlashOrigin(ld);
      if (origin === undefined || origin !== mapping.baseAddress) {
        throw new UnknownBoardError(
          q.fqbn,
          `linker script FLASH origin ${origin === undefined ? 'unparsable' : '0x' + origin.toString(16)} != expected 0x${(mapping.baseAddress ?? 0).toString(16)}`,
        );
      }
      mapping.source += ` + linker origin 0x${origin.toString(16)} verified`;
    }
    return mapping;
  }

  throw new UnknownBoardError(q.fqbn);
}
