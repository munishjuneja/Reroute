## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## How it was tested

<!-- New or changed tests, and any manual check in real Chrome (permission prompt, user scripts, Full interception banner). -->

## Checklist

- [ ] `npm test` passes
- [ ] Code I added or changed is lint-clean (`npx eslint <files>`) and has JSDoc
- [ ] No persisted names changed (storage keys, config fields, rule types, `rr:` messages) — or a migration is included
- [ ] Security invariants in `AGENTS.md` still hold; security-relevant changes reviewed
- [ ] New permissions are justified in `PRIVACY.md`
- [ ] `CHANGELOG.md` updated for user-visible changes
- [ ] No client names, internal hosts or personal paths (`npm run check` with your `private/terms.txt`)
