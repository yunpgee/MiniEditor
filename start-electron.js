const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const electronPackageRoot = path.join(projectRoot, 'node_modules', 'electron', 'dist');

function buildLaunchEnv() {
  const env = { ...process.env };
  const homeDirectory = process.env.HOME || process.env.USERPROFILE || '';
  const homeBin = path.join(homeDirectory, '.local', 'bin');
  if (homeBin && fs.existsSync(homeBin)) {
    const currentPath = env.PATH || '';
    env.PATH = currentPath ? `${homeBin}${path.delimiter}${currentPath}` : homeBin;
  }
  return env;
}

function getElectronExecutable() {
  if (process.platform === 'darwin') {
    const cacheRoot = '/private/tmp/minieditor-electron';
    const sourceApp = path.join(electronPackageRoot, 'Electron.app');
    const cachedApp = path.join(cacheRoot, 'Electron.app');

    fs.mkdirSync(cacheRoot, { recursive: true });

    let needsCopy = true;
    try {
      const sourceStat = fs.statSync(sourceApp);
      const cachedStat = fs.statSync(cachedApp);
      needsCopy = sourceStat.mtimeMs > cachedStat.mtimeMs;
    } catch (_error) {
      needsCopy = true;
    }

    if (needsCopy) {
      fs.rmSync(cachedApp, { recursive: true, force: true });
      const copy = spawnSync('ditto', ['--norsrc', '--noextattr', sourceApp, cachedApp], {
        stdio: 'inherit'
      });

      if (copy.status !== 0) {
        throw new Error('Failed to prepare a clean Electron.app copy for launch.');
      }
    }

    return path.join(cachedApp, 'Contents', 'MacOS', 'Electron');
  }

  if (process.platform === 'win32') {
    return path.join(electronPackageRoot, 'electron.exe');
  }

  return path.join(electronPackageRoot, 'electron');
}

function main() {
  const electronExecutable = getElectronExecutable();
  const child = spawn(electronExecutable, [projectRoot, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: projectRoot,
    env: buildLaunchEnv()
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exitCode = code ?? 0;
  });
}

main();
