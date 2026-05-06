const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const bundledBinDir = path.join(projectRoot, 'resources', 'bin');
const bundledTinymistPath = path.join(bundledBinDir, process.platform === 'win32' ? 'tinymist.exe' : 'tinymist');

function commandWorks(command) {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return result.status === 0;
}

function findTinymist() {
  const executableName = process.platform === 'win32' ? 'tinymist.exe' : 'tinymist';
  const homeDirectory = process.env.HOME || process.env.USERPROFILE || '';
  const homeBin = homeDirectory ? path.join(homeDirectory, '.local', 'bin') : null;
  const localAppDataBin = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'tinymist') : null;
  const candidates = [
    ...(homeBin ? [path.join(homeBin, executableName)] : []),
    ...(localAppDataBin ? [path.join(localAppDataBin, executableName)] : []),
    'tinymist'
  ];

  return candidates.find(commandWorks) || null;
}

function main() {
  const source = findTinymist();
  if (!source) {
    console.warn('Tinymist was not found. The packaged app will fall back to system tinymist/typst if available.');
    return;
  }

  fs.mkdirSync(bundledBinDir, { recursive: true });
  fs.copyFileSync(source, bundledTinymistPath);

  if (process.platform !== 'win32') {
    fs.chmodSync(bundledTinymistPath, 0o755);
  }

  console.log(`Bundled Tinymist: ${source} -> ${bundledTinymistPath}`);
}

main();
