# Contributing to Reroute

Reroute runs with powerful browser permissions and will be read by people deciding whether to trust it. Code
here is written to be read first: a newcomer should understand any function without running it.

## Workflow

1. `npm install && npx playwright install chromium`, then `npm test` to start from green.
2. Work on a branch. Keep each change to one purpose; a refactor and a feature are two pull requests.
3. Write or update tests with the change (see [Tests](#tests)).
4. `npm run format`, `npm run lint` on the files you touched, `npm test`.
5. Commit with a [Conventional Commit](https://www.conventionalcommits.org/) message and open a pull request using
   the template.

## Code style

### Formatting

Prettier owns formatting (2-space indent, single quotes, 100-column lines). Never hand-format or argue about
layout; run `npm run format`. `.editorconfig` sets the same basics for any editor.

### Names

Names are the main documentation. A reader should know what a value holds without looking up where it came from.

| Kind                 | Style                               | Examples                                               |
| -------------------- | ----------------------------------- | ------------------------------------------------------ |
| Variables, functions | `camelCase`, full words             | `matchedRule`, `pageHostname`, `compileRule()`         |
| Booleans             | reads as a yes/no question          | `isEnabled`, `hasSiteAccess`, `needsRequestBody`       |
| Functions            | verb first                          | `buildRedirect()`, `findWinningRule()`, `isSameSite()` |
| Constants            | `UPPER_SNAKE_CASE` for fixed values | `MAX_CAPTURED_BODY_BYTES`, `RESOURCE_TYPES`            |
| Event handlers       | `on` + event                        | `onRequestPaused()`, `onImportFileChosen()`            |

- No single-letter names except `i`/`j` loop indexes and `_` for an unused parameter. `rule`, not `r`;
  `config`, not `c`; `group`, not `g`; `element`, not `el`.
- No abbreviations a newcomer would have to decode (`dnr`, `rx`, `acts`, `st`, `diag`). Spell them out:
  `networkRules`, `pattern`, `actions`, `status`, `diagnostics`. Domain acronyms used in Chrome's own API
  names are fine inside identifiers that mirror that API (`dnrRule` for a declarativeNetRequest rule object).
- Name units: `delayMs`, `timeoutSeconds`, `maxBodyBytes`.
- The same thing has the same name everywhere. A rule's URL pattern is always `match`; the page's hostname is
  always `pageHostname`.

```js
// Avoid
const c = await getCache();
for (const r of c.live)
  if (c.re[r.id]?.test(u) && whenOk(r, ctx)) (r.type === 'rewrite' ? rw : t).push(r);

// Prefer
const { liveRules, patternsByRuleId } = await getCompiledState();
for (const rule of liveRules) {
  const matchesUrl = patternsByRuleId[rule.id]?.test(requestUrl);
  if (!matchesUrl || !conditionsMet(rule, requestContext)) continue;
  if (rule.type === 'rewrite') rewriteRules.push(rule);
  else terminalRules.push(rule);
}
```

### Functions

- One job per function. If you need "and" to describe it, split it.
- Aim for under 40 lines; ESLint warns at 60 and at a complexity of 12.
- At most 3 positional parameters; pass an options object beyond that.
- Return early for edge cases instead of nesting. ESLint allows nesting at most 3 blocks deep.
- No nested ternaries. One ternary for a simple choice is fine.
- Pure logic (no `chrome.*`, no DOM) lives in `core.js`, so it can be unit-tested.
- Do not mutate arguments unless the function's name and JSDoc say it does (`armAutoOff(settings)` does).

### JSDoc

Every function declaration and every exported function has a JSDoc block. Arrow functions get one when they
have a block body or are exported. Use the shared types in `extension/types.js`.

```js
/**
 * Works out where a map-remote rule sends a request.
 *
 * Wildcard rules copy the text matched by each `*` into the matching `*` of the
 * destination; regex rules use `$1`, `$2`… as written.
 *
 * @param {import('./types.js').Rule} rule A map-remote rule.
 * @param {string} requestUrl The URL the page asked for.
 * @returns {string | null} The rewritten URL, or null when the rule's pattern is invalid.
 */
export function destinationFor(rule, requestUrl) { … }
```

- The first sentence says what the function does for its caller, not how.
- Document every parameter and the return value with a type. Describe them when the name and type are not enough.
- Note side effects (`Writes rrLog in session storage.`), thrown errors (`@throws`) and anything surprising.
- Files start with a short comment saying what the file is responsible for and what it must not do.

### Comments

Comments explain **why**: a constraint, a browser quirk, a security reason, a decision that looks wrong but isn't.
The code already says what it does.

```js
// Good: explains a constraint the code cannot show
// loadingFinished only fires once the page reads the body, so also capture on a timer.

// Bad: repeats the code
// set status to the response status
recorded.status = response.status;
```

- Every `catch` that ignores an error says why that is safe: `catch { /* tab was closed */ }`.
- Mark security-relevant code with the invariant it protects: `// Security: pages only get their own answer.`
- No commented-out code; git keeps history. `TODO:` comments name what is missing and link an issue.

### Control flow and errors

- `async`/`await` over `.then()` chains.
- Never swallow errors silently. Either handle them, report them to the user (`rrRuntime.errors`), or comment why
  ignoring them is safe.
- Validate data at the edges: imported files (`normalizeConfig`), messages from content scripts, page events.
  Inside the code, trust the shapes in `types.js`.
- Use `===`; `== null` is allowed for "null or undefined".

### Constants and magic values

Name every number or string that has meaning: `const CAPTURE_FALLBACK_DELAY_MS = 1500`, not `setTimeout(fn, 1500)`.
Storage keys and message types are defined once and imported, never retyped.

### Compatibility

Anything persisted or exchanged is a public contract: storage keys (`rrConfig`…), config field names, rule
types, runtime message types (`rr:…`) and page event names. Renaming one breaks users' saved rules or exported
files. Add new names alongside old ones and migrate in `normalizeConfig()`. Refactors must not change them.

### UI code

- Build HTML from data only through `esc()`.
- Real `<button>`, `<a href>`, `<label>` + `<input>`; never a click handler on a `div`. Icon-only buttons need
  `aria-label`.
- User-facing text is short, plain English, and says what to do next.

### Performance

`onPaused()` in `background.js` and the hooks in `page/` run for every request. Keep them free of storage reads,
regex compilation and logging work that could be done once in `apply()`.

### Dependencies

`extension/` has no third-party code. Adding any needs a discussion first: every dependency has to be reviewed for
security and justified to the Chrome Web Store. Dev dependencies (test, lint, format) are fine.

## Tests

- Every behaviour change comes with a test that fails without it.
- One behaviour per test; the test name states the expected behaviour in plain words.
- Arrange, act, assert, in that order, separated by a blank line when the test is longer than a few lines.
- Use fictional hosts only: `*.example`, `localhost`, `127.0.0.1`.
- See `.claude/skills/test-extension/SKILL.md` for the helpers and patterns.

## Commits and pull requests

- Conventional Commits: `feat: add delay to map-remote rules`, `fix(recording): capture unread error responses`,
  `refactor(core): rename compile helpers`, `docs:`, `test:`, `chore:`.
- Subject line under 72 characters, imperative mood. Body explains why when it is not obvious.
- Fill in the pull request checklist. Security-relevant changes get a review against `AGENTS.md` › Security invariants.
- Add a line to `CHANGELOG.md` under "Unreleased" for anything a user would notice.

## Lint status

The existing code predates these rules, so `npm run lint` still reports issues (mostly short names and missing
JSDoc) and lint is not yet part of `npm test`. Until that clean-up is done: code you add or change must be
lint-clean, and leave every function you touch better named and documented than you found it.
