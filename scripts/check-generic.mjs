// Fails if anything outside private/ mentions a private term or a personal path.
// Run before every commit; the PostToolUse hook runs the same check on each edit.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, walk, privateTerms, genericProblems } from './lib.mjs';

const terms = privateTerms();
if (!terms) console.warn('check-generic: private/terms.txt not found — only checking for personal paths.');
let bad = 0;
for (const f of walk()) {
  if (f.endsWith(path.join('scripts', 'lib.mjs'))) continue;
  for (const p of genericProblems(fs.readFileSync(f, 'utf8'), terms)) { console.error(`${path.relative(ROOT, f)}: ${p}`); bad++; }
}
for (const f of walk()) {
  if (/rules.*\.json$/i.test(path.basename(f)) && !f.includes(`${path.sep}tests${path.sep}`)) { console.error(`${path.relative(ROOT, f)}: rules files belong in private/`); bad++; }
}
if (bad) { console.error(`check-generic: ${bad} problem(s).`); process.exit(1); }
console.log('check-generic: ok');
