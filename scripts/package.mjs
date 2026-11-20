// Builds dist/reroute-<version>.zip from extension/ for the Chrome Web Store.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: manifest ${manifest.version}, package.json ${pkg.version}.`);
  process.exit(1);
}
if (manifest.host_permissions?.length) {
  console.error('manifest.json has host_permissions — site access must stay optional (optional_host_permissions).');
  process.exit(1);
}
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', `reroute-${manifest.version}.zip`);
fs.rmSync(out, { force: true });
execFileSync('zip', ['-qr', '-X', out, '.', '-x', '.*'], { cwd: path.join(ROOT, 'extension'), stdio: 'inherit' });
console.log('Built', path.relative(ROOT, out));
