# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.1.1] - 2026-11-20

### Added

- Test suite (unit and end-to-end), lint and formatting setup, contributor and agent guides.

### Fixed

- Recording now captures responses whose body the page never reads, such as error responses where only the
  status is checked.
- A mock with status 0 now fails for scripts, styles and images too, instead of serving its body. The rule list
  and the URL tester describe it as a network error.
- Importing a rule with an unknown "Run at" value no longer stops every JavaScript inject rule from using
  user scripts.
- Imported rules with an unknown type become map-remote rules, as intended.

### Changed

- JavaScript Inject rules now run only through Chrome's user scripts API, so they need **Allow user scripts** on
  Reroute's Details page. The inline-script fallback is gone. The rule manager re-applies rules when you return to
  it, so turning the switch on takes effect without editing a rule.
- Code formatted with Prettier.
- Reroute no longer asks for the `declarativeNetRequestFeedback` permission. It only worked in unpacked builds,
  so Activity no longer lists redirect, header and block hits there.

## [2.1.0]

### Added

- Site access is requested per site instead of for all sites at install.
- Import preview; rules that run scripts or remove a page's security policy are imported switched off.
- "Safe to share" export that removes response bodies and masks secret headers.
- Auto-off timer and a per-site rule count in the popup.

### Security

- Web pages no longer receive the rule list or mock bodies; mocks only apply to requests to the page's own site.
- Extension pages cannot make network requests.

## [2.0.0]

### Added

- Rewritten as a self-contained Chrome extension: map remote, map local, mock, rewrite, block and inject rules,
  Full interception per tab, recording responses as mocks, drag-and-drop ordering, import and export.
