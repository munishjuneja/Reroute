# Security policy

Reroute can read and change web traffic in your browser, so security reports are taken seriously.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting
("Security" tab → "Report a vulnerability") with:

- what an attacker can do, and what they need (a malicious website, a crafted rules file, …),
- steps to reproduce, with the extension version,
- any suggested fix.

You should get a reply within a week. Fixes for confirmed issues are released as soon as they are ready, and
reporters are credited unless they ask not to be.

## Scope

In scope: anything that lets a web page read or change rules, mocks or recordings; rules applying where the user
did not intend; data leaving the device; permission or Content Security Policy weaknesses; unsafe handling of
imported rules files.

Out of scope: rules a user writes themselves that weaken a site's security (for example removing its CSP), and
issues that need an attacker to already control the user's browser profile.
