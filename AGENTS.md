# Reroute — agent guide

Reroute is a Manifest V3 Chrome extension that does what Charles Proxy's map remote / map local / rewrite
do, inside the browser: no proxy process, no CA certificate. It is headed for public release, so every
change must keep it **generic** (no client data) and **safe** (see Security invariants).

## Commands

| Command             | What it does                                                                      |
| ------------------- | --------------------------------------------------------------------------------- |
| `npm run test:unit` | Pure rule-engine tests, ~1 s. Run after any change to `extension/core.js`.        |
| `npm run test:e2e`  | Loads the extension in headless Chromium against throwaway local servers, ~1 min. |
| `npm test`          | `check` + unit + e2e. Must pass before you say a change is done.
| `npm run verify` | Same checks as `npm test`, one line per step and details only on failure. Prefer it in agent sessions. |                  |
| `npm run check`     | Syntax and formatting checks; fails on private terms or personal paths.           |
| `npm run package`   | Zips `extension/` into `dist/` for the Chrome Web Store.                          |
| `npm run format`    | Formats everything with Prettier. Never hand-format.                              |
| `npm run lint`      | ESLint with naming, complexity and JSDoc rules. `npx eslint <file>` for one file. |

Setup on a new machine: `npm install && npx playwright install chromium`. There is no build step: the files in
`extension/` are what Chrome loads (`chrome://extensions` → Load unpacked → `extension/`).

## Layout

```
extension/            the extension, loaded as-is
  core.js             pure rule engine: matching, compilation, risk/redaction, config normalisation
  background.js       service worker: applies rules, Full interception, recording, injection, activity log
  page/bridge.js      content script, isolated world: holds rules, answers one request at a time
  page/interceptor.js content script, MAIN world: patches fetch/XHR, holds NO rules
  options.*           rule manager;  popup.* toolbar popup;  ui.css shared styles
tests/unit/           node:test, no browser
tests/e2e/            node:test + Playwright; helpers.mjs launches Chromium with the extension
scripts/              check, package, Claude Code hook
private/              git-ignored: personal rules, mock files, private/terms.txt
```

## How a request is handled

Three paths, chosen per rule by `compileRule()` in `core.js`:

1. **declarativeNetRequest** (`compileDnr`) — redirects, header and query changes, blocking, and `data:` URL mocks
   for scripts/styles/images. Session rules, rebuilt from scratch on every config change. Chrome matches with RE2.
2. **Page hook** (`compilePage`) — mocks and status/body/delay rewrites for fetch/XHR. `interceptor.js` (MAIN world)
   dispatches `rr:q` and gets `rr:a` back synchronously from `bridge.js` (isolated world). Only the outcome for that
   one request crosses into the page.
3. **Full interception** (`chrome.debugger`, per tab, opt-in) — every rule on every request type, including serving
   a local document under the original URL. Also powers recording.

Rule priority: groups top to bottom, then rules top to bottom (`sortedRules`). The first map-remote / map-local /
mock / block that matches wins; all matching rewrites stack.

State: `chrome.storage.local` holds `rrConfig`, `rrSettings`, `rrPage` (compiled page rules).
`chrome.storage.session` holds `rrRuntime`, `rrLog`, `rrCaptures`, `rrRec`, `rrDebugTabs`.
The UI writes `rrConfig`; the worker reacts to `storage.onChanged` and calls `apply()`. Do not add a second
writer path.

## Security invariants

Breaking one of these is a release blocker. `tests/e2e/security.test.mjs` covers most of them.

1. Pages never receive the rule list or any mock other than the one answering their own request.
   `interceptor.js` must stay rule-free.
2. Page-hook and `data:` mocks only apply to requests to the page's own site, unless the rule lists the page's
   domain in `when.pageDomains`. `siteOf()` exists in both `core.js` and `page/bridge.js`; keep them identical
   (a unit test enforces it).
3. Site access is optional: `optional_host_permissions` only, never `host_permissions`. Rules that lack access are
   reported in `rrRuntime.needs`, not silently applied.
4. The extension makes no network requests of its own: no analytics, no remote code, no CDN, no `eval`/`new Function`
   in extension pages. Keep the manifest CSP (`connect-src 'none'`).
5. Imported rules that `riskOf()` rates `high` arrive disabled unless the user ticks "I wrote this file".
6. Anything that can hold secrets (mock bodies, recorded responses, Cookie/Authorization values) goes through
   `redactConfig()` in the "Safe to share" export.
7. Only the extension's own content script may write to the activity log (`sender.tab` check).
8. Full interception attaches only to tabs the user switched on, and detaches cleanly.

## Conventions

- Plain ES modules, no dependencies and no build step inside `extension/`. Third-party code would need a
  security review and a store justification.
- All HTML built from data goes through `esc()`. No inline `<script>` or `on*=` attributes (the CSP blocks them).
- Pure logic goes in `core.js` with a unit test; `chrome.*` calls stay in `background.js` and the pages.
- New rule fields must be handled in `normalizeConfig()` so old exports keep importing.
- User-facing text is plain and short. Errors say what to do next.
- Generic only: example hosts are `*.example`, `localhost` or `127.0.0.1`. Client names, internal hosts and
  personal paths must never be committed; list them in `private/terms.txt` so `npm run check` catches them.

## Code quality

Code must be understandable by someone new to the project without running it. Full guide with examples:
`CONTRIBUTING.md` › Code style. The rules that matter most:

- **Descriptive names.** Full words, no single letters (except `i`/`j` indexes and `_`), no private
  abbreviations: `rule` not `r`, `pageHostname` not `host`, `networkRules` not `dnr`. Booleans read as questions
  (`isEnabled`, `hasSiteAccess`). Units in names (`delayMs`).
- **JSDoc on every function declaration and export**: one-sentence summary, `@param` and `@returns` with types
  from `extension/types.js`, side effects and surprises.
- **Comments explain why**, not what: browser quirks, security reasons, non-obvious decisions. Every ignored error
  says why it is safe to ignore.
- **Small functions**: one job, early returns, max 3 levels of nesting, no nested ternaries, at most 3 parameters.
- **Named constants** for meaningful numbers and strings.
- **Formatting is Prettier's job**: run `npm run format`; the edit hook formats each file you change.
- **Never rename persisted names** while refactoring: storage keys, config fields, rule types, `rr:` message and
  event names. They are a contract with users' saved data and exported files.
- Existing code predates these rules and is not lint-clean yet. Anything you add or change must be; when you touch
  a function, leave it better named and documented. Do not reformat or rename unrelated code in the same change.

## Testing

- Every behaviour change gets a test. Engine logic → `tests/unit/core.test.mjs`. Anything involving Chrome →
  an e2e test using `launch()` and `serve()` from `tests/helpers.mjs`.
- `serve()` gives each test its own site; `url` and `otherSite` are the same server as two different sites,
  which is how cross-site behaviour is tested.
- `launch()` grants site access by copying the extension with `host_permissions`, because headless Chromium cannot
  answer permission prompts. Use `launch({ siteAccess: false })` to test the no-access path.
- Headless Chromium cannot test: the permission prompt itself, Chrome's "Allow user scripts" toggle (injection falls
  back to an inline script), the debugging banner, or Chrome Web Store behaviour. Say so when a change depends on them.
- Runtime messages must come from an extension page (`h.message()`); the worker cannot message itself.

## Gotchas

- `declarativeNetRequest` cannot change response bodies or status codes; that is why the page hook and Full
  interception exist.
- Redirecting a document with DNR changes the address bar. Only Full interception keeps the original URL.
- `chrome.debugger` cannot be an optional permission; it stays in `permissions`.
- The service worker can be stopped at any time. Never keep important state only in module variables; the
  `cache` in `background.js` is rebuilt by `getCache()`.
- `Network.loadingFinished` only fires once the page reads the body, so recording also captures on a timer after
  `responseReceived`.
- Chrome APIs change. Check developer.chrome.com before relying on remembered limits or behaviour.
