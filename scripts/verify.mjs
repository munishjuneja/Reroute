/**
 * Compact version of `npm test` for coding agents and CI logs: runs every check and test,
 * prints one line per step, and shows details only for what failed. Same checks as
 * `npm test`, a fraction of the output.
 *
 * Usage: npm run verify [-- unit|e2e|check] [-- <test file>]
 *   npm run verify               everything
 *   npm run verify -- unit       syntax/format checks + unit tests only
 *   npm run verify -- tests/e2e/ui.test.mjs   one test file
 */
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

const MAX_FAILURE_LINES = 60;
const argument = process.argv[2] || 'all';

const CHECK_STEPS = [
  ['syntax', ['node', 'scripts/check-syntax.mjs']],
  ['generic', ['node', 'scripts/check-generic.mjs']],
  ['format', ['npx', 'prettier', '--check', '--log-level', 'warn', '.']],
];
const UNIT_STEP = ['unit', ['node', '--test', '--test-reporter=dot', 'tests/unit/*.test.mjs']];
const E2E_STEP = [
  'e2e',
  ['node', '--test', '--test-reporter=dot', '--test-concurrency=1', 'tests/e2e/*.test.mjs'],
];

/**
 * Picks the steps to run from the command-line argument.
 *
 * @param {string} choice 'all', 'check', 'unit', 'e2e' or a test file path.
 * @returns {[string, string[]][]} Step names with their commands.
 */
function stepsFor(choice) {
  if (choice === 'check') return CHECK_STEPS;
  if (choice === 'unit') return [...CHECK_STEPS, UNIT_STEP];
  if (choice === 'e2e') return [E2E_STEP];
  if (choice.endsWith('.mjs')) {
    return [[choice, ['node', '--test', '--test-reporter=dot', '--test-concurrency=1', choice]]];
  }
  return [...CHECK_STEPS, UNIT_STEP, E2E_STEP];
}

/**
 * Keeps the useful part of a failing step's output: failure details, without stack frames
 * from node internals or the test runner.
 *
 * @param {string} output Combined stdout and stderr.
 * @returns {string} At most MAX_FAILURE_LINES lines.
 */
function failureSummary(output) {
  const lines = output
    .split('\n')
    .filter((line) => line.trim() && !/^\s*at .*(node:|node_modules)/.test(line))
    .filter((line) => !/^[.X]+$/.test(line.trim()))
    // The assertion message already shows actual vs expected; drop the error object dump.
    .filter(
      (line) => !/^\s+(generatedMessage|code|actual|expected|operator|diff):|^\s+}$/.test(line),
    );
  const trimmed = lines.slice(0, MAX_FAILURE_LINES);
  if (lines.length > MAX_FAILURE_LINES) {
    trimmed.push(`… ${lines.length - MAX_FAILURE_LINES} more lines`);
  }
  return trimmed.join('\n');
}

let failedSteps = 0;
for (const [name, [command, ...args]] of stepsFor(argument)) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`ok   ${name} (${seconds}s)`);
    continue;
  }
  failedSteps++;
  console.log(`FAIL ${name} (${seconds}s)`);
  console.log(failureSummary(`${result.stdout}\n${result.stderr}`));
}
process.exit(failedSteps ? 1 : 0);
