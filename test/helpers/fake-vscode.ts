/* Minimal in-memory stand-in for the `vscode` module; installed on import. */
import Module from 'node:module';

type Fn = (...a: any[]) => any;
export const fake = {
  api: undefined as any,
  commands: ['arduino-verify-sketch'] as string[],
  execute: (async () => undefined) as Fn,
  openDialog: (async () => undefined) as Fn,
  modalAnswers: [] as (string | undefined)[],
  infoMessages: [] as string[],
  warnings: [] as string[],
  errors: [] as string[],
  dialogCalls: 0,
  reset(): void {
    this.commands = ['arduino-verify-sketch'];
    this.execute = async () => undefined;
    this.openDialog = async () => undefined;
    this.modalAnswers = [];
    this.infoMessages = [];
    this.warnings = [];
    this.errors = [];
    this.dialogCalls = 0;
  },
};

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const vscodeStub = {
  extensions: { getExtension: () => (fake.api ? { isActive: true, exports: fake.api, activate: async () => fake.api } : undefined) },
  commands: {
    getCommands: async () => fake.commands,
    executeCommand: (id: string, ...a: unknown[]) => fake.execute(id, ...a),
    registerCommand: () => ({ dispose() {} }),
  },
  window: {
    showOpenDialog: async (...a: unknown[]) => { fake.dialogCalls++; return fake.openDialog(...a); },
    showInformationMessage: async (msg: string, opts?: { modal?: boolean }) => {
      if (opts?.modal) return fake.modalAnswers.shift();
      fake.infoMessages.push(msg);
      return undefined;
    },
    showWarningMessage: async (msg: string) => { fake.warnings.push(msg); return fake.modalAnswers.shift(); },
    showErrorMessage: async (msg: string) => { fake.errors.push(msg); return undefined; },
    withProgress: async (_o: unknown, fn: Fn) => fn({ report() {} }, token),
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
  },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  ProgressLocation: { Notification: 15 },
  StatusBarAlignment: { Left: 1 },
  env: { appRoot: '/nonexistent' },
};

const M = Module as unknown as { _load: Fn };
const orig = M._load;
M._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscodeStub : orig.call(this, request, ...rest);
};
export const fakeToken = token;
