/**
 * Claude Code PostToolUse hook. After each file edit it:
 *  1. formats the file with Prettier (when dev dependencies are installed),
 *  2. syntax-checks JavaScript,
 *  3. rejects private terms and personal paths, so client data never reaches a commit.
 *
 * Exit code 2 sends the message on stderr back to Claude, which then has to fix the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, privateTerms, genericProblems } from '../lib.mjs';

const FORMATTABLE = /\.(m?js|json|html|css|md)$/;
const SCANNED = /\.(m?js|json|html|css|md|txt)$/;
const PRETTIER_BIN = path.join(ROOT, 'node_modules', 'prettier', 'bin', 'prettier.cjs');

/**
 * Reads the hook payload Claude Code sends on stdin.
 *
 * @returns {Promise<string | undefined>} Absolute path of the edited file, if any.
 */
async function readEditedFilePath() {
  let payload = '';
  for await (const chunk of process.stdin) payload += chunk;
  return JSON.parse(payload || '{}').tool_input?.file_path;
}

/**
 * Formats a file in place. Skipped silently when Prettier is not installed yet.
 *
 * @param {string} filePath
 * @returns {string | null} Prettier's error output when the file could not be parsed.
 */
function formatFile(filePath) {
  if (!FORMATTABLE.test(filePath) || !fs.existsSync(PRETTIER_BIN)) return null;
  try {
    execFileSync(process.execPath, [PRETTIER_BIN, '--write', '--log-level', 'warn', filePath], {
      stdio: 'pipe',
    });
    return null;
  } catch (error) {
    return String(error.stderr).trim();
  }
}

/**
 * Parses a JavaScript file without running it.
 *
 * @param {string} filePath
 * @returns {string | null} The syntax error, if any.
 */
function syntaxError(filePath) {
  if (!/\.m?js$/.test(filePath)) return null;
  try {
    execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
    return null;
  } catch (error) {
    return String(error.stderr).trim();
  }
}

const filePath = await readEditedFilePath();
if (!filePath || !fs.existsSync(filePath)) process.exit(0);
const relativePath = path.relative(ROOT, filePath);
const outsideProject = relativePath.startsWith('..');
const isIgnored = relativePath.startsWith('private') || relativePath.startsWith('node_modules');
if (outsideProject || isIgnored) process.exit(0);

const problems = [formatFile(filePath), syntaxError(filePath)].filter(Boolean);
// lib.mjs holds the personal-path pattern itself, so it would always match.
if (SCANNED.test(filePath) && relativePath !== path.join('scripts', 'lib.mjs')) {
  const text = fs.readFileSync(filePath, 'utf8');
  for (const problem of genericProblems(text, privateTerms())) {
    problems.push(`${relativePath}: ${problem}`);
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(2);
}
