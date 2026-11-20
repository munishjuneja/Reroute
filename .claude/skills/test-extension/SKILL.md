---
name: test-extension
description: Run, write or debug Reroute's tests — unit tests for extension/core.js and Playwright end-to-end tests that load the extension in Chromium. Use when adding tests, when a test fails, or before saying a change works.
---

# Testing Reroute

## Run

- `npm run test:unit` after any change to `extension/core.js` (about a second).
- `npm run test:e2e` after any change to `background.js`, `page/`, `options.*`, `popup.*` or `manifest.json`.
- One file: `node --test tests/e2e/security.test.mjs`. One test: add `--test-name-pattern="auto-off"`.
- `npm test` before declaring work done.

A failing run that hangs at the end usually means a server or browser was not closed: every `launch()` needs
`h.close()` and every `serve()` needs `.close()` in `after()`.

## Where a new test goes

| Change                                                | Test                                   |
| ----------------------------------------------------- | -------------------------------------- |
| Matching, compilation, risk, redaction, import format | `tests/unit/core.test.mjs`             |
| What happens to real requests                         | `tests/e2e/rules.test.mjs`             |
| Keeping the original URL, cookies, chained hosts      | `tests/e2e/full-interception.test.mjs` |
| Leaks, permissions, import/export, auto-off           | `tests/e2e/security.test.mjs`          |
| Rule manager and popup                                | `tests/e2e/ui.test.mjs`                |

## Writing an e2e test

```js
import { launch, serve, send, rule, mock, config, sleep } from '../helpers.mjs';

const site = await serve((req, res, u) =>
  send(
    res,
    200,
    'text/html',
    '<script>window.done = fetch("/api").then(r => r.text()).then(t => window.T = t)</script>',
  ),
);
const h = await launch(); // site access granted
await h.setConfig(config([mock(site.url + '/api', '{"ok":1}')])); // waits until applied
const page = await h.ctx.newPage();
await page.goto(site.url + '/');
await page.evaluate(() => window.done);
assert.equal(await page.evaluate(() => window.T), '{"ok":1}');
```

- Wait on the page's own promise (`window.done`) or `waitForFunction`, not on fixed sleeps, wherever the page
  can tell you it is finished. Recording and logging are written with a short debounce — poll for them.
- `site.otherSite` is the same server as a different site — use it for cross-site cases.
- Full interception: `await h.message({ type: 'rr:dbg-toggle', tabId: await h.tabId(site.url) })`, then
  `page.bringToFront()` and navigate. Toggle it off again at the end of the test.
- Extension pages: `const opt = await h.extPage('options.html')`; `opt.errors` collects uncaught page errors —
  assert it is empty.
- No-access path: `launch({ siteAccess: false })`.
- Keep every URL fictional (`*.example`, `localhost`, `127.0.0.1`).

## What headless Chromium cannot check

The permission prompt, Chrome's "Allow user scripts" toggle, the debugging banner, and anything in the Chrome Web
Store. When a change depends on one of these, say so and give the user the manual steps to check it in real Chrome.
