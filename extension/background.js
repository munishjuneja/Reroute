import {
  DEFAULT_SETTINGS, compileDnr, compilePage, liveRules, jsRegex, matchSource, destFor, whenOk,
  responseB64, utf8ToB64, b64ToUtf8, seedConfig, uid, neededOrigins,
} from './core.js';

const K = {
  config: 'rrConfig', settings: 'rrSettings', page: 'rrPage',   // storage.local
  runtime: 'rrRuntime', log: 'rrLog', dbg: 'rrDebugTabs',       // storage.session
  rec: 'rrRec', caps: 'rrCaptures',
};
const dnr = chrome.declarativeNetRequest;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let cache = null;      // { live, re, injects, idMap, userScripts }
let logBuf = null, logLoad = null, capLoad = null;
let logTimer = null;
const pending = new Map(); // debugger requestId -> response-stage actions

// ---------- state ----------

async function load() {
  const st = await chrome.storage.local.get([K.config, K.settings]);
  let config = st[K.config];
  if (!config) {
    config = seedConfig();
    await chrome.storage.local.set({ [K.config]: config });
  }
  return { config, settings: { ...DEFAULT_SETTINGS, ...(st[K.settings] || {}) } };
}
const getDbg = async () => (await chrome.storage.session.get(K.dbg))[K.dbg] || [];
const setDbg = tabs => chrome.storage.session.set({ [K.dbg]: tabs });

async function log(entry) {
  // one shared load, so entries arriving together cannot overwrite each other
  logLoad ||= chrome.storage.session.get(K.log).then(s => { logBuf = s[K.log] || []; });
  await logLoad;
  logBuf.unshift({ t: Date.now(), ...entry });
  if (logBuf.length > 200) logBuf.length = 200;
  clearTimeout(logTimer);
  logTimer = setTimeout(() => chrome.storage.session.set({ [K.log]: logBuf }), 250);
}

// ---------- apply ----------

let chain = Promise.resolve();
const apply = () => (chain = chain.then(doApply, doApply));
const getCache = async () => { if (!cache) await apply(); return cache; };

async function doApply() {
  const { config, settings } = await load();

  // Auto-off: switch everything off once the chosen time has passed.
  if (settings.masterEnabled && settings.autoOffAt) {
    if (settings.autoOffAt <= Date.now()) {
      settings.masterEnabled = false; settings.autoOffAt = 0;
      await chrome.storage.local.set({ [K.settings]: settings });
    } else chrome.alarms.create('rr-autooff', { when: settings.autoOffAt });
  } else chrome.alarms.clear('rr-autooff');

  // Site access the enabled rules need but the user has not granted yet.
  const needs = [];
  for (const o of neededOrigins(config, settings)) {
    if (!(await chrome.permissions.contains({ origins: [o] }).catch(() => false))) needs.push(o);
  }
  const dbgTabs = await getDbg();
  const { rules, idMap, diag } = compileDnr(config, settings, dbgTabs);
  const errors = {};

  // Chrome matches with RE2 — drop rules whose regex it cannot run.
  const checked = new Map();
  const ok = [];
  for (const r of rules) {
    const rx = r.condition.regexFilter;
    if (rx && !checked.has(rx)) checked.set(rx, await dnr.isRegexSupported({ regex: rx, isCaseSensitive: false }));
    const res = rx ? checked.get(rx) : { isSupported: true };
    if (res.isSupported) ok.push(r);
    else errors[idMap[r.id].ruleId] = res.reason === 'memoryLimitExceeded'
      ? 'This pattern is too complex for Chrome — simplify it.'
      : 'Chrome cannot run this regex (RE2 syntax: no lookaheads or backreferences).';
  }
  try {
    const existing = await dnr.getSessionRules();
    await dnr.updateSessionRules({ removeRuleIds: existing.map(r => r.id), addRules: ok });
  } catch (e) { errors._global = String(e.message || e); }

  const page = compilePage(config, settings);
  await chrome.storage.local.set({ [K.page]: page });
  await syncContentScripts(page.length > 0).catch(e => { errors._global = String(e.message || e); });

  const live = liveRules(config, settings).filter(r => !diag[r.id]?.error && !errors[r.id]);
  const re = Object.fromEntries(live.map(r => [r.id, jsRegex(r)]));
  const injects = live.filter(r => r.type === 'inject');
  const userScripts = await syncUserScripts(injects.filter(r => r.inject.lang !== 'css'));

  cache = { live, re, injects, idMap, userScripts };
  await chrome.storage.session.set({ [K.runtime]: { errors, userScripts, needs, active: live.length, at: Date.now() } });
  const blocked = settings.masterEnabled && needs.length > 0;
  await chrome.action.setBadgeText({ text: !settings.masterEnabled ? 'off' : blocked ? '!' : String(live.length) });
  await chrome.action.setBadgeBackgroundColor({ color: !settings.masterEnabled ? '#8a93a0' : blocked ? '#c2410c' : '#2f6df6' });
  return live.length;
}

// The fetch/XHR hook is only registered while a rule needs it.
async function syncContentScripts(need) {
  const ids = ['rr-main', 'rr-bridge'];
  const cur = await chrome.scripting.getRegisteredContentScripts({ ids });
  if (need && cur.length === 2) return;
  if (cur.length) await chrome.scripting.unregisterContentScripts({ ids: cur.map(c => c.id) });
  if (!need) return;
  const base = { matches: ['http://*/*', 'https://*/*'], runAt: 'document_start', allFrames: true };
  await chrome.scripting.registerContentScripts([
    { ...base, id: 'rr-main', js: ['page/interceptor.js'], world: 'MAIN' },
    { ...base, id: 'rr-bridge', js: ['page/bridge.js'] },
  ]);
}

const wrapScript = rule =>
  '(function(){if(!new RegExp(' + JSON.stringify(matchSource(rule).source) + ',"i").test(location.href))return;\n' + rule.inject.code + '\n})();';

// Returns true when chrome.userScripts is usable ("Allow user scripts" is on).
async function syncUserScripts(rules) {
  let api;
  try { api = chrome.userScripts; } catch { return false; }
  if (!api) return false;
  try {
    await api.unregister();
    if (rules.length) await api.register(rules.map(r => ({
      id: 'rr-' + r.id, matches: ['http://*/*', 'https://*/*'], world: 'MAIN',
      runAt: r.inject.runAt || 'document_idle', js: [{ code: wrapScript(r) }],
    })));
    return true;
  } catch { return false; }
}

// ---------- inject ----------

chrome.webNavigation.onCommitted.addListener(async d => {
  if (d.frameId !== 0 || !/^https?:/.test(d.url)) return;
  const c = await getCache();
  for (const r of c.injects) {
    if (!c.re[r.id]?.test(d.url)) continue;
    const target = { tabId: d.tabId, frameIds: [0] };
    try {
      if (r.inject.lang === 'css') await chrome.scripting.insertCSS({ target, css: r.inject.code, origin: 'USER' });
      else if (!c.userScripts) {
        // Fallback when user scripts are not allowed: inline <script>, which a strict page CSP may refuse.
        await chrome.scripting.executeScript({
          target, world: 'MAIN', injectImmediately: r.inject.runAt === 'document_start', args: [r.inject.code],
          func: code => { const s = document.createElement('script'); s.textContent = code; (document.head || document.documentElement).appendChild(s); s.remove(); },
        });
      }
      log({ ruleId: r.id, name: r.name, url: d.url, via: 'inject' });
    } catch { /* tab went away or page is restricted */ }
  }
});

// ---------- full interception (chrome.debugger) ----------

const CDP_TYPES = {
  Document: ['main_frame', 'sub_frame'], Stylesheet: ['stylesheet'], Image: ['image'], Media: ['media'],
  Font: ['font'], Script: ['script'], XHR: ['xmlhttprequest'], Fetch: ['xmlhttprequest'],
  WebSocket: ['websocket'], Ping: ['ping'], CSPViolationReport: ['csp_report'],
};
const hdrGet = (obj, name) => { const k = Object.keys(obj || {}).find(k => k.toLowerCase() === name); return k ? obj[k] : undefined; };
const setHdr = (list, name, value) => {
  const out = list.filter(h => h.name.toLowerCase() !== name.toLowerCase());
  if (value !== '' && value != null) out.push({ name, value: String(value) });
  return out;
};

async function toggleDebugger(tabId) {
  const tabs = await getDbg();
  const target = { tabId };
  if (tabs.includes(tabId)) {
    await chrome.debugger.detach(target).catch(() => {});
    await setDbg(tabs.filter(t => t !== tabId));
    if (tabs.length === 1) await setRec(false);
  } else {
    await chrome.debugger.attach(target, '1.3');
    await chrome.debugger.sendCommand(target, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await chrome.debugger.sendCommand(target, 'Network.enable');
    await chrome.debugger.sendCommand(target, 'Network.setCacheDisabled', { cacheDisabled: true });
    await setDbg([...tabs, tabId]);
  }
  await apply();
  return (await getDbg()).includes(tabId);
}

chrome.debugger.onDetach.addListener(async src => {
  const tabs = await getDbg();
  if (src.tabId && tabs.includes(src.tabId)) {
    await setDbg(tabs.filter(t => t !== src.tabId));
    if (tabs.length === 1) await setRec(false);
    apply();
  }
});

chrome.debugger.onEvent.addListener((src, method, p) => {
  if (method.startsWith('Network.')) { onNetwork(src, method, p).catch(() => {}); return; }
  if (method !== 'Fetch.requestPaused') return;
  onPaused(src, p).catch(() => chrome.debugger.sendCommand(src, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}));
});

async function onPaused(src, p) {
  const send = (m, a) => chrome.debugger.sendCommand(src, m, a);
  const requestId = p.requestId;
  if (p.responseStatusCode !== undefined || p.responseErrorReason) return onResponse(send, p);

  const c = await getCache();
  const req = p.request;
  const url = req.url;
  const types = CDP_TYPES[p.resourceType] || ['other'];
  let pageHost = null;
  if (p.resourceType !== 'Document') {
    try { pageHost = new URL((await chrome.tabs.get(src.tabId)).url).hostname; } catch { /* unknown */ }
  }
  const ctx = { method: req.method, type: types, pageHost, body: req.postData || '' };

  let terminal = null;
  const rewrites = [];
  for (const r of c.live) {
    if (r.type === 'inject' || !c.re[r.id]?.test(url) || !whenOk(r, ctx)) continue;
    if (r.type === 'rewrite') rewrites.push(r);
    else if (!terminal) terminal = r;
  }
  if (!terminal && !rewrites.length) return send('Fetch.continueRequest', { requestId });
  const hit = r => log({ ruleId: r.id, name: r.name, url, via: 'full', tabId: src.tabId });

  if (terminal?.type === 'block') { hit(terminal); return send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); }

  if (terminal && terminal.type !== 'map-remote') {
    const r = terminal.response || {};
    hit(terminal);
    if (Number(r.delay) > 0) await sleep(Number(r.delay));
    if (r.status === 0 || r.status === '0') return send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
    let headers = [{ name: 'Content-Type', value: r.contentType || 'text/plain' }];
    for (const h of r.headers || []) if (h.name) headers = setHdr(headers, h.name, h.value);
    const origin = hdrGet(req.headers, 'origin');
    if (origin && !headers.some(h => h.name.toLowerCase() === 'access-control-allow-origin')) {
      headers.push({ name: 'Access-Control-Allow-Origin', value: origin }, { name: 'Access-Control-Allow-Credentials', value: 'true' },
        { name: 'Access-Control-Allow-Methods', value: '*' },
        { name: 'Access-Control-Allow-Headers', value: hdrGet(req.headers, 'access-control-request-headers') || '*' });
    }
    return send('Fetch.fulfillRequest', { requestId, responseCode: Number(r.status) || 200, responseHeaders: headers, body: responseB64(r) });
  }

  // map-remote and/or rewrites: continue the request, changed.
  const acts = rewrites.flatMap(r => r.actions || []);
  let newUrl = url;
  if (terminal) {
    newUrl = destFor(terminal, url) || url; hit(terminal);
    // Follow chained map-remote rules (e.g. site -> http://app:3000 -> http://localhost:3001).
    for (let hop = 0; hop < 5; hop++) {
      const next = c.live.find(r => r.type === 'map-remote' && c.re[r.id]?.test(newUrl) && whenOk(r, { ...ctx, pageHost: null }));
      const to = next && destFor(next, newUrl);
      if (!to || to === newUrl) break;
      newUrl = to; hit(next);
    }
  }
  rewrites.forEach(hit);
  const q = acts.filter(a => a.kind === 'query' && a.name);
  if (q.length) {
    const u = new URL(newUrl);
    for (const a of q) (a.value ? u.searchParams.set(a.name, a.value) : u.searchParams.delete(a.name));
    newUrl = u.href;
  }
  const args = { requestId };
  if (newUrl !== url) args.url = newUrl;
  const reqH = acts.filter(a => a.kind === 'req-header' && a.name);
  if (reqH.length) {
    let headers = Object.entries(req.headers).map(([name, value]) => ({ name, value: String(value) }));
    for (const a of reqH) headers = setHdr(headers, a.name, a.value);
    args.headers = headers;
  }
  const respActs = acts.filter(a => ['resp-header', 'resp-body', 'status'].includes(a.kind));
  if (respActs.length) { pending.set(requestId, respActs); args.interceptResponse = true; }
  const delay = Math.max(0, ...acts.filter(a => a.kind === 'delay').map(a => Number(a.value) || 0));
  if (delay) await sleep(delay);
  return send('Fetch.continueRequest', args);
}

function replaceBody(text, acts) {
  for (const a of acts) {
    if (!a.name) continue;
    try { text = a.regex ? text.replace(new RegExp(a.name, 'g'), a.value || '') : text.split(a.name).join(a.value || ''); } catch { /* bad regex */ }
  }
  return text;
}

async function onResponse(send, p) {
  const requestId = p.requestId;
  const acts = pending.get(requestId);
  pending.delete(requestId);
  if (!acts || p.responseErrorReason) return send('Fetch.continueRequest', { requestId });
  let headers = (p.responseHeaders || []).slice();
  for (const a of acts) if (a.kind === 'resp-header' && a.name) headers = setHdr(headers, a.name, a.value);
  const st = acts.filter(a => a.kind === 'status' && Number(a.value)).pop();
  const bodyActs = acts.filter(a => a.kind === 'resp-body');
  const code = p.responseStatusCode;
  const noBody = (code >= 300 && code < 400) || code === 204;
  if (noBody || (!bodyActs.length && !st)) {
    return send('Fetch.continueResponse', { requestId, responseCode: st && !(code >= 300 && code < 400) ? Number(st.value) : code, responseHeaders: headers });
  }
  const got = await send('Fetch.getResponseBody', { requestId });
  let body = got.body;
  if (bodyActs.length) {
    body = utf8ToB64(replaceBody(got.base64Encoded ? b64ToUtf8(got.body) : got.body, bodyActs));
    headers = setHdr(setHdr(headers, 'content-length', ''), 'content-encoding', '');
  } else if (!got.base64Encoded) body = utf8ToB64(got.body);
  return send('Fetch.fulfillRequest', { requestId, responseCode: st ? Number(st.value) : code, responseHeaders: headers, body });
}

// ---------- recording (needs Full interception on the tab) ----------

let rec = null, capBuf = null, capTimer = null;
const netReqs = new Map();
const isRec = async () => { if (rec === null) rec = !!(await chrome.storage.session.get(K.rec))[K.rec]; return rec; };
async function setRec(on) { rec = on; await chrome.storage.session.set({ [K.rec]: on }); }

async function addCapture(c) {
  capLoad ||= chrome.storage.session.get(K.caps).then(s => { capBuf = s[K.caps] || []; });
  await capLoad;
  capBuf.unshift(c);
  let total = 0;
  capBuf = capBuf.filter((x, i) => i < 80 && (total += x.body.length) < 6_000_000);
  clearTimeout(capTimer);
  capTimer = setTimeout(() => chrome.storage.session.set({ [K.caps]: capBuf }), 250);
}

async function onNetwork(src, method, p) {
  if (!(await isRec())) return;
  const key = src.tabId + ':' + p.requestId;
  if (method === 'Network.requestWillBeSent') {
    if ((p.type === 'XHR' || p.type === 'Fetch') && !netReqs.has(key)) {
      netReqs.set(key, { url: p.request.url, method: p.request.method, postData: p.request.postData || '' });
    }
  } else if (method === 'Network.responseReceived') {
    const r = netReqs.get(key);
    if (r) { r.status = p.response.status; r.mime = p.response.mimeType || ''; }
  } else if (method === 'Network.loadingFailed') {
    netReqs.delete(key);
  } else if (method === 'Network.loadingFinished') {
    const r = netReqs.get(key);
    netReqs.delete(key);
    if (!r || r.status === undefined) return;
    let got;
    try { got = await chrome.debugger.sendCommand(src, 'Network.getResponseBody', { requestId: p.requestId }); } catch { return; }
    const tooLarge = (got.body || '').length > 1_000_000;
    let gql = '';
    try { const j = JSON.parse(r.postData); gql = (Array.isArray(j) ? j[0] : j)?.operationName || ''; } catch { /* not GraphQL */ }
    addCapture({
      id: uid('c'), t: Date.now(), tabId: src.tabId, url: r.url, method: r.method, status: r.status, mime: r.mime,
      body: tooLarge ? '' : got.body || '', base64: !!got.base64Encoded, tooLarge, gql,
    });
  }
}

// ---------- events ----------

chrome.runtime.onInstalled.addListener(apply);
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'rr-autooff') apply(); });
chrome.permissions.onAdded.addListener(apply);
chrome.permissions.onRemoved.addListener(apply);
chrome.runtime.onStartup.addListener(apply);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[K.config] || changes[K.settings])) apply();
});

// Unpacked builds get a per-request callback for redirect/header/block rules.
dnr.onRuleMatchedDebug?.addListener(async info => {
  if (info.rule.rulesetId !== '_session') return;
  const c = await getCache();
  const m = c.idMap[info.rule.ruleId];
  if (m) log({ ruleId: m.ruleId, name: m.name, url: info.request.url, via: 'network', tabId: info.request.tabId });
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'rr:hit') {
    if (!sender.tab) return; // only our own content script reports hits
    log({ ruleId: msg.id, name: msg.name, url: msg.url, via: 'page', tabId: sender.tab?.id });
  } else if (msg.type === 'rr:apply') {
    apply().then(n => respond({ count: n })); return true;
  } else if (msg.type === 'rr:dbg-toggle') {
    toggleDebugger(msg.tabId).then(on => respond({ on }), e => respond({ on: false, error: String(e.message || e) })); return true;
  } else if (msg.type === 'rr:dbg-state') {
    getDbg().then(t => respond({ on: t.includes(msg.tabId) })); return true;
  } else if (msg.type === 'rr:rec-toggle') {
    (async () => {
      const on = !(await isRec());
      if (on && !(await getDbg()).includes(msg.tabId)) await toggleDebugger(msg.tabId);
      await setRec(on);
      return { on, dbg: (await getDbg()).includes(msg.tabId) };
    })().then(respond, e => respond({ on: false, error: String(e.message || e) }));
    return true;
  } else if (msg.type === 'rr:rec-state') {
    isRec().then(on => respond({ on })); return true;
  } else if (msg.type === 'rr:clear-captures') {
    capBuf = []; capLoad = Promise.resolve(); chrome.storage.session.set({ [K.caps]: [] }); respond({});
  } else if (msg.type === 'rr:clear-log') {
    logBuf = []; logLoad = Promise.resolve(); chrome.storage.session.set({ [K.log]: [] }); respond({});
  }
});

apply();
