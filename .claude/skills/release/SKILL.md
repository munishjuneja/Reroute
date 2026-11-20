---
name: release
description: Prepare a Reroute release — bump the version, run every check, build the Web Store zip and draft release notes. Only when the user asks to release.
disable-model-invocation: true
---

# Release

1. Ask which version to release if the user did not say (semver: new feature → minor, fixes only → patch).
2. Set the same version in `extension/manifest.json` and `package.json`.
3. Run `npm test`. Stop and report if anything fails.
4. Run the `security-reviewer` agent on everything since the last release tag (`git diff <last-tag>...HEAD`).
   Stop on any finding the user has not accepted.
5. Run `npm run package` and confirm `dist/reroute-<version>.zip` exists and contains no `private/`,
   `node_modules`, tests or dotfiles (`unzip -l`).
6. Draft release notes from the commits since the last tag: user-visible changes first, then fixes, then
   anything that needs action (re-granting site access, changed defaults). Plain language.
7. If permissions changed, update PRIVACY.md and list the new justification text for the store listing.
8. Show the user the notes and the manual checks headless tests cannot do: grant site access through the real
   prompt, "Allow user scripts", Full interception banner, and one real site of their choice.
9. Commit, tag `v<version>` and push only when the user says so.
