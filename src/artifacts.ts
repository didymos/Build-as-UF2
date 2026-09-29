import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BoardMapping, InputKind } from './boards';

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

export interface Artifact {
  kind: InputKind;
  path: string;
  mtimeMs: number;
}

const EXCLUDED = /(bootloader|partitions|boot_app0|\.merged\.|\.with_|\.save\.)/i;
const SOURCE_EXT = /\.(ino|pde|cpp|cc|c|h|hpp|hh|s|S|tpp|ipp)$/;

/** Arduino requires the main `.ino` to be named like the sketch folder. */
export function sketchNameOf(sketchPath: string): string {
  const base = path.basename(sketchPath);
  try {
    const inos = fs.readdirSync(sketchPath).filter((f) => f.endsWith('.ino'));
    if (inos.includes(`${base}.ino`)) {
      return base;
    }
    if (inos[0]) {
      return inos[0].slice(0, -4);
    }
  } catch {
    /* fall through */
  }
  return base;
}

/** Filesystem-safe board identifier from the FQBN: last segment, unsafe chars → `_`. */
export function boardIdOf(fqbn: string): string {
  const id = fqbn.split(':')[2] ?? fqbn;
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

function find(buildPath: string, files: string[], sketchName: string, ext: InputKind): Artifact | undefined {
  const candidates = files.filter((f) => f.toLowerCase().endsWith(`.${ext}`) && !EXCLUDED.test(f));
  const exact = candidates.find((f) => f === `${sketchName}.ino.${ext}` || f === `${sketchName}.${ext}`);
  const pick = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!pick) {
    if (candidates.length > 1) {
      throw new ArtifactError(
        `ambiguous .${ext} outputs in ${buildPath}: ${candidates.join(', ')} (expected ${sketchName}.ino.${ext})`,
      );
    }
    return undefined;
  }
  const p = path.join(buildPath, pick);
  return { kind: ext, path: p, mtimeMs: fs.statSync(p).mtimeMs };
}

/**
 * Preference: a `.uf2` produced by the core > the format the board mapping needs.
 * `.hex` is never used when the mapping wants `.bin` and vice versa (addresses differ).
 */
export function pickArtifact(buildPath: string, sketchName: string, mapping: BoardMapping): Artifact {
  let files: string[];
  try {
    files = fs.readdirSync(buildPath);
  } catch {
    throw new ArtifactError(`build folder ${buildPath} is not readable`);
  }
  const uf2 = find(buildPath, files, sketchName, 'uf2');
  if (uf2) {
    return uf2;
  }
  const wanted = find(buildPath, files, sketchName, mapping.input);
  if (!wanted) {
    throw new ArtifactError(
      `no .${mapping.input} output for ${mapping.chip} in ${buildPath} (found: ${files.filter((f) => /\.(uf2|hex|bin|elf|zip)$/.test(f)).join(', ') || 'nothing'})`,
    );
  }
  return wanted;
}

/** Newest mtime of any sketch source file (recursive, skips dot-folders). 0 if none. */
export function newestSourceMtime(sketchPath: string): number {
  let newest = 0;
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4 && e.name !== 'build') walk(p, depth + 1);
      } else if (SOURCE_EXT.test(e.name)) {
        try {
          newest = Math.max(newest, fs.statSync(p).mtimeMs);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(sketchPath, 0);
  return newest;
}
