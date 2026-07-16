# Obsidian-like Search

Extensión local de VS Code que añade un panel de búsqueda de texto completo estilo Obsidian para bóvedas de notas Markdown. Funciona totalmente offline y se instala en el perfil **"Obsidian like"**, junto al resto de extensiones de la suite (`obsidianlike`, `obsidianlike_tasks`, `obsidianlike_clearunusedimages`, `obsidianlike_calendar`).

## Uso

Abre el panel desde el icono de búsqueda en la barra de actividad, o con el comando **"Obsidian-like Search: Abrir búsqueda"** (`obsidianlikeSearch.open`). Los resultados se actualizan en vivo según se escribe, sin necesidad de pulsar Enter (Enter fuerza la búsqueda al instante y la guarda en el historial).

Mientras el cuadro de búsqueda está vacío se muestran siempre el resumen de sintaxis y el historial de búsquedas recientes; en cuanto se escribe algo, ambos se ocultan y aparecen los resultados. Cada entrada del historial (hasta 15, sin duplicados) se puede volver a ejecutar con un clic o eliminar con su botón `✕`.

### Sintaxis de búsqueda

| Operador | Efecto |
|---|---|
| `palabra` / `"frase exacta"` | Término libre: debe aparecer en el nombre de archivo o en el contenido. |
| `path:carpeta` | Filtra por ruta relativa del archivo. |
| `file:nombre` | Filtra por nombre de archivo (sin extensión). |
| `tag:nombre` | Filtra por etiqueta `#nombre` en el cuerpo o `tags:` en el frontmatter. |
| `line:(uno dos)` | Los términos deben coincidir en la misma línea. |
| `section:(encabezado)` | Restringe la búsqueda a líneas bajo un encabezado que contenga ese texto. |
| `[propiedad]` / `[propiedad:valor]` | Filtra por una propiedad del frontmatter YAML. |

Todos los términos y filtros se combinan con lógica AND. Los resultados se agrupan por archivo, con fragmentos de contexto resaltados que se pueden expandir/colapsar. Las notas cuyo **nombre de archivo** coincide con la búsqueda aparecen siempre primero, antes que las que solo coinciden en el contenido, sea cual sea el orden elegido.

Si buscas varias palabras (p. ej. `Jose Servet`) y aparecen juntas en el texto, se muestran como **una sola** coincidencia con todo el fragmento resaltado, en vez de una tarjeta separada por cada palabra.

Al hacer clic en un resultado, si tienes instalada la extensión **Obsidian-like** (`../obsidianlike`), el archivo se abre con su editor personalizado (el mismo render "WYSIWYG" que usa esa extensión) en lugar del editor de texto plano de VS Code. Si no está instalada, se abre con el editor de texto normal, seleccionando el fragmento exacto.

Botones de la barra de búsqueda: `Aa` alterna sensibilidad a mayúsculas/minúsculas, `✕` limpia la búsqueda, `⚙` muestra/oculta el resumen de sintaxis mientras hay una búsqueda en curso (en reposo se muestra siempre). Los resultados se pueden ordenar por nombre, por relevancia o por fecha de modificación del archivo (más recientes primero); en los tres modos, las coincidencias de nombre de archivo siguen yendo primero.

## Configuración

| Ajuste | Por defecto | Descripción |
|---|---|---|
| `obsidianlikeSearch.include` | `**/*.md` | Patrón glob de archivos incluidos en la búsqueda. |
| `obsidianlikeSearch.exclude` | `["**/node_modules/**", "**/.git/**", "**/.obsidian/**"]` | Lista de patrones glob de archivos y carpetas excluidos de la búsqueda (cada entrada puede apuntar a un archivo o a una carpeta, ej. `"**/Plantillas/**"`). |

## Desarrollo

```bash
npm install
npm run watch        # compila en modo watch (esbuild)
npm run check-types  # comprobación de tipos con tsc
```

Pulsa **F5** en VS Code (con este proyecto abierto) para lanzar un *Extension Development Host* con la extensión cargada.

## Compilar e instalar

```bash
npm run package
code --profile "Obsidian like" --uninstall-extension angelCastro.obsidianlike-search
code --profile "Obsidian like" --install-extension obsidianlike-search-0.0.1.vsix
```

Luego recarga la ventana de VS Code (Ctrl+Shift+P → "Developer: Reload Window").

Este proyecto también forma parte de `..\obsidianlike\make.bat`, que empaqueta y reinstala las cinco extensiones de la suite y relanza VS Code sobre la bóveda real.

## Seguridad y privacidad

Auditado (2026-07-14) en busca de llamadas de red salientes, telemetría o recolección de diagnósticos: **no hay ninguna**. La extensión funciona 100% offline.

- Sin `dependencies` en `package.json` (vacío); las `devDependencies` (`esbuild`, `typescript`, `@vscode/vsce`, `@types/*`) son solo herramientas de build y no se incluyen en el `.vsix` (ver `.vscodeignore`).
- El código fuente (`src/*.ts`) no usa `fetch`, `http`/`https`, `XMLHttpRequest`, `WebSocket` ni `child_process`; los únicos `import` son `vscode` y el módulo built-in `path`.
- El webview (`media/main.js`) solo se comunica con el extension host a través de la API sandboxed `acquireVsCodeApi()` (`postMessage`/`getState`/`setState`), y su CSP (`default-src 'none'`, sin `connect-src`) bloquearía cualquier `fetch`/XHR aunque existiera.
- Sin referencias a SDKs de telemetría o analítica (Application Insights, Sentry, PostHog, Google Analytics, etc.) ni a `vscode.env.*`/`openExternal`.
- La única integración entre procesos es local: el comando `vaultTool.openNoteAtLine` de la extensión hermana `obsidianlike` (mismo perfil de VS Code), vía `vscode.commands.executeCommand` — no sale del editor.

## Estado / pendientes

- Sin tests automatizados todavía (`src/searchEngine.ts` no depende de `vscode`, por lo que es fácil de testear de forma aislada en el futuro).
- Sin operadores OR/NOT ni búsqueda por regex; solo AND de subcadenas, como la búsqueda básica de Obsidian.
- Cada búsqueda relee y reescanea todos los archivos que coinciden con el patrón `include` (sin índice ni caché); adecuado para bóvedas de tamaño normal.
