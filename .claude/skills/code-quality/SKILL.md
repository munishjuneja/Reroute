---
name: code-quality
description: How to write, review or refactor Reroute code so it is readable — naming, JSDoc, comments, function size, formatting and lint. Use whenever writing new code, changing existing functions, cleaning up a file, or when the user asks for a refactor or code review.
---

# Writing readable Reroute code

The rules live in `CONTRIBUTING.md` › Code style; read it before your first change in a session. This skill is
the workflow for applying them.

## When writing or changing code

1. Read the surrounding function and `extension/types.js` so you reuse existing names and types.
2. Name things for what they hold or do (`matchedRule`, `buildRedirect()`), never by single letters or private
   abbreviations.
3. Write the JSDoc block first: if you cannot say in one sentence what the function does for its caller, the
   function is doing too much — split it.
4. Add a comment only where the reason is not visible in the code: a Chrome quirk, a security constraint, an
   ordering requirement, why an error is ignored.
5. Pull meaningful numbers and strings into named constants at the top of the file.
6. The edit hook formats with Prettier. Then run `npx eslint --quiet --format unix` and fix every problem inside
   the functions you added or changed.
7. Run the tests that cover the file (see the `test-extension` skill).

## When refactoring for readability

Refactors change names and structure, never behaviour.

1. Start from a green `npm test`. If it is not green, stop and report.
2. Work one file at a time, in this order of risk: `core.js` (unit-tested, safest), `popup.js`, `options.js`,
   `page/bridge.js`, `page/interceptor.js`, `background.js`.
3. Inside a file: add JSDoc and rename local variables first, then split long functions, then extract constants.    Files over 400 lines (`options.js`) are split into focused modules, e.g. `options/editor.js`,
   `options/import-export.js`; update the `<script>` tag and keep `options.js` as the entry point.
4. **Do not rename anything persisted or shared across contexts**: storage keys (`rrConfig`, `rrSettings`,
   `rrPage`, `rrRuntime`, `rrLog`, `rrCaptures`, `rrRec`, `rrDebugTabs`), config and rule field names, rule
   types, action kinds, `rr:` runtime messages and page event names, `data-*` attributes the tests use, and DOM
   ids referenced from HTML. Renaming an exported function means updating every import, including tests.
5. `siteOf()` is duplicated in `core.js` and `page/bridge.js`; keep both copies identical (a unit test checks).
6. After each file: `npx eslint --quiet --format unix <file>`, then `npm run verify` (or the `test-runner`
   agent). Commit per file with `refactor(<file>): …`..
   Afterwards Run npx prettier --write . so the edited files match the formatting check, then npm run verify. You should see five ok lines.
7. Do not change behaviour, user-facing text or test expectations in a refactor. If you find a bug, note it and
   fix it in a separate commit with its own test.

## Reviewing code

Check, in this order: correctness and tests; security invariants (use the `security-reviewer` agent for
security-relevant files); then readability — would a newcomer understand each name, does each function have one
job and an honest JSDoc, do comments explain why. Quote the line and propose the better version.
