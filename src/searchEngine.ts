export interface SearchMatch {
  line: number; // 0-based line number
  startCol: number;
  endCol: number;
  before: string;
  matchText: string;
  after: string;
}

export interface FileResult {
  uri: string;
  relativePath: string;
  fileName: string;
  titleMatch: boolean;
  titleBefore: string;
  titleMatchText: string;
  titleAfter: string;
  matches: SearchMatch[];
  exactPhraseMatch: boolean;
  score: number;
  mtime: number; // ms since epoch, from FileInput.mtime
}

export interface FileInput {
  uri: string;
  relativePath: string;
  text: string;
  mtime: number; // ms since epoch (last modified)
}

export interface ParsedQuery {
  freeTerms: string[];
  excludedTerms: string[];
  pathFilters: string[];
  fileFilters: string[];
  tagFilters: string[];
  lineGroups: string[][];
  sectionFilters: string[];
  propertyFilters: { key: string; value?: string }[];
}

const CONTEXT_RADIUS = 60;

function stripQuotes(token: string): string {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Extracts `line:(...)` / `section:(...)` groups (which may contain spaces)
 * before generic whitespace tokenizing splits them apart.
 */
function extractParenGroups(raw: string, prefix: string): { groups: string[]; rest: string } {
  const groups: string[] = [];
  let rest = '';
  let i = 0;
  while (i < raw.length) {
    if (raw.startsWith(prefix, i) && raw[i + prefix.length] === '(') {
      const start = i + prefix.length + 1;
      const end = raw.indexOf(')', start);
      if (end !== -1) {
        groups.push(raw.slice(start, end));
        i = end + 1;
        continue;
      }
    }
    rest += raw[i];
    i++;
  }
  return { groups, rest };
}

export function parseQuery(raw: string): ParsedQuery {
  const parsed: ParsedQuery = {
    freeTerms: [],
    excludedTerms: [],
    pathFilters: [],
    fileFilters: [],
    tagFilters: [],
    lineGroups: [],
    sectionFilters: [],
    propertyFilters: [],
  };

  let remaining = raw;

  const lineExtract = extractParenGroups(remaining, 'line:');
  for (const g of lineExtract.groups) {
    parsed.lineGroups.push(g.trim().split(/\s+/).filter(Boolean));
  }
  remaining = lineExtract.rest;

  const sectionExtract = extractParenGroups(remaining, 'section:');
  for (const g of sectionExtract.groups) {
    parsed.sectionFilters.push(g.trim());
  }
  remaining = sectionExtract.rest;

  const tokens = remaining.match(/-?"[^"]*"|\[[^\]]*\]|\S+/g) || [];

  for (const rawToken of tokens) {
    if (rawToken.startsWith('-') && rawToken.length > 1) {
      const excluded = stripQuotes(rawToken.slice(1));
      if (excluded) parsed.excludedTerms.push(excluded);
      continue;
    }

    if (rawToken.startsWith('[') && rawToken.endsWith(']')) {
      const inner = rawToken.slice(1, -1);
      const colonIdx = inner.indexOf(':');
      if (colonIdx === -1) {
        parsed.propertyFilters.push({ key: inner.trim().toLowerCase() });
      } else {
        parsed.propertyFilters.push({
          key: inner.slice(0, colonIdx).trim().toLowerCase(),
          value: inner.slice(colonIdx + 1).trim(),
        });
      }
      continue;
    }

    const lower = rawToken.toLowerCase();
    if (lower.startsWith('path:')) {
      parsed.pathFilters.push(stripQuotes(rawToken.slice(5)));
      continue;
    }
    if (lower.startsWith('file:')) {
      parsed.fileFilters.push(stripQuotes(rawToken.slice(5)));
      continue;
    }
    if (lower.startsWith('tag:')) {
      let v = stripQuotes(rawToken.slice(4));
      if (v.startsWith('#')) v = v.slice(1);
      parsed.tagFilters.push(v);
      continue;
    }
    if (lower.startsWith('line:')) {
      const v = stripQuotes(rawToken.slice(5));
      if (v) parsed.lineGroups.push([v]);
      continue;
    }
    if (lower.startsWith('section:')) {
      const v = stripQuotes(rawToken.slice(8));
      if (v) parsed.sectionFilters.push(v);
      continue;
    }

    const stripped = stripQuotes(rawToken);
    if (stripped) parsed.freeTerms.push(stripped);
  }

  return parsed;
}

function indexOfAll(haystack: string, needle: string, caseSensitive: boolean): number[] {
  if (!needle) return [];
  const h = caseSensitive ? haystack : haystack.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  const result: number[] = [];
  let from = 0;
  while (true) {
    const idx = h.indexOf(n, from);
    if (idx === -1) break;
    result.push(idx);
    from = idx + n.length;
  }
  return result;
}

function contains(haystack: string, needle: string, caseSensitive: boolean): boolean {
  if (!needle) return true;
  if (caseSensitive) return haystack.includes(needle);
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function baseName(relativePath: string): string {
  const parts = relativePath.split(/[\\/]/);
  const last = parts[parts.length - 1] || relativePath;
  return last.replace(/\.[^./\\]+$/, '');
}

function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(text);
  if (!m) return {};
  const result: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const km = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (km) result[km[1].toLowerCase()] = km[2].trim();
  }
  return result;
}

function computeHeadingPerLine(lines: string[]): string[] {
  const result: string[] = [];
  let current = '';
  for (const line of lines) {
    const hm = /^#{1,6}\s+(.*)$/.exec(line);
    if (hm) current = hm[1].trim();
    result.push(current);
  }
  return result;
}

function buildContext(lineText: string, start: number, end: number): { before: string; matchText: string; after: string } {
  const contextStart = Math.max(0, start - CONTEXT_RADIUS);
  const contextEnd = Math.min(lineText.length, end + CONTEXT_RADIUS);
  let before = lineText.slice(contextStart, start);
  let after = lineText.slice(end, contextEnd);
  if (contextStart > 0) before = '…' + before.trimStart();
  if (contextEnd < lineText.length) after = after.trimEnd() + '…';
  return { before, matchText: lineText.slice(start, end), after };
}

export function search(
  parsed: ParsedQuery,
  files: FileInput[],
  caseSensitive: boolean
): FileResult[] {
  const results: FileResult[] = [];

  for (const file of files) {
    const fileName = baseName(file.relativePath);

    if (parsed.pathFilters.some((f) => !contains(file.relativePath, f, caseSensitive))) continue;
    if (parsed.fileFilters.some((f) => !contains(fileName, f, caseSensitive))) continue;
    if (parsed.excludedTerms.some((t) => contains(fileName, t, caseSensitive) || contains(file.text, t, caseSensitive))) continue;

    const frontmatter = parseFrontmatter(file.text);

    if (parsed.tagFilters.length > 0) {
      const fmTags = frontmatter['tags'] || '';
      const tagsOk = parsed.tagFilters.every((tag) => {
        const inBody = new RegExp(`#${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|$)`, caseSensitive ? '' : 'i').test(file.text);
        const inFm = contains(fmTags, tag, caseSensitive);
        return inBody || inFm;
      });
      if (!tagsOk) continue;
    }

    if (parsed.propertyFilters.length > 0) {
      const propsOk = parsed.propertyFilters.every((p) => {
        const val = frontmatter[p.key];
        if (val === undefined) return false;
        if (p.value === undefined) return true;
        return contains(val, p.value, caseSensitive);
      });
      if (!propsOk) continue;
    }

    const lines = file.text.split(/\r?\n/);
    const headingPerLine = parsed.sectionFilters.length > 0 ? computeHeadingPerLine(lines) : null;

    const lineAllowed = (lineIdx: number): boolean => {
      if (!headingPerLine) return true;
      const heading = headingPerLine[lineIdx];
      return parsed.sectionFilters.some((sf) => contains(heading, sf, caseSensitive));
    };

    if (parsed.lineGroups.length > 0) {
      const groupsSatisfied = parsed.lineGroups.every((group) =>
        lines.some((line, idx) => lineAllowed(idx) && group.every((term) => contains(line, term, caseSensitive)))
      );
      if (!groupsSatisfied) continue;
    }

    const titleMatchTerm = parsed.freeTerms.find((term) => contains(fileName, term, caseSensitive));
    const titleMatch = !!titleMatchTerm;

    if (parsed.freeTerms.length > 0) {
      const allTermsPresent = parsed.freeTerms.every((term) => {
        if (contains(fileName, term, caseSensitive)) return true;
        return lines.some((line, idx) => lineAllowed(idx) && contains(line, term, caseSensitive));
      });
      if (!allTermsPresent) continue;
    }

    const matches: SearchMatch[] = [];
    const normalizeTerm = (t: string) => (caseSensitive ? t : t.toLowerCase());
    const distinctFreeTerms = new Set(parsed.freeTerms.map(normalizeTerm));
    const highlightTerms = [
      ...parsed.freeTerms.map((term) => ({ term, isFree: true })),
      ...parsed.tagFilters.map((t) => ({ term: '#' + t, isFree: false })),
      ...parsed.lineGroups.flat().map((term) => ({ term, isFree: false })),
    ];

    // A multi-term free-text query (e.g. "token oscuro") should rank files where the
    // terms appear together as a phrase above files where they only matched separately.
    // exactPhraseMatch tracks whether some merged match group (see below) covers every
    // distinct free term at once. With 0-1 free terms there's nothing to distinguish.
    let exactPhraseMatch = distinctFreeTerms.size <= 1;

    if (highlightTerms.length > 0) {
      lines.forEach((line, idx) => {
        if (!lineAllowed(idx)) return;

        const ranges: { start: number; end: number; term: string; isFree: boolean }[] = [];
        for (const { term, isFree } of highlightTerms) {
          for (const start of indexOfAll(line, term, caseSensitive)) {
            ranges.push({ start, end: start + term.length, term, isFree });
          }
        }
        if (ranges.length === 0) return;

        ranges.sort((a, b) => a.start - b.start || a.end - b.end);

        // Merge ranges that overlap or touch (with only whitespace between them):
        // a multi-word query like "Jose Servet" tokenizes into two free terms that
        // each match separately, but when they occur next to each other in the text
        // that's one phrase occurrence, not two overlapping snippet cards for the
        // same spot.
        const merged: { start: number; end: number; freeTermsSeen: Set<string> }[] = [];
        for (const r of ranges) {
          const last = merged[merged.length - 1];
          if (last && (r.start <= last.end || !line.slice(last.end, r.start).trim())) {
            last.end = Math.max(last.end, r.end);
            if (r.isFree) last.freeTermsSeen.add(normalizeTerm(r.term));
          } else {
            merged.push({
              start: r.start,
              end: r.end,
              freeTermsSeen: new Set(r.isFree ? [normalizeTerm(r.term)] : []),
            });
          }
        }

        for (const r of merged) {
          if (r.freeTermsSeen.size === distinctFreeTerms.size) exactPhraseMatch = true;
          const ctx = buildContext(line, r.start, r.end);
          matches.push({ line: idx, startCol: r.start, endCol: r.end, ...ctx });
        }
      });
    }

    matches.sort((a, b) => a.line - b.line || a.startCol - b.startCol);

    if (
      parsed.freeTerms.length === 0 &&
      parsed.lineGroups.length === 0 &&
      parsed.tagFilters.length === 0 &&
      matches.length === 0 &&
      !titleMatch &&
      (parsed.pathFilters.length > 0 ||
        parsed.fileFilters.length > 0 ||
        parsed.propertyFilters.length > 0 ||
        parsed.excludedTerms.length > 0)
    ) {
      // Pure filter query (path:/file:/[property]/-term) with no free terms: include file as a bare match.
    } else if (!titleMatch && matches.length === 0) {
      continue;
    }

    let titleBefore = '';
    let titleMatchText = '';
    let titleAfter = fileName;
    if (titleMatch && titleMatchTerm) {
      const idx = caseSensitive
        ? fileName.indexOf(titleMatchTerm)
        : fileName.toLowerCase().indexOf(titleMatchTerm.toLowerCase());
      if (idx !== -1) {
        titleBefore = fileName.slice(0, idx);
        titleMatchText = fileName.slice(idx, idx + titleMatchTerm.length);
        titleAfter = fileName.slice(idx + titleMatchTerm.length);
      }
    }

    const score = (titleMatch ? 1 : 0) + matches.length;

    results.push({
      uri: file.uri,
      relativePath: file.relativePath,
      fileName,
      titleMatch,
      titleBefore,
      titleMatchText,
      titleAfter,
      matches,
      exactPhraseMatch,
      score,
      mtime: file.mtime,
    });
  }

  return results;
}
