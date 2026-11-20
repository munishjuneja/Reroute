@AGENTS.md

## Claude Code specifics

- Skills in `.claude/skills/`: `test-extension` (writing and running tests), `change-rule-engine` (adding a rule type,
  action or field — the cross-file checklist), `security-review` (the invariants as a checklist), `release`
  (user-invoked only: `/release`).
- Subagent `security-reviewer` (`.claude/agents/`) reviews a diff against the security invariants. Use it before
  finishing any change to `background.js`, `page/`, the manifest, import/export or permissions.
- A PostToolUse hook (`scripts/hooks/after-edit.mjs`) syntax-checks each edited JS file and rejects private terms
  or personal paths. If it blocks an edit, fix the file — do not work around the hook.
- Never read, quote or copy anything from `private/` into other files, commits or PR text.

## Using tokens economically

- Verify with `npm run verify` (one line per step, details only on failure), not `npm test`. Scope it:
  `npm run verify -- unit` after `core.js` changes, `npm run verify -- tests/e2e/<file>` for one file. For the
  full end-to-end run, use the `test-runner` agent so its output stays out of this conversation.
- Lint with `npx eslint --quiet --format unix <files>` (errors only, one line each), never the whole repo
  unless asked.
- Find before reading: `Grep` for the function or name, then `Read` only that range of large files
  (`options.js`, `core.js`, `background.js`). Do not re-read a file after editing it.
- Do not read `package-lock.json`, `node_modules/`, `dist/` or icons (blocked in settings).
- Keep replies short: what changed and the verify result. No diff recaps, no restating file contents.
- One task per session. After each committed file in a multi-file job, the user may `/clear`; leave the repo in a
  state where `git log` and the task description are enough to continue.
