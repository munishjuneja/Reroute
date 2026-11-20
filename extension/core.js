// Reroute core: rule model, matching and compilation. Pure — no chrome.* calls —
// so the service worker, the options page and the popup all share it.

export const RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other',
];
export const TYPE_LABELS = {
  'map-remote': 'Map remote', 'map-local': 'Map local', mock: 'Mock response',
  rewrite: 'Rewrite', block: 'Block', inject: 'Inject',
};
export const ACTION_KINDS = {
  'req-header': 'Request header', 'resp-header': 'Response header', query: 'Query param',
  'resp-body': 'Response body replace', status: 'Status code', delay: 'Delay (ms)',
};
export const DEFAULT_SETTINGS = { masterEnabled: true, autoOffMin: 0, autoOffAt: 0 };

// Resource types a data: redirect can serve (documents and fetch/XHR cannot follow one).
const DATA_TYPES = ['sub_frame', 'stylesheet', 'script', 'image', 'font', 'media', 'object', 'other'];
const DNR_METHODS = ['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put'];
const PAGE_KINDS = ['resp-body', 'status', 'delay'];
const MAX_DATA_URL = 1_500_000;

export const uid = (p = 'r') => p + Math.random().toString(36).slice(2, 10);
const rxEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(String(str ?? ''));
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
export const responseB64 = r => (r?.base64 ? r.body || '' : utf8ToB64(r?.body || ''));

// ---------- sites and permissions ----------

// Registrable-domain guess (no public suffix list): example.com, example.co.uk.
// page/bridge.js carries the same function — keep them in step.
export function siteOf(h) {
  const p = String(h).split('.');
  if (p.length <= 2 || /^\d+$/.test(p[p.length - 1])) return String(h);
  const n = p[p.length - 1].length === 2 && p[p.length - 2].length <= 3 ? 3 : 2;
  return p.slice(-n).join('.');
}

// The host a rule's match is pinned to, or null when it could be any host.
export function matchHost(rule) {
  const raw = String(rule.match || '').trim();
  if (rule.regex) {
    const m = raw.match(/^\^?https?\??:\\?\/\\?\/((?:[\w-]|\\\.)+)(?=\\?\/|\$|:|$)/i);
    return m ? m[1].replace(/\\\./g, '.').toLowerCase() : null;
  }
  const m = raw.match(/^[a-z*]+:\/\/([^/?#]+)/i);
  if (!m) return null;
  let h = m[1].replace(/:(\d+|\*)$/, '').toLowerCase();
  if (h.startsWith('*.')) h = h.slice(2);
  return !h || h.includes('*') ? null : h;
}
const originPattern = host => (siteOf(host) === host && (!host.includes('.') || /^\d+$/.test(host.split('.').pop())) ? `*://${host}/*` : `*://*.${siteOf(host)}/*`);

// Site access the enabled rules need. ['<all_urls>'] when a rule is not pinned to a host.
export function neededOrigins(config, settings) {
  const out = new Set();
  for (const r of liveRules(config, settings)) {
    const h = matchHost(r);
    if (!h) return ['<all_urls>'];
    out.add(originPattern(h));
    if (r.type === 'map-remote') {
      try { out.add(originPattern(new URL(String(r.dest).replace(/\*|\$[0-9]/g, 'x')).hostname)); } catch { /* reported by compileRule */ }
    }
    for (const d of r.when?.pageDomains || []) out.add(originPattern(d));
  }
  return [...out];
}

// Enabled rules not pinned to one host: the reason neededOrigins asks for all sites.
export function unpinnedRules(config, settings) {
  return liveRules(config, settings).filter(r => !matchHost(r));
}

// What a rule does that a reviewer should know about. level 'high' = disabled on import.
export function riskOf(rule) {
  const out = [];
  const acts = rule.type === 'rewrite' ? rule.actions || [] : [];
  if (rule.type === 'inject' && rule.inject?.lang !== 'css') out.push({ level: 'high', text: 'Runs a script on matching pages.' });
  if (acts.some(a => a.kind === 'resp-header' && /^content-security-policy/i.test(a.name))) out.push({ level: 'high', text: 'Removes or changes the page security policy (CSP).' });
  if (rule.cors || acts.some(a => a.kind === 'resp-header' && /^access-control-allow-origin$/i.test(a.name))) out.push({ level: 'info', text: 'Lets other sites read these responses (CORS).' });
  if (acts.some(a => a.kind === 'req-header' && /^(cookie|authorization)$/i.test(a.name) && a.value)) out.push({ level: 'info', text: 'Sets a Cookie or Authorization header.' });
  if (rule.type === 'map-remote') {
    const from = matchHost(rule);
    let to = null;
    try { to = new URL(String(rule.dest).replace(/\*|\$[0-9]/g, 'x')).hostname; } catch { /* no destination */ }
    if (to && (!from || siteOf(from) !== siteOf(to)) && !/^(localhost|127\.0\.0\.1)$/.test(to)) out.push({ level: 'info', text: 'Sends requests to another site: ' + to + '.' });
  }
  return out;
}

const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token)$/i;
// Copy of a config that is safe to share: no response bodies, no secret header values.
export function redactConfig(config) {
  const c = structuredClone(config);
  for (const r of c.rules) {
    if (r.response) {
      if (r.response.body) r.response.fileName ||= 'body removed on export';
      r.response.body = ''; r.response.base64 = false;
      for (const h of r.response.headers || []) if (SECRET_HEADER.test(h.name) && h.value) h.value = 'REDACTED';
    }
    for (const a of r.actions || []) if (/header/.test(a.kind) && SECRET_HEADER.test(a.name) && a.value) a.value = 'REDACTED';
  }
  return c;
}

// Call whenever the master switch or the auto-off choice changes.
export function armAutoOff(settings) {
  const min = Number(settings.autoOffMin) || 0;
  settings.autoOffAt = settings.masterEnabled && min ? Date.now() + min * 60000 : 0;
  return settings;
}

// ---------- matching ----------

// Wildcard matches are exact with * as "anything" (same as Charles); regex is used as written.
export function matchSource(rule) {
  const raw = String(rule.match || '').trim();
  if (rule.regex) return { source: raw, groups: null };
  const parts = raw.split('*').map(rxEscape);
  return { source: '^' + parts.join('(.*)') + '$', groups: parts.length - 1 };
}
export function jsRegex(rule) {
  try { return new RegExp(matchSource(rule).source, 'i'); } catch { return null; }
}

// Destination URL for a map-remote rule. Wildcard: each * in dest takes the matching * capture.
export function destFor(rule, url) {
  const re = jsRegex(rule);
  if (!re) return null;
  let d = String(rule.dest || '').trim();
  if (matchSource(rule).groups !== null) {
    let i = 0;
    d = d.replace(/\$/g, '$$$$').split('*').reduce((a, s, idx) => (idx === 0 ? s : a + '$' + (++i) + s), '');
  }
  return url.replace(re, d);
}
function destToDnr(rule) {
  const d = String(rule.dest || '').trim();
  if (matchSource(rule).groups === null) return d.replace(/\$([0-9])/g, '\\$1');
  let i = 0;
  return d.split('*').reduce((a, s, idx) => (idx === 0 ? s : a + '\\' + (++i) + s), '');
}

export function gqlMatch(op, body) {
  if (!op) return true;
  if (!body || typeof body !== 'string') return false;
  let items;
  try { const j = JSON.parse(body); items = Array.isArray(j) ? j : [j]; } catch { return false; }
  const re = new RegExp('\\b(query|mutation|subscription)\\s+' + rxEscape(op) + '\\b');
  return items.some(it => it && (it.operationName === op || (typeof it.query === 'string' && re.test(it.query))));
}

const domainOk = (list, host) => list.some(d => host === d || host.endsWith('.' + d));

// ctx: { method, type: string | string[], pageHost, body }. Missing fields are not checked.
export function whenOk(rule, ctx = {}) {
  const w = rule.when || {};
  if (w.methods?.length && ctx.method && !w.methods.includes(ctx.method.toUpperCase())) return false;
  if (w.resourceTypes?.length && ctx.type) {
    const t = [].concat(ctx.type);
    if (!w.resourceTypes.some(x => t.includes(x))) return false;
  }
  if (w.pageDomains?.length && ctx.pageHost != null && !domainOk(w.pageDomains, ctx.pageHost)) return false;
  if (w.gql && ctx.body !== undefined && !gqlMatch(w.gql, ctx.body)) return false;
  return true;
}

// Priority order: groups top to bottom, then rules top to bottom inside each group.
export function sortedRules(config) {
  const gi = new Map((config.groups || []).map((g, i) => [g.id, i]));
  const pos = r => gi.get(r.groupId) ?? 1e9;
  return (config.rules || []).map((r, i) => [r, i]).sort((a, b) => pos(a[0]) - pos(b[0]) || a[1] - b[1]).map(x => x[0]);
}

export function liveRules(config, settings) {
  if (!settings?.masterEnabled) return [];
  const groups = Object.fromEntries((config.groups || []).map(g => [g.id, g]));
  return sortedRules(config).filter(r => {
    const g = groups[r.groupId];
    return r.enabled && g && g.enabled && g.profileId === config.activeProfile;
  });
}

// ---------- compilation ----------

const pageActions = rule => (rule.actions || []).filter(a => PAGE_KINDS.includes(a.kind) && String(a.kind === 'resp-body' ? a.name : a.value || '') !== '');

// One source rule -> declarativeNetRequest rules + diagnostics.
// Returns { dnr: [{ action, condition? }], page: bool, error?, notes: [] }.
export function compileRule(rule) {
  const notes = [];
  const { source } = matchSource(rule);
  if (!String(rule.match || '').trim()) return { dnr: [], notes, error: 'No match pattern.' };
  if (!jsRegex(rule)) return { dnr: [], notes, error: 'The match is not a valid regular expression.' };

  const w = rule.when || {};
  const types = w.resourceTypes?.length ? w.resourceTypes.filter(t => RESOURCE_TYPES.includes(t)) : RESOURCE_TYPES;
  const cond = (resourceTypes = types) => {
    const c = { regexFilter: source, resourceTypes };
    const methods = (w.methods || []).map(m => m.toLowerCase()).filter(m => DNR_METHODS.includes(m));
    if (methods.length) c.requestMethods = methods;
    if (w.pageDomains?.length) c.initiatorDomains = w.pageDomains;
    return c;
  };
  const dnr = [];
  let page = false;

  if (rule.type === 'map-remote') {
    const dest = String(rule.dest || '').trim();
    if (!dest) return { dnr: [], notes, error: 'No destination set.' };
    dnr.push({ condition: cond(), action: { type: 'redirect', redirect: { regexSubstitution: destToDnr(rule) } } });
    if (rule.cors) {
      try {
        const origin = new URL(dest.replace(/\*|\$[0-9]/g, 'x')).origin;
        dnr.push({
          condition: { urlFilter: '|' + origin + '/', resourceTypes: RESOURCE_TYPES },
          action: { type: 'modifyHeaders', responseHeaders: corsHeaders() },
        });
      } catch { notes.push('Could not work out the destination origin for CORS headers.'); }
    }
    notes.push('Scripts, styles, images and API calls are swapped silently. A redirected document shows the new URL in the address bar — use Full interception to keep the original URL.');
  } else if (rule.type === 'map-local' || rule.type === 'mock') {
    const r = rule.response || {};
    if (rule.type === 'map-local' && !r.body) return { dnr: [], notes, error: 'No content yet — load ' + (r.fileName || 'a file') + '.' };
    page = true;
    const status = Number(r.status) || 200;
    const dataTypes = types.filter(t => DATA_TYPES.includes(t));
    const b64 = responseB64(r);
    // Same rule as the fetch/XHR hook: only pages on the request's own site, or listed domains.
    const host = matchHost(rule);
    const scope = w.pageDomains?.length ? w.pageDomains : host ? [siteOf(host)] : null;
    if (status === 200 && !w.gql && dataTypes.length && b64.length <= MAX_DATA_URL && scope) {
      dnr.push({
        condition: { ...cond(dataTypes), initiatorDomains: scope },
        action: { type: 'redirect', redirect: { url: 'data:' + (r.contentType || 'text/plain') + ';base64,' + b64 } },
      });
      notes.push('fetch/XHR get the full response (status, headers, delay). Scripts, styles and images get the body only, and a strict CSP on the page can refuse them. Documents need Full interception. On a page from a different site than the request, fetch/XHR only get it if the page domain is listed under Only when (or with Full interception).');
    } else {
      notes.push('Applies to fetch/XHR calls. Other request types need Full interception on the tab. On a page from a different site than the request, fetch/XHR only get it if the page domain is listed under Only when (or with Full interception).');
    }
  } else if (rule.type === 'rewrite') {
    const req = [], res = [], add = [], remove = [];
    for (const a of rule.actions || []) {
      if (!a.name && (a.kind === 'req-header' || a.kind === 'resp-header' || a.kind === 'query')) continue;
      const hdr = a.value ? { header: a.name, operation: 'set', value: a.value } : { header: a.name, operation: 'remove' };
      if (a.kind === 'req-header') req.push(hdr);
      else if (a.kind === 'resp-header') res.push(hdr);
      else if (a.kind === 'query') (a.value ? add.push({ key: a.name, value: a.value }) : remove.push(a.name));
      else if (a.kind === 'req-body') notes.push('Request body rewriting is not supported.');
    }
    page = pageActions(rule).length > 0;
    if (!w.gql) {
      if (add.length || remove.length) {
        const queryTransform = {};
        if (add.length) queryTransform.addOrReplaceParams = add;
        if (remove.length) queryTransform.removeParams = remove;
        dnr.push({ condition: cond(), action: { type: 'redirect', redirect: { transform: { queryTransform } } } });
      }
      if (req.length || res.length) {
        const action = { type: 'modifyHeaders' };
        if (req.length) action.requestHeaders = req;
        if (res.length) action.responseHeaders = res;
        dnr.push({ condition: cond(), action });
      }
    } else if (req.length || res.length || add.length || remove.length) {
      notes.push('With a GraphQL operation set, header and query actions only apply under Full interception.');
    }
    if (!dnr.length && !page) return { dnr: [], notes, error: 'Add at least one action.' };
    if (page) notes.push('Body, status and delay actions apply to fetch/XHR calls; other request types need Full interception. On a page from a different site than the request, fetch/XHR only get it if the page domain is listed under Only when (or with Full interception).');
  } else if (rule.type === 'block') {
    dnr.push({ condition: cond(), action: { type: 'block' } });
  } else if (rule.type === 'inject') {
    if (!String(rule.inject?.code || '').trim()) return { dnr: [], notes, error: 'Nothing to inject yet.' };
    notes.push('The match is tested against the page URL.');
  } else {
    return { dnr: [], notes, error: 'Unknown rule type "' + rule.type + '".' };
  }
  return { dnr, page, notes };
}

export function corsHeaders() {
  return [
    { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
    { header: 'Access-Control-Allow-Methods', operation: 'set', value: '*' },
    { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
  ];
}

// Whole config -> DNR rules. Rule order is priority: earlier rules win.
export function compileDnr(config, settings, excludedTabIds = []) {
  const live = new Set(liveRules(config, settings).map(r => r.id));
  const rules = [], idMap = {}, diag = {};
  let next = 1;
  sortedRules(config).forEach((rule, index) => {
    const c = compileRule(rule);
    const d = diag[rule.id] = { error: c.error || null, notes: c.notes, live: live.has(rule.id) && !c.error, dnrIds: [] };
    if (!d.live) return;
    for (const r of c.dnr) {
      const id = next++;
      const condition = { ...r.condition };
      if (excludedTabIds.length) condition.excludedTabIds = excludedTabIds;
      rules.push({ id, priority: Math.max(1, 100000 - index), action: r.action, condition });
      idMap[id] = { ruleId: rule.id, name: rule.name || '(unnamed)' };
      d.dnrIds.push(id);
    }
  });
  return { rules, idMap, diag };
}

// Rules handled by the in-page fetch/XHR hook.
export function compilePage(config, settings) {
  const out = [];
  for (const rule of liveRules(config, settings)) {
    const c = compileRule(rule);
    if (c.error || !c.page) continue;
    const w = rule.when || {};
    if (w.resourceTypes?.length && !w.resourceTypes.includes('xmlhttprequest')) continue;
    const base = {
      id: rule.id, name: rule.name || '(unnamed)', src: matchSource(rule).source,
      methods: w.methods || [], domains: w.pageDomains || [], gql: w.gql || '',
    };
    if (rule.type === 'rewrite') out.push({ ...base, kind: 'rewrite', actions: pageActions(rule) });
    else {
      const r = rule.response || {};
      out.push({ ...base, kind: 'mock', response: {
        status: r.status === 0 || r.status === '0' ? 0 : Number(r.status) || 200,
        contentType: r.contentType || 'text/plain', body: r.body || '', base64: !!r.base64,
        headers: (r.headers || []).filter(h => h.name), delay: Number(r.delay) || 0,
      } });
    }
  }
  return out;
}

// ---------- tester ----------

export function testUrl(config, settings, { url, method = 'GET', type = '' }) {
  const out = [];
  let won = false;
  for (const rule of liveRules(config, settings)) {
    const re = jsRegex(rule);
    if (!re || !re.test(url) || !whenOk(rule, { method, type: type || undefined })) continue;
    const c = compileRule(rule);
    if (c.error) continue;
    let outcome;
    if (rule.type === 'map-remote') outcome = '→ ' + destFor(rule, url);
    else if (rule.type === 'map-local') outcome = 'Serves ' + (rule.response?.fileName || 'stored content') + ' (' + (rule.response?.contentType || 'text/plain') + ')';
    else if (rule.type === 'mock') outcome = 'Responds ' + (rule.response?.status === 0 ? 'with a network error' : (Number(rule.response?.status) || 200) + ' ' + (rule.response?.contentType || 'text/plain'));
    else if (rule.type === 'block') outcome = 'Blocks the request';
    else if (rule.type === 'inject') outcome = 'Injects ' + (rule.inject?.lang === 'css' ? 'CSS' : 'JavaScript') + ' when this is the page URL';
    else outcome = (rule.actions || []).filter(a => a.name || a.value).map(a => ACTION_KINDS[a.kind] || a.kind).join(', ');
    const terminal = !['rewrite', 'inject'].includes(rule.type);
    out.push({ rule, outcome, shadowed: terminal && won });
    if (terminal) won = true;
  }
  return out;
}

// ---------- config shape ----------

export function seedConfig() {
  const p = uid('p'), g = uid('g');
  const rule = (o) => ({ id: uid(), groupId: g, enabled: false, regex: false, actions: [], when: {}, ...o });
  return {
    version: 2, activeProfile: p,
    profiles: [{ id: p, name: 'Default' }],
    groups: [{ id: g, profileId: p, name: 'Examples', enabled: true }],
    rules: [
      rule({ type: 'map-remote', name: 'Site assets → local dev server', match: 'https://www.example.com/assets/*', dest: 'http://localhost:3000/assets/*', cors: true }),
      rule({ type: 'mock', name: 'Mock user API', match: 'https://api.example.com/v1/user*', response: { status: 200, contentType: 'application/json', body: '{\n  "id": 1,\n  "name": "Test User"\n}', headers: [], delay: 0 } }),
      rule({ type: 'rewrite', name: 'Allow CORS on API', match: 'https://api.example.com/*', actions: corsHeaders().map(h => ({ kind: 'resp-header', name: h.header, value: h.value })) }),
      rule({ type: 'inject', name: 'Hello from Reroute', match: 'https://www.example.com/*', inject: { lang: 'js', runAt: 'document_idle', code: "console.log('Reroute: script injected');" } }),
    ],
  };
}

// Accepts current configs and the v1 rules.json (engine / first extension) format.
export function normalizeConfig(raw) {
  if (!raw || !Array.isArray(raw.rules)) throw new Error('No "rules" array found.');
  const c = { version: 2, activeProfile: raw.activeProfile, profiles: [], groups: [], rules: [] };
  c.profiles = (raw.profiles || []).map(p => ({ id: String(p.id || uid('p')), name: p.name || 'Profile' }));
  if (!c.profiles.length) c.profiles.push({ id: uid('p'), name: 'Default' });
  if (!c.profiles.some(p => p.id === c.activeProfile)) c.activeProfile = c.profiles[0].id;
  c.groups = (raw.groups || []).map(g => ({
    id: String(g.id || uid('g')), name: g.name || 'Group', enabled: g.enabled !== false,
    profileId: c.profiles.some(p => p.id === g.profileId) ? g.profileId : c.activeProfile,
  }));
  if (!c.groups.length) c.groups.push({ id: uid('g'), profileId: c.activeProfile, name: 'Rules', enabled: true });
  const seen = new Set();
  for (const r of raw.rules) {
    if (!r || typeof r !== 'object') continue;
    let id = String(r.id || uid());
    if (seen.has(id)) id = uid();
    seen.add(id);
    const rule = {
      id, enabled: !!r.enabled, regex: !!r.regex, name: r.name || '',
      groupId: c.groups.some(g => g.id === r.groupId) ? r.groupId : c.groups[0].id,
      type: TYPE_LABELS[r.type] ? r.type : 'map-remote',
      match: String(r.match || '').trim(),
      when: {
        methods: (r.when?.methods || []).map(m => String(m).toUpperCase()),
        resourceTypes: (r.when?.resourceTypes || []).filter(t => RESOURCE_TYPES.includes(t)),
        pageDomains: (r.when?.pageDomains || []).map(String), gql: r.when?.gql || '',
      },
      actions: (r.actions || []).map(a => {
        if (a.kind === 'strip-req-cookie') return { kind: 'req-header', name: 'Cookie', value: '' };
        if (a.kind === 'strip-resp-cookie') return { kind: 'resp-header', name: 'Set-Cookie', value: '' };
        return { kind: a.kind, name: a.name || '', value: a.value ?? '', regex: !!a.regex };
      }),
    };
    if (r.dest !== undefined) rule.dest = String(r.dest);
    if (r.cors) rule.cors = true;
    if (r.response) rule.response = {
      status: r.response.status ?? 200, contentType: r.response.contentType || 'text/plain',
      body: r.response.body || '', base64: !!r.response.base64, fileName: r.response.fileName || '',
      headers: (r.response.headers || []).map(h => ({ name: h.name || '', value: h.value || '' })),
      delay: Number(r.response.delay) || 0,
    };
    if (r.inject) rule.inject = { lang: r.inject.lang === 'css' ? 'css' : 'js', runAt: r.inject.runAt || 'document_idle', code: r.inject.code || '' };
    c.rules.push(rule);
  }
  return c;
}
