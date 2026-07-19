"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
function activate(context) {
    let panel;
    let trackedUri;
    let debounce;
    function sendDoc() {
        if (!panel || !trackedUri) {
            return;
        }
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === trackedUri.toString());
        const text = doc ? doc.getText() : '';
        panel.webview.postMessage({ type: 'gcode', text });
    }
    const open = vscode.commands.registerCommand('gcodePreview.open', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('Open a .gcode file first, then run this command.');
            return;
        }
        trackedUri = editor.document.uri;
        if (!panel) {
            panel = vscode.window.createWebviewPanel('gcodePreview', 'G-code Preview', vscode.ViewColumn.Beside, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
            });
            panel.webview.html = getHtml(panel.webview, context.extensionUri);
            panel.onDidDispose(() => {
                panel = undefined;
            }, null, context.subscriptions);
            // The webview tells us when it has booted and is ready to receive data.
            panel.webview.onDidReceiveMessage((msg) => {
                if (msg && msg.type === 'ready') {
                    sendDoc();
                }
            }, undefined, context.subscriptions);
        }
        panel.reveal(vscode.ViewColumn.Beside);
        sendDoc();
    });
    context.subscriptions.push(open);
    // Hot reload on save.
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
        if (trackedUri && doc.uri.toString() === trackedUri.toString()) {
            sendDoc();
        }
    }));
    // Live update while typing (debounced), so you can scrub the fan bands without saving.
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
        if (trackedUri && e.document.uri.toString() === trackedUri.toString()) {
            if (debounce) {
                clearTimeout(debounce);
            }
            debounce = setTimeout(sendDoc, 300);
        }
    }));
    // If you click into a different g-code editor, follow it.
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!panel || !editor) {
            return;
        }
        const name = editor.document.fileName.toLowerCase();
        if (name.endsWith('.gcode') || name.endsWith('.gco') || name.endsWith('.g') || name.endsWith('.nc')) {
            trackedUri = editor.document.uri;
            sendDoc();
        }
    }));
}
function deactivate() { }
function getNonce() {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
function getHtml(webview, extensionUri) {
    const nonce = getNonce();
    const asset = (...p) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', ...p));
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
      position: fixed; bottom: 10px; left: 10px; font: 11px/1.5 monospace; color: #ddd;
      text-shadow: 0 1px 2px #000; z-index: 10;
    }
    .sw { display: inline-block; width: 10px; height: 10px; margin-right: 5px; vertical-align: middle; }
  </style>
</head>
<body>
  <canvas id="c"></canvas>
  <div id="hud">loading…</div>
  <div id="legend">
    <div><span class="sw" style="background:#2f7fff"></span>fan ON (M106 S255)</div>
    <div><span class="sw" style="background:#ff5a3c"></span>fan OFF (M107)</div>
    <div><span class="sw" style="background:#555"></span>travel move</div>
  </div>
  <script nonce="${nonce}" src="${threeUri}"></script>
  <script nonce="${nonce}" src="${orbitUri}"></script>
  <script nonce="${nonce}" src="${mainUri}"></script>
</body>
</html>`;
}
//# sourceMappingURL=extension.js.map