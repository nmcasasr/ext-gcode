import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseStl } from './stl';
import { sliceVase, DEFAULT_OPTIONS } from './vase';
import { clampOverhangs } from './clamp';
import { runOrca, extractGcodeFrom3mf, OrcaConfig } from './orca';
import { packBambu3mf } from './bambu';

export function activate(context: vscode.ExtensionContext) {
  let panel: vscode.WebviewPanel | undefined;
  let trackedUri: vscode.Uri | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let watcher: fs.FSWatcher | undefined;
  let watchDebounce: ReturnType<typeof setTimeout> | undefined;
  let watchTarget: string | undefined; // exact file being watched (may not exist yet)
  let watchNewestIn: string | undefined; // or: follow the newest g-code in this folder
  let watchStatus: vscode.StatusBarItem | undefined;

  // Reads the tracked file's current content — from the open editor if it's
  // open, otherwise straight from disk (so external tools like Orca refresh it).
  async function sendDoc() {
    if (!panel || !trackedUri) {
      return;
    }
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === trackedUri!.toString()
    );
    let text = '';
    if (doc) {
      text = doc.getText();
    } else {
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(trackedUri));
      } catch {
        text = '';
      }
    }
    panel.webview.postMessage({ type: 'gcode', text });
  }

  function ensurePanel() {
    if (panel) {
      return;
    }
    panel = vscode.window.createWebviewPanel(
      'gcodePreview',
      'G-code Preview',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );
    panel.webview.html = getHtml(panel.webview, context.extensionUri);
    panel.onDidDispose(
      () => {
        panel = undefined;
      },
      null,
      context.subscriptions
    );
    // The webview tells us when it has booted and is ready to receive data.
    panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg && msg.type === 'ready') {
          sendDoc();
        }
      },
      undefined,
      context.subscriptions
    );
  }

  // Reveal the preview for a specific g-code document uri.
  function openPreviewForUri(uri: vscode.Uri) {
    trackedUri = uri;
    ensurePanel();
    panel!.reveal(vscode.ViewColumn.Beside);
    sendDoc();
  }

  const open = vscode.commands.registerCommand('gcodePreview.open', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('Open a .gcode file first, then run this command.');
      return;
    }
    openPreviewForUri(editor.document.uri);
  });
  context.subscriptions.push(open);

  // STL -> Vase-mode G-code, then open it in the preview.
  const slice = vscode.commands.registerCommand('gcodePreview.sliceVase', async () => {
    let stlUri: vscode.Uri | undefined;
    const active = vscode.window.activeTextEditor;
    if (active && active.document.fileName.toLowerCase().endsWith('.stl')) {
      stlUri = active.document.uri;
    } else {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Slice (vase mode)',
        filters: { STL: ['stl'] }
      });
      stlUri = picked && picked[0];
    }
    if (!stlUri) {
      return;
    }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Slicing (vase mode)…' },
        async () => {
          const bytes = await vscode.workspace.fs.readFile(stlUri!);
          const tris = parseStl(bytes);
          if (tris.length === 0) {
            throw new Error('No triangles found in STL.');
          }
          const { gcode, stats } = sliceVase(tris, DEFAULT_OPTIONS);

          const outUri = stlUri!.with({ path: stlUri!.path.replace(/\.stl$/i, '') + '.vase.gcode' });
          await vscode.workspace.fs.writeFile(outUri, Buffer.from(gcode, 'utf8'));

          const doc = await vscode.workspace.openTextDocument(outUri);
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
          openPreviewForUri(outUri);

          vscode.window.showInformationMessage(
            `Vase sliced: ${stats.layers} layers · ${stats.height.toFixed(1)} mm tall · ${stats.triangles} triangles.`
          );
        }
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage('Vase slicing failed: ' + m);
    }
  });
  context.subscriptions.push(slice);

  // Shared helper: resolve an STL uri from the active editor or a file picker.
  async function resolveStl(label: string): Promise<vscode.Uri | undefined> {
    const active = vscode.window.activeTextEditor;
    if (active && active.document.fileName.toLowerCase().endsWith('.stl')) {
      return active.document.uri;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false, openLabel: label, filters: { STL: ['stl'] }
    });
    return picked && picked[0];
  }

  function cfgNum(key: string, dflt: number): number {
    const v = vscode.workspace.getConfiguration('gcodePreview').get<number>(key);
    return typeof v === 'number' ? v : dflt;
  }

  // STL -> overhang-clamped STL. Reshapes bulges/twists so no wall exceeds the
  // target angle from vertical, then writes <name>.fixed.stl for re-slicing.
  async function clampToStl(stlUri: vscode.Uri): Promise<vscode.Uri> {
    const bytes = await vscode.workspace.fs.readFile(stlUri);
    const tris = parseStl(bytes);
    if (tris.length === 0) {
      throw new Error('No triangles found in STL.');
    }
    const maxAngle = cfgNum('clampAngle', 45);
    const layerHeight = cfgNum('layerHeight', 0.3);
    const { stl, stats } = clampOverhangs(tris, { layerHeight, resample: 200, maxAngle });
    const outUri = stlUri.with({ path: stlUri.path.replace(/\.stl$/i, '') + '.fixed.stl' });
    await vscode.workspace.fs.writeFile(outUri, stl);
    vscode.window.showInformationMessage(
      `Overhang clamp @${maxAngle}°: reshaped ${stats.clampedPoints}/${stats.totalPoints} points ` +
      `(max pull ${stats.maxPullMm.toFixed(1)} mm) → ${path.basename(outUri.fsPath)}`
    );
    return outUri;
  }

  const clamp = vscode.commands.registerCommand('gcodePreview.clampOverhangs', async () => {
    const stlUri = await resolveStl('Clamp overhangs');
    if (!stlUri) { return; }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Clamping overhangs…' },
        async () => { await clampToStl(stlUri); }
      );
    } catch (err) {
      vscode.window.showErrorMessage('Overhang clamp failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  });
  context.subscriptions.push(clamp);

  // Read Orca config from settings.
  function orcaConfig(): OrcaConfig {
    const c = vscode.workspace.getConfiguration('gcodePreview');
    return {
      binary: c.get<string>('orcaBinary') || '',
      machineSettings: c.get<string>('orcaMachine') || '',
      processSettings: c.get<string>('orcaProcess') || '',
      filament: c.get<string>('orcaFilament') || '',
      extraArgs: c.get<string[]>('orcaExtraArgs') || []
    };
  }

  // Slice an STL with the real OrcaSlicer CLI, extract plain g-code, preview it.
  async function orcaSliceToGcode(stlUri: vscode.Uri): Promise<vscode.Uri> {
    const cfg = orcaConfig();
    if (!cfg.binary) {
      throw new Error('Set "gcodePreview.orcaBinary" (path to the OrcaSlicer executable) in Settings first.');
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-'));
    const out3mf = path.join(tmpDir, 'out.gcode.3mf');
    await runOrca(cfg, stlUri.fsPath, out3mf, path.dirname(stlUri.fsPath));
    const zip = await fs.promises.readFile(out3mf);
    const gcode = extractGcodeFrom3mf(zip);
    const outUri = stlUri.with({ path: stlUri.path.replace(/\.stl$/i, '') + '.gcode' });
    await vscode.workspace.fs.writeFile(outUri, Buffer.from(gcode, 'utf8'));
    return outUri;
  }

  const orcaSlice = vscode.commands.registerCommand('gcodePreview.sliceWithOrca', async () => {
    const stlUri = await resolveStl('Slice with Orca');
    if (!stlUri) { return; }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Slicing with OrcaSlicer…' },
        async () => {
          const outUri = await orcaSliceToGcode(stlUri);
          openPreviewForUri(outUri);
          vscode.window.showInformationMessage(`Orca sliced → ${path.basename(outUri.fsPath)}`);
        }
      );
    } catch (err) {
      vscode.window.showErrorMessage('Orca slicing failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  });
  context.subscriptions.push(orcaSlice);

  // Full pipeline: STL -> overhang clamp -> Orca slice -> preview overhangs.
  const pipeline = vscode.commands.registerCommand('gcodePreview.pipeline', async () => {
    const stlUri = await resolveStl('Run pipeline');
    if (!stlUri) { return; }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Pipeline: clamp → Orca → preview…' },
        async (p) => {
          p.report({ message: 'clamping overhangs' });
          const fixed = await clampToStl(stlUri);
          p.report({ message: 'slicing with Orca' });
          const outUri = await orcaSliceToGcode(fixed);
          openPreviewForUri(outUri);
        }
      );
    } catch (err) {
      vscode.window.showErrorMessage('Pipeline failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  });
  context.subscriptions.push(pipeline);

  // --- Watching g-code that some external tool keeps rewriting ---------------
  //
  // Two generators feed this: Orca re-exporting over the same path, and the
  // FullControl lamp scripts in ../vacante-g-code, which write a fresh
  // output/<nombre>.gcode on every run. Re-run the generator, see it here.
  //
  // We watch the *directory*, never the file path. fs.watch on a file follows
  // the inode, so a generator that writes a temp file and renames it over the
  // target — the safe way to write, and what guardar_gcode() does — would fire
  // once and then go silent forever. Watching the directory also lets us start
  // before the file exists, which is the normal case for a gitignored output/.
  const GCODE_RE = /\.(gcode|gco|g)$/i;

  function setWatchStatus(label: string | undefined) {
    if (!label) {
      watchStatus?.hide();
      return;
    }
    if (!watchStatus) {
      watchStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      watchStatus.command = 'gcodePreview.stopWatching';
      watchStatus.tooltip = 'G-code preview is watching for changes — click to stop.';
      context.subscriptions.push(watchStatus);
    }
    watchStatus.text = `$(eye) ${label}`;
    watchStatus.show();
  }

  function stopWatching(quiet = false) {
    if (watcher) { watcher.close(); watcher = undefined; }
    if (watchDebounce) { clearTimeout(watchDebounce); watchDebounce = undefined; }
    watchTarget = undefined;
    watchNewestIn = undefined;
    setWatchStatus(undefined);
    if (!quiet) { vscode.window.showInformationMessage('No longer watching for g-code changes.'); }
  }

  // A generator writing megabytes of g-code fires its first change event long
  // before it has finished. Wait for the size to stop moving so we never parse
  // half a file. Gives up after ~3 s and previews whatever is there.
  async function waitUntilStable(p: string): Promise<boolean> {
    let last = -1;
    for (let i = 0; i < 40; i++) {
      let size: number;
      try {
        size = (await fs.promises.stat(p)).size;
      } catch {
        return false; // vanished mid-write (a rename in progress) — the next event covers it
      }
      if (size > 0 && size === last) { return true; }
      last = size;
      await new Promise((r) => setTimeout(r, 80));
    }
    return true;
  }

  async function newestGcodeIn(dir: string): Promise<string | undefined> {
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return undefined;
    }
    let best: string | undefined;
    let bestTime = -1;
    for (const n of names) {
      if (!GCODE_RE.test(n)) { continue; }
      const full = path.join(dir, n);
      try {
        const st = await fs.promises.stat(full);
        if (st.isFile() && st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = full; }
      } catch {
        // vanished mid-scan; ignore
      }
    }
    return best;
  }

  async function refreshWatched() {
    const target = watchNewestIn ? await newestGcodeIn(watchNewestIn) : watchTarget;
    if (!target) { return; }
    if (!(await waitUntilStable(target))) { return; }
    trackedUri = vscode.Uri.file(target);
    ensurePanel();
    setWatchStatus(path.basename(target));
    await sendDoc();
  }

  function startWatching(dir: string, opts: { file?: string; newest?: boolean }) {
    stopWatching(true);
    watchTarget = opts.file;
    watchNewestIn = opts.newest ? dir : undefined;
    watcher = fs.watch(dir, (_event, filename) => {
      const name = filename ? filename.toString() : undefined;
      // `filename` can be null on some platforms — then we can't filter, just refresh.
      if (name) {
        if (watchTarget && path.basename(watchTarget) !== name) { return; }
        if (watchNewestIn && !GCODE_RE.test(name)) { return; }
      }
      if (watchDebounce) { clearTimeout(watchDebounce); }
      watchDebounce = setTimeout(() => { void refreshWatched(); }, 150);
    });
    setWatchStatus(opts.file ? path.basename(opts.file) : `newest in ${path.basename(dir)}/`);
    void refreshWatched();
  }

  context.subscriptions.push({ dispose: () => stopWatching(true) });

  // Watch one g-code file for external rewrites (e.g. Orca re-exporting it).
  const watch = vscode.commands.registerCommand('gcodePreview.watchGcode', async () => {
    let uri: vscode.Uri | undefined;
    const active = vscode.window.activeTextEditor;
    const name = active?.document.fileName.toLowerCase() || '';
    if (name.endsWith('.gcode') || name.endsWith('.gco') || name.endsWith('.g')) {
      uri = active!.document.uri;
    } else {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false, openLabel: 'Watch this g-code', filters: { 'G-code': ['gcode', 'gco', 'g'] }
      });
      uri = picked && picked[0];
    }
    if (!uri) { return; }

    openPreviewForUri(uri);
    try {
      startWatching(path.dirname(uri.fsPath), { file: uri.fsPath });
      vscode.window.showInformationMessage(
        `Watching ${path.basename(uri.fsPath)} — exports over this file refresh the preview automatically.`
      );
    } catch (err) {
      vscode.window.showErrorMessage('Could not watch file: ' + (err instanceof Error ? err.message : String(err)));
    }
  });
  context.subscriptions.push(watch);

  // Watch a whole folder and always preview the newest g-code in it. This is
  // the one for a generator loop: the FullControl scripts write a new file per
  // `--nombre`, so pinning a single path means re-running this command on every
  // rename. The folder need not have any g-code in it yet.
  const watchFolder = vscode.commands.registerCommand('gcodePreview.watchFolder', async (arg?: vscode.Uri) => {
    let dir = arg;
    if (!dir) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false, canSelectFiles: false, canSelectFolders: true,
        openLabel: 'Watch newest g-code here'
      });
      dir = picked && picked[0];
    }
    if (!dir) { return; }

    ensurePanel();
    panel!.reveal(vscode.ViewColumn.Beside);
    try {
      startWatching(dir.fsPath, { newest: true });
      vscode.window.showInformationMessage(
        `Watching ${path.basename(dir.fsPath)}/ — the newest .gcode written there is previewed automatically.`
      );
    } catch (err) {
      vscode.window.showErrorMessage('Could not watch folder: ' + (err instanceof Error ? err.message : String(err)));
    }
  });
  context.subscriptions.push(watchFolder);

  const stopWatch = vscode.commands.registerCommand('gcodePreview.stopWatching', () => stopWatching());
  context.subscriptions.push(stopWatch);

  // Wrap a .gcode in a Bambu .gcode.3mf so it can be printed over LAN — the A1
  // refuses plain g-code, and the Orca CLI has no send/upload option (checked on
  // 2.4.2: "Upload & Print" exists only in the GUI). Needs a template: a real
  // .gcode.3mf the user exported from Orca for their own machine and nozzle.
  async function bambuTemplate(): Promise<Buffer | undefined> {
    const c = vscode.workspace.getConfiguration('gcodePreview');
    const configured = c.get<string>('bambuTemplate') || '';
    if (configured && fs.existsSync(configured)) {
      return fs.promises.readFile(configured);
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Use as Bambu template',
      title: 'Pick a .gcode.3mf exported from OrcaSlicer for your printer',
      filters: { 'Bambu g-code project': ['3mf'] }
    });
    if (!picked || !picked[0]) { return undefined; }
    // Remember it: the template is per-printer, not per-file.
    await c.update('bambuTemplate', picked[0].fsPath, vscode.ConfigurationTarget.Global);
    return fs.promises.readFile(picked[0].fsPath);
  }

  const packBambu = vscode.commands.registerCommand('gcodePreview.packBambu3mf', async (arg?: vscode.Uri) => {
    const src = arg || vscode.window.activeTextEditor?.document.uri;
    if (!src || !GCODE_RE.test(src.fsPath)) {
      vscode.window.showErrorMessage('Open or right-click a .gcode file first.');
      return;
    }
    try {
      const template = await bambuTemplate();
      if (!template) { return; }

      const name = path.basename(src.fsPath).replace(GCODE_RE, '');
      const gcode = await fs.promises.readFile(src.fsPath, 'utf8');
      const result = packBambu3mf(template, gcode, name);
      const outPath = path.join(path.dirname(src.fsPath), `${name}.gcode.3mf`);
      await fs.promises.writeFile(outPath, result.zip);

      const s = result.stats;
      const choice = await vscode.window.showInformationMessage(
        `${name}.gcode.3mf — ${s.layerCount} layers, ${Math.round(s.seconds / 60)} min, ` +
          `${(s.filamentMm / 1000).toFixed(1)} m filament. Open it in Bambu Studio and press Print.`,
        'Reveal in Finder'
      );
      if (choice === 'Reveal in Finder') {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outPath));
      }
    } catch (err) {
      vscode.window.showErrorMessage('Could not pack the .gcode.3mf: ' + (err instanceof Error ? err.message : String(err)));
    }
  });
  context.subscriptions.push(packBambu);

  // Hot reload on save.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (trackedUri && doc.uri.toString() === trackedUri.toString()) {
        sendDoc();
      }
    })
  );

  // Live update while typing (debounced), so you can scrub the fan bands without saving.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (trackedUri && e.document.uri.toString() === trackedUri.toString()) {
        if (debounce) {
          clearTimeout(debounce);
        }
        debounce = setTimeout(sendDoc, 300);
      }
    })
  );

  // If you click into a different g-code editor, follow it.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!panel || !editor) {
        return;
      }
      // While watching, the watcher owns the panel: clicking into some other
      // g-code must not silently retarget it out from under the loop.
      if (watcher) {
        return;
      }
      const name = editor.document.fileName.toLowerCase();
      if (name.endsWith('.gcode') || name.endsWith('.gco') || name.endsWith('.g') || name.endsWith('.nc')) {
        trackedUri = editor.document.uri;
        sendDoc();
      }
    })
  );
}

export function deactivate() {}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const asset = (...p: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', ...p));
  const mainUri = asset('main.js');
  // three.js r128 (global THREE build) + OrbitControls, vendored locally in
  // media/vendor so the preview works offline and needs no remote CSP host.
  const threeUri = asset('vendor', 'three.min.js');
  const orbitUri = asset('vendor', 'OrbitControls.js');
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #1e1e1e; }
    #c { width: 100vw; height: 100vh; display: block; }
    #hud {
      position: fixed; top: 8px; left: 10px; font: 12px/1.4 monospace;
      color: #ddd; text-shadow: 0 1px 2px #000; pointer-events: none; z-index: 10;
    }
    #legend {
      position: fixed; top: 8px; right: 12px; font: 11px/1.5 monospace; color: #ddd;
      text-shadow: 0 1px 2px #000; z-index: 10; text-align: right;
    }
    .sw { display: inline-block; width: 10px; height: 10px; margin-right: 5px; vertical-align: middle; }
    #modeBtn {
      display: block; margin: 0 0 6px auto; padding: 3px 9px; cursor: pointer;
      font: 11px system-ui, sans-serif; color: #eee; background: #2d2d2d;
      border: 1px solid #4a4a4a; border-radius: 6px;
    }
    #modeBtn:hover { background: #3a3a3a; }

    /* --- Timelapse scrub bar (Bambu-style) --------------------------------- */
    #timebar {
      position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 12px;
      width: min(760px, calc(100vw - 40px));
      padding: 8px 14px; box-sizing: border-box;
      background: rgba(30, 30, 30, 0.82); border: 1px solid #3a3a3a;
      border-radius: 10px; backdrop-filter: blur(6px);
      font: 12px/1 system-ui, sans-serif; color: #ddd; z-index: 20;
      user-select: none;
    }
    #timebar.hidden { display: none; }
    #play {
      flex: 0 0 auto; width: 30px; height: 30px; border-radius: 50%;
      border: none; cursor: pointer; background: #00c07f; color: #062;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s;
    }
    #play:hover { background: #14d891; }
    #play svg { width: 14px; height: 14px; fill: #04321f; }
    #scrub {
      flex: 1 1 auto; -webkit-appearance: none; appearance: none;
      height: 5px; border-radius: 3px; background: #444; cursor: pointer; outline: none;
    }
    #scrub::-webkit-slider-runnable-track { height: 5px; border-radius: 3px; }
    #scrub::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none; width: 15px; height: 15px;
      border-radius: 50%; background: #00c07f; border: 2px solid #eafff6;
      margin-top: -5px; box-shadow: 0 1px 3px rgba(0,0,0,0.5);
    }
    #tlabel {
      flex: 0 0 auto; font-variant-numeric: tabular-nums; min-width: 72px;
      text-align: right; color: #bdbdbd; font-size: 11px;
    }

    /* --- Vertical layer slider (Bambu-style, right edge) -------------------- */
    #layerbar {
      position: fixed; right: 18px; top: 50%; transform: translateY(-50%);
      display: flex; flex-direction: column; align-items: center; gap: 6px;
      font: 11px/1.2 system-ui, sans-serif; color: #bdbdbd; z-index: 20;
      user-select: none;
    }
    #layerbar.hidden { display: none; }
    #layer-top, #layer-bot {
      font-variant-numeric: tabular-nums; text-align: center; min-height: 26px;
      color: #cfcfcf; text-shadow: 0 1px 2px #000; white-space: pre-line;
    }
    #layer {
      -webkit-appearance: slider-vertical; appearance: slider-vertical;
      writing-mode: vertical-lr; direction: rtl;
      width: 6px; height: 46vh; cursor: pointer; accent-color: #00c07f;
      background: #444; border-radius: 3px;
    }
    #layer::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none; width: 15px; height: 15px;
      border-radius: 50%; background: #00c07f; border: 2px solid #eafff6;
      box-shadow: 0 1px 3px rgba(0,0,0,0.5);
    }
  </style>
</head>
<body>
  <canvas id="c"></canvas>
  <div id="hud">loading…</div>
  <div id="legend">
    <button id="modeBtn" title="Toggle color scheme">Color: Fan</button>
    <div id="legend-fan">
      <div><span class="sw" style="background:#2f7fff"></span>fan ON (M106 S255)</div>
      <div><span class="sw" style="background:#ff5a3c"></span>fan OFF (M107)</div>
      <div><span class="sw" style="background:#555"></span>travel move</div>
    </div>
    <div id="legend-ovh" style="display:none">
      <div>overhang (angle from vertical)</div>
      <div><span class="sw" style="background:#2fbf4d"></span>0–30° safe</div>
      <div><span class="sw" style="background:#ffd23f"></span>~45° watch</div>
      <div><span class="sw" style="background:#ff8c1a"></span>~55° risky</div>
      <div><span class="sw" style="background:#ff2a2a"></span>65°+ likely fails</div>
    </div>
  </div>
  <div id="timebar" class="hidden">
    <button id="play" title="Play / pause timelapse (space)">
      <svg id="play-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
    </button>
    <input id="scrub" type="range" min="0" max="1" value="1" step="1" />
    <span id="tlabel">0 / 0</span>
  </div>
  <div id="layerbar" class="hidden">
    <div id="layer-top">–</div>
    <input id="layer" type="range" min="1" max="1" value="1" step="1" title="Layer" />
    <div id="layer-bot">1</div>
  </div>
  <script nonce="${nonce}" src="${threeUri}"></script>
  <script nonce="${nonce}" src="${orbitUri}"></script>
  <script nonce="${nonce}" src="${mainUri}"></script>
</body>
</html>`;
}
