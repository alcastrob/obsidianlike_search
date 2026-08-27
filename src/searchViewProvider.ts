import * as vscode from 'vscode';
import * as path from 'path';
import { FileInput, FileResult, SearchCancelledError, parseQuery, search } from './searchEngine';

interface SearchRequestMessage {
  command: 'search';
  query: string;
  caseSensitive: boolean;
  sort: 'name' | 'relevance' | 'date-asc' | 'date-desc';
}

interface OpenMatchMessage {
  command: 'openMatch';
  uri: string;
  line?: number;
  startCol?: number;
  endCol?: number;
}

type InboundMessage =
  | SearchRequestMessage
  | OpenMatchMessage
  | { command: 'ready' }
  | { command: 'cancelSearch' };

export class SearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'obsidianlikeSearch.searchView';

  private view?: vscode.WebviewView;
  private webviewReady = false;
  private pendingQuery: string | undefined;
  private pendingFocus = false;
  private currentSearch: AbortController | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.webviewReady = false;

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
      } else if (message.command === 'cancelSearch') {
        this.handleCancelSearch();
      } else if (message.command === 'ready') {
        this.webviewReady = true;
        this.flushPendingQuery();
        if (this.pendingFocus) {
          this.pendingFocus = false;
          this.view?.webview.postMessage({ command: 'focus' });
        }
      }
    });

    // El panel arranca visible en cuanto se resuelve (el usuario acaba de
    // seleccionarlo en la activity bar), así que pedimos el foco ya mismo.
    // sendFocus() lo encola si el script del webview aún no ha mandado
    // 'ready' (misma carrera que pendingQuery evita para runQuery).
    this.sendFocus();

    // Selecciones posteriores del icono (con el panel ya cargado, sin pasar
    // por 'ready' de nuevo) llegan aquí como cambios de visibilidad.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendFocus();
      }
    });
  }

  public focusInput(): void {
    this.view?.show(true);
    this.sendFocus();
  }

  private sendFocus(): void {
    if (this.webviewReady && this.view) {
      this.view.webview.postMessage({ command: 'focus' });
    } else {
      this.pendingFocus = true;
    }
  }

  /**
   * Carga `query` en el cuadro de búsqueda y ejecuta la búsqueda, revelando el
   * panel si hace falta. Usado por otras extensiones "Obsidian like" (p.ej.
   * obsidianlike-links) a través del comando `obsidianlikeSearch.searchFor`.
   * Si el webview aún no ha terminado de cargar (primera vez que se revela),
   * la query se guarda y se envía en cuanto llega su mensaje "ready" — un
   * `postMessage` antes de eso se perdería porque el script todavía no está
   * escuchando.
   */
  public runQuery(query: string): void {
    this.pendingQuery = query;
    this.view?.show(true);
    this.flushPendingQuery();
  }

  private flushPendingQuery(): void {
    if (this.webviewReady && this.view && this.pendingQuery !== undefined) {
      this.view.webview.postMessage({ command: 'setQuery', query: this.pendingQuery });
      this.pendingQuery = undefined;
    }
  }

  /**
   * Aborta la búsqueda del botón "Cancelar" del webview (visible junto al
   * spinner de #loadingIndicator mientras una búsqueda está en curso). El
   * propio `search()` de searchEngine comprueba `signal.aborted` entre
   * archivos y lanza SearchCancelledError, que handleSearch atrapa sin
   * enviar 'results' — el webview ya se ha limpiado localmente al pulsar el
   * botón (ver cancelSearchBtn en main.js), así que aquí no hace falta
   * responder nada.
   */
  private handleCancelSearch(): void {
    this.currentSearch?.abort();
  }

  private async handleSearch(message: SearchRequestMessage): Promise<void> {
    if (!this.view) return;

    // Una nueva búsqueda (nueva pulsación de tecla tras el debounce, cambio de
    // orden/mayúsculas, o el botón "Cancelar") siempre invalida cualquier
    // búsqueda anterior todavía en curso.
    this.currentSearch?.abort();
    const controller = new AbortController();
    this.currentSearch = controller;

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
      if (controller.signal.aborted) return;
      this.view.webview.postMessage({ command: 'error', message: String(err) });
      return;
    }
    if (controller.signal.aborted) return;

    const parsed = parseQuery(trimmed);
    let results: FileResult[];
    try {
      results = await search(parsed, files, message.caseSensitive, { signal: controller.signal });
    } catch (err) {
      if (err instanceof SearchCancelledError) return;
      this.view.webview.postMessage({ command: 'error', message: String(err) });
      return;
    }
    if (controller.signal.aborted) return;

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
    } else if (message.sort === 'date-desc') {
      results.sort(
        (a, b) =>
          Number(b.titleMatch) - Number(a.titleMatch) ||
          Number(b.exactPhraseMatch) - Number(a.exactPhraseMatch) ||
          b.mtime - a.mtime ||
          a.fileName.localeCompare(b.fileName)
      );
    } else if (message.sort === 'date-asc') {
      results.sort(
        (a, b) =>
          Number(b.titleMatch) - Number(a.titleMatch) ||
          Number(b.exactPhraseMatch) - Number(a.exactPhraseMatch) ||
          a.mtime - b.mtime ||
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
    <button id="cancelSearchBtn" class="text-btn cancel-btn" title="Cancelar búsqueda">Cancelar</button>
  </div>

  <div id="idlePanel">
    <div id="historyPanel" class="history-panel">
      <div class="options-title">Búsquedas recientes</div>
      <div id="historyList" class="history-list"></div>
    </div>

    <div id="optionsPanel" class="options-panel">
      <div class="options-title">Opciones de búsqueda</div>
      <div class="option-row"><code>-término</code><span>excluir resultados que lo contengan</span></div>
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
      <option value="date-desc">Ordenar por fecha de modificación (más reciente primero)</option>
      <option value="date-asc">Ordenar por fecha de modificación (más antigua primero)</option>
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
