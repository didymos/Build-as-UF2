import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getApi, readState } from './arduinoContext';
import type { ArduinoState } from './arduinoContext';
import { ArtifactError, boardIdOf, newestSourceMtime, pickArtifact, sketchNameOf } from './artifacts';
import type { Artifact } from './artifacts';
import { resolveBoard } from './boards';
import type { BoardMapping, BoardOverride } from './boards';
import { BuildCancelled, triggerBuild } from './build';
import type { BuildMethod, BuildOutcome } from './build';
import { toUf2 } from './convert';

const BUILD_AND_CONVERT = 'Build and convert';
const CONVERT_ONLY = 'Convert only';
const LAST_FOLDER_KEY = 'uf2export.lastFolder';

const hex = (n: number): string => '0x' + n.toString(16).padStart(8, '0');

function readFileOrUndefined(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function resolveMapping(state: ArduinoState, props: Readonly<Record<string, string>>, overrides: Record<string, BoardOverride>): BoardMapping {
  return resolveBoard({ fqbn: state.fqbn, buildProperties: props, overrides, readFile: readFileOrUndefined });
}

async function writeAtomic(target: string, data: Buffer): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, target);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
}

async function reveal(file: string): Promise<void> {
  try {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
    return;
  } catch {
    /* command missing in this host: fall back to the OS file manager */
  }
  const dir = path.dirname(file);
  if (process.platform === 'darwin') cp.spawn('open', ['-R', file], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'win32') cp.spawn('explorer.exe', [`/select,${file}`], { detached: true, stdio: 'ignore' }).unref();
  else cp.spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
}

async function chooseFolder(ext: vscode.ExtensionContext, state: ArduinoState): Promise<string | undefined> {
  const last = ext.workspaceState.get<Record<string, string>>(LAST_FOLDER_KEY, {})[state.sketchPath];
  const start = last && fs.existsSync(last) ? last : state.sketchPath;
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(start),
    openLabel: 'Export UF2 here',
    title: 'UF2 Export: choose target folder',
  });
  return picked?.[0]?.fsPath;
}

interface Result {
  output: string;
  bytes: number;
}

async function doExport(ext: vscode.ExtensionContext, out: vscode.OutputChannel, log: (m: string) => void): Promise<Result | undefined> {
  const cfg = vscode.workspace.getConfiguration('uf2export');
  const overrides = cfg.get<Record<string, BoardOverride>>('overrides', {});

  // 1) FQBN, 2) mapping – both before any question is asked.
  const api = await getApi();
  const state = await readState(api);
  log(`sketch ${state.sketchPath}`);
  log(`board ${state.boardName} (${state.fqbn})`);
  const preMapping = resolveMapping(state, state.buildProperties, overrides);
  log(`mapping: ${preMapping.chip}, input .${preMapping.input}, family ${preMapping.familyId === undefined ? 'from file' : hex(preMapping.familyId)}, base ${preMapping.baseAddress === undefined ? 'from file' : hex(preMapping.baseAddress)} [${preMapping.source}]`);

  // 3) folder
  const folder = await chooseFolder(ext, state);
  if (!folder) {
    log('cancelled at folder dialog');
    return undefined;
  }
  const map = ext.workspaceState.get<Record<string, string>>(LAST_FOLDER_KEY, {});
  await ext.workspaceState.update(LAST_FOLDER_KEY, { ...map, [state.sketchPath]: folder });

  // 4) modal
  const choice = await vscode.window.showInformationMessage(
    'Export UF2',
    { modal: true, detail: `Board: ${state.boardName} (${state.fqbn}) → ${folder}` },
    BUILD_AND_CONVERT,
    CONVERT_ONLY,
  );
  if (!choice) {
    log('cancelled at confirmation dialog');
    return undefined;
  }
  let doBuild = choice === BUILD_AND_CONVERT;

  // 5) convert only: existing build must exist and be fresh
  const sketchName = sketchNameOf(state.sketchPath);
  if (!doBuild) {
    let existing: Artifact | undefined;
    if (state.compileBuildPath) {
      try {
        existing = pickArtifact(state.compileBuildPath, sketchName, preMapping);
      } catch (e) {
        if (!(e instanceof ArtifactError)) throw e;
        log(`no usable build output: ${e.message}`);
      }
    }
    const newest = newestSourceMtime(state.sketchPath);
    const problem = !existing ? 'No build output found' : existing.mtimeMs < newest ? 'The build output is older than the sketch sources' : undefined;
    if (problem) {
      log(`${problem}`);
      const again = await vscode.window.showWarningMessage(`${problem}. Build first?`, { modal: true }, BUILD_AND_CONVERT);
      if (!again) {
        log('cancelled at stale-build dialog');
        return undefined;
      }
      doBuild = true;
    }
  }

  // 6) overwrite check (before the expensive build)
  const output = path.join(folder, `${sketchName}.${boardIdOf(state.fqbn)}.uf2`);
  if (fs.existsSync(output)) {
    const ok = await vscode.window.showWarningMessage(`${path.basename(output)} already exists in ${folder}. Overwrite?`, { modal: true }, 'Overwrite');
    if (!ok) {
      log('cancelled at overwrite dialog');
      return undefined;
    }
  }

  return vscode.window.withProgress<Result | undefined>(
    { location: vscode.ProgressLocation.Notification, title: 'UF2 Export', cancellable: true },
    async (progress, token) => {
      let outcome: BuildOutcome | undefined;
      try {
        let buildPath: string;
        let props: Readonly<Record<string, string>>;
        if (doBuild) {
          progress.report({ message: 'Building…' });
          outcome = await triggerBuild({
            api,
            state,
            token,
            log,
            method: cfg.get<BuildMethod>('buildMethod', 'auto'),
            cliPath: cfg.get<string>('arduinoCliPath', ''),
          });
          buildPath = outcome.buildPath;
          props = outcome.buildProperties ?? state.buildProperties;
        } else {
          buildPath = state.compileBuildPath as string;
          props = state.compileBuildProperties ?? state.buildProperties;
        }
        log(`build folder ${buildPath} (${outcome ? outcome.via : 'existing'})`);

        // Re-resolve with the properties of the compile that actually ran (includes board options).
        const mapping = resolveMapping(state, props, overrides);
        if (JSON.stringify(mapping) !== JSON.stringify(preMapping)) {
          log(`mapping changed after build: ${mapping.chip}, family ${mapping.familyId === undefined ? 'from file' : hex(mapping.familyId)}, base ${mapping.baseAddress === undefined ? 'from file' : hex(mapping.baseAddress)} [${mapping.source}]`);
        }

        progress.report({ message: 'Converting…' });
        const artifact = pickArtifact(buildPath, sketchName, mapping);
        log(`input ${artifact.path} (.${artifact.kind})`);
        const conv = toUf2(artifact, mapping);
        const fam = conv.info.families.map((f) => `${hex(f.familyId)}@${hex(f.startAddress)}`).join(', ');
        log(`${conv.how}; blocks ${conv.info.blockCount}, size ${conv.info.size} bytes, families ${fam}`);

        if (token.isCancellationRequested) throw new BuildCancelled();
        progress.report({ message: 'Writing…' });
        await writeAtomic(output, conv.data);
        log(`wrote ${output}`);
        return { output, bytes: conv.data.length };
      } finally {
        outcome?.cleanup();
      }
    },
  );
}

export async function runExport(ext: vscode.ExtensionContext, out: vscode.OutputChannel): Promise<void> {
  const log = (m: string): void => out.appendLine(`[${new Date().toISOString()}] ${m}`);
  log('--- UF2 export ---');
  try {
    const result = await doExport(ext, out, log);
    if (result) {
      const pick = await vscode.window.showInformationMessage(`UF2 written: ${result.output} (${result.bytes} bytes)`, 'Reveal in folder');
      if (pick) await reveal(result.output);
    }
  } catch (e) {
    if (e instanceof BuildCancelled) {
      log('cancelled; the IDE build, if started, keeps running');
      void vscode.window.showInformationMessage('UF2 export cancelled. A build already started in the IDE keeps running; no file was written.');
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    log(`ERROR: ${msg}`);
    out.show(true);
    void vscode.window.showErrorMessage(`UF2 export failed: ${msg}`);
  }
}
