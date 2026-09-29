import * as vscode from 'vscode';

/**
 * Wrapper around the `dankeboy36.vscode-arduino-api` extension that Arduino IDE 2.x bundles
 * (measured: version 0.1.2, "IDE2 lane"). Only the members used here are typed.
 * The state is EMPTY at activation and filled ~350 ms later, so it is read lazily.
 */
const API_ID = 'dankeboy36.vscode-arduino-api';

export interface ConfigValue {
  value: string;
  valueLabel?: string;
  selected: boolean;
}
export interface ConfigOption {
  option: string;
  optionLabel?: string;
  values: ConfigValue[];
}
interface CompileSummary {
  buildPath: string;
  buildProperties: Readonly<Record<string, string>>;
}
interface BoardDetails {
  fqbn: string;
  buildProperties: Readonly<Record<string, string>>;
  configOptions: ConfigOption[];
}
export interface ArduinoApi {
  readonly sketchPath: string | undefined;
  readonly fqbn: string | undefined;
  readonly compileSummary: CompileSummary | undefined;
  readonly boardDetails: BoardDetails | undefined;
  readonly userDirPath: string | undefined;
  readonly dataDirPath: string | undefined;
  onDidChange(property: 'compileSummary'): vscode.Event<CompileSummary | undefined>;
}

export interface ArduinoState {
  sketchPath: string;
  /** Selected board FQBN without config options (as the API reports it). */
  fqbn: string;
  boardName: string;
  buildProperties: Readonly<Record<string, string>>;
  configOptions: readonly ConfigOption[];
  /** Latest IDE compile, if the sketch was verified in this session. */
  compileBuildPath: string | undefined;
  compileBuildProperties: Readonly<Record<string, string>> | undefined;
}

export class ArduinoContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArduinoContextError';
  }
}

export async function getApi(): Promise<ArduinoApi> {
  const ext = vscode.extensions.getExtension<ArduinoApi>(API_ID);
  if (!ext) {
    throw new ArduinoContextError(`Extension ${API_ID} not found; this extension only works inside Arduino IDE 2.x.`);
  }
  const api = ext.isActive ? ext.exports : await ext.activate();
  if (!api) {
    throw new ArduinoContextError(`${API_ID} did not export an API.`);
  }
  return api;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function readState(api: ArduinoApi): Promise<ArduinoState> {
  // Right after IDE start the state is not populated yet.
  for (let i = 0; i < 10 && api.sketchPath === undefined; i++) {
    await sleep(500);
  }
  const sketchPath = api.sketchPath;
  if (!sketchPath) {
    throw new ArduinoContextError('No sketch is open in the Arduino IDE.');
  }
  for (let i = 0; i < 2 && api.fqbn === undefined; i++) {
    await sleep(500);
  }
  const fqbn = api.fqbn;
  if (!fqbn) {
    throw new ArduinoContextError('No board selected. Select a board in the Arduino IDE first.');
  }
  const bp = api.boardDetails?.buildProperties ?? {};
  return {
    sketchPath,
    fqbn,
    boardName: bp['name'] ?? fqbn,
    buildProperties: bp,
    configOptions: api.boardDetails?.configOptions ?? [],
    compileBuildPath: api.compileSummary?.buildPath,
    compileBuildProperties: api.compileSummary?.buildProperties,
  };
}

/** `vendor:arch:board` + the currently selected option values, as `arduino-cli --fqbn` expects. */
export function fqbnWithOptions(state: ArduinoState): string {
  const base = state.fqbn.split(':').slice(0, 3).join(':');
  const opts = state.configOptions
    .map((o) => {
      const v = o.values.find((x) => x.selected);
      return v ? `${o.option}=${v.value}` : undefined;
    })
    .filter((x): x is string => x !== undefined);
  return opts.length > 0 ? `${base}:${opts.join(',')}` : base;
}
