---
name: change-rule-engine
description: Checklist for adding or changing a Reroute rule type, rewrite action, condition ("Only when…") or rule field. Use whenever a change touches what a rule can do, because the rule model is implemented in several files that must stay in step.
---

# Changing what a rule can do

A rule is defined once in `extension/core.js` but executed by three paths and edited in two pages. Work through
this list in order; skip a step only when you can say why it does not apply.

1. **Model** — `core.js`: add constants (`TYPE_LABELS`, `ACTION_KINDS`, …) and accept the new field in
   `normalizeConfig()` with a safe default, so older exports still import.
2. **Validation** — `compileRule()`: return `error` for unusable input and `notes` explaining which request types
   the feature reaches. Never throw.
3. **Network path** — `compileRule()` / `compileDnr()`: if declarativeNetRequest can do it, emit DNR rules here.
   Check the current Chrome docs for what DNR supports; do not rely on memory.
4. **Page path** — if it changes fetch/XHR bodies, status or timing: `compilePage()`, then `page/bridge.js`
   (decides) and `page/interceptor.js` (applies). The interceptor must receive only the outcome for one request.
5. **Full interception** — `background.js` `onPaused()` / `onResponse()`: make the debugger path do the same thing
   for every request type.
6. **Tester** — `testUrl()` so "Test a URL" describes the outcome.
7. **Safety** — `riskOf()` if the feature can run code, weaken page security or send data elsewhere;
   `redactConfig()` if it can hold secrets; `neededOrigins()` if it reaches a new host.
8. **Editor** — `options.js` `renderEditor()` and the `input` handler (`data-f`, `data-ai`, …). Escape all values
   with `esc()`. Real `<button>`/`<label>` elements, no click handlers on divs.
9. **Popup / list summary** — `ruleRow()` in `options.js` if the one-line summary should show it.
10. **Docs** — README rule table and "Good to know".
11. **Tests** — unit test for steps 1–2, 6–7; e2e test in `tests/e2e/rules.test.mjs` for steps 3–5, both without
    and with Full interception.
12. Run `npm test`, then use the `security-reviewer` agent if steps 4, 5 or 7 changed.
