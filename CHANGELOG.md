# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Test suite (unit and end-to-end), lint and formatting setup, contributor and agent guides.

### Changed

- Code formatted with Prettier.

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
