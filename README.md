# Reroute

Charles-style request rules that run entirely in Chrome: no proxy process, no CA certificate.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → select this folder.
3. Optional, for script injection: open Reroute's **Details** and turn on **Allow user scripts**.
4. Click the toolbar icon → **Open rule manager**.

A few disabled example rules are created on first run.

## Rule types

| Type | What it does | Works for |
|---|---|---|
| Map remote | Sends matching requests to another URL | Everything. A redirected *document* shows the new URL unless Full interception is on. |
| Map local | Answers with a file stored in the extension | fetch/XHR, scripts, styles, images, fonts. Documents need Full interception. |
| Mock response | Answers with a status, headers, body and delay you write | fetch/XHR. Other request types get the body only (status 200). |
| Rewrite | Changes request/response headers, query params, status, body, or adds delay | Headers and query: everything. Status, body, delay: fetch/XHR. |
| Block | Fails the request | Everything |
| Inject | Runs your JavaScript or CSS on matching pages | Top-level pages |

**Full interception** (toolbar popup, per tab) lifts every "fetch/XHR only" limit above and lets
you serve a local page under the original URL. It uses `chrome.debugger`, so Chrome shows a
"debugging this browser" banner on that tab while it is on.

## Matching

- `*` matches anything; the rest is exact. `https://site.com/api/*` matches query strings,
  `https://site.com/api/users` does not match `…/users?page=2`.
- In a map-remote destination, each `*` takes the text matched by the same `*` in the match.
- Tick **Regular expression** for regex (RE2 syntax: no lookaheads or backreferences); use `$1` in destinations.
- Rules higher in a group win. Rewrite rules stack; of the others, the first match handles the request.
- **Only when…** narrows a rule by method, request type, page domain or GraphQL operation name.

## Typical setup: local bundles on a deployed site

1. Map remote: `https://www.site.com/static/js/*` → `http://localhost:3000/static/js/*`, with
   **Add CORS headers** ticked. Use a wildcard over the whole folder so lazy chunks are mapped too.
2. If the page has a CSP that refuses `localhost`: add a Rewrite rule on the page URL and click **Remove CSP**.
3. Reload. Chrome may ask once to allow the site to reach your local network — allow it.

The page keeps its real origin, so cookies, session and every other API call behave as normal.

## Recording responses as mocks

1. On the tab you want to capture, open the popup and turn on **Record API responses**
   (this also turns on Full interception for that tab).
2. Use the page. Every fetch/XHR response is captured.
3. In the rule manager open **Activity** → **Recorded responses** → **Save as mock**.
   The new rule lands in a "Recorded" group with URL, method, status, body and (for GraphQL) the operation name filled in.
4. Edit the body if you want a variation. Mocks for fetch/XHR keep working with recording and Full interception off.

Recordings are kept for the browser session only (latest 80, bodies up to 1 MB).

## Ordering

Higher rules win, and groups higher in the sidebar win over groups below. Drag a rule onto another
rule to reorder it, onto a group to move it there, or drag groups to reorder them.

## Loading mock files in bulk

Imported map-local rules that pointed at files on disk arrive without content. Open any of them,
click **Load from file…** and select all your mock files at once — each file fills the rules waiting for that file name.

## Good to know

- Reload the tab after adding your first mock or body rewrite: the fetch/XHR hook is installed at page load.
- Script tags with an `integrity` hash will reject a swapped file. Serve the document itself with
  Full interception and drop the attribute there.
- CORS headers added by rules use `*`, which browsers refuse for requests sent with credentials.
  Mocks answered under Full interception echo the request origin instead.
- **Activity** lists the requests rules acted on. **Test a URL** shows which rules would fire and why.
- Import accepts Reroute exports and the older `rules.json` format; Export saves everything, or one group from its header.
- Only traffic from this browser is affected. For other browsers, devices or `curl` you still need a proxy.

## Security and privacy

- **Nothing leaves your machine.** No analytics, no remote code, no third-party libraries. The extension's
  own pages are barred from making network requests at all (`connect-src 'none'`).
- **Site access is opt-in.** Reroute asks for access only to the sites your enabled rules name. Until you grant it,
  the toolbar badge shows `!` and the rules are not applied. A rule not tied to one host (for example `https://*/api/*`)
  needs access to all sites, which you can also grant from the rule manager.
- **Pages never see your rules.** The in-page hook asks the extension about one request at a time and receives only
  that request's outcome.
- **Mocks stay on their own site.** A page only gets mocks and rewrites for requests to its own site. To serve one to
  a page on a different site, list that page's domain under **Only when… → Page is on domain**, or use Full
  interception. Otherwise any website could request a URL you mock and read the mock.
- **Imports are previewed.** The import dialog lists what the file does. Rules that run scripts or remove a page's
  security policy arrive switched off unless you confirm you wrote the file.
- **Exports can be made safe to share.** "Safe to share" leaves out response bodies and masks Cookie, Authorization
  and API-key header values. "Everything" is a full backup — treat it like a file of secrets.
- **Auto-off.** The popup can switch Reroute off after 1, 4 or 8 hours, and shows how many enabled rules
  can affect the site in the current tab.
- **Still your responsibility:** rules, mock bodies and recordings are stored unencrypted in the browser profile;
  rules that remove CSP or add wildcard CORS weaken those protections while enabled; Full interception can see all
  traffic on the tab it is attached to, which is why it is per tab and shows Chrome's banner.
- "Same site" is judged from the domain name without the public suffix list, so unusual domains can be misjudged.

## Files

- `core.js` — rule model, matching, compilation to `declarativeNetRequest`
- `background.js` — applies rules, injection, Full interception, activity log
- `page/` — fetch/XHR hook (main world) and its bridge
- `options.*`, `popup.*`, `ui.css` — rule manager and toolbar popup
