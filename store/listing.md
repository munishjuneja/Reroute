# Chrome Web Store listing

Text to paste into the Developer Dashboard. Keep it in step with `extension/manifest.json`, `PRIVACY.md` and what
the extension actually does: the store compares them.

## Store listing tab

**Name:** Reroute (from the manifest)

**Summary** (the manifest `description`, max 132 characters). Current:

> Map remote, map local, mock, rewrite, block and inject — Charles-style request rules that run entirely in Chrome.

Suggested, without naming another product (110 characters):

> Map remote, map local, mock, rewrite, block and inject — request rules for web developers, entirely in Chrome.

**Category:** Developer Tools

**Language:** English

**Description:**

```text
Reroute changes how Chrome handles the network requests of sites you choose, so you can develop and test against a live site without a proxy or a CA certificate.

WHAT IT DOES
• Map remote — send matching requests to another URL, for example load a deployed site's scripts from your local dev server.
• Map local — answer requests with a file you load into Reroute.
• Mock response — answer fetch/XHR calls with the status, headers, body and delay you write. Filter by method or GraphQL operation name.
• Rewrite — change request and response headers, query parameters, status codes or body text, or add a delay.
• Block — make matching requests fail.
• Inject — run your own JavaScript or CSS on matching pages.

FULL INTERCEPTION AND RECORDING
Switch on Full interception for a single tab to apply every rule to every request type and to serve a local page under the original URL. Chrome shows its "debugging this browser" banner on that tab while it is on. Record API responses on that tab and save any of them as a mock with one click.

ORGANISED AND PREDICTABLE
• Rules live in groups and profiles; higher rules win, and you can drag to reorder.
• "Test a URL" shows which rules would fire for a request and why.
• Activity lists the requests your rules acted on.
• Auto-off switches everything off after the time you choose.
• Import and export rule files. "Safe to share" export removes response bodies and masks Cookie, Authorization and API-key headers.

PRIVATE BY DESIGN
• Reroute makes no network requests of its own: no analytics, no telemetry, no remote code.
• Your rules and mock files stay in your browser.
• Site access is asked for per site, only for the sites your enabled rules name, and you can revoke it at any time.
• Imported rules that run scripts or remove a page's security policy arrive switched off until you review them.

Reroute only affects traffic from this browser. Source code and documentation: https://github.com/munishjuneja/Reroute
```

**Screenshots** (1280×800, at least one, up to five). Suggested:

1. Rule manager with a group of rules and the map-remote editor open.
2. A mock response being edited (status, headers, JSON body).
3. Test a URL, showing a winning rule and a shadowed one.
4. The toolbar popup with Full interception and Record API responses.
5. Activity with recorded responses and "Save as mock".

Use fictional hosts such as `www.example.com` and `localhost` in every screenshot.

**Small promo tile** (440×280): optional.

## Privacy practices tab

**Single purpose:**

```text
Reroute lets web developers change how Chrome handles network requests on sites they choose — redirecting, mocking, rewriting or blocking them, or injecting their own code — to develop and test web applications.
```

**Permission justifications:**

| Permission                       | Justification                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| declarativeNetRequest            | Applies the user's redirect, header, query-parameter and block rules to requests that match them.                                                                                                                                                                                                                                      |
| scripting                        | Registers Reroute's content scripts, which answer the page's fetch/XHR requests with the user's mocks and rewrites, on sites the user granted access to. Also inserts CSS from the user's Inject rules, and their JavaScript as an inline script when "Allow user scripts" is off.                                                     |
| userScripts                      | Runs JavaScript the user wrote in an Inject rule, only on pages matching that rule. The user must turn on "Allow user scripts" for Reroute.                                                                                                                                                                                            |
| webNavigation                    | Detects when a page matching an Inject rule starts loading, so the user's code or styles are added to it.                                                                                                                                                                                                                              |
| debugger                         | Full interception and response recording. Attached only to a tab where the user switches it on in the popup, and detached when they switch it off; Chrome shows its debugging banner meanwhile. Used to serve local files under the original URL, change status and body for any request type, and capture responses to save as mocks. |
| storage                          | Saves the user's rules and settings locally.                                                                                                                                                                                                                                                                                           |
| unlimitedStorage                 | Mock bodies and files loaded for map-local rules can exceed the default storage quota.                                                                                                                                                                                                                                                 |
| alarms                           | Switches Reroute off at the time the user chose with the auto-off timer.                                                                                                                                                                                                                                                               |
| activeTab                        | Reads the current tab's address when the popup opens, to show how many rules apply to that site.                                                                                                                                                                                                                                       |
| Host permissions (optional only) | Requested at run time, only for the sites the user's enabled rules name, so the rules can apply there. Access to all sites is requested only if the user writes a rule not tied to one site and approves the prompt.                                                                                                                   |

**Are you using remote code?** No. All code is packaged with the extension. Inject rules run JavaScript or CSS that
the user typed into Reroute themselves; it is stored locally and never fetched from a server.

**Data usage:** tick none of the data categories. Reroute does not collect or transmit any user data. Tick all three
certifications (not sold to third parties; not used or transferred for purposes unrelated to the single purpose;
not used to determine creditworthiness or for lending).

**Privacy policy URL:** https://github.com/munishjuneja/Reroute/blob/main/PRIVACY.md (the repository must be public).

## Test instructions for the reviewer (optional field)

```text
No account is needed.
1. Click the toolbar icon → Open rule manager. An "Examples" group with four disabled rules is created on first run.
2. Switch on "Hello from Reroute" (an Inject rule for https://www.example.com/*). Click "Grant access" in the banner and accept Chrome's prompt for example.com.
3. Open https://www.example.com/ and DevTools → Console: "Reroute: script injected" is logged.
4. Add a rule: Type "Block", Match URL https://www.example.com/*. Reload the page: Chrome shows that the request was blocked. Switch the rule off.
5. On that tab, open the popup and switch on "Full interception on this tab": Chrome shows its debugging banner. Switch it off and the banner disappears.
```
