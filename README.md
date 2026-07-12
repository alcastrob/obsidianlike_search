# Obsidian-like Search

Extensión local de VS Code que añade un panel de búsqueda de texto completo estilo Obsidian para bóvedas de notas Markdown. Funciona totalmente offline y se instala en el perfil **"Obsidian like"**, junto al resto de extensiones de la suite (`obsidianlike`, `obsidianlike_tasks`, `obsidianlike_clearunusedimages`, `obsidianlike_calendar`).

## Uso

Abre el panel desde el icono de búsqueda en la barra de actividad, o con el comando **"Obsidian-like Search: Abrir búsqueda"** (`obsidianlikeSearch.open`). Escribe la consulta y pulsa Enter.

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

Todos los términos y filtros se combinan con lógica AND. Los resultados se agrupan por archivo, con fragmentos de contexto resaltados que se pueden expandir/colapsar y abrir directamente en el editor.

Botones de la barra de búsqueda: `Aa` alterna sensibilidad a mayúsculas/minúsculas, `✕` limpia la búsqueda, `⚙` muestra un resumen de la sintaxis disponible. Los resultados se pueden ordenar por nombre o por relevancia.

## Configuración

| Ajuste | Por defecto | Descripción |
|---|---|---|
| `obsidianlikeSearch.include` | `**/*.md` | Patrón glob de archivos incluidos en la búsqueda. |
| `obsidianlikeSearch.exclude` | `**/{node_modules,.git,.obsidian}/**` | Patrón glob de archivos/carpetas excluidos. |

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

## Estado / pendientes

- Sin tests automatizados todavía (`src/searchEngine.ts` no depende de `vscode`, por lo que es fácil de testear de forma aislada en el futuro).
- Sin operadores OR/NOT ni búsqueda por regex; solo AND de subcadenas, como la búsqueda básica de Obsidian.
- Cada búsqueda relee y reescanea todos los archivos que coinciden con el patrón `include` (sin índice ni caché); adecuado para bóvedas de tamaño normal.
