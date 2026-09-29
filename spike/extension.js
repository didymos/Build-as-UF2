'use strict';
// THROWAWAY Phase-0 spike. Plain JS on purpose (no build step). Output: OutputChannel "UF2 Spike".
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API_ID = 'dankeboy36.vscode-arduino-api';
let out;
const log = (...a) => out.appendLine(a.map((x) => (typeof x === 'string' ? x : safe(x))).join(' '));
function safe(v, max = 4000) {
  try {
    const s = JSON.stringify(v, (k, x) => (typeof x === 'function' ? '[fn]' : x), 1);
    return s && s.length > max ? s.slice(0, max) + '…[truncated]' : String(s);
  } catch (e) { return `[unserializable: ${e}]`; }
}
const KEYS = ['sketchPath', 'compileSummary', 'fqbn', 'boardDetails', 'port', 'userDirPath', 'dataDirPath'];
const BP_KEYS = ['build.mcu', 'build.variant', 'build.core', 'build.board', 'build.arch', 'build.f_cpu',
  'build.extra_flags', 'upload.tool', 'upload.maximum_size', 'upload.protocol', 'bootloader.tool',
  'build.flash_offset', 'build.bootloader_addr', 'build.partitions', 'build.fs_start', 'build.fs_end',
  'build.flash_size', 'build.chip', 'build.tarch', 'recipe.objcopy.bin.pattern', 'recipe.objcopy.hex.pattern',
  'recipe.objcopy.uf2.pattern', 'build.mcu.family', 'build.uf2', 'runtime.platform.path', 'runtime.tools.arduino-cli.path'];

function pickBp(bp) {
  if (!bp) return undefined;
  const o = {};
  for (const k of BP_KEYS) if (k in bp) o[k] = bp[k];
  for (const k of Object.keys(bp)) if (/uf2|fs_start|fs_end|littlefs|flash_offset|mklittlefs/i.test(k)) o[k] = bp[k];
  return { totalKeys: Object.keys(bp).length, picked: o };
}
const BP_RE = /^(build\.(mcu|core|variant|board|arch|series|ldscript|extra_flags|softdevice|sd_|.*addr|.*flash|.*offset|.*family|.*uf2|.*bootloader|.*version|vid|pid|usb_.*|f_cpu|variant_system_lib|.*sd.*)|upload\.|bootloader\.|recipe\.(objcopy|hooks\.objcopy|hooks\.savehex|output|hooks\.postbuild)|runtime\.(platform\.path|tools\..*path)|serial\.|version|name|nordic\.|nrf.*|.*uf2.*|.*softdevice.*)/i;
function dumpProps(tag, bp) {
  if (!bp) { log(`[${tag}] no buildProperties`); return; }
  const f = path.join(os.homedir(), `uf2spike-${tag}-buildprops.json`);
  try { fs.writeFileSync(f, JSON.stringify(bp, null, 1)); log(`[${tag}] FULL buildProperties (${Object.keys(bp).length} keys) written to`, f); } catch (e) { log('write failed', String(e)); }
  const lines = Object.keys(bp).filter((k) => BP_RE.test(k)).sort().map((k) => `  ${k} = ${String(bp[k]).slice(0, 300)}`);
  log(`[${tag}] filtered buildProperties (${lines.length}):\n` + lines.join('\n'));
}
function describe(api) {
  log('typeof exports:', typeof api, '| own keys:', Object.keys(api), '| proto keys:', Object.getOwnPropertyNames(Object.getPrototypeOf(api) || {}));
  for (const k of KEYS) {
    let v; try { v = api[k]; } catch (e) { v = `[getter threw: ${e}]`; }
    if (k === 'boardDetails' && v) {
      log(`api.${k}: fqbn=`, v.fqbn, '| name=', v.name, '| keys=', Object.keys(v), '| configOptions.length=', (v.configOptions || []).length);
      dumpProps('boardDetails', v.buildProperties);
    } else if (k === 'compileSummary' && v) {
      log(`api.${k}: keys=`, Object.keys(v), '| buildPath=', v.buildPath, '| usedLibraries=', (v.usedLibraries || []).length, '| executableSectionsSize=', v.executableSectionsSize);
      dumpProps('compileSummary', v.buildProperties);
    } else log(`api.${k}:`, v);
  }
}

async function inspectApi() {
  log('=== [1] vscode-arduino-api ===');
  const ext = vscode.extensions.getExtension(API_ID);
  log('getExtension exists:', !!ext);
  if (!ext) {
    log('all extension ids matching /arduino/i:', vscode.extensions.all.map((e) => e.id).filter((i) => /arduino/i.test(i)));
    log('total extensions:', vscode.extensions.all.length);
    return undefined;
  }
  log('packageJSON.version:', ext.packageJSON && ext.packageJSON.version, '| isActive:', ext.isActive);
  const api = ext.isActive ? ext.exports : await ext.activate();
  if (!api) { log('exports undefined after activate'); return undefined; }
  for (let i = 0; i < 30 && api.fqbn === undefined; i++) await new Promise((r) => setTimeout(r, 500));
  log('state populated after polling:', api.fqbn !== undefined);
  describe(api);
  log('onDidChange typeof:', typeof api.onDidChange);
  return api;
}
let subscribed = false;
function subscribe(api, ctx) {
  if (subscribed || !api || typeof api.onDidChange !== 'function') return;
  subscribed = true;
  for (const k of KEYS) {
    try {
      ctx.subscriptions.push(api.onDidChange(k)((v) => {
        const brief = k === 'boardDetails' ? v && v.fqbn : k === 'compileSummary' ? v && v.buildPath : v;
        log(`[event ${new Date().toISOString()}] onDidChange('${k}') →`, brief);
      }));
    } catch (e) { log(`subscribe(${k}) failed:`, String(e)); }
  }
  log('subscribed onDidChange for', KEYS.join(','));
}

async function listCommands() {
  log('=== [2] commands ===');
  const all = await vscode.commands.getCommands(true);
  log('total commands:', all.length);
  const hits = all.filter((c) => /arduino|verify|compile|upload|sketch|export/i.test(c) && !/^arduino-(open-example|open-recent|include-library)/.test(c)).sort();
  log('filtered /arduino|verify|compile|upload|sketch|export/i (' + hits.length + '):\n  ' + hits.join('\n  '));
  for (const id of ['arduino-verify-sketch', 'arduino-export-binaries', 'arduino-verify-sketch-clean', 'arduino-is-optimize-for-debug', 'arduinoAPI.updateState']) {
    log(`  registered '${id}':`, all.includes(id));
  }
}

async function runVerify(api) {
  log('=== [2b] executeCommand("arduino-verify-sketch") ===');
  const before = api && api.compileSummary;
  log('compileSummary.buildPath before:', before && before.buildPath);
  let changed = 0, firedAt;
  const d = api && api.onDidChange ? api.onDidChange('compileSummary')(() => { changed++; firedAt = Date.now(); }) : undefined;
  const t0 = Date.now();
  let ret, err;
  try { ret = await vscode.commands.executeCommand('arduino-verify-sketch'); } catch (e) { err = e; }
  const t1 = Date.now();
  log('executeCommand resolved after', t1 - t0, 'ms | returned:', ret === undefined ? 'undefined' : safe(ret, 1500), '| error:', err ? String(err) : 'none');
  log('compileSummary events already fired at resolve time:', changed);
  await new Promise((r) => setTimeout(r, 3000));
  log('compileSummary events 3 s after resolve:', changed, changed ? `(first at t0+${firedAt - t0}ms)` : '');
  const after = api && api.compileSummary;
  log('compileSummary.buildPath after:', after && after.buildPath);
  if (after && after.buildPath) {
    try { log('buildPath listing:', fs.readdirSync(after.buildPath).slice(0, 80)); } catch (e) { log('readdir failed:', String(e)); }
  }
  if (after) { log('--- describe() after verify ---'); describe(api); }
  if (d) d.dispose();
}

function findCli() {
  log('=== [4] arduino-cli location ===');
  const exe = process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli';
  log('platform:', process.platform, process.arch, '| process.execPath:', process.execPath, '| appRoot:', vscode.env.appRoot);
  log('process.resourcesPath:', process.resourcesPath, '| argv:', process.argv.slice(0, 4), '| __dirname:', __dirname);
  log('env ARDUINO_*:', Object.keys(process.env).filter((k) => /arduino|theia/i.test(k)).map((k) => `${k}=${process.env[k]}`));
  const cands = new Set();
  const rel = (base) => [
    path.join(base, 'resources', 'app', 'lib', 'backend', 'resources', exe),
    path.join(base, 'app', 'lib', 'backend', 'resources', exe),
    path.join(base, 'lib', 'backend', 'resources', exe),
    path.join(base, 'resources', exe), path.join(base, exe)];
  const bases = [];
  // walk up from a few known anchors
  for (const anchor of [vscode.env.appRoot, process.execPath, process.resourcesPath, process.argv[1], __dirname]) {
    let p = anchor; if (!p) continue;
    for (let i = 0; i < 8; i++) { bases.push(p); const n = path.dirname(p); if (n === p) break; p = n; }
  }
  const osBases = process.platform === 'darwin'
    ? ['/Applications/Arduino IDE.app/Contents', path.join(os.homedir(), 'Applications/Arduino IDE.app/Contents')]
    : process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Arduino IDE'), 'C:\\Program Files\\Arduino IDE']
      : ['/opt/arduino-ide', '/opt/Arduino IDE', path.join(os.homedir(), 'arduino-ide'), path.join(os.homedir(), 'Applications')];
  for (const b of [...bases, ...osBases]) for (const c of rel(b)) cands.add(c);
  const found = [...cands].filter((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
  log('candidates checked:', cands.size, '| FOUND:', found);
  log('PATH entries with arduino-cli:', (process.env.PATH || '').split(path.delimiter).filter((d) => { try { return fs.existsSync(path.join(d, exe)); } catch { return false; } }));
  log('~/.arduino15 exists:', fs.existsSync(path.join(os.homedir(), '.arduino15')), '| ~/.arduinoIDE:', fs.existsSync(path.join(os.homedir(), '.arduinoIDE')));
}

async function probe(ctx) {
  out.show(true);
  log('\n################ PROBE', new Date().toISOString(), '################');
  log('vscode.version (Theia API level):', vscode.version, '| appName:', vscode.env.appName, '| uiKind:', vscode.env.uiKind);
  const api = await inspectApi();
  subscribe(api, ctx);
  await listCommands();
  log('=== [3] editor/title button: contributed in package.json; if you see a package icon in the editor tab toolbar, it renders. Statusbar item "UF2 Spike" is the control. ===');
  findCli();
  log('=== done. Run "UF2 Spike: Run IDE verify and measure" next (board must be selected). ===');
  return api;
}

function activate(ctx) {
  out = vscode.window.createOutputChannel('UF2 Spike');
  ctx.subscriptions.push(out);
  log('activate() called', new Date().toISOString());
  const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  sb.text = 'UF2 Spike'; sb.command = 'uf2spike.menu'; sb.tooltip = 'Phase-0: pick probe / verify / dump'; sb.show();
  const sbv = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
  sbv.text = 'UF2 Verify'; sbv.command = 'uf2spike.verify'; sbv.tooltip = 'Run IDE verify and measure'; sbv.show();
  ctx.subscriptions.push(sb, sbv);
  const reg = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('uf2spike.menu', async () => {
    const pick = await vscode.window.showQuickPick(['probe', 'verify', 'dumpApi']);
    if (pick) await vscode.commands.executeCommand('uf2spike.' + pick);
  });
  reg('uf2spike.probe', () => probe(ctx).catch((e) => log('probe failed:', String(e && e.stack || e))));
  reg('uf2spike.dumpApi', async () => { out.show(true); const api = await inspectApi(); subscribe(api, ctx); });
  reg('uf2spike.verify', async () => {
    out.show(true);
    const api = await inspectApi(); subscribe(api, ctx);
    await runVerify(api).catch((e) => log('verify probe failed:', String(e && e.stack || e)));
  });
  probe(ctx).catch((e) => log('auto-probe failed:', String(e && e.stack || e)));
}
function deactivate() {}
module.exports = { activate, deactivate };
