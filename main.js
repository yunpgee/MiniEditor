const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

let mainWindow;
const autosaveFileName = 'autosave-session.json';
let isQuitting = false;
let appMenu;
let typstCommandCache = null;
let typstLspClient = null;

const menuState = {
  wordWrap: true,
  documentMode: 'markdown',
  statusBar: true,
  lineNumbers: true,
  theme: 'system',
  folderTree: false
};

app.setName('MiniEditor');

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

const binaryFileExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf',
  '.zip', '.gz', '.7z', '.rar', '.exe', '.dll', '.dylib', '.so',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv'
]);

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function readEditableTextFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (binaryFileExtensions.has(extension)) {
    focusMainWindow();
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'MiniEditor',
      message: `${path.basename(filePath)} is not a text file.`,
      detail: 'Images are shown from Markdown with image syntax, for example ![](image.png).'
    });
    return null;
  }

  const buffer = await fs.readFile(filePath);
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));

  if (sample.includes(0)) {
    focusMainWindow();
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'MiniEditor',
      message: `${path.basename(filePath)} looks like a binary file.`,
      detail: 'MiniEditor can open text and source files. Reference images from a Markdown document instead.'
    });
    return null;
  }

  return buffer.toString('utf8');
}

function getFontMimeType(fileName) {
  if (fileName.endsWith('.woff2')) {
    return 'font/woff2';
  }

  if (fileName.endsWith('.woff')) {
    return 'font/woff';
  }

  if (fileName.endsWith('.ttf')) {
    return 'font/ttf';
  }

  return 'application/octet-stream';
}

async function inlineKatexFontUrls(css) {
  const fontUrlPattern = /url\((?:'|")?(fonts\/[^)'"]+)(?:'|")?\)/g;
  const fontPaths = [...new Set([...css.matchAll(fontUrlPattern)].map((match) => match[1]))];
  let inlinedCss = css;

  for (const fontPath of fontPaths) {
    const fontFile = await fs.readFile(path.join(__dirname, '..', 'node_modules', 'katex', 'dist', fontPath));
    const dataUrl = `data:${getFontMimeType(fontPath)};base64,${fontFile.toString('base64')}`;
    inlinedCss = inlinedCss.replaceAll(`url(${fontPath})`, `url(${dataUrl})`);
  }

  return inlinedCss;
}

async function replaceFileAtomic(filePath, data) {
  const directory = path.dirname(filePath);
  const extension = path.extname(filePath);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const temporaryPath = path.join(directory, `.${path.basename(filePath, extension)}.${suffix}.tmp${extension}`);

  await fs.writeFile(temporaryPath, data);
  await fs.rename(temporaryPath, filePath);
}

function getAutosavePath() {
  return path.join(app.getPath('userData'), autosaveFileName);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
    }

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        const error = new Error(`Command was terminated by signal ${signal}.`);
        error.signal = signal;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(stderr.trim() || stdout.trim() || `Command failed with exit code ${code}.`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function locateTypstCommand() {
  if (typstCommandCache) {
    return typstCommandCache;
  }

  const executableName = process.platform === 'win32' ? 'tinymist.exe' : 'tinymist';
  const bundledBin = process.resourcesPath
    ? path.join(process.resourcesPath, 'bin')
    : null;
  const devBundledBin = path.join(__dirname, '..', 'resources', 'bin');
  const homeDirectory = process.env.HOME || process.env.USERPROFILE || '';
  const homeBin = homeDirectory ? path.join(homeDirectory, '.local', 'bin') : null;
  const localAppDataBin = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'tinymist') : null;
  const candidates = [
    ...(bundledBin ? [path.join(bundledBin, executableName)] : []),
    path.join(devBundledBin, executableName),
    ...(homeBin ? [path.join(homeBin, 'tinymist'), path.join(homeBin, 'typst')] : []),
    ...(process.platform === 'win32' && homeBin ? [path.join(homeBin, 'tinymist.exe'), path.join(homeBin, 'typst.exe')] : []),
    ...(localAppDataBin ? [path.join(localAppDataBin, executableName)] : []),
    'tinymist',
    'typst'
  ];

  for (const command of candidates) {
    const candidate = spawnSync(command, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    if (candidate.status === 0) {
      typstCommandCache = command;
      return typstCommandCache;
    }
  }

  typstCommandCache = null;
  return null;
}

async function compileTypstPreview(payload = {}) {
  return compileTypstDocument(payload, 'svg');
}

async function compileTypstDocument(payload = {}, format = 'svg') {
const command = locateTypstCommand();
  if (!command) {
    return {
      available: false,
      pages: [],
      message: 'Typst is not installed on this machine.'
    };
  }

  const source = String(payload.source ?? '');
  const documentPath = payload.documentPath || null;
  const rootDirectory = documentPath ? path.dirname(documentPath) : null;
  const outputDirectory = await fs.mkdtemp(path.join(app.getPath('temp'), 'mini-editor-typst-preview-'));
  const effectiveRootDirectory = rootDirectory || outputDirectory;
  const inputName = documentPath
    ? `.mini-editor-typst-preview-${Date.now()}-${Math.random().toString(36).slice(2)}.typ`
    : 'preview.typ';
  const inputDirectory = documentPath ? effectiveRootDirectory : outputDirectory;
  const inputPath = path.join(inputDirectory, inputName);
  const outputPath = path.join(outputDirectory, 'preview-{p}.svg');

  try {
    await fs.writeFile(inputPath, source, 'utf8');
    const outputFile = format === 'pdf' ? path.join(outputDirectory, 'preview.pdf') : outputPath;
    const args = ['compile', '--root', effectiveRootDirectory, '--format', format, inputPath, outputFile];
    await runCommand(command, args, {
      cwd: inputDirectory,
      env: process.env
    });

    if (format === 'pdf') {
      const pdf = await fs.readFile(outputFile);
      return {
        available: true,
        pages: [],
        pdf: pdf.toString('base64'),
        message: ''
      };
    }

    const entries = await fs.readdir(outputDirectory, { withFileTypes: true });
    const svgFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.svg'))
      .map((entry) => entry.name)
      .sort((a, b) => {
        const pageA = Number(a.match(/(\d+)/)?.[1] || 0);
        const pageB = Number(b.match(/(\d+)/)?.[1] || 0);
        return pageA - pageB || a.localeCompare(b);
      });

    const pages = [];
    for (const fileName of svgFiles) {
      const match = fileName.match(/(\d+)/);
      const page = Number(match?.[1] || pages.length + 1);
      const svg = await fs.readFile(path.join(outputDirectory, fileName), 'utf8');
      pages.push({ page, svg });
    }

    return {
      available: true,
      pages,
      message: pages.length > 0 ? '' : 'Typst preview rendered no pages.'
    };
  } catch (error) {
    return {
      available: true,
      pages: [],
      message: error.stderr?.trim() || error.message || 'Typst preview failed.'
    };
  } finally {
    await fs.rm(outputDirectory, { recursive: true, force: true }).catch(() => {});
    if (documentPath) {
      await fs.rm(inputPath, { force: true }).catch(() => {});
    }
  }
}

function flattenDocumentSymbols(symbols, depth = 1, output = []) {
  for (const symbol of symbols || []) {
    const line = Number(symbol?.selectionRange?.start?.line ?? symbol?.range?.start?.line ?? 0) + 1;
    if (symbol?.name) {
      output.push({
        text: symbol.name,
        line,
        level: depth
      });
    }

    if (Array.isArray(symbol?.children) && symbol.children.length > 0) {
      flattenDocumentSymbols(symbol.children, depth + 1, output);
    }
  }

  return output;
}

class TypstLspClient {
  constructor(command) {
    this.command = command;
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.documentState = new Map();
    this.diagnostics = new Map();
    this.initPromise = null;
  }

  start() {
    if (this.child && !this.child.killed) {
      return;
    }

    this.child = spawn(this.command, ['lsp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: app.getPath('home'),
      env: {
        ...process.env,
        PATH: process.env.PATH || ''
      }
    });

    this.buffer = '';
    this.initialized = false;
    this.documentState.clear();
    this.diagnostics.clear();

    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      this.drain();
    });

    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        console.error('[tinymist]', text);
      }
    });

    this.child.on('exit', () => {
      this.child = null;
      this.initialized = false;
      for (const pending of this.pending.values()) {
        pending.reject(new Error('Tinymist LSP exited.'));
      }
      this.pending.clear();
    });
  }

  write(message) {
    if (!this.child || this.child.killed) {
      throw new Error('Tinymist LSP is not running.');
    }

    const json = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
  }

  drain() {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const header = this.buffer.slice(0, headerEnd);
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) {
        return;
      }

      const body = this.buffer.slice(bodyStart, bodyStart + length);
      this.buffer = this.buffer.slice(bodyStart + length);

      let message;
      try {
        message = JSON.parse(body);
      } catch (_error) {
        continue;
      }

      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || 'Tinymist request failed.'));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }

      if (message.method === 'textDocument/publishDiagnostics') {
        const uri = message.params?.uri;
        if (uri) {
          this.diagnostics.set(uri, Array.isArray(message.params?.diagnostics) ? message.params.diagnostics : []);
        }
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  async ensureInitialized(rootUri) {
    this.start();

    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      await this.request('initialize', {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            documentSymbol: {
              hierarchicalDocumentSymbolSupport: true
            }
          }
        }
      });
      this.notify('initialized', {});
      this.initialized = true;
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  getDocumentUri(documentPath) {
    const fallbackPath = path.join(app.getPath('temp'), 'mini-editor-typst-outline.typ');
    return pathToFileURL(documentPath || fallbackPath).href;
  }

  async updateDocument(documentPath, source) {
    const uri = this.getDocumentUri(documentPath);
    const rootPath = documentPath ? path.dirname(documentPath) : app.getPath('temp');
    const rootUri = pathToFileURL(rootPath).href;
    await this.ensureInitialized(rootUri);
    this.diagnostics.delete(uri);

    const nextVersion = (this.documentState.get(uri)?.version || 0) + 1;
    const text = String(source ?? '');
    const current = this.documentState.get(uri);

    if (!current) {
      this.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: 'typst',
          version: nextVersion,
          text
        }
      });
    } else {
      this.notify('textDocument/didChange', {
        textDocument: {
          uri,
          version: nextVersion
        },
        contentChanges: [{ text }]
      });
    }

    this.documentState.set(uri, { version: nextVersion, text });
    return uri;
  }

  async getDocumentSymbols(documentPath, source) {
    const uri = await this.updateDocument(documentPath, source);
    const result = await this.request('textDocument/documentSymbol', {
      textDocument: { uri }
    });

    if (!Array.isArray(result)) {
      return [];
    }

    return flattenDocumentSymbols(result);
  }

  async getDocumentAnalysis(documentPath, source) {
    const uri = await this.updateDocument(documentPath, source);
    const symbolsPromise = this.request('textDocument/documentSymbol', {
      textDocument: { uri }
    }).catch(() => []);
    const result = await symbolsPromise;
    const diagnostics = await this.waitForDiagnostics(uri, 1200);

    return {
      available: true,
      items: Array.isArray(result) ? flattenDocumentSymbols(result) : [],
      diagnostics: Array.isArray(diagnostics) ? diagnostics : []
    };
  }

  waitForDiagnostics(uri, timeoutMs = 1200) {
    const initial = this.diagnostics.get(uri);
    if (Array.isArray(initial)) {
      return Promise.resolve(initial);
    }

    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const current = this.diagnostics.get(uri);
        if (Array.isArray(current)) {
          clearInterval(timer);
          resolve(current);
          return;
        }

        if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          resolve([]);
        }
      }, 40);
    });
  }
}

function getTypstLspClient() {
  const command = locateTypstCommand();
  if (!command) {
    return null;
  }

  if (!typstLspClient || typstLspClient.command !== command) {
    typstLspClient = new TypstLspClient(command);
  }

  return typstLspClient;
}

const saveFilters = [
  { name: 'Typst', extensions: ['typ'] },
  { name: 'Markdown', extensions: ['md'] },
  { name: 'Plain Text', extensions: ['txt'] },
  { name: 'C Source', extensions: ['c'] },
  { name: 'C Header', extensions: ['h'] },
  { name: 'JavaScript', extensions: ['js'] },
  { name: 'TypeScript', extensions: ['ts'] },
  { name: 'Python', extensions: ['py'] },
  { name: 'HTML', extensions: ['html'] },
  { name: 'CSS', extensions: ['css'] },
  { name: 'JSON', extensions: ['json'] },
  { name: 'All Files', extensions: ['*'] }
];

function buildSaveFilters(defaultExtension) {
  const extension = defaultExtension || 'md';
  const currentFilter = saveFilters.find((filter) => filter.extensions[0] === extension);
  const otherFilters = saveFilters.filter((filter) => filter !== currentFilter);

  return currentFilter ? [currentFilter, ...otherFilters] : saveFilters;
}

function normalizeSaveExtension(filePath, filterIndex, filters, defaultExtension) {
  const filter = filters[filterIndex || 0];
  const fallbackExtension = defaultExtension || 'md';

  if (filter && filter.extensions[0] === '*') {
    return filePath;
  }

  const selectedExtension = filter ? filter.extensions[0] : fallbackExtension;
  const extension = `.${selectedExtension}`;
  return filePath.slice(0, filePath.length - path.extname(filePath).length) + extension;
}

async function confirmReplaceIfNeeded(originalPath, normalizedPath) {
  if (originalPath === normalizedPath) {
    return true;
  }

  try {
    await fs.access(normalizedPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return true;
    }

    throw error;
  }

  focusMainWindow();
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Replace', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'MiniEditor',
    message: `${path.basename(normalizedPath)} already exists.`,
    detail: `Replacing it will overwrite the current contents in ${path.basename(path.dirname(normalizedPath))}.`
  });

  return result.response === 0;
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function loadMenuState() {
  try {
    const content = await fs.readFile(getSettingsPath(), 'utf8');
    Object.assign(menuState, JSON.parse(content));
    if (Object.prototype.hasOwnProperty.call(menuState, 'markdownMode')) {
      menuState.documentMode = menuState.markdownMode ? 'markdown' : 'plain';
      delete menuState.markdownMode;
    }
    if (!['markdown', 'typst', 'plain'].includes(menuState.documentMode)) {
      menuState.documentMode = 'markdown';
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function saveMenuState() {
  const settingsPath = getSettingsPath();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await replaceFileAtomic(settingsPath, JSON.stringify(menuState, null, 2));
}

function updateMenuChecks() {
  if (!appMenu) {
    return;
  }

  appMenu = Menu.buildFromTemplate(buildAppMenuTemplate());
  Menu.setApplicationMenu(appMenu);
}

function applyThemeToWindow(theme) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const safeTheme = ['system', 'light', 'white', 'dark'].includes(theme) ? theme : 'system';
  mainWindow.webContents.send('menu-theme', safeTheme);
}

function setDocumentModeState(mode) {
  const safeMode = ['markdown', 'typst', 'plain'].includes(mode) ? mode : 'markdown';
  menuState.documentMode = safeMode;
  updateMenuChecks();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu-document-mode', safeMode);
  }
}

function setThemeState(theme) {
  const safeTheme = ['system', 'light', 'white', 'dark'].includes(theme) ? theme : 'system';
  menuState.theme = safeTheme;
  updateMenuChecks();
  applyThemeToWindow(safeTheme);
}

function isHiddenEntry(entryName) {
  return entryName === 'node_modules' || entryName === '.git' || entryName === '.DS_Store';
}

const editableTreeExtensions = new Set([
  'typ', 'md', 'markdown', 'mdown', 'txt',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx',
  'js', 'jsx', 'ts', 'tsx',
  'py', 'rb', 'go', 'rs', 'java', 'cs', 'php', 'swift', 'kt', 'kts',
  'html', 'htm', 'css', 'scss', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini',
  'sh', 'zsh', 'bash', 'sql'
]);

function isEditableTreeFile(entryName) {
  const extension = path.extname(entryName).slice(1).toLowerCase();
  return editableTreeExtensions.has(extension);
}

async function buildFolderTree(rootPath, depth = 0, maxDepth = 4) {
  const stats = await fs.stat(rootPath);

  if (!stats.isDirectory()) {
    return null;
  }

  const name = path.basename(rootPath) || rootPath;
  const node = {
    name,
    path: rootPath,
    kind: 'directory',
    children: [],
    hasEditableDescendant: false
  };

  if (depth >= maxDepth) {
    return node;
  }

  let entries = [];

  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    return node;
  }

  const visibleEntries = entries
    .filter((entry) => !isHiddenEntry(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) {
        return -1;
      }

      if (!a.isDirectory() && b.isDirectory()) {
        return 1;
      }

      return a.name.localeCompare(b.name);
    });

  for (const entry of visibleEntries) {
    const entryPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      const child = await buildFolderTree(entryPath, depth + 1, maxDepth);
      if (child) {
        node.children.push(child);
        if (child.hasEditableDescendant || child.kind === 'file') {
          node.hasEditableDescendant = true;
        }
      }
      continue;
    }

    if (entry.isFile()) {
      if (!isEditableTreeFile(entry.name)) {
        continue;
      }

      node.children.push({
        name: entry.name,
        path: entryPath,
        kind: 'file'
      });
      node.hasEditableDescendant = true;
    }
  }

  if (node.children.length > 0 && !node.hasEditableDescendant) {
    node.children = [];
  }

  return node;
}

async function buildExportHtml(payload) {
  const rawKatexCss = await fs.readFile(path.join(__dirname, '..', 'node_modules', 'katex', 'dist', 'katex.min.css'), 'utf8');
  const katexCss = await inlineKatexFontUrls(rawKatexCss);
  const title = payload.title || 'MiniEditor Export';
  const fontFamily = payload.font === 'serif'
    ? 'Georgia, "Times New Roman", serif'
    : '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const fontSize = Math.max(12, Math.min(28, Number(payload.fontSize) || 15));
  const html = payload.html || '';

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>${katexCss}</style>
    <style>
      body {
        margin: 0;
        background: #ffffff;
        color: #22201c;
        font-family: ${fontFamily};
        font-size: ${fontSize}px;
        line-height: 1.65;
      }

      main {
        max-width: 860px;
        margin: 0 auto;
        padding: 32px 40px 64px;
      }

      h1, h2, h3 {
        line-height: 1.25;
      }

      a {
        color: #095e61;
      }

      blockquote {
        margin-left: 0;
        padding-left: 16px;
        border-left: 4px solid #d8d2c4;
        color: #6f6a60;
      }

      code {
        padding: 2px 5px;
        border-radius: 4px;
        background: #ebe6da;
      }

      pre {
        overflow: auto;
        padding: 14px;
        border-radius: 6px;
        background: #ebe6da;
      }

      pre code {
        padding: 0;
        background: transparent;
      }

      img {
        max-width: 100%;
        height: auto;
        display: block;
        margin: 12px 0;
      }

      table {
        border-collapse: collapse;
      }

      th, td {
        padding: 6px 10px;
        border: 1px solid #d8d2c4;
      }

      .math-block {
        position: relative;
        margin: 1em 0;
        overflow-x: auto;
        text-align: center;
      }

      .equation-number {
        position: absolute;
        right: 0;
        top: 50%;
        color: #6f6a60;
        font-size: 0.92em;
        transform: translateY(-50%);
      }

      .crossref-link {
        color: #095e61;
        font-weight: 600;
        text-decoration: none;
      }

      .crossref-missing {
        color: #b3261e;
        font-weight: 700;
      }

      .figure-block {
        margin: 1.2em 0;
      }

      .figure-block img {
        margin: 0 auto;
      }

      figcaption {
        margin-top: 8px;
        color: #6f6a60;
        font-size: 0.92em;
        text-align: center;
      }

      @media print {
        main {
          max-width: none;
          padding: 0;
        }
      }
    </style>
  </head>
  <body>
    <main>${html}</main>
  </body>
</html>`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 760,
    minHeight: 480,
    title: 'MiniEditor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details.reason, details.exitCode);
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.error('Renderer became unresponsive.');
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('Failed to load:', errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow.webContents.send('app-before-close');
  });
}

function buildAppMenuTemplate() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => mainWindow.webContents.send('menu-new') },
        { label: 'Open...', accelerator: 'CmdOrCtrl+O', click: () => mainWindow.webContents.send('menu-open') },
        { label: 'Open Folder...', accelerator: 'CmdOrCtrl+Shift+O', click: () => mainWindow.webContents.send('menu-open-folder') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => mainWindow.webContents.send('menu-save') },
        { label: 'Save As...', accelerator: 'CmdOrCtrl+Shift+S', click: () => mainWindow.webContents.send('menu-save-as') },
        { type: 'separator' },
        { label: 'Export as PDF...', click: () => mainWindow.webContents.send('menu-export-pdf') },
        { type: 'separator' },
        { label: 'Print...', accelerator: 'CmdOrCtrl+P', click: () => mainWindow.webContents.send('menu-print') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { type: 'separator' },
        { label: 'Find...', accelerator: 'CmdOrCtrl+F', click: () => mainWindow.webContents.send('menu-find') },
        { label: 'Find Next', accelerator: 'F3', click: () => mainWindow.webContents.send('menu-find-next') },
        { label: 'Find Previous', accelerator: 'Shift+F3', click: () => mainWindow.webContents.send('menu-find-previous') },
        { label: 'Replace...', accelerator: 'CmdOrCtrl+H', click: () => mainWindow.webContents.send('menu-replace') },
        { type: 'separator' },
        { role: 'selectAll' },
        { label: 'Time/Date', accelerator: 'F5', click: () => mainWindow.webContents.send('menu-time-date') }
      ]
    },
    {
      label: 'Format',
      submenu: [
        {
          label: 'Word Wrap',
          id: 'wordWrap',
          type: 'checkbox',
          checked: menuState.wordWrap,
          click: (menuItem) => {
            menuState.wordWrap = menuItem.checked;
            saveMenuState().catch(() => {});
            mainWindow.webContents.send('menu-word-wrap', menuItem.checked);
          }
        },
        {
          label: 'Document Mode',
          submenu: [
            {
              label: 'Markdown',
              id: 'documentModeMarkdown',
              type: 'radio',
              checked: menuState.documentMode === 'markdown',
              click: () => {
                setDocumentModeState('markdown');
                saveMenuState().catch(() => {});
              }
            },
            {
              label: 'Typst',
              id: 'documentModeTypst',
              type: 'radio',
              checked: menuState.documentMode === 'typst',
              click: () => {
                setDocumentModeState('typst');
                saveMenuState().catch(() => {});
              }
            },
            {
              label: 'Plain Text',
              id: 'documentModePlain',
              type: 'radio',
              checked: menuState.documentMode === 'plain',
              click: () => {
                setDocumentModeState('plain');
                saveMenuState().catch(() => {});
              }
            }
          ]
        },
        { type: 'separator' },
        { label: 'Sans', click: () => mainWindow.webContents.send('menu-font', 'sans') },
        { label: 'Serif', click: () => mainWindow.webContents.send('menu-font', 'serif') },
        { label: 'Mono', click: () => mainWindow.webContents.send('menu-font', 'mono') },
        { type: 'separator' },
        { label: 'Increase Size', accelerator: 'CmdOrCtrl+=', click: () => mainWindow.webContents.send('menu-font-size', 'increase') },
        { label: 'Decrease Size', accelerator: 'CmdOrCtrl+-', click: () => mainWindow.webContents.send('menu-font-size', 'decrease') },
        { label: 'Reset Size', accelerator: 'CmdOrCtrl+0', click: () => mainWindow.webContents.send('menu-font-size', 'reset') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Preview', accelerator: 'CmdOrCtrl+Shift+P', click: () => mainWindow.webContents.send('menu-toggle-preview') },
        {
          label: 'Status Bar',
          id: 'statusBar',
          type: 'checkbox',
          checked: menuState.statusBar,
          click: (menuItem) => {
            menuState.statusBar = menuItem.checked;
            saveMenuState().catch(() => {});
            mainWindow.webContents.send('menu-status-bar', menuItem.checked);
          }
        },
        {
          label: 'Folder Tree',
          id: 'folderTree',
          type: 'checkbox',
          checked: menuState.folderTree,
          click: (menuItem) => {
            menuState.folderTree = menuItem.checked;
            saveMenuState().catch(() => {});
            mainWindow.webContents.send('menu-folder-tree', menuItem.checked);
          }
        },
        {
          label: 'Line Numbers',
          id: 'lineNumbers',
          type: 'checkbox',
          checked: menuState.lineNumbers,
          click: (menuItem) => {
            menuState.lineNumbers = menuItem.checked;
            saveMenuState().catch(() => {});
            mainWindow.webContents.send('menu-line-numbers', menuItem.checked);
          }
        },
        {
          label: 'Theme',
          submenu: [
            {
              label: 'System',
              id: 'themeSystem',
              type: 'radio',
              checked: menuState.theme === 'system',
              click: () => {
                setThemeState('system');
                saveMenuState().catch(() => {});
              }
            },
            {
              label: 'Light',
              id: 'themeLight',
              type: 'radio',
              checked: menuState.theme === 'light',
              click: () => {
                setThemeState('light');
                saveMenuState().catch(() => {});
              }
            },
            {
              label: 'White',
              id: 'themeWhite',
              type: 'radio',
              checked: menuState.theme === 'white',
              click: () => {
                setThemeState('white');
                saveMenuState().catch(() => {});
              }
            },
            {
              label: 'Dark',
              id: 'themeDark',
              type: 'radio',
              checked: menuState.theme === 'dark',
              click: () => {
                setThemeState('dark');
                saveMenuState().catch(() => {});
              }
            }
          ]
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About MiniEditor',
          click: () => {
            focusMainWindow();
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About MiniEditor',
              message: 'MiniEditor',
              detail: 'A minimal Markdown editor with math preview, export, and Notepad-style editing tools.'
            });
          }
        }
      ]
    }
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: 'MiniEditor',
      submenu: [
        { label: 'About MiniEditor', role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit MiniEditor', role: 'quit' }
      ]
    });
  }

  return template;
}

function createApplicationMenu() {
  appMenu = Menu.buildFromTemplate(buildAppMenuTemplate());
  Menu.setApplicationMenu(appMenu);
}

ipcMain.handle('file-open', async () => {
  focusMainWindow();
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Text and Source Files', extensions: ['typ', 'md', 'markdown', 'mdown', 'txt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'cs', 'php', 'swift', 'kt', 'kts', 'html', 'htm', 'css', 'scss', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'sh', 'zsh', 'bash', 'sql'] },
      { name: 'Typst', extensions: ['typ'] },
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown'] },
      { name: 'Plain Text', extensions: ['txt'] },
      { name: 'C/C++', extensions: ['c', 'h', 'cpp', 'hpp', 'cc', 'cxx'] },
      { name: 'Web', extensions: ['html', 'htm', 'css', 'scss', 'js', 'jsx', 'ts', 'tsx', 'json'] },
      { name: 'Scripts', extensions: ['py', 'rb', 'sh', 'zsh', 'bash'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const content = await readEditableTextFile(filePath);
  if (content === null) {
    return null;
  }

  return { filePath, content };
});

ipcMain.handle('file-open-path', async (_event, filePath) => {
  const content = await readEditableTextFile(filePath);
  if (content === null) {
    return null;
  }

  return { filePath, content };
});

ipcMain.handle('pick-folder', async () => {
  focusMainWindow();
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return { folderPath: result.filePaths[0] };
});

ipcMain.handle('read-folder-tree', async (_event, folderPath) => {
  return buildFolderTree(folderPath);
});

function resolveDocumentAssetPath(documentPath, source) {
  if (!documentPath || !source || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(source)) {
    return null;
  }

  return path.isAbsolute(source)
    ? source
    : path.resolve(path.dirname(documentPath), source);
}

function getBibtexKeys(content) {
  const keys = new Set();
  const entryPattern = /@\w+\s*\{\s*([^,\s]+)\s*,/g;

  for (const match of content.matchAll(entryPattern)) {
    keys.add(match[1]);
  }

  return keys;
}

ipcMain.handle('research-check-files', async (_event, payload = {}) => {
  const documentPath = payload.documentPath || null;
  const imageSources = Array.isArray(payload.imageSources) ? payload.imageSources : [];
  const citationKeys = Array.isArray(payload.citationKeys) ? payload.citationKeys : [];
  const images = [];

  for (const source of imageSources) {
    const filePath = resolveDocumentAssetPath(documentPath, source);
    if (!filePath) {
      continue;
    }

    try {
      await fs.access(filePath);
      images.push({ source, exists: true });
    } catch (_error) {
      images.push({ source, exists: false });
    }
  }

  if (!documentPath || citationKeys.length === 0) {
    return {
      images,
      citations: {
        refsFound: false,
        missingKeys: []
      }
    };
  }

  const bibPath = path.join(path.dirname(documentPath), 'refs.bib');

  try {
    const bibContent = await fs.readFile(bibPath, 'utf8');
    const keys = getBibtexKeys(bibContent);
    return {
      images,
      citations: {
        refsFound: true,
        missingKeys: citationKeys.filter((key) => !keys.has(key))
      }
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return {
      images,
      citations: {
        refsFound: false,
        missingKeys: citationKeys
      }
    };
  }
});

ipcMain.handle('typst-preview-render', async (_event, payload = {}) => {
  return compileTypstPreview(payload);
});

ipcMain.handle('typst-export-pdf', async (_event, payload = {}) => {
  const defaultName = payload.defaultName || 'untitled.pdf';
  focusMainWindow();
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  const compiled = await compileTypstDocument(payload, 'pdf');
  if (!compiled.available || !compiled.pdf) {
    return null;
  }

  await fs.writeFile(result.filePath, Buffer.from(compiled.pdf, 'base64'));
  return { filePath: result.filePath };
});

ipcMain.handle('typst-outline', async (_event, payload = {}) => {
  const client = getTypstLspClient();
  if (!client) {
    return { available: false, items: [] };
  }

  try {
    return await client.getDocumentAnalysis(payload.documentPath || null, payload.source || '');
  } catch (error) {
    console.error('Typst outline failed:', error);
    return { available: false, items: [], message: error.message || 'Typst outline failed.' };
  }
});

ipcMain.handle('file-save', async (_event, payload) => {
  let filePath = payload.filePath;

  if (!filePath || payload.saveAs) {
    const defaultExtension = payload.defaultExtension || 'md';
    const filters = buildSaveFilters(defaultExtension);
    focusMainWindow();
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filePath || payload.defaultPath || 'untitled.md',
      filters
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    const normalizedPath = normalizeSaveExtension(result.filePath, result.filterIndex, filters, defaultExtension);

    if (!(await confirmReplaceIfNeeded(result.filePath, normalizedPath))) {
      return null;
    }

    filePath = normalizedPath;
  }

  await fs.writeFile(filePath, payload.content, 'utf8');
  return { filePath };
});

ipcMain.handle('confirm-close', async (_event, payload) => {
  const action = payload.action || 'close';
  const verb = action === 'new'
    ? 'creating a new file'
    : action === 'open'
      ? 'opening another file'
      : 'closing';

  focusMainWindow();
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'MiniEditor',
    message: `Do you want to save changes to ${payload.fileName || 'untitled'}?`,
    detail: `Save the current file before ${verb}? Unsaved changes will be lost if you do not save them.`
  });

  return result.response === 0 ? 'save' : result.response === 1 ? 'discard' : 'cancel';
});

ipcMain.handle('menu-state-read', () => menuState);

ipcMain.handle('menu-state-write', async (_event, state) => {
  Object.assign(menuState, state);
  if (!['markdown', 'typst', 'plain'].includes(menuState.documentMode)) {
    menuState.documentMode = 'markdown';
  }
  updateMenuChecks();
  if (Object.prototype.hasOwnProperty.call(state, 'theme')) {
    applyThemeToWindow(menuState.theme);
  }
  await saveMenuState();
  return menuState;
});

function popupContextMenu(event, kind, payload = {}) {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  focusMainWindow();
  let template = [];

  if (kind === 'app') {
    if (appMenu) {
      updateMenuChecks();
      appMenu.popup({ window: sourceWindow });
    }
    return;
  }

  if (kind === 'editor') {
    template = [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'delete' },
      { type: 'separator' },
      { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find...', click: () => event.sender.send('menu-find') },
      { label: 'Replace...', click: () => event.sender.send('menu-replace') },
      { label: 'Time/Date', click: () => event.sender.send('menu-time-date') }
    ];
  } else if (kind === 'preview') {
    template = [
      { role: 'copy' },
      { type: 'separator' },
      { label: 'Export as PDF...', click: () => event.sender.send('preview-export-pdf') },
      { label: 'Print...', click: () => event.sender.send('menu-print') }
    ];
  } else if (kind === 'tree-file') {
    template = [
      { label: 'Open', click: () => event.sender.send('context-open-tree-file', payload.path) },
      { label: 'Open Folder...', click: () => event.sender.send('menu-open-folder') },
      { label: 'Copy Path', click: () => clipboard.writeText(payload.path || '') },
      { type: 'separator' },
      { label: 'Refresh Tree', click: () => event.sender.send('context-refresh-folder-tree') }
    ];
  } else {
    template = [
      { label: 'Open Folder...', click: () => event.sender.send('menu-open-folder') },
      { label: 'Refresh Tree', click: () => event.sender.send('context-refresh-folder-tree') }
    ];
  }

  Menu.buildFromTemplate(template).popup({ window: sourceWindow });
}

ipcMain.on('preview-context-menu', (event) => {
  popupContextMenu(event, 'preview');
});

ipcMain.on('show-context-menu', (event, payload = {}) => {
  popupContextMenu(event, payload.kind || 'editor', payload);
});

ipcMain.handle('export-pdf', async (_event, payload) => {
  const defaultName = payload.defaultName || 'untitled.pdf';
  focusMainWindow();
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  const exportWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  let temporaryDirectory = null;

  try {
    const html = await buildExportHtml(payload);
    temporaryDirectory = await fs.mkdtemp(path.join(app.getPath('temp'), 'mini-editor-export-'));
    const temporaryHtmlPath = path.join(temporaryDirectory, 'preview.html');

    await fs.writeFile(temporaryHtmlPath, html, 'utf8');
    await exportWindow.loadFile(temporaryHtmlPath);
    await exportWindow.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true');
    const pdf = await exportWindow.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: {
        marginType: 'default'
      }
    });

    await replaceFileAtomic(result.filePath, pdf);
    return { filePath: result.filePath };
  } finally {
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }

    exportWindow.destroy();
  }
});

ipcMain.handle('print-preview', async (_event, payload) => {
  const exportWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  let temporaryDirectory = null;

  try {
    const html = await buildExportHtml(payload);
    temporaryDirectory = await fs.mkdtemp(path.join(app.getPath('temp'), 'mini-editor-print-'));
    const temporaryHtmlPath = path.join(temporaryDirectory, 'preview.html');

    await fs.writeFile(temporaryHtmlPath, html, 'utf8');
    await exportWindow.loadFile(temporaryHtmlPath);
    await exportWindow.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true');
    exportWindow.webContents.print({});
    return { printed: true };
  } finally {
    if (temporaryDirectory) {
      setTimeout(() => {
        fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      }, 30000);
    }

    setTimeout(() => exportWindow.destroy(), 30000);
  }
});

ipcMain.handle('autosave-write', async (_event, payload) => {
  const autosavePath = getAutosavePath();
  const session = {
    filePath: payload.filePath || null,
    content: payload.content || '',
    selectionStart: Number(payload.selectionStart) || 0,
    selectionEnd: Number(payload.selectionEnd) || 0,
    savedContent: payload.savedContent || '',
    savedAt: new Date().toISOString()
  };

  await fs.mkdir(path.dirname(autosavePath), { recursive: true });
  await replaceFileAtomic(autosavePath, JSON.stringify(session, null, 2));
  return { savedAt: session.savedAt };
});

ipcMain.handle('autosave-read', async () => {
  try {
    const content = await fs.readFile(getAutosavePath(), 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
});

ipcMain.handle('autosave-clear', async () => {
  await fs.rm(getAutosavePath(), { force: true });
  return { cleared: true };
});

ipcMain.handle('close-window', () => {
  if (mainWindow) {
    isQuitting = true;
    mainWindow.destroy();
  }
});

ipcMain.handle('set-title', (_event, title) => {
  if (mainWindow) {
    mainWindow.setTitle(title);
  }
});

app.whenReady().then(async () => {
  await loadMenuState();
  createWindow();
  createApplicationMenu();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
