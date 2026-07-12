(function () {
  const vscode = acquireVsCodeApi();

  const searchInput = document.getElementById('searchInput');
  const caseToggle = document.getElementById('caseToggle');
  const clearBtn = document.getElementById('clearBtn');
  const optionsToggle = document.getElementById('optionsToggle');
  const optionsPanel = document.getElementById('optionsPanel');
  const resultsHeader = document.getElementById('resultsHeader');
  const resultsCount = document.getElementById('resultsCount');
  const sortSelect = document.getElementById('sortSelect');
  const resultsContainer = document.getElementById('resultsContainer');

  const DEBOUNCE_MS = 200;

  const state = {
    caseSensitive: false,
    collapsed: new Set(),
  };

  let debounceTimer = null;

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function runSearch() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    const query = searchInput.value;
    if (!query.trim()) {
      resultsContainer.innerHTML = '';
      resultsHeader.classList.add('hidden');
      return;
    }
    vscode.postMessage({
      command: 'search',
      query,
      caseSensitive: state.caseSensitive,
      sort: sortSelect.value,
    });
  }

  function scheduleSearch() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, DEBOUNCE_MS);
  }

  searchInput.addEventListener('input', () => {
    if (!searchInput.value.trim()) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      resultsContainer.innerHTML = '';
      resultsHeader.classList.add('hidden');
      return;
    }
    scheduleSearch();
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      runSearch();
    }
  });

  caseToggle.addEventListener('click', () => {
    state.caseSensitive = !state.caseSensitive;
    caseToggle.classList.toggle('active', state.caseSensitive);
    if (searchInput.value.trim()) runSearch();
  });

  clearBtn.addEventListener('click', () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    searchInput.value = '';
    resultsContainer.innerHTML = '';
    resultsHeader.classList.add('hidden');
    searchInput.focus();
  });

  optionsToggle.addEventListener('click', () => {
    optionsPanel.classList.toggle('hidden');
  });

  sortSelect.addEventListener('change', () => {
    if (searchInput.value.trim()) runSearch();
  });

  function renderTitle(file) {
    if (!file.titleMatch) return escapeHtml(file.fileName);
    return (
      escapeHtml(file.titleBefore) +
      '<mark>' +
      escapeHtml(file.titleMatchText) +
      '</mark>' +
      escapeHtml(file.titleAfter)
    );
  }

  function renderSnippet(match) {
    return (
      escapeHtml(match.before) +
      '<mark>' +
      escapeHtml(match.matchText) +
      '</mark>' +
      escapeHtml(match.after)
    );
  }

  function renderResults(payload) {
    resultsContainer.innerHTML = '';

    if (payload.files.length === 0) {
      resultsHeader.classList.add('hidden');
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No se han encontrado resultados.';
      resultsContainer.appendChild(empty);
      return;
    }

    resultsHeader.classList.remove('hidden');
    resultsCount.textContent = payload.total + (payload.total === 1 ? ' resultado' : ' resultados');

    for (const file of payload.files) {
      const group = document.createElement('div');
      group.className = 'file-group';

      const header = document.createElement('div');
      header.className = 'file-header';

      const hasChildren = file.matches.length > 0;
      const collapsed = state.collapsed.has(file.uri);

      let chevronHtml = '';
      if (hasChildren) {
        chevronHtml = '<span class="chevron' + (collapsed ? ' collapsed' : '') + '">▾</span>';
      } else {
        chevronHtml = '<span class="chevron"></span>';
      }

      header.innerHTML =
        chevronHtml +
        '<span class="file-name" title="' + escapeHtml(file.relativePath) + '">' + renderTitle(file) + '</span>' +
        (hasChildren ? '<span class="match-count">' + file.matches.length + '</span>' : '');

      header.addEventListener('click', () => {
        if (hasChildren) {
          if (state.collapsed.has(file.uri)) {
            state.collapsed.delete(file.uri);
          } else {
            state.collapsed.add(file.uri);
          }
          renderResults(payload);
        } else {
          vscode.postMessage({ command: 'openMatch', uri: file.uri });
        }
      });

      group.appendChild(header);

      if (hasChildren && !collapsed) {
        const snippets = document.createElement('div');
        snippets.className = 'snippets';
        for (const match of file.matches) {
          const card = document.createElement('div');
          card.className = 'snippet-card';
          card.innerHTML = renderSnippet(match);
          card.addEventListener('click', () => {
            vscode.postMessage({
              command: 'openMatch',
              uri: file.uri,
              line: match.line,
              startCol: match.startCol,
              endCol: match.endCol,
            });
          });
          snippets.appendChild(card);
        }
        group.appendChild(snippets);
      }

      resultsContainer.appendChild(group);
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.command === 'results') {
      renderResults(message);
    } else if (message.command === 'error') {
      resultsContainer.innerHTML = '';
      resultsHeader.classList.add('hidden');
      const err = document.createElement('div');
      err.className = 'error-state';
      err.textContent = 'Error: ' + message.message;
      resultsContainer.appendChild(err);
    } else if (message.command === 'focus') {
      searchInput.focus();
      searchInput.select();
    }
  });

  vscode.postMessage({ command: 'ready' });
})();
