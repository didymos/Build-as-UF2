import * as fs from 'node:fs';
import type { Artifact } from './artifacts';
import type { BoardMapping } from './boards';
import { convertBin, convertHex, parseUf2Info } from './uf2/encoder';
import type { Uf2Info } from './uf2/encoder';

export interface Conversion {
  data: Buffer;
  info: Uf2Info;
  /** What was done, for the log. */
  how: string;
}

const hex = (n: number): string => '0x' + n.toString(16).padStart(8, '0');

/** Turns a build artifact into a validated UF2. Never returns a structurally broken file. */
export function toUf2(artifact: Artifact, mapping: BoardMapping): Conversion {
  const raw = fs.readFileSync(artifact.path);
  let data: Buffer;
  let how: string;

  if (artifact.kind === 'uf2') {
    data = raw;
    how = 'passthrough of core-built .uf2';
  } else if (artifact.kind === 'hex') {
    if (mapping.familyId === undefined) throw new Error('board mapping has no familyId for .hex input');
    data = convertHex(raw.toString('latin1'), mapping.familyId);
    how = `hex → uf2, family ${hex(mapping.familyId)}`;
  } else {
    if (mapping.familyId === undefined || mapping.baseAddress === undefined) {
      throw new Error('board mapping needs familyId and baseAddress for .bin input');
    }
    data = convertBin(raw, mapping.baseAddress, mapping.familyId);
    how = `bin → uf2, family ${hex(mapping.familyId)}, base ${hex(mapping.baseAddress)}`;
  }

  const info = parseUf2Info(data);
  if (info.errors.length > 0) {
    throw new Error(`invalid UF2 (${artifact.path}): ${info.errors.slice(0, 3).join('; ')}`);
  }
  if (artifact.kind === 'uf2' && mapping.familyId !== undefined) {
    if (!info.families.some((f) => f.familyId === mapping.familyId)) {
      throw new Error(
        `family mismatch: ${artifact.path} contains ${info.families.map((f) => hex(f.familyId)).join(', ')}, board mapping expects ${hex(mapping.familyId)}`,
      );
    }
  }
  return { data, info, how };
}
