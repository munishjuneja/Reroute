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
