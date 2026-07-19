import * as vscode from 'vscode';
import * as path from 'path';
import { FileInput, FileResult, parseQuery, search } from './searchEngine';

interface SearchRequestMessage {
  command: 'search';
  query: string;
  caseSensitive: boolean;
  sort: 'name' | 'relevance' | 'date';
}

interface OpenMatchMessage {
  command: 'openMatch';
  uri: string;
  line?: number;
  startCol?: number;
  endCol?: number;
}

type InboundMessage = SearchRequestMessage | OpenMatchMessage | { command: 'ready' };

export class SearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'obsidianlikeSearch.searchView';

  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: InboundMessage) => {
      if (message.command === 'search') {
        await this.handleSearch(message);
      } else if (message.command === 'openMatch') {
        await this.handleOpenMatch(message);
      }
    });
  }

  public focusInput(): void {
    this.view?.show(true);
    this.view?.webview.postMessage({ command: 'focus' });
  }

  private async handleSearch(message: SearchRequestMessage): Promise<void> {
    if (!this.view) return;

    const config = vscode.workspace.getConfiguration('obsidianlikeSearch');
    const include = config.get<string>('include', '**/*.md');
    const excludePatterns = config.get<string[]>('exclude', [
      '**/node_modules/**',
      '**/.git/**',
      '**/.obsidian/**',
    ]);
    const exclude =
      excludePatterns.length === 0
        ? undefined
        : excludePatterns.length === 1
          ? excludePatterns[0]
          : `{${excludePatterns.join(',')}}`;

    const trimmed = message.query.trim();
    if (!trimmed) {
      this.view.webview.postMessage({ command: 'results', total: 0, files: [] });
      return;
    }

    let files: FileInput[];
    try {
      const uris = await vscode.workspace.findFiles(include, exclude);
      files = await Promise.all(
        uris.map(async (uri) => {
          const [bytes, stat] = await Promise.all([
            vscode.workspace.fs.readFile(uri),
            vscode.workspace.fs.stat(uri),
          ]);
          const text = Buffer.from(bytes).toString('utf8');
          const relativePath = vscode.workspace.asRelativePath(uri, true);
          return { uri: uri.toString(), relativePath, text, mtime: stat.mtime };
        })
      );
    } catch (err) {
      this.view.webview.postMessage({ command: 'error', message: String(err) });
      return;
    }

    const parsed = parseQuery(trimmed);
    let results = search(parsed, files, message.caseSensitive);

    // Filename matches always lead, regardless of the chosen sort mode — that's the
    // result the user is almost always looking for when they typed the query. Next,
    // for multi-word free-text queries, files where all terms occur together as a
    // phrase (exactPhraseMatch) lead over files that only matched the terms separately
    // — the chosen sort mode is the tiebreaker within each of those two groups.
    if (message.sort === 'relevance') {
      results.sort(
        (a, b) =>
          Number(b.titleMatch) - Number(a.titleMatch) ||
          Number(b.exactPhraseMatch) - Number(a.exactPhraseMatch) ||
          b.score - a.score ||
          a.fileName.localeCompare(b.fileName)
      );
    } else if (message.sort === 'date') {
      results.sort(
        (a, b) =>
          Number(b.titleMatch) - Number(a.titleMatch) ||
          Number(b.exactPhraseMatch) - Number(a.exactPhraseMatch) ||
          b.mtime - a.mtime ||
          a.fileName.localeCompare(b.fileName)
      );
    } else {
      results.sort(
        (a, b) =>
          Number(b.titleMatch) - Number(a.titleMatch) ||
          Number(b.exactPhraseMatch) - Number(a.exactPhraseMatch) ||
          a.fileName.localeCompare(b.fileName) ||
          a.relativePath.localeCompare(b.relativePath)
      );
    }

    const total = results.reduce((sum, r) => sum + r.score, 0);

    this.view.webview.postMessage({
      command: 'results',
      total,
      files: results,
    });
  }

  private async handleOpenMatch(message: OpenMatchMessage): Promise<void> {
    try {
      const uri = vscode.Uri.parse(message.uri);

      // Soft dependency on angelCastro.obsidianlike (same "Obsidian like" profile):
      // when present, open results in its custom rendered editor instead of the
      // plain text editor. `vaultTool.openNoteAtLine` only knows about the line
      // (matching the granularity of its own wikilink/heading navigation), not the
      // column, so it's called whenever we have a line and falls back to the plain
      // text editor (with exact column selection) otherwise.
      const commands = await vscode.commands.getCommands(true);
      if (commands.includes('vaultTool.openNoteAtLine')) {
        await vscode.commands.executeCommand('vaultTool.openNoteAtLine', uri, message.line);
        return;
      }

      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });

      if (typeof message.line === 'number') {
        const startCol = message.startCol ?? 0;
        const endCol = message.endCol ?? startCol;
        const lineCount = doc.lineCount;
        const line = Math.min(message.line, Math.max(0, lineCount - 1));
        const lineLength = doc.lineAt(line).text.length;
        const range = new vscode.Range(
          line,
          Math.min(startCol, lineLength),
          line,
          Math.min(endCol, lineLength)
        );
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`No se pudo abrir el archivo: ${err}`);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Búsqueda</title>
</head>
<body>
  <div class="search-box-row">
    <span class="icon icon-search" aria-hidden="true"></span>
    <input id="searchInput" type="text" placeholder="Escriba para empezar a buscar" autocomplete="off" />
    <button id="caseToggle" class="text-btn" title="Coincidir mayúsculas/minúsculas">Aa</button>
    <button id="clearBtn" class="icon-btn" title="Limpiar">✕</button>
    <button id="optionsToggle" class="icon-btn" title="Opciones de búsqueda">⚙</button>
  </div>

  <div id="loadingIndicator" class="loading-indicator hidden">
    <span class="spinner" aria-hidden="true"></span>
    <span>Buscando…</span>
  </div>

  <div id="idlePanel">
    <div id="historyPanel" class="history-panel">
      <div class="options-title">Búsquedas recientes</div>
      <div id="historyList" class="history-list"></div>
    </div>

    <div id="optionsPanel" class="options-panel">
      <div class="options-title">Opciones de búsqueda</div>
      <div class="option-row"><code>path:</code><span>coincidir la ruta del archivo</span></div>
      <div class="option-row"><code>file:</code><span>coincidir el nombre de archivo</span></div>
      <div class="option-row"><code>tag:</code><span>buscar por etiquetas</span></div>
      <div class="option-row"><code>line:</code><span>buscar palabras clave en la misma línea</span></div>
      <div class="option-row"><code>section:</code><span>buscar palabras clave bajo el mismo encabezado</span></div>
      <div class="option-row"><code>[propiedad]</code><span>coincidir la propiedad</span></div>
    </div>
  </div>

  <div id="resultsHeader" class="results-header hidden">
    <span id="resultsCount"></span>
    <select id="sortSelect">
      <option value="name">Ordenar por nombre</option>
      <option value="relevance">Ordenar por relevancia</option>
      <option value="date">Ordenar por fecha de modificación</option>
    </select>
  </div>

  <div id="resultsContainer" class="results-container"></div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
