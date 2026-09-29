import * as vscode from 'vscode';
import { runExport } from './ui';

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('UF2 Export');
  let running = false;

  const command = vscode.commands.registerCommand('uf2export.export', async () => {
    if (running) {
      void vscode.window.showWarningMessage('UF2 export is already running.');
      return;
    }
    running = true;
    try {
      await runExport(context, out);
    } finally {
      running = false;
    }
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  status.text = 'UF2';
  status.tooltip = 'Export the current sketch as .uf2 (Ctrl/Cmd+Alt+U)';
  status.command = 'uf2export.export';
  status.show();

  context.subscriptions.push(out, command, status);
}

export function deactivate(): void {
  /* nothing to clean up */
}
