import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { fqbnWithOptions } from './arduinoContext';
import type { ArduinoApi, ArduinoState } from './arduinoContext';

export const IDE_VERIFY_COMMAND = 'arduino-verify-sketch';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildError';
  }
}
export class BuildCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'BuildCancelled';
  }
}

export type BuildMethod = 'auto' | 'ide' | 'cli';

export interface BuildOptions {
  api: ArduinoApi;
  state: ArduinoState;
  token: vscode.CancellationToken;
  log: (message: string) => void;
  method: BuildMethod;
  cliPath?: string;
  timeoutMs?: number;
}

export interface BuildOutcome {
  buildPath: string;
  /** Build properties of the actual compile, when known. */
  buildProperties?: Readonly<Record<string, string>>;
  via: 'ide' | 'cli';
  /** Removes temporary output (CLI builds only). */
  cleanup: () => void;
}

function race<T>(work: Thenable<T>, token: vscode.CancellationToken, timeoutMs: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BuildError(`${what} did not finish within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    const sub = token.onCancellationRequested(() => reject(new BuildCancelled()));
    work.then(
      (v) => { clearTimeout(timer); sub.dispose(); resolve(v); },
      (e: unknown) => { clearTimeout(timer); sub.dispose(); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

async function ideBuild(o: BuildOptions): Promise<BuildOutcome> {
  let events = 0;
  const sub = o.api.onDidChange('compileSummary')(() => { events++; });
  try {
    o.log(`IDE build: executeCommand("${IDE_VERIFY_COMMAND}")`);
    const started = Date.now();
    // Measured: resolves only after the build; returns the compile options object on success and
    // undefined on failure, invalid sketch or when another build is running.
    const result = await race(
      vscode.commands.executeCommand<unknown>(IDE_VERIFY_COMMAND),
      o.token,
      o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'IDE build',
    );
    o.log(`IDE build returned after ${Date.now() - started} ms (${result === undefined ? 'undefined' : 'ok'}), compileSummary events: ${events}`);
    if (result === undefined) {
      throw new BuildError('The IDE did not report a successful build (compile error, or a build was already running). See the IDE output.');
    }
    const summary = o.api.compileSummary;
    if (!summary?.buildPath) {
      throw new BuildError('The IDE build finished but reported no build folder.');
    }
    return { buildPath: summary.buildPath, buildProperties: summary.buildProperties, via: 'ide', cleanup: () => undefined };
  } finally {
    sub.dispose();
  }
}

function bundledCli(): string | undefined {
  const exe = process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli';
  // Measured on macOS: <appRoot>/lib/backend/resources/arduino-cli. Other OSes: same layout assumed, checked for existence.
  const p = path.join(vscode.env.appRoot, 'lib', 'backend', 'resources', exe);
  return fs.existsSync(p) ? p : undefined;
}

export function resolveCli(setting: string | undefined): string {
  return setting?.trim() || bundledCli() || 'arduino-cli';
}

async function cliBuild(o: BuildOptions): Promise<BuildOutcome> {
  const cli = resolveCli(o.cliPath);
  const buildPath = fs.mkdtempSync(path.join(os.tmpdir(), 'uf2export-'));
  const cleanup = (): void => fs.rmSync(buildPath, { recursive: true, force: true });
  const args = ['compile', '--fqbn', fqbnWithOptions(o.state), '--build-path', buildPath];
  const cfg = path.join(os.homedir(), '.arduinoIDE', 'arduino-cli.yaml');
  if (fs.existsSync(cfg)) {
    args.push('--config-file', cfg);
  }
  args.push(o.state.sketchPath);
  o.log(`CLI build: ${cli} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  try {
    await race(
      new Promise<void>((resolve, reject) => {
        const child = cp.spawn(cli, args, { windowsHide: true });
        const sub = o.token.onCancellationRequested(() => child.kill());
        const tail: string[] = [];
        const onData = (d: Buffer): void => {
          const text = d.toString();
          o.log(text.trimEnd());
          tail.push(text);
          if (tail.length > 20) tail.shift();
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', (e) => { sub.dispose(); reject(new BuildError(`cannot run ${cli}: ${e.message}`)); });
        child.on('close', (code) => {
          sub.dispose();
          if (code === 0) resolve();
          else reject(new BuildError(`arduino-cli exited with code ${String(code)}`));
        });
      }),
      o.token,
      o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'arduino-cli compile',
    );
  } catch (e) {
    cleanup();
    throw e;
  }
  return { buildPath, via: 'cli', cleanup };
}

/** Primary: IDE verify command. Fallback: arduino-cli (only if the command does not exist, or by setting). */
export async function triggerBuild(o: BuildOptions): Promise<BuildOutcome> {
  const hasIde = (await vscode.commands.getCommands(true)).includes(IDE_VERIFY_COMMAND);
  if (o.method === 'ide' || (o.method === 'auto' && hasIde)) {
    if (!hasIde) throw new BuildError(`IDE command ${IDE_VERIFY_COMMAND} is not registered.`);
    return ideBuild(o);
  }
  return cliBuild(o);
}
