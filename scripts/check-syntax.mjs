// Parses every JavaScript file in the repo without running it.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, walk } from './lib.mjs';

let bad = 0;
for (const f of walk().filter((f) => /\.m?js$/.test(f))) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    console.error(`${path.relative(ROOT, f)}\n${e.stderr}`);
    bad++;
  }
}
if (bad) process.exit(1);
console.log('check-syntax: ok');
