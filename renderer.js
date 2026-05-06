import { createEditorFacade } from './editor-codemirror.js';
import MarkdownIt from 'markdown-it';

const starterMarkdown = '';

const editorHost = document.querySelector('#editor');
const editor = createEditorFacade(editorHost, starterMarkdown, {
  lineNumbersVisible: true
});
const preview = document.querySelector('#preview');
const previewPane = document.querySelector('.preview-pane');
const typstPreviewControls = document.querySelector('#typstPreviewControls');
const typstZoomOutButton = document.querySelector('#typstZoomOutButton');
const typstActualButton = document.querySelector('#typstActualButton');
const typstFitButton = document.querySelector('#typstFitButton');
const typstZoomInButton = document.querySelector('#typstZoomInButton');
const fileName = document.querySelector('#fileName');
const dirtyMark = document.querySelector('#dirtyMark');
const newButton = document.querySelector('#newButton');
const openButton = document.querySelector('#openButton');
const saveButton = document.querySelector('#saveButton');
const saveAsButton = document.querySelector('#saveAsButton');
const menuButton = document.querySelector('#menuButton');
const undoButton = document.querySelector('#undoButton');
const redoButton = document.querySelector('#redoButton');
const searchButton = document.querySelector('#searchButton');
const folderTreeButton = document.querySelector('#folderTreeButton');
const researchButton = document.querySelector('#researchButton');
const previewButton = document.querySelector('#previewButton');
const sidebarDivider = document.querySelector('#sidebarDivider');
const splitter = document.querySelector('#splitter');
const folderSplitter = document.querySelector('#folderSplitter');
const researchSplitter = document.querySelector('#researchSplitter');
const workspace = document.querySelector('.workspace');
const editorPane = document.querySelector('.editor-pane');
const folderTreePane = document.querySelector('#folderTreePane');
const folderTree = document.querySelector('#folderTree');
const folderUpButton = document.querySelector('#folderUpButton');
const openFolderButton = document.querySelector('#openFolderButton');
const researchPane = document.querySelector('#researchPane');
const outlineList = document.querySelector('#outlineList');
const referenceChecks = document.querySelector('#referenceChecks');
const findPanel = document.querySelector('#findPanel');
const findInput = document.querySelector('#findInput');
const replaceInput = document.querySelector('#replaceInput');
const findPreviousButton = document.querySelector('#findPreviousButton');
const findNextButton = document.querySelector('#findNextButton');
const replaceButton = document.querySelector('#replaceButton');
const replaceAllButton = document.querySelector('#replaceAllButton');
const closeFindButton = document.querySelector('#closeFindButton');
const statusBar = document.querySelector('#statusBar');
const cursorStatus = document.querySelector('#cursorStatus');
const countStatus = document.querySelector('#countStatus');
const fileTypeStatus = document.querySelector('#fileTypeStatus');

let currentPath = null;
let savedContent = starterMarkdown;
let previewVisible = false;
let fontSize = 15;
let replaceMode = false;
let autosaveTimer = null;
let autosaveReady = false;
let restoringAutosave = false;
let syncingMenuState = false;
let folderTreeVisible = false;
let researchVisible = false;
let folderRootPath = null;
let folderTreeData = null;
let folderTreeLoading = false;
let folderSplitterDragging = false;
let previewSplitterDragging = false;
let researchSplitterDragging = false;
let previewBlockAnchors = [];
let syncingScroll = false;
let previewSyncRaf = 0;
let editorSyncRaf = 0;
let typstPreviewSyncTimer = 0;
let typstEditorSyncTimer = 0;
let scrollSyncOrigin = null;
let scrollSyncOriginTimer = null;
let researchCheckRun = 0;
let documentMode = 'markdown';
let typstPreviewRenderTimer = 0;
let typstPreviewRenderJobId = 0;
let typstOutlineRequestId = 0;
let typstOutlineCacheKey = '';
let typstOutlineCache = [];
let typstDiagnosticsCacheKey = '';
let typstDiagnosticsCache = [];
let typstDiagnosticsReady = false;
let typstPreviewZoomMode = 'fit';
let typstPreviewZoomLevel = 1;
let typstPreviewHasRenderedPages = false;

const TYPST_BASE_PAGE_WIDTH = 820;

const markdownIt = new MarkdownIt({
  breaks: true,
  html: true,
  linkify: true
});

const imageLinkPattern = /\.(?:png|jpe?g|gif|webp|bmp|ico|svg)(?:[?#].*)?$/i;
const crossReferencePattern = /@((?:fig|eq):[A-Za-z0-9_.:-]+)/g;
const labeledFigurePattern = /!\[([^\]\n]*)\]\(([^)\n]+)\)\s*\{#(fig:[A-Za-z0-9_.:-]+)\}/g;
function getDirectoryPath(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex === -1 ? '' : normalized.slice(0, slashIndex);
}

function normalizePathParts(filePath) {
  const isAbsolute = filePath.startsWith('/') || /^[A-Za-z]:\//.test(filePath);
  const prefix = filePath.match(/^[A-Za-z]:\//)?.[0] || (isAbsolute ? '/' : '');
  const rest = prefix ? filePath.slice(prefix.length) : filePath;
  const parts = [];

  for (const part of rest.split('/')) {
    if (!part || part === '.') {
      continue;
    }

    if (part === '..') {
      parts.pop();
      continue;
    }

    parts.push(part);
  }

  return `${prefix}${parts.join('/')}`;
}

function pathToFileUrl(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const absolutePath = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file://${absolutePath.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

function resolveMarkdownAssetUrl(documentPath, source) {
  if (!source || typeof source !== 'string') {
    return source;
  }

  const trimmed = source.trim();

  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(trimmed) || !documentPath) {
    return source;
  }

  const normalizedSource = trimmed.replaceAll('\\', '/');
  const assetPath = normalizedSource.startsWith('/') || /^[A-Za-z]:\//.test(normalizedSource)
    ? normalizedSource
    : normalizePathParts(`${getDirectoryPath(documentPath)}/${normalizedSource}`);

  return pathToFileUrl(assetPath);
}

function getCrossReferenceDomId(label) {
  return `xref-${label.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function getCrossReferenceText(reference, prefix = '') {
  if (reference.kind === 'fig') {
    return /図\s*$/.test(prefix) ? String(reference.number) : `図 ${reference.number}`;
  }

  return /式\s*$/.test(prefix) ? `(${reference.number})` : `式 (${reference.number})`;
}

function collectCrossReferences(source) {
  const references = new Map();
  let figureNumber = 0;
  let equationNumber = 0;

  for (const match of source.matchAll(labeledFigurePattern)) {
    const label = match[3];
    if (!references.has(label)) {
      figureNumber += 1;
      references.set(label, {
        kind: 'fig',
        number: figureNumber,
        domId: getCrossReferenceDomId(label)
      });
    }
  }

  const equationPattern = /\$\$([\s\S]+?)\$\$\s*\{#(eq:[A-Za-z0-9_.:-]+)\}|\\\[([\s\S]+?)\\\]\s*\{#(eq:[A-Za-z0-9_.:-]+)\}/g;
  for (const match of source.matchAll(equationPattern)) {
    const label = match[2] || match[4];
    if (!references.has(label)) {
      equationNumber += 1;
      references.set(label, {
        kind: 'eq',
        number: equationNumber,
        domId: getCrossReferenceDomId(label)
      });
    }
  }

  return references;
}

function buildFigureHtml(alt, href, label, references) {
  const reference = references.get(label);
  const source = resolveMarkdownAssetUrl(currentPath, href);
  const safeSource = escapeHtml(source || '');
  const safeAlt = escapeHtml(alt || '');
  const caption = reference
    ? `<figcaption>図 ${reference.number}${safeAlt ? `. ${safeAlt}` : ''}</figcaption>`
    : '';
  const idAttributes = reference
    ? ` id="${escapeHtml(reference.domId)}" data-crossref-label="${escapeHtml(label)}"`
    : '';

  return `<figure class="figure-block crossref-target"${idAttributes}><img src="${safeSource}" alt="${safeAlt}">${caption}</figure>`;
}

function replaceCrossReferences(root, references) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('code, pre, a, .katex')) {
        return NodeFilter.FILTER_REJECT;
      }

      crossReferencePattern.lastIndex = 0;
      return crossReferencePattern.test(node.nodeValue)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });
  const nodes = [];

  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }

  for (const node of nodes) {
    const fragment = document.createDocumentFragment();
    const text = node.nodeValue;
    let lastIndex = 0;

    text.replace(crossReferencePattern, (match, label, offset) => {
      fragment.append(document.createTextNode(text.slice(lastIndex, offset)));

      const reference = references.get(label);
      if (reference) {
        const link = document.createElement('a');
        link.className = 'crossref-link';
        link.href = `#${reference.domId}`;
        link.textContent = getCrossReferenceText(reference, text.slice(0, offset));
        fragment.append(link);
      } else {
        const missing = document.createElement('span');
        missing.className = 'crossref-missing';
        missing.textContent = '??';
        missing.title = `Missing reference: ${label}`;
        fragment.append(missing);
      }

      lastIndex = offset + match.length;
      return match;
    });

    fragment.append(document.createTextNode(text.slice(lastIndex)));
    node.replaceWith(fragment);
  }
}

function getLineFromIndex(source, index) {
  const clippedIndex = Math.max(0, Math.min(Number(index) || 0, source.length));
  let line = 1;

  for (let i = 0; i < clippedIndex; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      continue;
    }

    if (source[i] === '\r') {
      line += 1;
      if (source[i + 1] === '\n') {
        i += 1;
      }
    }
  }

  return line;
}

function getOutlineItems(source) {
  const items = [];
  const headingPattern = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;

  for (const match of source.matchAll(headingPattern)) {
    items.push({
      level: match[1].length,
      text: match[2].replace(/\s+\{#[^}]+\}\s*$/, '').trim(),
      line: getLineFromIndex(source, match.index || 0)
    });
  }

  return items;
}

function getTypstLabelPattern() {
  return /<([A-Za-z0-9_.:-]+)>/g;
}

function getTypstReferencePattern() {
  return /@([A-Za-z0-9_.:-]+)/g;
}

function parseTypstDocument(source) {
  const lines = source.split(/\r\n|\r|\n/);
  const blocks = [];
  const headings = [];
  const labels = [];
  const usages = [];
  const references = new Map();
  let index = 0;

  const registerLabel = (label, kind, line) => {
    if (!label) {
      return;
    }

    if (!references.has(label)) {
      references.set(label, {
        kind,
        domId: getCrossReferenceDomId(label),
        line
      });
    }
  };

  const detectInlineReferences = (text, line) => {
    const pattern = getTypstReferencePattern();
    for (const match of text.matchAll(pattern)) {
      usages.push({
        label: match[1],
        line
      });
    }
  };

  const stripTrailingLabel = (text) => {
    const match = text.match(/\s*<([A-Za-z0-9_.:-]+)>\s*$/);
    if (!match) {
      return { text, label: null };
    }

    return {
      text: text.slice(0, match.index).trimEnd(),
      label: match[1]
    };
  };

  while (index < lines.length) {
    const lineNumber = index + 1;
    const rawLine = lines[index];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^(```|~~~)/.test(rawLine.trimStart())) {
      const fence = rawLine.trimStart().slice(0, 3);
      const startLine = lineNumber;
      const codeLines = [rawLine];
      index += 1;

      while (index < lines.length) {
        codeLines.push(lines[index]);
        if (lines[index].trimStart().startsWith(fence)) {
          index += 1;
          break;
        }
        index += 1;
      }

      blocks.push({
        type: 'code',
        startLine,
        endLine: index,
        text: codeLines.join('\n')
      });
      continue;
    }

    const headingMatch = rawLine.match(/^(=+)\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length);
      const { text: headingText, label } = stripTrailingLabel(headingMatch[2]);
      const startLine = lineNumber;
      const endLine = lineNumber;
      blocks.push({
        type: 'heading',
        level,
        startLine,
        endLine,
        text: headingText,
        label
      });
      headings.push({
        level,
        text: headingText,
        line: lineNumber
      });
      if (label) {
        labels.push({ label, kind: 'heading', line: lineNumber });
        registerLabel(label, 'heading', lineNumber);
      }
      detectInlineReferences(headingText, lineNumber);
      index += 1;
      continue;
    }

    const startLine = lineNumber;
    const paragraphLines = [rawLine];
    index += 1;

    while (index < lines.length) {
      const nextLine = lines[index];
      const nextTrimmed = nextLine.trim();
      if (!nextTrimmed || /^(```|~~~)/.test(nextLine.trimStart()) || /^(=+)\s+/.test(nextLine)) {
        break;
      }
      paragraphLines.push(nextLine);
      index += 1;
    }

    const text = paragraphLines.join('\n');
    const lastLine = startLine + paragraphLines.length - 1;
    const { text: paragraphText, label } = stripTrailingLabel(text);
    blocks.push({
      type: 'paragraph',
      startLine,
      endLine: lastLine,
      text: paragraphText,
      label
    });
    if (label) {
      labels.push({ label, kind: 'block', line: lastLine });
      registerLabel(label, 'block', lastLine);
    }
    detectInlineReferences(paragraphText, startLine);
  }

  return {
    blocks,
    headings,
    labels,
    usages,
    references
  };
}

function escapeTextWithTypstReferences(text, references, line) {
  const pattern = getTypstReferencePattern();
  const fragments = [];
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    fragments.push(escapeHtml(text.slice(lastIndex, match.index)));
    const label = match[1];
    const reference = references.get(label);
    if (reference) {
      fragments.push(`<a class="crossref-link" href="#${escapeHtml(reference.domId)}">@${escapeHtml(label)}</a>`);
    } else {
      fragments.push(`<span class="crossref-missing" title="Missing reference: ${escapeHtml(label)}">??</span>`);
    }
    lastIndex = (match.index || 0) + match[0].length;
  }

  fragments.push(escapeHtml(text.slice(lastIndex)));
  return fragments.join('');
}

function buildTypstPreviewHtml(parsed) {
  const htmlParts = [];
  previewBlockAnchors = [];

  for (const block of parsed.blocks) {
    let html = '';
    let idAttributes = '';

    if (block.label) {
      const reference = parsed.references.get(block.label);
      if (reference) {
        idAttributes = ` id="${escapeHtml(reference.domId)}" data-crossref-label="${escapeHtml(block.label)}"`;
      }
    }

    if (block.type === 'heading') {
      html = `<h${block.level}>${escapeTextWithTypstReferences(block.text, parsed.references, block.startLine)}</h${block.level}>`;
    } else if (block.type === 'code') {
      html = `<pre><code>${escapeHtml(block.text)}</code></pre>`;
    } else {
      const paragraphs = block.text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
      html = paragraphs.length > 1
        ? paragraphs.map((part) => `<p>${escapeTextWithTypstReferences(part, parsed.references, block.startLine)}</p>`).join('')
        : `<p>${escapeTextWithTypstReferences(block.text, parsed.references, block.startLine)}</p>`;
    }

    previewBlockAnchors.push({
      startLine: block.startLine,
      endLine: block.endLine,
      element: null
    });
    htmlParts.push(`<section class="md-block typst-block" data-source-line="${block.startLine}" data-source-end-line="${block.endLine}"${idAttributes}>${html}</section>`);
  }

  return {
    html: htmlParts.join(''),
    parsed
  };
}

function flattenTypstOutlineItems(items, depth = 1, output = []) {
  for (const item of items || []) {
    if (!item || !item.text) {
      continue;
    }

    output.push({
      level: Math.max(1, depth),
      text: String(item.text),
      line: Math.max(1, Number(item.line) || 1)
    });

    if (Array.isArray(item.children) && item.children.length > 0) {
      flattenTypstOutlineItems(item.children, depth + 1, output);
    }
  }

  return output;
}

function renderTypstOutlineItems(items) {
  return items.length > 0
    ? items.map((item) => `<button class="outline-item" type="button" data-line="${item.line}" style="--outline-level:${item.level};"><span class="outline-text">${escapeHtml(item.text)}</span><span class="outline-line">${item.line}</span></button>`).join('')
    : '<p class="research-empty">No headings yet.</p>';
}

function waitForTimeout(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildTypstReferenceChecksFromParsedDocument(parsedDocument) {
  const labels = Array.isArray(parsedDocument?.labels) ? parsedDocument.labels : [];
  const usages = Array.isArray(parsedDocument?.usages) ? parsedDocument.usages : [];
  const labelsByName = new Map();
  const usedLabels = new Set(usages.map((usage) => usage.label));
  const issues = [];

  for (const label of labels) {
    const group = labelsByName.get(label.label) || [];
    group.push(label);
    labelsByName.set(label.label, group);
  }

  for (const group of labelsByName.values()) {
    if (group.length > 1) {
      issues.push({
        type: 'duplicate',
        label: group[0].label,
        line: group[0].line,
        text: `重複ラベル: ${group[0].label}`
      });
    }
  }

  for (const usage of usages) {
    if (!parsedDocument?.references?.has(usage.label)) {
      issues.push({
        type: 'missing',
        label: usage.label,
        line: usage.line,
        text: `未定義: @${usage.label}`
      });
    }
  }

  for (const label of labels) {
    if (!usedLabels.has(label.label)) {
      issues.push({
        type: 'unused',
        label: label.label,
        line: null,
        text: `未使用: ${label.label}`
      });
    }
  }

  return {
    labels,
    usages,
    issues,
    imageSources: [],
    citationKeys: []
  };
}

function hashOutlineSource(source) {
  let hash = 5381;
  const text = String(source ?? '');

  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }

  return `${text.length}:${hash >>> 0}`;
}

function buildTypstReferenceChecksFromDiagnostics(diagnostics = []) {
  const issues = [];

  for (const diagnostic of diagnostics || []) {
    const message = String(diagnostic?.message || '');
    const missingMatch = message.match(/label `<([^>]+)>` does not exist/i);
    if (!missingMatch) {
      continue;
    }

    issues.push({
      type: 'missing',
      label: missingMatch[1],
      line: Number(diagnostic?.range?.start?.line || 0) + 1,
      text: `未定義: @${missingMatch[1]}`
    });
  }

  return {
    labels: [],
    usages: [],
    issues,
    imageSources: [],
    citationKeys: []
  };
}

function buildTypstPageAnchors(pageElements, totalLines) {
  const count = pageElements.length;
  if (count === 0) {
    return [];
  }

  const anchors = [];
  let previousEnd = 1;

  for (let index = 0; index < count; index += 1) {
    const startLine = index === 0
      ? 1
      : previousEnd + 1;
    const endLine = index === count - 1
      ? totalLines
      : Math.max(startLine, Math.round(((index + 1) * totalLines) / count));
    previousEnd = endLine;
    anchors.push({
      startLine,
      endLine,
      element: pageElements[index]
    });
  }

  return anchors;
}

function clampTypstZoomLevel(value) {
  return Math.max(0.5, Math.min(3, Number(value) || 1));
}

function getTypstFitWidth() {
  const availableWidth = Math.max(320, previewPane.clientWidth - 56);
  return Math.max(320, availableWidth);
}

function getTypstCurrentPageWidth() {
  if (!typstPreviewHasRenderedPages) {
    return TYPST_BASE_PAGE_WIDTH;
  }

  if (typstPreviewZoomMode === 'fit') {
    return getTypstFitWidth();
  }

  return Math.round(TYPST_BASE_PAGE_WIDTH * typstPreviewZoomLevel);
}

function syncTypstPreviewControls() {
  const isTypstMode = documentMode === 'typst';
  const controlsVisible = isTypstMode && previewVisible;

  if (typstPreviewControls) {
    typstPreviewControls.hidden = !controlsVisible;
  }

  const hasPages = controlsVisible && typstPreviewHasRenderedPages;
  for (const button of [typstZoomOutButton, typstActualButton, typstFitButton, typstZoomInButton]) {
    if (button) {
      button.disabled = !hasPages;
    }
  }

  if (typstFitButton) {
    typstFitButton.classList.toggle('active', hasPages && typstPreviewZoomMode === 'fit');
  }

  if (typstActualButton) {
    typstActualButton.classList.toggle('active', hasPages && typstPreviewZoomMode !== 'fit' && Math.abs(typstPreviewZoomLevel - 1) < 0.001);
    typstActualButton.title = `100% (${Math.round(typstPreviewZoomLevel * 100)}%)`;
    typstActualButton.setAttribute('aria-label', typstActualButton.title);
  }

  if (typstZoomOutButton) {
    typstZoomOutButton.title = hasPages ? 'Zoom out' : 'Typst preview unavailable';
    typstZoomOutButton.setAttribute('aria-label', typstZoomOutButton.title);
  }

  if (typstZoomInButton) {
    typstZoomInButton.title = hasPages ? 'Zoom in' : 'Typst preview unavailable';
    typstZoomInButton.setAttribute('aria-label', typstZoomInButton.title);
  }
}

function applyTypstPreviewScale() {
  if (!typstPreviewHasRenderedPages) {
    syncTypstPreviewControls();
    return;
  }

  const targetWidth = getTypstCurrentPageWidth();
  preview.querySelectorAll('.typst-page').forEach((page) => {
    page.style.width = `${Math.max(320, Math.round(targetWidth))}px`;
  });
  syncTypstPreviewControls();
}

function setTypstPreviewZoomMode(mode, { persist = true } = {}) {
  const safeMode = mode === 'fit' ? 'fit' : 'fixed';
  typstPreviewZoomMode = safeMode;

  if (safeMode === 'fit') {
    localStorage.setItem('miniEditorTypstZoomMode', 'fit');
  } else {
    localStorage.setItem('miniEditorTypstZoomMode', 'fixed');
  }

  if (persist) {
    localStorage.setItem('miniEditorTypstZoomLevel', String(typstPreviewZoomLevel));
  }

  applyTypstPreviewScale();
}

function setTypstPreviewZoomLevel(level, { persist = true } = {}) {
  typstPreviewZoomLevel = clampTypstZoomLevel(level);
  typstPreviewZoomMode = 'fixed';
  if (persist) {
    localStorage.setItem('miniEditorTypstZoomLevel', String(typstPreviewZoomLevel));
    localStorage.setItem('miniEditorTypstZoomMode', 'fixed');
  }
  applyTypstPreviewScale();
}

function adjustTypstPreviewZoom(step) {
  const current = typstPreviewZoomMode === 'fit' ? 1 : typstPreviewZoomLevel;
  setTypstPreviewZoomLevel(current * step);
}

function restoreTypstPreviewZoomState() {
  const savedMode = localStorage.getItem('miniEditorTypstZoomMode');
  const savedLevel = localStorage.getItem('miniEditorTypstZoomLevel');
  typstPreviewZoomMode = savedMode === 'fit' ? 'fit' : 'fixed';
  typstPreviewZoomLevel = clampTypstZoomLevel(savedLevel || 1);
  syncTypstPreviewControls();
}

function getCrossReferenceLabels(source) {
  const references = collectCrossReferences(source);
  return [...references.entries()].map(([label, reference]) => ({
    label,
    ...reference
  }));
}

function getLabeledElements(source) {
  const labels = [];
  const figurePattern = /!\[([^\]\n]*)\]\(([^)\n]+)\)\s*\{#(fig:[A-Za-z0-9_.:-]+)\}/g;
  const equationPattern = /\$\$([\s\S]+?)\$\$\s*\{#(eq:[A-Za-z0-9_.:-]+)\}|\\\[([\s\S]+?)\\\]\s*\{#(eq:[A-Za-z0-9_.:-]+)\}/g;

  for (const match of source.matchAll(figurePattern)) {
    labels.push({
      kind: 'fig',
      label: match[3],
      line: getLineFromIndex(source, match.index || 0)
    });
  }

  for (const match of source.matchAll(equationPattern)) {
    labels.push({
      kind: 'eq',
      label: match[2] || match[4],
      line: getLineFromIndex(source, match.index || 0)
    });
  }

  return labels;
}

function getDuplicateLabels(labels) {
  const grouped = new Map();

  for (const label of labels) {
    const group = grouped.get(label.label) || [];
    group.push(label);
    grouped.set(label.label, group);
  }

  return [...grouped.values()].filter((group) => group.length > 1);
}

function getCrossReferenceUsages(source) {
  const usages = [];
  const usagePattern = /@((?:fig|eq):[A-Za-z0-9_.:-]+)/g;

  for (const match of source.matchAll(usagePattern)) {
    usages.push({
      label: match[1],
      line: getLineFromIndex(source, match.index || 0)
    });
  }

  return usages;
}

function getResearchImageSources(source) {
  const sources = new Set();
  const imagePattern = /!\[[^\]\n]*\]\(([^)\n]+)\)/g;
  const linkPattern = /\[[^\]\n]+\]\(([^)\n]+)\)/g;

  for (const match of source.matchAll(imagePattern)) {
    sources.add(match[1].trim());
  }

  for (const match of source.matchAll(linkPattern)) {
    const href = match[1].trim();
    if (imageLinkPattern.test(href)) {
      sources.add(href);
    }
  }

  return [...sources].filter((source) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(source));
}

function getCitationKeys(source) {
  const keys = new Set();
  const citationGroupPattern = /\[([^\]]*@[^]]*?)\]/g;
  const keyPattern = /@([A-Za-z0-9_:.#$%&+?<>~/-]+)/g;

  for (const group of source.matchAll(citationGroupPattern)) {
    for (const match of group[1].matchAll(keyPattern)) {
      if (!/^(?:fig|eq):/.test(match[1])) {
        keys.add(match[1]);
      }
    }
  }

  return [...keys];
}

function renderReferenceIssues(checks, { typst = false } = {}) {
  const summary = typst
    ? `${checks.issues.length} issues`
    : [
        `${checks.labels.length} labels`,
        `${checks.usages.length} refs`,
        `${checks.issues.length} issues`
      ].join(' · ');
  const issueHtml = checks.issues.length > 0
    ? checks.issues.map((issue) => `<button class="reference-issue ${issue.type}" type="button"${issue.line ? ` data-line="${issue.line}"` : ''}><span>${escapeHtml(issue.text)}</span>${issue.line ? `<small>${issue.line}</small>` : ''}</button>`).join('')
    : '<p class="research-ok">All references look good.</p>';

  referenceChecks.innerHTML = `<div class="reference-summary">${escapeHtml(summary)}</div>${issueHtml}`;
}

async function refreshTypstOutline(source) {
  if (getCurrentFileType().preview !== 'typst') {
    return;
  }

  const cacheKey = `${currentPath || 'untitled'}\u0000${hashOutlineSource(source)}`;
  if (cacheKey === typstOutlineCacheKey && typstOutlineCache.length > 0 && outlineList.innerHTML) {
    return;
  }

  typstOutlineCacheKey = cacheKey;
  const requestId = ++typstOutlineRequestId;
  const parsedDocument = parseTypstDocument(source);
  const localOutlineItems = flattenTypstOutlineItems(parsedDocument.headings);
  const localTypstChecks = buildTypstReferenceChecksFromParsedDocument(parsedDocument);
  outlineList.innerHTML = typstOutlineCacheKey === cacheKey && typstOutlineCache.length > 0
    ? renderTypstOutlineItems(typstOutlineCache)
    : '<p class="research-empty">Analyzing Typst outline...</p>';

  try {
    const result = await Promise.race([
      window.miniEditor.getTypstOutline({
        documentPath: currentPath,
        source
      }),
      waitForTimeout(1200).then(() => null)
    ]);

    if (requestId !== typstOutlineRequestId || getCurrentFileType().preview !== 'typst') {
      return;
    }

    if (!result) {
      const fallbackOutline = localOutlineItems;
      typstOutlineCache = fallbackOutline;
      typstDiagnosticsReady = false;
      typstDiagnosticsCacheKey = cacheKey;
      typstDiagnosticsCache = [];
      outlineList.innerHTML = renderTypstOutlineItems(fallbackOutline);
      editor.setReferenceDiagnostics(localTypstChecks);
      if (researchVisible) {
        renderReferenceIssues(localTypstChecks, { typst: true });
      }
      return;
    }

    const outlineItems = flattenTypstOutlineItems(result?.items || []);
    if (!result?.available) {
      outlineList.innerHTML = renderTypstOutlineItems(localOutlineItems);
      typstDiagnosticsReady = false;
      typstDiagnosticsCacheKey = cacheKey;
      typstDiagnosticsCache = [];
      editor.setReferenceDiagnostics(localTypstChecks);
      if (researchVisible) {
        renderReferenceIssues(localTypstChecks, { typst: true });
      }
      return;
    }

    typstOutlineCache = outlineItems;
    typstDiagnosticsCacheKey = cacheKey;
    typstDiagnosticsCache = Array.isArray(result.diagnostics) ? result.diagnostics : [];
    typstDiagnosticsReady = true;
    outlineList.innerHTML = renderTypstOutlineItems(outlineItems);
    if (researchVisible) {
      const checks = buildTypstReferenceChecksFromDiagnostics(typstDiagnosticsCache);
      editor.setReferenceDiagnostics(checks);
      renderReferenceIssues(checks, { typst: true });
    }
  } catch (error) {
    if (requestId !== typstOutlineRequestId || getCurrentFileType().preview !== 'typst') {
      return;
    }

    console.error('Typst outline failed:', error);
    outlineList.innerHTML = renderTypstOutlineItems(localOutlineItems);
    typstDiagnosticsReady = false;
    typstDiagnosticsCacheKey = cacheKey;
    typstDiagnosticsCache = [];
    editor.setReferenceDiagnostics(localTypstChecks);
    if (researchVisible) {
      renderReferenceIssues(localTypstChecks, { typst: true });
    }
  }
}

async function updateFileResearchChecks(checks, runId) {
  if (!currentPath || (checks.imageSources.length === 0 && checks.citationKeys.length === 0)) {
    return;
  }

  try {
    const result = await window.miniEditor.checkResearchFiles({
      documentPath: currentPath,
      imageSources: checks.imageSources,
      citationKeys: checks.citationKeys
    });

    if (runId !== researchCheckRun) {
      return;
    }

    for (const image of result.images || []) {
      if (!image.exists) {
        checks.issues.push({
          type: 'missing-file',
          line: null,
          text: `画像なし: ${image.source}`
        });
      }
    }

    if (checks.citationKeys.length > 0 && !result.citations?.refsFound) {
      checks.issues.push({
        type: 'missing-citation',
        line: null,
        text: 'refs.bib がありません'
      });
    }

    for (const key of result.citations?.missingKeys || []) {
      checks.issues.push({
        type: 'missing-citation',
        line: null,
        text: `citationなし: @${key}`
      });
    }

    renderReferenceIssues(checks);
  } catch (error) {
    console.error('Research file checks failed:', error);
  }
}

function buildResearchChecks(source) {
  const labeledElements = getLabeledElements(source);
  const labels = getCrossReferenceLabels(source);
  const usages = getCrossReferenceUsages(source);
  const labelsByName = new Map(labels.map((label) => [label.label, label]));
  const usedLabels = new Set(usages.map((usage) => usage.label));
  const issues = [];

  for (const group of getDuplicateLabels(labeledElements)) {
    const [first] = group;
    issues.push({
      type: 'duplicate',
      label: first.label,
      line: first.line,
      text: `重複ラベル: ${first.label}`
    });
  }

  for (const usage of usages) {
    if (!labelsByName.has(usage.label)) {
      issues.push({
        type: 'missing',
        label: usage.label,
        line: usage.line,
        text: `未定義: @${usage.label}`
      });
    }
  }

  for (const label of labels) {
    if (!usedLabels.has(label.label)) {
      issues.push({
        type: 'unused',
        label: label.label,
        line: null,
        text: `未使用: ${label.label}`
      });
    }
  }

  return {
    labels,
    usages,
    issues,
    imageSources: getResearchImageSources(source),
    citationKeys: getCitationKeys(source)
  };
}

function jumpToEditorLine(line, { syncPreview = true } = {}) {
  const doc = editor.view.state.doc;
  const targetLine = Math.max(1, Math.min(Number(line) || 1, doc.lines));
  const shouldSyncPreview = syncPreview && previewVisible && previewBlockAnchors.length > 0;
  if (shouldSyncPreview) {
    syncingScroll = true;
  }

  editor.focus();
  editor.scrollLineIntoView(targetLine, 'start');
  if (shouldSyncPreview) {
    scrollPreviewToSourceLine(targetLine);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        syncingScroll = false;
      });
    });
  }
  updateStatus();
}

function findPreviewAnchorForLine(line) {
  if (previewBlockAnchors.length === 0) {
    return null;
  }

  let chosen = previewBlockAnchors[0];
  for (const anchor of previewBlockAnchors) {
    if (anchor.startLine <= line && line <= anchor.endLine) {
      return anchor;
    }

    if (anchor.startLine <= line) {
      chosen = anchor;
    } else {
      break;
    }
  }

  return chosen;
}

function scrollPreviewToSourceLine(line) {
  if (!previewVisible || previewBlockAnchors.length === 0) {
    return;
  }

  const targetLine = Math.max(1, Number(line) || 1);
  const anchor = findPreviewAnchorForLine(targetLine);
  if (!anchor) {
    return;
  }

  const offset = anchor.pageAnchor
    ? anchor.element.offsetTop
    : getPreviewOffsetForSourceLine(targetLine);
  const targetTop = Math.max(0, offset - (previewPane.clientHeight * (anchor.pageAnchor ? 0.04 : 0.18)));
  previewPane.scrollTop = targetTop;
}

function findPreviewAnchorForPosition(position) {
  if (previewBlockAnchors.length === 0) {
    return null;
  }

  let chosen = previewBlockAnchors[0];
  for (const anchor of previewBlockAnchors) {
    if (anchor.element.offsetTop <= position) {
      chosen = anchor;
      continue;
    }

    break;
  }

  return chosen;
}

function getPreviewSourceLineAtPosition(position) {
  const anchor = findPreviewAnchorForPosition(position);
  if (!anchor) {
    return 1;
  }

  const blockTop = anchor.element.offsetTop;
  const blockHeight = Math.max(1, anchor.element.offsetHeight);
  const sourceSpan = Math.max(0, anchor.endLine - anchor.startLine);
  const fraction = Math.max(0, Math.min(1, (position - blockTop) / blockHeight));
  const rawLine = sourceSpan === 0
    ? anchor.startLine
    : anchor.startLine + (sourceSpan * fraction);

  return Math.max(1, Math.round(rawLine));
}

function getPreviewOffsetForSourceLine(line) {
  const anchor = findPreviewAnchorForLine(line);
  if (!anchor) {
    return 0;
  }

  const blockTop = anchor.element.offsetTop;
  if (anchor.pageAnchor) {
    return blockTop;
  }

  const blockHeight = Math.max(1, anchor.element.offsetHeight);
  const sourceSpan = Math.max(0, anchor.endLine - anchor.startLine);
  const clampedLine = Math.max(anchor.startLine, Math.min(Number(line) || anchor.startLine, anchor.endLine));
  const fraction = sourceSpan === 0 ? 0 : (clampedLine - anchor.startLine) / sourceSpan;

  return blockTop + (blockHeight * fraction);
}

function setScrollSyncOrigin(origin) {
  scrollSyncOrigin = origin;
  clearTimeout(scrollSyncOriginTimer);
  scrollSyncOriginTimer = setTimeout(() => {
    scrollSyncOrigin = null;
  }, 160);
}

function hasTypstPagePreview() {
  return documentMode === 'typst' && typstPreviewHasRenderedPages;
}

function getEditorCenterLine() {
  const view = editor.view;
  const middleHeight = view.scrollDOM.scrollTop + (view.scrollDOM.clientHeight / 2);
  const block = view.lineBlockAtHeight(middleHeight) || view.lineBlockAt(view.state.selection.main.head);
  return view.state.doc.lineAt(block.from).number;
}

function isPreviewAnchorVisible(anchor) {
  if (!anchor?.element) {
    return false;
  }

  const visibleTop = previewPane.scrollTop;
  const visibleBottom = visibleTop + previewPane.clientHeight;
  const anchorTop = anchor.element.offsetTop;
  const anchorBottom = anchorTop + Math.max(1, anchor.element.offsetHeight);

  return anchorBottom > visibleTop + 24 && anchorTop < visibleBottom - 24;
}

function syncPreviewScrollFromEditor() {
  if (!previewVisible || previewBlockAnchors.length === 0 || syncingScroll || scrollSyncOrigin === 'preview') {
    return;
  }

  syncingScroll = true;
  const editorLine = Math.max(1, Math.min(getEditorCenterLine(), editor.view.state.doc.lines));
  const anchor = findPreviewAnchorForLine(editorLine);
  if (hasTypstPagePreview() && isPreviewAnchorVisible(anchor)) {
    requestAnimationFrame(() => {
      syncingScroll = false;
    });
    return;
  }

  const previewRange = Math.max(1, previewPane.scrollHeight - previewPane.clientHeight);
  const targetTop = getPreviewOffsetForSourceLine(editorLine);
  previewPane.scrollTop = Math.max(0, Math.min(previewRange, targetTop - (previewPane.clientHeight * 0.35)));
  requestAnimationFrame(() => {
    syncingScroll = false;
  });
}

function schedulePreviewScrollSync() {
  if (hasTypstPagePreview()) {
    clearTimeout(typstPreviewSyncTimer);
    typstPreviewSyncTimer = setTimeout(() => {
      typstPreviewSyncTimer = 0;
      syncPreviewScrollFromEditor();
    }, 70);
    return;
  }

  if (previewSyncRaf) {
    return;
  }

  previewSyncRaf = requestAnimationFrame(() => {
    previewSyncRaf = 0;
    syncPreviewScrollFromEditor();
  });
}

function syncEditorScrollFromPreview() {
  if (!previewVisible || previewBlockAnchors.length === 0 || syncingScroll || scrollSyncOrigin === 'editor') {
    return;
  }

  const previewCenter = previewPane.scrollTop + (previewPane.clientHeight / 2);
  const targetLine = Math.max(1, Math.min(getPreviewSourceLineAtPosition(previewCenter), editor.view.state.doc.lines));

  syncingScroll = true;
  editor.scrollLineIntoView(targetLine, 'center');
  requestAnimationFrame(() => {
    syncingScroll = false;
  });
}

function scheduleEditorScrollSync() {
  if (hasTypstPagePreview()) {
    clearTimeout(typstEditorSyncTimer);
    typstEditorSyncTimer = setTimeout(() => {
      typstEditorSyncTimer = 0;
      syncEditorScrollFromPreview();
    }, 70);
    return;
  }

  if (editorSyncRaf) {
    return;
  }

  editorSyncRaf = requestAnimationFrame(() => {
    editorSyncRaf = 0;
    syncEditorScrollFromPreview();
  });
}

function renderResearchSidebar(checks = null) {
  if (!researchVisible) {
    return;
  }

  if (getCurrentFileType().preview === 'typst') {
    refreshTypstOutline(editor.value);
    const currentKey = `${currentPath || 'untitled'}\u0000${hashOutlineSource(editor.value)}`;
    if (typstDiagnosticsReady && typstDiagnosticsCacheKey === currentKey) {
      const checks = buildTypstReferenceChecksFromDiagnostics(typstDiagnosticsCache);
      editor.setReferenceDiagnostics(checks);
      renderReferenceIssues(checks, { typst: true });
    } else if (typstOutlineCacheKey === currentKey && typstOutlineCache.length > 0) {
      const parsedDocument = parseTypstDocument(editor.value);
      const checks = buildTypstReferenceChecksFromParsedDocument(parsedDocument);
      editor.setReferenceDiagnostics(checks);
      renderReferenceIssues(checks, { typst: true });
    } else {
      referenceChecks.innerHTML = '<p class="research-empty">Analyzing Typst references...</p>';
      editor.setReferenceDiagnostics({ issues: [] });
    }
    return;
  }

  if (!checks) {
    const modeLabel = getCurrentFileType().label;
    outlineList.innerHTML = `<p class="research-empty">${escapeHtml(modeLabel)} のアウトラインはまだありません。</p>`;
    referenceChecks.innerHTML = `<p class="research-empty">${escapeHtml(modeLabel)} の参照チェックはまだありません。</p>`;
    return;
  } else {
    const runId = researchCheckRun + 1;
    researchCheckRun = runId;
    editor.setReferenceDiagnostics(checks);
    const outlineItems = getOutlineItems(editor.value);
    outlineList.innerHTML = outlineItems.length > 0
      ? outlineItems.map((item) => `<button class="outline-item" type="button" data-line="${item.line}" style="--outline-level:${item.level};"><span class="outline-text">${escapeHtml(item.text)}</span><span class="outline-line">${item.line}</span></button>`).join('')
      : '<p class="research-empty">No headings yet.</p>';
    renderReferenceIssues(checks);
    updateFileResearchChecks(checks, runId);
  }
}

markdownIt.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const href = token.attrGet('src') || '';
  const source = resolveMarkdownAssetUrl(currentPath, href);
  token.attrSet('src', source || href);
  return self.renderToken(tokens, idx, options);
};

markdownIt.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const href = token.attrGet('href') || '';
  const source = resolveMarkdownAssetUrl(currentPath, href);
  token.attrSet('href', source || href);
  return self.renderToken(tokens, idx, options);
};

function normalizePreviewAnchors(root) {
  root.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href') || '';
    if (!imageLinkPattern.test(href)) {
      return;
    }

    const source = resolveMarkdownAssetUrl(currentPath, href);
    const img = document.createElement('img');
    img.src = source || href;
    img.alt = link.textContent.trim();
    const title = link.getAttribute('title');
    if (title) {
      img.title = title;
    }
    link.replaceWith(img);
  });
}

const fileTypes = new Map([
  ['md', { label: 'Markdown', preview: 'markdown' }],
  ['markdown', { label: 'Markdown', preview: 'markdown' }],
  ['mdown', { label: 'Markdown', preview: 'markdown' }],
  ['typ', { label: 'Typst', preview: 'typst' }],
  ['txt', { label: 'Text', preview: 'plain' }],
  ['c', { label: 'C', preview: 'source' }],
  ['h', { label: 'C/C++ Header', preview: 'source' }],
  ['cpp', { label: 'C++', preview: 'source' }],
  ['hpp', { label: 'C++ Header', preview: 'source' }],
  ['cc', { label: 'C++', preview: 'source' }],
  ['cxx', { label: 'C++', preview: 'source' }],
  ['js', { label: 'JavaScript', preview: 'source' }],
  ['jsx', { label: 'JavaScript JSX', preview: 'source' }],
  ['ts', { label: 'TypeScript', preview: 'source' }],
  ['tsx', { label: 'TypeScript TSX', preview: 'source' }],
  ['py', { label: 'Python', preview: 'source' }],
  ['rb', { label: 'Ruby', preview: 'source' }],
  ['go', { label: 'Go', preview: 'source' }],
  ['rs', { label: 'Rust', preview: 'source' }],
  ['java', { label: 'Java', preview: 'source' }],
  ['cs', { label: 'C#', preview: 'source' }],
  ['php', { label: 'PHP', preview: 'source' }],
  ['swift', { label: 'Swift', preview: 'source' }],
  ['kt', { label: 'Kotlin', preview: 'source' }],
  ['kts', { label: 'Kotlin', preview: 'source' }],
  ['html', { label: 'HTML', preview: 'source' }],
  ['htm', { label: 'HTML', preview: 'source' }],
  ['css', { label: 'CSS', preview: 'source' }],
  ['scss', { label: 'SCSS', preview: 'source' }],
  ['json', { label: 'JSON', preview: 'source' }],
  ['xml', { label: 'XML', preview: 'source' }],
  ['yaml', { label: 'YAML', preview: 'source' }],
  ['yml', { label: 'YAML', preview: 'source' }],
  ['toml', { label: 'TOML', preview: 'source' }],
  ['ini', { label: 'INI', preview: 'source' }],
  ['sh', { label: 'Shell', preview: 'source' }],
  ['zsh', { label: 'Shell', preview: 'source' }],
  ['bash', { label: 'Shell', preview: 'source' }],
  ['sql', { label: 'SQL', preview: 'source' }]
]);

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function buildMathBlockHtml(id, label, reference, lineCount) {
  const targetAttributes = reference
    ? ` id="${escapeHtml(reference.domId)}" data-crossref-label="${escapeHtml(label)}"`
    : '';
  const className = `math-block${reference ? ' crossref-target' : ''}`;
  const openTag = `<div class="${className}" data-math-id="${id}"${targetAttributes}>`;
  const closeTag = '</div>';

  if (lineCount <= 1) {
    return `${openTag}${closeTag}`;
  }

  if (lineCount === 2) {
    return `${openTag}\n${closeTag}`;
  }

  const emptyLines = new Array(Math.max(0, lineCount - 2)).fill('');
  return [openTag, ...emptyLines, closeTag].join('\n');
}

function prepareMarkdownForRender(source, references) {
  const blocks = [];
  const withMath = source.replace(/\$\$([\s\S]+?)\$\$(?:\s*\{#(eq:[A-Za-z0-9_.:-]+)\})?|\\\[([\s\S]+?)\\\](?:\s*\{#(eq:[A-Za-z0-9_.:-]+)\})?/g, (match, dollarTex, dollarLabel, bracketTex, bracketLabel) => {
    const tex = (dollarTex ?? bracketTex ?? '').trim();
    const label = dollarLabel ?? bracketLabel ?? null;
    const reference = label ? references.get(label) : null;
    const lineCount = Math.max(1, match.split('\n').length);
    const id = blocks.push({ tex, label }) - 1;
    return buildMathBlockHtml(id, label, reference, lineCount);
  });

  return {
    markdown: withMath.replace(labeledFigurePattern, (_match, alt, href, label) => {
      return buildFigureHtml(alt, href, label, references);
    }),
    blocks
  };
}

function findMarkdownTokenGroupEnd(tokens, startIndex) {
  let depth = 0;

  for (let i = startIndex; i < tokens.length; i += 1) {
    depth += tokens[i].nesting || 0;
    if (depth === 0) {
      return i;
    }
  }

  return startIndex;
}

function renderMarkdownBlocks(tokens, env = {}) {
  const htmlParts = [];
  previewBlockAnchors = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.map) {
      continue;
    }

    const startLine = token.map[0] + 1;
    const endLine = Math.max(startLine, (token.map[1] || startLine) - 1);
    let html = '';
    let endIndex = i;

    if (token.nesting === 1) {
      endIndex = findMarkdownTokenGroupEnd(tokens, i);
      html = markdownIt.renderer.render(tokens.slice(i, endIndex + 1), markdownIt.options, env);
    } else {
      html = markdownIt.renderer.render([token], markdownIt.options, env);
    }

    previewBlockAnchors.push({
      startLine,
      endLine,
      element: null
    });
    htmlParts.push(`<section class="md-block" data-source-line="${startLine}" data-source-end-line="${endLine}">${html}</section>`);
    i = endIndex;
  }

  return htmlParts.join('');
}

function getDisplayName(filePath) {
  if (!filePath) {
    if (documentMode === 'typst') {
      return 'untitled.typ';
    }

    if (documentMode === 'plain') {
      return 'untitled.txt';
    }

    return 'untitled.md';
  }

  return filePath.split(/[\\/]/).pop();
}

function getExtension(filePath) {
  const name = getDisplayName(filePath).toLocaleLowerCase();
  const dotIndex = name.lastIndexOf('.');

  if (dotIndex === -1) {
    return '';
  }

  return name.slice(dotIndex + 1);
}

function getCurrentFileType() {
  if (documentMode === 'markdown') {
    return fileTypes.get('md');
  }

  if (documentMode === 'typst') {
    return fileTypes.get('typ');
  }

  return fileTypes.get('txt');
}

function getExportBaseName() {
  return getDisplayName(currentPath).replace(/\.[^.]+$/, '') || 'untitled';
}

function getFolderRootFromPath(filePath) {
  if (!filePath) {
    return null;
  }

  const parts = filePath.split(/[\\/]/);
  parts.pop();
  return parts.join('/');
}

function getParentFolderPath(folderPath) {
  if (!folderPath) {
    return null;
  }

  const parts = folderPath.split(/[\\/]/).filter(Boolean);

  if (parts.length <= 1) {
    return null;
  }

  parts.pop();
  return folderPath.startsWith('/') ? `/${parts.join('/')}` : parts.join('/');
}

function isBinaryLikeName(name) {
  return /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|7z|rar|exe|dll|dylib|so|mp3|mp4|mov|avi|mkv)$/i.test(name);
}

function getDefaultSaveName() {
  if (currentPath) {
    const name = getDisplayName(currentPath);

    if (documentMode === 'typst') {
      return name.replace(/\.[^.]+$/, '') + '.typ';
    }

    if (documentMode === 'plain') {
      return name.replace(/\.[^.]+$/, '') + '.txt';
    }

    return name;
  }

  if (documentMode === 'typst') {
    return 'untitled.typ';
  }

  if (documentMode === 'plain') {
    return 'untitled.txt';
  }

  return 'untitled.md';
}

function getDefaultSaveExtension() {
  if (documentMode === 'typst') {
    return 'typ';
  }

  if (documentMode === 'plain') {
    return 'txt';
  }

  if (currentPath) {
    return getExtension(currentPath) || 'md';
  }

  return 'md';
}

function isDirty() {
  return editor.value !== savedContent;
}

function scheduleAutosave() {
  if (!autosaveReady || restoringAutosave) {
    return;
  }

  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    window.miniEditor.writeAutosave({
      filePath: currentPath,
      content: editor.value,
      savedContent,
      selectionStart: editor.selectionStart,
      selectionEnd: editor.selectionEnd
    }).catch((error) => {
      console.error('Autosave failed:', error);
    });
  }, 1200);
}

async function clearAutosave() {
  clearTimeout(autosaveTimer);
  await window.miniEditor.clearAutosave();
}

function updateTitle() {
  const dirty = isDirty();
  const name = getDisplayName(currentPath);
  fileName.textContent = name;
  dirtyMark.textContent = dirty ? 'Unsaved' : '';
  window.miniEditor.setTitle(`${dirty ? '* ' : ''}${name} - MiniEditor`);
}

function render() {
  try {
    const fileType = getCurrentFileType();
    const previewMode = fileType.preview;
    const researchChecks = previewMode === 'markdown'
      ? buildResearchChecks(editor.value)
      : null;

    if (previewMode === 'typst') {
      const typst = parseTypstDocument(editor.value);
      renderResearchSidebar(researchChecks);
      scheduleTypstPreviewRender(typst);
      return;
    }

    if (previewMode !== 'markdown') {
      preview.innerHTML = `<pre class="plain-preview"><code>${escapeHtml(editor.value)}</code></pre>`;
      previewBlockAnchors = [];
      renderResearchSidebar(null);
      return;
    }

    const crossReferences = collectCrossReferences(editor.value);
    const { markdown, blocks } = prepareMarkdownForRender(editor.value, crossReferences);
    const tokens = markdownIt.parse(markdown, {});

    preview.innerHTML = renderMarkdownBlocks(tokens);
    previewBlockAnchors = [...preview.querySelectorAll('.md-block[data-source-line]')].map((element) => ({
      startLine: Number(element.dataset.sourceLine) || 1,
      endLine: Number(element.dataset.sourceEndLine) || Number(element.dataset.sourceLine) || 1,
      element
    }));

    preview.querySelectorAll('.math-block').forEach((element) => {
      const block = blocks[Number(element.dataset.mathId)] || { tex: '', label: null };
      const reference = block.label ? crossReferences.get(block.label) : null;

      try {
        element.innerHTML = katex.renderToString(block.tex, {
          displayMode: true,
          throwOnError: false
        });
      } catch (_error) {
        element.innerHTML = `<pre><code>${escapeHtml(block.tex)}</code></pre>`;
      }

      if (reference) {
        const number = document.createElement('span');
        number.className = 'equation-number';
        number.textContent = `(${reference.number})`;
        element.append(number);
      }
    });

    replaceCrossReferences(preview, crossReferences);
    normalizePreviewAnchors(preview);

    renderMathInElement(preview, {
      delimiters: [
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false }
      ],
      throwOnError: false
    });

    if (previewVisible) {
      schedulePreviewScrollSync();
    }

    renderResearchSidebar(researchChecks);

  } catch (error) {
    console.error('Preview render failed:', error);
    preview.innerHTML = `<pre class="plain-preview"><code>${escapeHtml(String(error && error.message ? error.message : error))}</code></pre>`;
    previewBlockAnchors = [];
    renderResearchSidebar(null);
  }
}

function runEditorCommand(command) {
  editor.focus();
  let executed = false;

  if (command === 'undo') {
    executed = editor.undo();
  } else if (command === 'redo') {
    executed = editor.redo();
  }

  if (!executed) {
    return;
  }
}

function setPreviewVisible(visible) {
  previewVisible = visible;
  document.body.classList.toggle('preview-visible', previewVisible);
  previewButton.classList.toggle('active', previewVisible);
  previewButton.title = previewVisible ? 'プレビューを隠す' : 'プレビュー';
  previewButton.setAttribute('aria-label', previewButton.title);
  syncTypstPreviewControls();

  if (previewVisible) {
    render();
  }
}

function togglePreview() {
  setPreviewVisible(!previewVisible);
}

function setFolderTreeVisible(visible) {
  folderTreeVisible = visible;
  document.body.classList.toggle('folder-tree-visible', folderTreeVisible);
  folderTreePane.hidden = !folderTreeVisible;
  folderSplitter.hidden = !folderTreeVisible;
  folderTreeButton.classList.toggle('active', folderTreeVisible);
  localStorage.setItem('miniEditorFolderTree', String(folderTreeVisible));
  if (!syncingMenuState) {
    window.miniEditor.writeMenuState({ folderTree: folderTreeVisible }).catch(() => {});
  }

  if (folderTreeVisible) {
    ensureFolderRoot().catch((error) => {
      console.error('Folder tree open failed:', error);
    });
  }

  updateSidebarDividerVisibility();
}

function setResearchVisible(visible) {
  researchVisible = visible;
  document.body.classList.toggle('research-visible', researchVisible);
  researchPane.hidden = !researchVisible;
  researchButton.classList.toggle('active', researchVisible);
  localStorage.setItem('miniEditorResearchPane', String(researchVisible));

  if (researchVisible) {
    const previewMode = getCurrentFileType().preview;
    renderResearchSidebar(
      previewMode === 'markdown' ? buildResearchChecks(editor.value)
        : null
    );
  }

  updateSidebarDividerVisibility();
}

function updateSidebarDividerVisibility() {
  const shouldShow = folderTreeVisible || researchVisible;
  if (sidebarDivider) {
    sidebarDivider.hidden = !shouldShow;
  }
}

function updateFolderNavState() {
  const parentPath = getParentFolderPath(folderRootPath);
  folderUpButton.disabled = !folderRootPath || !parentPath;
}

function clampFolderWidth(value, totalWidth) {
  return Math.max(220, Math.min(value, Math.max(220, totalWidth - 320)));
}

function clampResearchWidth(value, totalWidth) {
  return Math.max(240, Math.min(value, Math.max(240, totalWidth - 360)));
}

function renderTreeNode(node, depth = 0) {
  if (!node) {
    return '';
  }

  if (node.kind === 'file') {
    const selected = currentPath && node.path === currentPath ? ' selected' : '';
    const binaryClass = isBinaryLikeName(node.name) ? ' binary' : '';
    return `<button class="tree-item file${selected}${binaryClass}" data-depth="${depth}" style="--tree-depth:${depth};" data-path="${escapeHtml(node.path)}" type="button"><span class="tree-glyph">${folderIconSvg('file')}</span><span class="tree-label">${escapeHtml(node.name)}</span></button>`;
  }

  if (!node.hasEditableDescendant) {
    return `<div class="tree-item folder leaf" data-depth="${depth}" style="--tree-depth:${depth};" data-path="${escapeHtml(node.path)}"><span class="tree-glyph">${folderIconSvg('directory')}</span><span class="tree-label">${escapeHtml(node.name)}</span></div>`;
  }

  const openAttr = depth < 2 ? ' open' : '';
  const children = (node.children || []).map((child) => renderTreeNode(child, depth + 1)).join('');
  return `<details class="tree-dir" data-depth="${depth}" style="--tree-depth:${depth};" data-path="${escapeHtml(node.path)}"${openAttr}><summary><span class="tree-arrow" aria-hidden="true"></span><button class="tree-enter" type="button" data-dir-path="${escapeHtml(node.path)}"><span class="tree-glyph">${folderIconSvg('directory')}</span><span class="tree-label">${escapeHtml(node.name)}</span></button></summary><div class="tree-children">${children}</div></details>`;
}

function folderIconSvg(kind) {
  if (kind === 'directory') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h6l2 2h8v10H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  }

  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h8l4 4v12H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 4v4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
}

async function refreshFolderTree() {
  if (!folderRootPath || folderTreeLoading) {
    return;
  }

  folderTreeLoading = true;

  try {
    folderTreeData = await window.miniEditor.readFolderTree(folderRootPath);
    folderTree.innerHTML = folderTreeData ? renderTreeNode(folderTreeData) : '';
    updateFolderNavState();
  } finally {
    folderTreeLoading = false;
  }
}

async function ensureFolderRoot() {
  if (!folderRootPath && currentPath) {
    folderRootPath = getFolderRootFromPath(currentPath);
  }

  if (!folderRootPath) {
    folderTree.innerHTML = '';
    updateFolderNavState();
    return;
  }

  await refreshFolderTree();
}

async function pickFolderRoot() {
  const result = await window.miniEditor.pickFolder();
  if (!result) {
    return;
  }

  folderRootPath = result.folderPath;
  await refreshFolderTree();
}

async function navigateFolderRoot(nextRootPath) {
  if (!nextRootPath || nextRootPath === folderRootPath) {
    return;
  }

  folderRootPath = nextRootPath;
  await refreshFolderTree();
}

async function openTreeFile(filePath) {
  if (!(await confirmDiscardChanges('open'))) {
    return;
  }

  const result = await window.miniEditor.openFilePath(filePath);
  if (!result) {
    return;
  }

  await clearAutosave();
  setDocument(result.content, result.filePath);
}

function applyFont(font) {
  document.body.dataset.font = font;
  localStorage.setItem('miniEditorFont', font);
}

function clampFontSize(value) {
  return Math.max(12, Math.min(28, Number(value) || 15));
}

function applyFontSize(size) {
  fontSize = clampFontSize(size);
  document.documentElement.style.setProperty('--font-size', `${fontSize}px`);
  localStorage.setItem('miniEditorFontSize', String(fontSize));
}

function changeFontSize(action) {
  if (action === 'increase') {
    applyFontSize(fontSize + 1);
  } else if (action === 'decrease') {
    applyFontSize(fontSize - 1);
  } else {
    applyFontSize(15);
  }
}

function getExportPayload(extension) {
  if (!previewVisible) {
    setPreviewVisible(true);
  } else {
    render();
  }

  const baseName = getExportBaseName();

  return {
    title: baseName,
    html: preview.innerHTML,
    font: document.body.dataset.font,
    fontSize,
    defaultName: `${baseName}.${extension}`
  };
}

async function exportPreviewAsPdf() {
  if (documentMode === 'typst') {
    const result = await window.miniEditor.exportTypstPdf({
      source: editor.value,
      documentPath: currentPath,
      defaultName: `${getExportBaseName()}.pdf`
    });

    if (!result) {
      return;
    }

    return;
  }

  await window.miniEditor.exportPdf(getExportPayload('pdf'));
}

async function printPreview() {
  await window.miniEditor.printPreview(getExportPayload('html'));
}

function updateStatus() {
  const cursor = editor.selectionStart;
  const beforeCursor = editor.value.slice(0, cursor);
  const lines = beforeCursor.split('\n');
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;

  cursorStatus.textContent = `Ln ${line}, Col ${column}`;
  countStatus.textContent = `${editor.value.length} chars`;
  fileTypeStatus.textContent = getCurrentFileType().label;
  previewButton.title = previewVisible ? 'プレビューを隠す' : 'プレビュー';
  previewButton.setAttribute('aria-label', previewButton.title);
}

function setTypstPreviewLoading(message = 'Typst をレンダリングしています...') {
  preview.innerHTML = `<div class="typst-preview-status">${escapeHtml(message)}</div>`;
  previewBlockAnchors = [];
  typstPreviewHasRenderedPages = false;
  syncTypstPreviewControls();
}

function buildTypstPreviewBlockAnchorsFromFallback() {
  return [...preview.querySelectorAll('.md-block[data-source-line]')].map((element) => ({
    startLine: Number(element.dataset.sourceLine) || 1,
    endLine: Number(element.dataset.sourceEndLine) || Number(element.dataset.sourceLine) || 1,
    element
  }));
}

function buildTypstPreviewBlockAnchorsFromPages(pageElements, totalLines) {
  const count = pageElements.length;
  if (count === 0) {
    return [];
  }

  const anchors = [];
  let previousEnd = 1;

  for (let index = 0; index < count; index += 1) {
    const startLine = index === 0 ? 1 : previousEnd + 1;
    const endLine = index === count - 1
      ? totalLines
      : Math.max(startLine, Math.round(((index + 1) * totalLines) / count));
    previousEnd = endLine;
    anchors.push({
      startLine,
      endLine,
      element: pageElements[index],
      pageAnchor: true
    });
  }

  return anchors;
}

function buildTypstFallbackPreviewHtml(parsed, notice = '') {
  const fallback = buildTypstPreviewHtml(parsed);
  const noticeHtml = notice
    ? `<div class="typst-preview-notice">${escapeHtml(notice)}</div>`
    : '';
  return `${noticeHtml}${fallback.html || `<pre class="plain-preview"><code>${escapeHtml(editor.value)}</code></pre>`}`;
}

function buildTypstCompiledPreviewHtml(pages, notice = '') {
  const noticeHtml = notice
    ? `<div class="typst-preview-notice">${escapeHtml(notice)}</div>`
    : '';
  const pageHtml = pages.map((page, index) => {
    const pageNumber = page.page || (index + 1);
    return `<section class="typst-page" data-page="${pageNumber}"><div class="typst-page-sheet">${page.svg}</div><div class="typst-page-number">${pageNumber}</div></section>`;
  }).join('');

  return `${noticeHtml}<div class="typst-preview-pages">${pageHtml}</div>`;
}

async function renderTypstPreviewAsync(source, parsed, jobId) {
  const result = await window.miniEditor.renderTypstPreview({
    source,
    documentPath: currentPath
  });

  if (jobId !== typstPreviewRenderJobId || getCurrentFileType().preview !== 'typst') {
    return;
  }

  if (!result?.available || !result.pages || result.pages.length === 0) {
    preview.innerHTML = buildTypstFallbackPreviewHtml(parsed);
    previewBlockAnchors = buildTypstPreviewBlockAnchorsFromFallback();
    typstPreviewHasRenderedPages = false;
    syncTypstPreviewControls();
    if (previewVisible) {
      schedulePreviewScrollSync();
    }
    return;
  }

  preview.innerHTML = buildTypstCompiledPreviewHtml(result.pages, result.message);
  const pageElements = [...preview.querySelectorAll('.typst-page')];
  previewBlockAnchors = buildTypstPreviewBlockAnchorsFromPages(pageElements, editor.view.state.doc.lines);
  typstPreviewHasRenderedPages = true;
  applyTypstPreviewScale();

  if (previewVisible) {
    schedulePreviewScrollSync();
  }
}

function scheduleTypstPreviewRender(parsed) {
  clearTimeout(typstPreviewRenderTimer);
  const jobId = ++typstPreviewRenderJobId;
  setTypstPreviewLoading(previewVisible ? 'Typst をレンダリングしています...' : 'Typst のプレビューは非表示です。');

  typstPreviewRenderTimer = setTimeout(() => {
    renderTypstPreviewAsync(editor.value, parsed, jobId).catch((error) => {
      if (jobId !== typstPreviewRenderJobId || getCurrentFileType().preview !== 'typst') {
        return;
      }

      console.error('Typst preview render failed:', error);
      const message = String(error?.message || '');
      const isMissingCompiler = /typst is not installed|not found|ENOENT/i.test(message);
      preview.innerHTML = buildTypstFallbackPreviewHtml(parsed, isMissingCompiler ? '' : (message || 'Typst preview failed.'));
      previewBlockAnchors = buildTypstPreviewBlockAnchorsFromFallback();
      typstPreviewHasRenderedPages = false;
      syncTypstPreviewControls();
      if (previewVisible) {
        schedulePreviewScrollSync();
      }
    });
  }, 240);
}

function setLineNumbersVisible(visible) {
  const enabled = Boolean(visible);
  editor.setLineNumbersVisible(enabled);
  if (!syncingMenuState) {
    window.miniEditor.writeMenuState({ lineNumbers: enabled }).catch(() => {});
  }
}

function inferDocumentModeFromPath(filePath) {
  if (!filePath) {
    return null;
  }

  const ext = getExtension(filePath);

  if (ext === 'typ') {
    return 'typst';
  }

  if (ext === 'md' || ext === 'markdown' || ext === 'mdown') {
    return 'markdown';
  }

  if (ext === 'txt') {
    return 'plain';
  }

  return filePath ? 'plain' : null;
}

function setDocumentMode(mode, { persist = true, rerender = true } = {}) {
  const safeMode = ['markdown', 'typst', 'plain'].includes(mode) ? mode : 'markdown';
  documentMode = safeMode;
  document.body.dataset.documentMode = safeMode;
  if (persist) {
    localStorage.setItem('miniEditorDocumentMode', safeMode);
  }

  if (persist && !syncingMenuState) {
    window.miniEditor.writeMenuState({ documentMode: safeMode }).catch(() => {});
  }

  if (safeMode === 'typst' && !previewVisible) {
    previewVisible = true;
    document.body.classList.add('preview-visible');
    previewButton.classList.add('active');
    previewButton.title = 'プレビューを隠す';
    previewButton.setAttribute('aria-label', previewButton.title);
  }

  if (safeMode === 'typst' && !researchVisible) {
    setResearchVisible(true);
  }

  if (rerender) {
    render();
    updateTitle();
    updateStatus();
  }
  syncTypstPreviewControls();
}

function setTheme(theme, { persist = true } = {}) {
  const safeTheme = ['system', 'light', 'white', 'dark'].includes(theme) ? theme : 'system';
  document.body.dataset.theme = safeTheme;
  localStorage.setItem('miniEditorTheme', safeTheme);

  if (persist && !syncingMenuState) {
    window.miniEditor.writeMenuState({ theme: safeTheme }).catch(() => {});
  }
}

function setStatusBarVisible(visible) {
  document.body.classList.toggle('status-visible', visible);
  statusBar.hidden = !visible;
  localStorage.setItem('miniEditorStatusBar', String(visible));
  if (!syncingMenuState) {
    window.miniEditor.writeMenuState({ statusBar: visible }).catch(() => {});
  }
}

function setWordWrap(enabled) {
  editor.wrap = enabled ? 'soft' : 'off';
  document.body.classList.toggle('no-wrap', !enabled);
  localStorage.setItem('miniEditorWordWrap', String(enabled));
  if (!syncingMenuState) {
    window.miniEditor.writeMenuState({ wordWrap: enabled }).catch(() => {});
  }
}

function openFindPanel({ replace = false } = {}) {
  replaceMode = replace;
  findPanel.hidden = false;
  replaceInput.hidden = !replaceMode;
  replaceButton.hidden = !replaceMode;
  replaceAllButton.hidden = !replaceMode;
  searchButton.classList.add('active');

  if (editor.selectionStart !== editor.selectionEnd) {
    findInput.value = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  }

  findInput.focus();
  findInput.select();
}

function closeFindPanel() {
  findPanel.hidden = true;
  searchButton.classList.remove('active');
  editor.focus();
}

function toggleFindPanel({ replace = false } = {}) {
  if (!findPanel.hidden) {
    if (replace && !replaceMode) {
      openFindPanel({ replace: true });
      return;
    }

    closeFindPanel();
    return;
  }

  openFindPanel({ replace });
}

function findText(direction = 1) {
  const query = findInput.value;

  if (!query) {
    openFindPanel();
    return false;
  }

  const content = editor.value;
  const haystack = content.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const currentStart = editor.selectionStart;
  const currentEnd = editor.selectionEnd;
  let index = -1;

  if (direction > 0) {
    index = haystack.indexOf(needle, currentEnd);

    if (index === -1) {
      index = haystack.indexOf(needle, 0);
    }
  } else {
    index = haystack.lastIndexOf(needle, Math.max(0, currentStart - 1));

    if (index === -1) {
      index = haystack.lastIndexOf(needle);
    }
  }

  if (index === -1) {
    window.alert(`"${query}" が見つかりません。`);
    return false;
  }

  editor.focus();
  editor.setSelectionRange(index, index + query.length);
  updateStatus();
  return true;
}

function replaceCurrent() {
  const query = findInput.value;

  if (!query) {
    openFindPanel({ replace: true });
    return;
  }

  const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);

  if (selected.toLocaleLowerCase() !== query.toLocaleLowerCase() && !findText(1)) {
    return;
  }

  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.setRangeText(replaceInput.value, start, end, 'end');
  render();
  updateTitle();
  updateStatus();
  findText(1);
}

function replaceAll() {
  const query = findInput.value;

  if (!query) {
    openFindPanel({ replace: true });
    return;
  }

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const replaced = editor.value.replace(new RegExp(escaped, 'gi'), replaceInput.value);

  if (replaced === editor.value) {
    window.alert(`"${query}" が見つかりません。`);
    return;
  }

  editor.value = replaced;
  render();
  updateTitle();
  updateStatus();
}

function insertTimeDate() {
  const now = new Date();
  const stamp = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(now);

  editor.setRangeText(stamp, editor.selectionStart, editor.selectionEnd, 'end');
  render();
  updateTitle();
  updateStatus();
  editor.focus();
}

function setDocument(content, filePath = null) {
  currentPath = filePath;
  editor.value = content;
  savedContent = content;
  const inferredMode = inferDocumentModeFromPath(filePath);
  if (inferredMode) {
    setDocumentMode(inferredMode, { persist: false, rerender: false });
  }
  render();
  updateTitle();
  updateStatus();
  scheduleAutosave();

  if (filePath) {
    folderRootPath = getFolderRootFromPath(filePath);
    if (folderTreeVisible) {
      refreshFolderTree().catch((error) => {
        console.error('Folder tree refresh failed:', error);
      });
    }
  }
}

async function restoreAutosaveIfAvailable() {
  const session = await window.miniEditor.readAutosave();

  if (!session || !session.content || session.content === starterMarkdown) {
    autosaveReady = true;
    scheduleAutosave();
    return;
  }

  const savedAt = session.savedAt ? new Date(session.savedAt).toLocaleString() : 'unknown time';
  const name = session.filePath ? getDisplayName(session.filePath) : 'untitled.md';
  const shouldRestore = window.confirm(`前回の未保存内容があります。\n\n${name}\n${savedAt}\n\n復元しますか？`);

  if (!shouldRestore) {
    await clearAutosave();
    autosaveReady = true;
    scheduleAutosave();
    return;
  }

  restoringAutosave = true;
  currentPath = session.filePath || null;
  editor.value = session.content;
  savedContent = session.savedContent || '';
  const inferredMode = inferDocumentModeFromPath(currentPath);
  if (inferredMode) {
    setDocumentMode(inferredMode, { persist: false, rerender: false });
  }
  render();
  updateTitle();
  updateStatus();
  editor.setSelectionRange(session.selectionStart || 0, session.selectionEnd || session.selectionStart || 0);
  restoringAutosave = false;
  autosaveReady = true;
  scheduleAutosave();
}

async function confirmDiscardChanges(action = 'close') {
  if (!isDirty()) {
    return true;
  }

  const choice = await window.miniEditor.confirmClose({
    fileName: getDisplayName(currentPath),
    action
  });

  if (choice === 'cancel') {
    return false;
  }

  if (choice === 'save') {
    return saveDocument();
  }

  return true;
}

async function newDocument() {
  if (!(await confirmDiscardChanges('new'))) {
    return;
  }

  await clearAutosave();
  setDocument('', null);
}

async function openDocument() {
  if (!(await confirmDiscardChanges('open'))) {
    return;
  }

  const result = await window.miniEditor.openFile();
  if (!result) {
    return;
  }

  await clearAutosave();
  setDocument(result.content, result.filePath);
}

async function saveDocument({ saveAs = false } = {}) {
  const result = await window.miniEditor.saveFile({
    filePath: currentPath,
    content: editor.value,
    saveAs,
    defaultPath: getDefaultSaveName(),
    defaultExtension: getDefaultSaveExtension()
  });

  if (!result) {
    return false;
  }

  currentPath = result.filePath;
  savedContent = editor.value;
  const inferredMode = inferDocumentModeFromPath(currentPath);
  if (inferredMode) {
    setDocumentMode(inferredMode, { persist: false, rerender: false });
  }
  render();
  updateTitle();
  updateStatus();
  await clearAutosave();

  const nextRoot = getFolderRootFromPath(result.filePath);
  if (nextRoot) {
    folderRootPath = nextRoot;
    if (folderTreeVisible) {
      refreshFolderTree().catch((error) => {
        console.error('Folder tree refresh failed:', error);
      });
    }
  }

  return true;
}

async function closeDocumentWindow() {
  if (isDirty()) {
    const choice = await window.miniEditor.confirmClose({
      fileName: getDisplayName(currentPath),
      action: 'close'
    });

    if (choice === 'cancel') {
      return;
    }

    if (choice === 'save' && !(await saveDocument())) {
      return;
    }
  }

  window.miniEditor.closeWindow();
}

editor.addEventListener('input', () => {
  render();
  updateTitle();
  updateStatus();
  scheduleAutosave();
});
editor.addEventListener('selectionchange', scheduleAutosave);
editor.addEventListener('scroll', () => {
  if (previewVisible && !syncingScroll) {
    setScrollSyncOrigin('editor');
    schedulePreviewScrollSync();
  }
});
previewPane.addEventListener('scroll', () => {
  if (previewVisible && !syncingScroll) {
    setScrollSyncOrigin('preview');
    if (hasTypstPagePreview()) {
      clearTimeout(typstEditorSyncTimer);
      clearTimeout(typstPreviewSyncTimer);
      return;
    }

    scheduleEditorScrollSync();
  }
});
editor.addEventListener('click', updateStatus);
editor.addEventListener('keyup', updateStatus);
editor.addEventListener('select', updateStatus);

previewButton.addEventListener('click', togglePreview);
if (typstZoomOutButton) {
  typstZoomOutButton.addEventListener('click', () => {
    if (!typstPreviewHasRenderedPages) {
      return;
    }

    const current = typstPreviewZoomMode === 'fit' ? 1 : typstPreviewZoomLevel;
    setTypstPreviewZoomLevel(current / 1.12);
  });
}
if (typstActualButton) {
  typstActualButton.addEventListener('click', () => {
    if (!typstPreviewHasRenderedPages) {
      return;
    }

    setTypstPreviewZoomLevel(1);
  });
}
if (typstFitButton) {
  typstFitButton.addEventListener('click', () => {
    if (!typstPreviewHasRenderedPages) {
      return;
    }

    setTypstPreviewZoomMode('fit');
  });
}
if (typstZoomInButton) {
  typstZoomInButton.addEventListener('click', () => {
    if (!typstPreviewHasRenderedPages) {
      return;
    }

    const current = typstPreviewZoomMode === 'fit' ? 1 : typstPreviewZoomLevel;
    setTypstPreviewZoomLevel(current * 1.12);
  });
}
menuButton.addEventListener('click', () => window.miniEditor.showContextMenu({ kind: 'app' }));
undoButton.addEventListener('click', () => runEditorCommand('undo'));
redoButton.addEventListener('click', () => runEditorCommand('redo'));
newButton.addEventListener('click', newDocument);
openButton.addEventListener('click', openDocument);
saveButton.addEventListener('click', () => saveDocument());
saveAsButton.addEventListener('click', () => saveDocument({ saveAs: true }));
searchButton.addEventListener('click', () => toggleFindPanel());
folderTreeButton.addEventListener('click', () => {
  if (folderTreeVisible) {
    setFolderTreeVisible(false);
    return;
  }

  setFolderTreeVisible(true);
});
researchButton.addEventListener('click', () => {
  setResearchVisible(!researchVisible);
});
openFolderButton.addEventListener('click', () => {
  pickFolderRoot().catch((error) => console.error('Folder pick failed:', error));
});
findNextButton.addEventListener('click', () => findText(1));
findPreviousButton.addEventListener('click', () => findText(-1));
replaceButton.addEventListener('click', replaceCurrent);
replaceAllButton.addEventListener('click', replaceAll);
closeFindButton.addEventListener('click', closeFindPanel);
findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    findText(event.shiftKey ? -1 : 1);
  } else if (event.key === 'Escape') {
    closeFindPanel();
  }
});
replaceInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    replaceCurrent();
  } else if (event.key === 'Escape') {
    closeFindPanel();
  }
});

preview.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.miniEditor.showContextMenu({ kind: 'preview' });
});

preview.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');

  if (!link || !preview.contains(link)) {
    return;
  }

  event.preventDefault();
  if (link.hash) {
    const target = preview.querySelector(`#${CSS.escape(decodeURIComponent(link.hash.slice(1)))}`);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
});

editor.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.miniEditor.showContextMenu({ kind: 'editor' });
});

folderTreePane.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const target = event.target.closest('button[data-path]');

  if (target) {
    window.miniEditor.showContextMenu({
      kind: 'tree-file',
      path: target.dataset.path
    });
    return;
  }

  window.miniEditor.showContextMenu({ kind: 'tree-root' });
});

folderTree.addEventListener('click', (event) => {
  const dirButton = event.target.closest('button[data-dir-path]');
  if (dirButton) {
    event.preventDefault();
    event.stopPropagation();
    navigateFolderRoot(dirButton.dataset.dirPath).catch((error) => {
      console.error('Folder navigation failed:', error);
    });
    return;
  }

  const button = event.target.closest('button[data-path]');
  if (!button) {
    return;
  }

  openTreeFile(button.dataset.path).catch((error) => {
    console.error('Tree open failed:', error);
  });
});

researchPane.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-line]');
  if (!button) {
    return;
  }

  jumpToEditorLine(button.dataset.line);
});

splitter.addEventListener('pointerdown', (event) => {
  if (!previewVisible) {
    return;
  }

  splitter.setPointerCapture(event.pointerId);
  previewSplitterDragging = true;
  document.body.classList.add('resizing');
});

splitter.addEventListener('pointermove', (event) => {
  if (!previewSplitterDragging || !splitter.hasPointerCapture(event.pointerId)) {
    return;
  }

  const workspaceRect = workspace.getBoundingClientRect();
  const editorRect = editorPane.getBoundingClientRect();
  const minWidth = 260;
  const splitterWidth = 18;
  const width = Math.max(minWidth, Math.min(event.clientX - editorRect.left, workspaceRect.right - editorRect.left - minWidth - splitterWidth));
  workspace.style.setProperty('--editor-width', `${Math.round(width)}px`);
  localStorage.setItem('miniEditorEditorWidth', `${Math.round(width)}px`);
});

splitter.addEventListener('pointerup', (event) => {
  if (splitter.hasPointerCapture(event.pointerId)) {
    splitter.releasePointerCapture(event.pointerId);
  }

  previewSplitterDragging = false;
  document.body.classList.remove('resizing');
});

splitter.addEventListener('pointercancel', () => {
  previewSplitterDragging = false;
  document.body.classList.remove('resizing');
});

folderSplitter.addEventListener('pointerdown', (event) => {
  if (!folderTreeVisible) {
    return;
  }

  folderSplitter.setPointerCapture(event.pointerId);
  folderSplitterDragging = true;
  document.body.classList.add('resizing');
});

folderSplitter.addEventListener('pointermove', (event) => {
  if (!folderSplitterDragging || !folderSplitter.hasPointerCapture(event.pointerId)) {
    return;
  }

  const rect = workspace.getBoundingClientRect();
  const width = clampFolderWidth(event.clientX - rect.left, rect.width);
  workspace.style.setProperty('--folder-tree-width', `${Math.round(width)}px`);
  localStorage.setItem('miniEditorFolderTreeWidth', `${Math.round(width)}px`);
});

folderSplitter.addEventListener('pointerup', (event) => {
  if (folderSplitter.hasPointerCapture(event.pointerId)) {
    folderSplitter.releasePointerCapture(event.pointerId);
  }

  folderSplitterDragging = false;
  document.body.classList.remove('resizing');
});

folderSplitter.addEventListener('pointercancel', () => {
  folderSplitterDragging = false;
  document.body.classList.remove('resizing');
});

researchSplitter.addEventListener('pointerdown', (event) => {
  if (!researchVisible) {
    return;
  }

  researchSplitter.setPointerCapture(event.pointerId);
  researchSplitterDragging = true;
  document.body.classList.add('resizing');
});

researchSplitter.addEventListener('pointermove', (event) => {
  if (!researchSplitterDragging || !researchSplitter.hasPointerCapture(event.pointerId)) {
    return;
  }

  const rect = workspace.getBoundingClientRect();
  const width = clampResearchWidth(rect.right - event.clientX, rect.width);
  workspace.style.setProperty('--research-width', `${Math.round(width)}px`);
  localStorage.setItem('miniEditorResearchWidth', `${Math.round(width)}px`);
});

researchSplitter.addEventListener('pointerup', (event) => {
  if (researchSplitter.hasPointerCapture(event.pointerId)) {
    researchSplitter.releasePointerCapture(event.pointerId);
  }

  researchSplitterDragging = false;
  document.body.classList.remove('resizing');
});

researchSplitter.addEventListener('pointercancel', () => {
  researchSplitterDragging = false;
  document.body.classList.remove('resizing');
});

folderUpButton.addEventListener('click', () => {
  const parentPath = getParentFolderPath(folderRootPath);
  if (!parentPath) {
    return;
  }

  navigateFolderRoot(parentPath).catch((error) => {
    console.error('Folder navigation failed:', error);
  });
});

if (typeof ResizeObserver !== 'undefined') {
  const typstPreviewResizeObserver = new ResizeObserver(() => {
    if (documentMode === 'typst' && typstPreviewHasRenderedPages) {
      applyTypstPreviewScale();
    }
  });

  typstPreviewResizeObserver.observe(previewPane);
}

window.addEventListener('resize', () => {
  if (documentMode === 'typst' && typstPreviewHasRenderedPages) {
    applyTypstPreviewScale();
  }
});

window.miniEditor.onMenuNew(newDocument);
window.miniEditor.onMenuOpen(openDocument);
window.miniEditor.onMenuOpenFolder(() => pickFolderRoot());
window.miniEditor.onMenuSave(() => saveDocument());
window.miniEditor.onMenuSaveAs(() => saveDocument({ saveAs: true }));
window.miniEditor.onMenuExportPdf(exportPreviewAsPdf);
window.miniEditor.onMenuPrint(printPreview);
window.miniEditor.onMenuFind(() => toggleFindPanel());
window.miniEditor.onMenuFindNext(() => findPanel.hidden ? openFindPanel() : findText(1));
window.miniEditor.onMenuFindPrevious(() => findPanel.hidden ? openFindPanel() : findText(-1));
window.miniEditor.onMenuReplace(() => toggleFindPanel({ replace: true }));
window.miniEditor.onMenuTimeDate(insertTimeDate);
window.miniEditor.onMenuWordWrap((_event, enabled) => setWordWrap(enabled));
window.miniEditor.onMenuStatusBar((_event, visible) => setStatusBarVisible(visible));
window.miniEditor.onMenuFolderTree((_event, visible) => setFolderTreeVisible(visible));
window.miniEditor.onMenuLineNumbers((_event, visible) => setLineNumbersVisible(visible));
window.miniEditor.onMenuDocumentMode((_event, mode) => setDocumentMode(mode));
window.miniEditor.onMenuTheme((_event, theme) => setTheme(theme, { persist: false }));
window.miniEditor.onMenuTogglePreview(togglePreview);
window.miniEditor.onMenuFont((_event, font) => applyFont(font));
window.miniEditor.onMenuFontSize((_event, action) => changeFontSize(action));
window.miniEditor.onPreviewExportPdf(exportPreviewAsPdf);
window.miniEditor.onBeforeClose(closeDocumentWindow);
window.miniEditor.onContextOpenTreeFile((_event, filePath) => {
  if (!filePath) {
    return;
  }

  openTreeFile(filePath).catch((error) => {
    console.error('Tree open failed:', error);
  });
});
window.miniEditor.onContextRefreshFolderTree(() => {
  if (!folderTreeVisible) {
    return;
  }

  refreshFolderTree().catch((error) => {
    console.error('Folder tree refresh failed:', error);
  });
});

applyFont(localStorage.getItem('miniEditorFont') || 'mono');
applyFontSize(localStorage.getItem('miniEditorFontSize') || 15);
setDocumentMode(localStorage.getItem('miniEditorDocumentMode') || 'markdown', {
  persist: false,
  rerender: false
});
restoreTypstPreviewZoomState();
workspace.style.setProperty('--editor-width', '50%');
workspace.style.setProperty('--folder-tree-width', '280px');
workspace.style.setProperty('--research-width', '300px');
updateFolderNavState();
setResearchVisible(localStorage.getItem('miniEditorResearchPane') === 'true');
setPreviewVisible(false);
updateSidebarDividerVisibility();
restoringAutosave = true;
setDocument('');
restoringAutosave = false;

window.miniEditor.readMenuState()
  .then((state) => {
    try {
      syncingMenuState = true;
      setWordWrap(Boolean(state.wordWrap));
      setStatusBarVisible(Boolean(state.statusBar));
      setFolderTreeVisible(Boolean(state.folderTree));
      setLineNumbersVisible(Boolean(state.lineNumbers));
      setDocumentMode(state.documentMode || 'markdown');
      setTheme(state.theme || 'system', { persist: false });
    } finally {
      syncingMenuState = false;
    }
  })
  .then(() => restoreAutosaveIfAvailable())
  .catch((error) => {
    console.error('Startup restore failed:', error);
    autosaveReady = true;
  });
