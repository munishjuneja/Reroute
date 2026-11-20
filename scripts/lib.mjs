// Shared helpers for the repo scripts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'private']);
const TEXT = /\.(m?js|json|html|css|md|txt|ya?ml)$/i;

export function walk(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (TEXT.test(e.name)) out.push(p);
  }
  return out;
}

// Words that must never be committed (client names, internal hosts…), one per line,
// kept in the git-ignored private/terms.txt.
export function privateTerms() {
  const f = path.join(ROOT, 'private', 'terms.txt');
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
}

// Problems in one file's text: private terms and personal machine paths.
export function genericProblems(text, terms) {
  const out = [];
  for (const t of terms || []) if (text.toLowerCase().includes(t.toLowerCase())) out.push(`contains private term "${t}"`);
  const home = text.match(/(\/Users\/[\w.-]+|[A-Z]:\\\\?Users\\\\?[\w.-]+|\/home\/[\w.-]+)/);
  if (home) out.push(`contains a personal path "${home[0]}"`);
  return out;
}
