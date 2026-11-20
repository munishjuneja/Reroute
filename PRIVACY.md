# Privacy

Reroute does not collect, transmit or sell any data.

- It makes no network requests of its own. There is no analytics, telemetry, advertising or remotely loaded code.
- Rules, mock responses and settings are stored locally in the browser's extension storage.
- Recorded responses are kept in memory for the browser session only and are discarded when the browser closes,
  unless you save one as a mock rule.
- Site access is requested per site, only for the sites your enabled rules name, and can be revoked at any time
  from the browser's extension settings.
- Exported rule files are created on your device. The "Safe to share" export removes response bodies and masks
  common secret headers; the full export does not.

## Permissions

| Permission                            | Why it is needed                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| declarativeNetRequest (+Feedback)     | Redirect, block and modify headers of matching requests; list which rules matched      |
| scripting, userScripts, webNavigation | The fetch/XHR hook for mocks, and running the JavaScript/CSS you write in Inject rules |
| debugger                              | Full interception and recording, only on tabs where you switch it on                   |
| storage, unlimitedStorage             | Keep your rules and mock files                                                         |
| alarms                                | The auto-off timer                                                                     |
| activeTab                             | Read the current tab's address for the popup                                           |
| Site access (optional)                | Apply your rules on the sites they name                                                |
