const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const targets = [
  'dist',
  '.DS_Store',
  path.join('dist', '.DS_Store'),
  path.join('resources', 'bin', 'tinymist'),
  path.join('resources', 'bin', 'tinymist.exe')
];

for (const target of targets) {
  const fullPath = path.join(projectRoot, target);
  fs.rmSync(fullPath, { recursive: true, force: true });
  console.log(`Removed ${target}`);
}
