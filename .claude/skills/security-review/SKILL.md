---
name: security-review
description: Review a Reroute change for security and privacy problems before it is finished — leaks to web pages, permissions, remote code, import/export of secrets, or anything that would fail Chrome Web Store review. Use for changes to background.js, page/, manifest.json, permissions, import/export or recording.
---

# Security review

Read the diff (`git diff`, or `git diff main...HEAD` on a branch), then check each item. Report findings with file,
line, the concrete failure scenario, and a fix. Say "no findings" explicitly if there are none.

## Invariants (see AGENTS.md for the reasoning)

- [ ] `page/interceptor.js` holds no rules, patterns or mock bodies; it only learns `active`/`needBody` and the
      answer to its own `rr:q`.
- [ ] Anything dispatched to the page (`CustomEvent` detail) contains only data about the request the page itself
      made. Page-dispatched events are untrusted input to `bridge.js`.
- [ ] Mocks and rewrites through the page hook or `data:` redirects are limited to the page's own site unless
      `when.pageDomains` says otherwise. `siteOf()` is identical in `core.js` and `bridge.js`.
- [ ] Manifest: no `host_permissions`; site access stays in `optional_host_permissions`; no new permission without
      a line in PRIVACY.md explaining why; extension CSP unchanged (`connect-src 'none'`, no `unsafe-eval`).
- [ ] No `fetch`/XHR/WebSocket from extension pages or the worker, no remote scripts, no `eval`/`new Function`,
      no `innerHTML` with unescaped data.
- [ ] Imports: new risky capabilities are reported by `riskOf()`; `high` ones arrive disabled.
- [ ] Exports: new fields that can hold secrets are cleared or masked by `redactConfig()`.
- [ ] `chrome.runtime.onMessage` handlers that change state check the sender where a content script could reach
      them.
- [ ] Full interception and recording stay per tab and opt-in, and stop when the debugger detaches.
- [ ] Nothing client-specific: `npm run check` passes.

## Store-review lens

Would a reviewer see behaviour the listing and PRIVACY.md do not explain? Broader permissions than the feature
needs? Data leaving the device? Any of these is a finding even if the code is correct.
