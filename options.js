import {
  RESOURCE_TYPES, TYPE_LABELS, ACTION_KINDS, DEFAULT_SETTINGS, uid, compileRule, testUrl,
  normalizeConfig, seedConfig, corsHeaders, sortedRules, riskOf, redactConfig, armAutoOff,
} from './core.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TYPE_HINTS = {
  'map-remote': 'Send matching requests to another URL — e.g. production assets to your local dev server.',
  'map-local': 'Answer matching requests with a file stored in the extension.',
  mock: 'Answer matching requests with a response you write here: status, headers, body, delay.',
  rewrite: 'Let the request through, but change headers, query params, status or body.',
  block: 'Fail matching requests.',
  inject: 'Run your own JavaScript or CSS on matching pages.',
};
const MIME = { json: 'application/json', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', html: 'text/html', htm: 'text/html', svg: 'image/svg+xml', txt: 'text/plain', xml: 'application/xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', woff2: 'font/woff2', woff: 'font/woff' };

let config, settings = { ...DEFAULT_SETTINGS }, runtime = { errors: {} }, logs = [], caps = [], recOn = false, drag = null;
let sel = { group: 'all', rule: null }, tab = 'rules', lastJson = '', saveTimer, pendingImport = null;

// ---------- data ----------
const groupsOf = () => config.groups.filter(g => g.profileId === config.activeProfile);
const rulesOf = gid => sortedRules(config).filter(r => r.groupId === gid);
const current = () => config.rules.find(r => r.id === sel.rule) || null;
const diagFor = rule => { const c = compileRule(rule); return { error: c.error || runtime.errors?.[rule.id] || null, notes: c.notes }; };

function ensureShape(rule) {
  rule.actions ||= []; rule.when ||= {};
  if (rule.type === 'map-local' || rule.type === 'mock') rule.response ||= { status: 200, contentType: 'application/json', body: '', headers: [], delay: 0 };
  if (rule.response) rule.response.headers ||= [];
  if (rule.type === 'inject') rule.inject ||= { lang: 'js', runAt: 'document_idle', code: '' };
  if (rule.type === 'map-remote') rule.dest ??= '';
}
function save() {
  clearTimeout(saveTimer);
  lastJson = JSON.stringify(config);
  return chrome.storage.local.set({ rrConfig: config });
}
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 250); };
const saveSettings = () => chrome.storage.local.set({ rrSettings: settings });

// ---------- render ----------
const sw = (on, act, id, label) => `<button class="sw" role="switch" aria-checked="${!!on}" data-act="${act}" data-id="${esc(id)}" aria-label="${esc(label)}"></button>`;

function renderTop() {
  $('#master').setAttribute('aria-checked', !!settings.masterEnabled);
  $('#masterLbl').textContent = settings.masterEnabled ? 'On' : 'Off — no rules apply';
  $('#profile').innerHTML = config.profiles.map(p => `<option value="${esc(p.id)}"${p.id === config.activeProfile ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  for (const t of ['rules', 'test', 'log']) $('#tab-' + t).hidden = t !== tab;
  const b = $('#banner');
  b.hidden = !runtime.errors?._global;
  b.textContent = runtime.errors?._global ? 'Chrome rejected the rule set: ' + runtime.errors._global : '';
  const needs = runtime.needs || [];
  $('#perm').hidden = !needs.length || !settings.masterEnabled;
  const all = needs.includes('<all_urls>');
  $('#permText').textContent = all
    ? 'Rules are not applied yet. At least one enabled rule is not tied to a single site, so Reroute needs access to all sites.'
    : 'Rules are not applied yet. Reroute needs access to: ' + needs.map(o => o.replace(/^\*:\/\/(\*\.)?|\/\*$/g, '')).join(', ') + '.';
  $('#permGrant').hidden = all;
}

function renderSide() {
  const gs = groupsOf();
  const total = gs.reduce((n, g) => n + rulesOf(g.id).length, 0);
  $('#side').innerHTML = `<h2>Groups</h2>
    <div class="grp ${sel.group === 'all' ? 'sel' : ''}"><button class="name" data-act="group" data-id="all">All rules</button><span class="count">${total}</span></div>
    ${gs.map(g => `<div class="grp ${sel.group === g.id ? 'sel' : ''}" draggable="true" data-drag="group" data-id="${esc(g.id)}" data-gid="${esc(g.id)}">
      ${sw(g.enabled, 'g-toggle', g.id, 'Enable group ' + g.name)}
      <button class="name" data-act="group" data-id="${esc(g.id)}">${esc(g.name)}</button><span class="count">${rulesOf(g.id).length}</span></div>`).join('')}
    <button class="ghost" data-act="g-add" style="margin-top:6px">＋ New group</button>`;
}

function ruleRow(r, groupOn) {
  const d = diagFor(r);
  let summary = esc(r.match || '(no match yet)');
  if (r.type === 'map-remote' && r.dest) summary += ' → ' + esc(r.dest);
  else if (r.type === 'map-local' && r.response?.fileName) summary += ' → ' + esc(r.response.fileName);
  else if (r.type === 'mock') summary += ' → ' + (r.response?.status === 0 ? 'network error' : esc(Number(r.response?.status) || 200));
  return `<div class="rule ${sel.rule === r.id ? 'sel' : ''} ${r.enabled && groupOn && settings.masterEnabled ? '' : 'off'}" draggable="true" data-drag="rule" data-id="${esc(r.id)}">
    <span class="grip" aria-hidden="true" title="Drag to reorder">⠿</span>${sw(r.enabled, 'r-toggle', r.id, 'Enable rule ' + (r.name || r.match))}
    <button class="body" data-act="rule" data-id="${esc(r.id)}">
      <div class="nm">${esc(r.name || '(unnamed)')}</div><div class="pair">${summary}</div>
      ${d.error ? `<div class="err">${esc(d.error)}</div>` : ''}
    </button>
    <span class="tag ${esc(r.type)}">${esc(TYPE_LABELS[r.type] || r.type)}</span></div>`;
}

function renderList() {
  const gs = groupsOf();
  const g = gs.find(x => x.id === sel.group);
  const shown = g ? [g] : gs;
  const body = shown.map(x => {
    const rs = rulesOf(x.id);
    return (g ? '' : `<div class="sub">${esc(x.name)}${x.enabled ? '' : ' — off'}</div>`) +
      (rs.length ? rs.map(r => ruleRow(r, x.enabled)).join('') : g ? '<div class="empty">No rules in this group yet.</div>' : '');
  }).join('');
  $('#list').innerHTML = `<div class="list-h"><h1>${esc(g ? g.name : 'All rules')}</h1>
      ${g ? `<button class="ghost" data-act="g-rename" title="Rename group" aria-label="Rename group">✎</button>
             <button class="ghost" data-act="g-export" title="Export this group" aria-label="Export this group">⤓</button>
             <button class="ghost danger" data-act="g-del" title="Delete group" aria-label="Delete group">🗑</button>` : ''}
      <button class="primary" data-act="r-add">＋ New rule</button></div>${body || '<div class="empty">No groups yet — add one on the left.</div>'}`;
}

const field = (label, inner, hint = '') => `<div class="field"><label>${label}${inner}</label>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
const input = (f, v, o = {}) => `<input type="${o.num ? 'number' : 'text'}" class="${o.mono ? 'mono' : ''}" data-f="${f}"${o.as ? ` data-as="${o.as}"` : ''} value="${esc(v)}" placeholder="${esc(o.ph || '')}" spellcheck="false">`;

function renderDiag() {
  const r = current(), el = $('#diag');
  if (!r || !el) return;
  const d = diagFor(r);
  el.innerHTML = (d.error ? `<div class="note bad">${esc(d.error)}</div>` : '') +
    riskOf(r).map(x => `<div class="note warn">${esc(x.text)}</div>`).join('') + d.notes.map(n => `<div class="note">${esc(n)}</div>`).join('');
}

function renderEditor() {
  const r = current();
  if (!r) { $('#editor').innerHTML = '<div class="empty">Select a rule to edit it, or create a new one.</div>'; return; }
  ensureShape(r);
  const w = r.when;
  let h = `<div class="pane-h" style="margin-left:0">Rule</div>
    ${field('Name', input('name', r.name))}
    ${field('Type', `<select data-f="type" data-rerender>${Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}"${k === r.type ? ' selected' : ''}>${v}</option>`).join('')}</select>`, TYPE_HINTS[r.type])}
    ${field(r.type === 'inject' ? 'Page URL' : 'Match URL', input('match', r.match, { mono: true, ph: 'https://www.example.com/assets/*' }),
      r.regex ? 'Chrome uses RE2: no lookaheads or backreferences.' : '* matches anything. Without a trailing *, a URL with a query string will not match.')}
    <label class="check"><input type="checkbox" data-f="regex" data-rerender ${r.regex ? 'checked' : ''}> Regular expression</label>`;

  if (r.type === 'map-remote') {
    h += field('Send to', input('dest', r.dest, { mono: true, ph: 'http://localhost:3000/assets/*' }),
      r.regex ? 'Use $1, $2 for capture groups.' : 'Each * here takes the text matched by the same * above.');
    h += `<label class="check"><input type="checkbox" data-f="cors" ${r.cors ? 'checked' : ''}> Add CORS headers to responses from the destination</label>`;
  }

  if (r.type === 'map-local' || r.type === 'mock') {
    const p = r.response;
    h += `<div class="field row"><button class="fit" data-act="file">Load from file…</button>
      <span class="muted">${p.fileName ? esc(p.fileName) : 'or write the body below'}</span></div>
      <div class="row">
        ${field('Content type', input('response.contentType', p.contentType, { ph: 'application/json' }))}
        ${r.type === 'mock' ? field('Status', input('response.status', p.status, { num: true, as: 'num' })) + field('Delay (ms)', input('response.delay', p.delay || 0, { num: true, as: 'num' })) : ''}
      </div>
      ${r.type === 'mock' ? '<div class="hint" style="margin:-6px 0 8px">Status 0 simulates a network failure.</div>' : ''}`;
    if (r.type === 'mock') {
      h += `<div class="lbl">Response headers</div>` + p.headers.map((x, i) => `<div class="hdr">
        <input type="text" data-hi="${i}" data-hf="name" value="${esc(x.name)}" placeholder="Header" aria-label="Header name">
        <input type="text" data-hi="${i}" data-hf="value" value="${esc(x.value)}" placeholder="Value" aria-label="Header value">
        <button class="ghost danger" data-act="h-del" data-id="${i}" aria-label="Remove header">✕</button></div>`).join('') +
        `<button class="ghost" data-act="h-add" style="margin-bottom:8px">＋ Header</button>`;
    }
    h += p.base64
      ? `<div class="note">Binary file, ${Math.round(p.body.length * 0.75 / 1024)} KB. <button class="ghost" data-act="file-clear">Remove</button></div>`
      : field('Body', `<textarea data-f="response.body" spellcheck="false">${esc(p.body)}</textarea>`);
  }

  if (r.type === 'rewrite') {
    h += `<div class="lbl">Actions</div>` + r.actions.map((a, i) => {
      const single = a.kind === 'status' || a.kind === 'delay';
      const ph = a.kind === 'resp-body' ? ['Find', 'Replace with'] : a.kind === 'query' ? ['Param', 'Value (empty removes)'] : ['Header', 'Value (empty removes)'];
      return `<div class="act">
        <select data-ai="${i}" data-af="kind" data-rerender aria-label="Action">${Object.entries(ACTION_KINDS).map(([k, v]) => `<option value="${k}"${k === a.kind ? ' selected' : ''}>${v}</option>`).join('')}${ACTION_KINDS[a.kind] ? '' : `<option selected>${esc(a.kind)}</option>`}</select>
        ${single ? `<input type="number" data-ai="${i}" data-af="value" value="${esc(a.value)}" placeholder="${a.kind === 'status' ? '503' : '1500'}" aria-label="Value" style="grid-column:span 2">`
          : `<input type="text" class="mono" data-ai="${i}" data-af="name" value="${esc(a.name)}" placeholder="${ph[0]}" aria-label="${ph[0]}">
             <input type="text" class="mono" data-ai="${i}" data-af="value" value="${esc(a.value)}" placeholder="${ph[1]}" aria-label="${ph[1]}">`}
        <span class="row" style="gap:2px">${a.kind === 'resp-body' ? `<label class="check fit" title="Find is a regular expression"><input type="checkbox" data-ai="${i}" data-af="regex" ${a.regex ? 'checked' : ''}>.*</label>` : ''}
          <button class="ghost danger fit" data-act="a-del" data-id="${i}" aria-label="Remove action">✕</button></span></div>`;
    }).join('') + `<div class="foot" style="margin-top:4px"><button data-act="a-add">＋ Action</button><button data-act="a-cors">Allow CORS</button><button data-act="a-csp">Remove CSP</button></div>`;
  }

  if (r.type === 'inject') {
    const j = r.inject;
    h += `<div class="row">
      ${field('Language', `<select data-f="inject.lang" data-rerender><option value="js"${j.lang !== 'css' ? ' selected' : ''}>JavaScript</option><option value="css"${j.lang === 'css' ? ' selected' : ''}>CSS</option></select>`)}
      ${j.lang !== 'css' ? field('Run at', `<select data-f="inject.runAt">${[['document_start', 'Before the page loads'], ['document_end', 'When the DOM is ready'], ['document_idle', 'After the page loads']].map(([k, v]) => `<option value="${k}"${k === j.runAt ? ' selected' : ''}>${v}</option>`).join('')}</select>`) : ''}
    </div>
    ${field('Code', `<textarea data-f="inject.code" spellcheck="false" style="min-height:220px">${esc(j.code)}</textarea>`)}
    ${j.lang !== 'css' && !runtime.userScripts ? `<div class="note">For reliable script injection, turn on <b>Allow user scripts</b> for Reroute on its chrome://extensions details page. Until then scripts are added as inline tags, which pages with a strict CSP refuse.</div>` : ''}`;
  } else {
    h += `<details ${(w.methods?.length || w.resourceTypes?.length || w.pageDomains?.length || w.gql) ? 'open' : ''}><summary>Only when…</summary>
      ${field('Methods', input('when.methods', (w.methods || []).join(', '), { as: 'ulist', ph: 'any — e.g. GET, POST' }))}
      ${field('Page is on domain', input('when.pageDomains', (w.pageDomains || []).join(', '), { as: 'list', ph: 'any — e.g. example.com' }), 'Subdomains are included.')}
      ${['mock', 'map-local', 'rewrite'].includes(r.type) ? field('GraphQL operation name', input('when.gql', w.gql || '', { ph: 'any — e.g. GetCart' })) : ''}
      <div class="lbl">Request types (none ticked = all)</div>
      <div class="types">${RESOURCE_TYPES.map(t => `<label class="check"><input type="checkbox" data-rt="${t}" ${w.resourceTypes?.includes(t) ? 'checked' : ''}> ${t}</label>`).join('')}</div>
    </details>`;
  }
  h += `<div id="diag"></div>
    <div class="foot"><button data-act="r-up">↑ Move up</button><button data-act="r-down">↓ Move down</button>
    <button data-act="r-dup">Duplicate</button><button class="danger" data-act="r-del">Delete</button></div>
    <div class="hint" style="margin-top:6px">Higher rules win, and groups higher in the sidebar win over groups below. Drag rules or groups to reorder.</div>`;
  $('#editor').innerHTML = h;
  renderDiag();
}

function renderTest() {
  const url = $('#tUrl').value.trim();
  if (!url) { $('#tOut').innerHTML = ''; return; }
  if (!settings.masterEnabled) { $('#tOut').innerHTML = '<div class="note bad">Reroute is switched off, so nothing applies.</div>'; return; }
  const res = testUrl(config, settings, { url, method: $('#tMethod').value, type: $('#tType').value });
  $('#tOut').innerHTML = res.length ? res.map(x => `<div class="result ${x.shadowed ? 'shadow' : ''}">
      <div class="row"><b>${esc(x.rule.name || '(unnamed)')}</b><span class="tag fit ${esc(x.rule.type)}">${esc(TYPE_LABELS[x.rule.type])}</span></div>
      <div class="mono muted" style="word-break:break-all">${esc(x.outcome)}</div>
      ${x.shadowed ? '<div class="hint">Matches, but a rule above it handles the request first.</div>' : ''}</div>`).join('')
    : '<div class="empty">No enabled rule matches this URL.</div>';
}

const VIA = { network: 'network', page: 'fetch/XHR', full: 'full', inject: 'inject' };
function renderLog() {
  $('#logOut').innerHTML = logs.length ? logs.map(l => `<div class="logrow">
      <span class="muted">${new Date(l.t).toLocaleTimeString()}</span><span class="muted">${esc(VIA[l.via] || l.via)}</span>
      <span>${esc(l.name || '')}</span><span class="u" title="${esc(l.url)}">${esc(l.url)}</span></div>`).join('')
    : '<div class="empty">Nothing yet. Reload a page your rules apply to.</div>';
}

const kb = c => (c.tooLarge ? 'too large' : Math.max(1, Math.round((c.base64 ? c.body.length * 0.75 : c.body.length) / 1024)) + ' KB');
function renderCaps() {
  $('#capState').textContent = recOn
    ? 'Recording is on. fetch/XHR responses from tabs with Full interception appear here.'
    : 'Recording is off. Turn on “Record API responses” from the toolbar popup on the tab you want to capture.';
  $('#capOut').innerHTML = caps.length ? caps.map(c => `<div class="caprow">
      <span class="muted">${new Date(c.t).toLocaleTimeString()}</span><span><b>${esc(c.method)}</b> ${esc(c.status)}</span>
      <span class="u" title="${esc(c.url)}">${c.gql ? `<b>${esc(c.gql)}</b> · ` : ''}${esc(c.url)}</span><span class="muted">${kb(c)}</span>
      <button data-act="cap-save" data-id="${esc(c.id)}" ${c.tooLarge ? 'disabled' : ''}>Save as mock</button></div>`).join('')
    : '<div class="empty">No recorded responses.</div>';
}

function renderAll() {
  if (sel.group !== 'all' && !groupsOf().some(g => g.id === sel.group)) sel.group = 'all';
  if (sel.rule && !current()) sel.rule = null;
  renderTop(); renderSide(); renderList(); renderEditor(); renderTest(); renderLog(); renderCaps();
}

// ---------- actions ----------
function download(name, data) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function moveRule(rule, dir) {
  const same = rulesOf(rule.groupId);
  const other = same[same.indexOf(rule) + dir];
  if (!other) return;
  const i = config.rules.indexOf(rule), j = config.rules.indexOf(other);
  [config.rules[i], config.rules[j]] = [config.rules[j], config.rules[i]];
}

const ACTIONS = {
  group: id => { sel.group = id; },
  rule: id => { sel.rule = id; },
  'g-toggle': id => { const g = config.groups.find(g => g.id === id); g.enabled = !g.enabled; },
  'g-add': () => { const name = prompt('Group name'); if (!name) return false; const g = { id: uid('g'), profileId: config.activeProfile, name, enabled: true }; config.groups.push(g); sel.group = g.id; },
  'g-rename': () => { const g = config.groups.find(g => g.id === sel.group); const name = prompt('Group name', g.name); if (!name) return false; g.name = name; },
  'g-del': () => {
    const g = config.groups.find(g => g.id === sel.group);
    if (!confirm(`Delete group "${g.name}" and its ${rulesOf(g.id).length} rule(s)?`)) return false;
    config.rules = config.rules.filter(r => r.groupId !== g.id); config.groups = config.groups.filter(x => x !== g); sel.group = 'all';
  },
  'g-export': () => {
    const g = config.groups.find(g => g.id === sel.group), p = config.profiles.find(p => p.id === g.profileId);
    download(`reroute-${g.name.replace(/\W+/g, '-').toLowerCase()}.json`, { version: 2, activeProfile: p.id, profiles: [p], groups: [g], rules: rulesOf(g.id) });
    return false;
  },
  'r-toggle': id => { const r = config.rules.find(r => r.id === id); r.enabled = !r.enabled; },
  'r-add': () => {
    let gid = sel.group !== 'all' ? sel.group : groupsOf()[0]?.id;
    if (!gid) { const g = { id: uid('g'), profileId: config.activeProfile, name: 'Rules', enabled: true }; config.groups.push(g); gid = g.id; }
    const r = { id: uid(), groupId: gid, enabled: true, type: 'map-remote', regex: false, name: '', match: '', dest: '', actions: [], when: {} };
    config.rules.push(r); sel.rule = r.id;
    setTimeout(() => $('#editor input')?.focus());
  },
  'r-dup': () => { const r = current(); const c = structuredClone(r); c.id = uid(); c.name = (r.name || 'Rule') + ' copy'; config.rules.splice(config.rules.indexOf(r) + 1, 0, c); sel.rule = c.id; },
  'r-del': () => { const r = current(); if (!confirm(`Delete rule "${r.name || r.match}"?`)) return false; config.rules = config.rules.filter(x => x !== r); sel.rule = null; },
  'r-up': () => moveRule(current(), -1),
  'r-down': () => moveRule(current(), 1),
  'a-add': () => { current().actions.push({ kind: 'resp-header', name: '', value: '' }); },
  'a-del': i => { current().actions.splice(+i, 1); },
  'a-cors': () => { current().actions.push(...corsHeaders().map(h => ({ kind: 'resp-header', name: h.header, value: h.value }))); },
  'a-csp': () => { current().actions.push({ kind: 'resp-header', name: 'Content-Security-Policy', value: '' }, { kind: 'resp-header', name: 'Content-Security-Policy-Report-Only', value: '' }); },
  'h-add': () => { current().response.headers.push({ name: '', value: '' }); },
  'h-del': i => { current().response.headers.splice(+i, 1); },
  file: () => { $('#fileBody').click(); return false; },
  'cap-save': id => {
    const c = caps.find(x => x.id === id);
    if (!c) return false;
    let g = groupsOf().find(g => g.name === 'Recorded');
    if (!g) { g = { id: uid('g'), profileId: config.activeProfile, name: 'Recorded', enabled: true }; config.groups.unshift(g); }
    const u = new URL(c.url);
    const r = {
      id: uid(), groupId: g.id, enabled: true, type: 'mock', regex: false, actions: [],
      name: (c.gql ? c.gql + ' · ' : '') + c.method + ' ' + u.pathname,
      match: u.origin + u.pathname + (u.search ? '*' : ''),
      when: { methods: [c.method], ...(c.gql ? { gql: c.gql } : {}) },
      response: { status: c.status, contentType: c.mime || 'application/json', body: c.body, base64: c.base64, headers: [], delay: 0, fileName: '' },
    };
    if (!c.base64 && /json/.test(c.mime)) { try { r.response.body = JSON.stringify(JSON.parse(c.body), null, 2); } catch { /* keep as recorded */ } }
    config.rules.push(r); sel = { group: g.id, rule: r.id }; tab = 'rules';
  },
  'file-clear': () => { Object.assign(current().response, { body: '', base64: false, fileName: '' }); },
};

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t || !ACTIONS[t.dataset.act]) return;
  if (ACTIONS[t.dataset.act](t.dataset.id) === false) return;
  save(); renderAll();
});

function setPath(obj, path, v) {
  const keys = path.split('.');
  const last = keys.pop();
  for (const k of keys) obj = obj[k] ||= {};
  obj[last] = v;
}
$('#editor').addEventListener('input', e => {
  const t = e.target, d = t.dataset, r = current();
  if (!r) return;
  const val = t.type === 'checkbox' ? t.checked : t.value;
  if (d.f) {
    let v = val;
    if (d.as === 'num') v = v === '' ? '' : Number(v);
    if (d.as === 'list' || d.as === 'ulist') v = String(v).split(/[\s,]+/).filter(Boolean).map(x => (d.as === 'ulist' ? x.toUpperCase() : x.toLowerCase()));
    setPath(r, d.f, v);
  } else if (d.ai !== undefined) r.actions[+d.ai][d.af] = val;
  else if (d.hi !== undefined) r.response.headers[+d.hi][d.hf] = val;
  else if (d.rt) {
    const set = new Set(r.when.resourceTypes || []);
    t.checked ? set.add(d.rt) : set.delete(d.rt);
    r.when.resourceTypes = RESOURCE_TYPES.filter(x => set.has(x));
  } else return;
  saveSoon(); renderList();
  if (d.rerender !== undefined) renderEditor(); else renderDiag();
});

$('#fileBody').onchange = async e => {
  const files = [...e.target.files], r = current();
  e.target.value = '';
  if (!files.length || !r) return;
  const base = s => String(s || '').split(/[\\/]/).pop().toLowerCase();
  // With several files picked, each one fills the rule waiting for a file of that name.
  const mine = files.find(f => base(f.name) === base(r.response.fileName)) || files[0];
  let filled = 0;
  for (const f of files) {
    if (f === mine) continue;
    for (const o of config.rules) {
      if (o !== r && o.type === 'map-local' && o.response && !o.response.body && base(o.response.fileName) === base(f.name)) { await fillFrom(o, f); filled++; }
    }
  }
  await fillFrom(r, mine);
  save(); renderAll();
  if (files.length > 1) alert(`Loaded ${mine.name} here and filled ${filled} other rule(s) waiting for the selected files.`);
};
async function fillFrom(r, f) {
  const buf = new Uint8Array(await f.arrayBuffer());
  const p = r.response;
  let text = null;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); if (text.includes('\u0000')) text = null; } catch { /* binary */ }
  if (text !== null) Object.assign(p, { body: text, base64: false });
  else {
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    Object.assign(p, { body: btoa(s), base64: true });
  }
  p.fileName = f.name;
  p.contentType = f.type || MIME[f.name.split('.').pop().toLowerCase()] || 'application/octet-stream';
  if (!r.name) r.name = f.name;
}

// header controls
$('#master').onclick = () => { settings.masterEnabled = !settings.masterEnabled; armAutoOff(settings); saveSettings(); renderAll(); };
$('#permGrant').onclick = () => chrome.permissions.request({ origins: runtime.needs || [] }).catch(e => alert('Could not request access: ' + e.message));
$('#permAll').onclick = () => chrome.permissions.request({ origins: ['<all_urls>'] }).catch(e => alert('Could not request access: ' + e.message));
$('#profile').onchange = e => { config.activeProfile = e.target.value; sel = { group: 'all', rule: null }; save(); renderAll(); };
$('#pAdd').onclick = () => {
  const name = prompt('Profile name'); if (!name) return;
  const p = { id: uid('p'), name }; config.profiles.push(p);
  config.groups.push({ id: uid('g'), profileId: p.id, name: 'Rules', enabled: true });
  config.activeProfile = p.id; sel = { group: 'all', rule: null }; save(); renderAll();
};
$('#pRename').onclick = () => { const p = config.profiles.find(p => p.id === config.activeProfile); const name = prompt('Profile name', p.name); if (!name) return; p.name = name; save(); renderAll(); };
$('#pDel').onclick = () => {
  if (config.profiles.length < 2) return alert('This is the only profile.');
  const p = config.profiles.find(p => p.id === config.activeProfile);
  if (!confirm(`Delete profile "${p.name}" with all its groups and rules?`)) return;
  const gids = new Set(config.groups.filter(g => g.profileId === p.id).map(g => g.id));
  config.rules = config.rules.filter(r => !gids.has(r.groupId));
  config.groups = config.groups.filter(g => !gids.has(g.id));
  config.profiles = config.profiles.filter(x => x !== p);
  config.activeProfile = config.profiles[0].id; sel = { group: 'all', rule: null }; save(); renderAll();
};
document.querySelectorAll('[data-tab]').forEach(b => (b.onclick = () => { tab = b.dataset.tab; renderTop(); }));

// import / export
$('#btnExport').onclick = () => $('#dlgExport').showModal();
$('#expCancel').onclick = () => $('#dlgExport').close();
$('#expFull').onclick = () => { download('reroute-rules-backup.json', config); $('#dlgExport').close(); };
$('#expSafe').onclick = () => { download('reroute-rules.json', redactConfig(config)); $('#dlgExport').close(); };
const highRisk = r => riskOf(r).some(x => x.level === 'high');
const settleImport = () => { if (!$('#impTrust').checked) for (const r of pendingImport.rules) if (highRisk(r)) r.enabled = false; };
$('#btnImport').onclick = () => $('#fileImport').click();
$('#fileImport').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    pendingImport = normalizeConfig(JSON.parse(await f.text()));
    const byType = {};
    for (const r of pendingImport.rules) byType[TYPE_LABELS[r.type]] = (byType[TYPE_LABELS[r.type]] || 0) + 1;
    $('#dlgText').textContent = `${f.name}: ${pendingImport.rules.length} rule(s) in ${pendingImport.groups.length} group(s) — ` + Object.entries(byType).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ') + '.';
    const flagged = pendingImport.rules.map(r => ({ r, risks: riskOf(r) })).filter(x => x.risks.length);
    const high = flagged.filter(x => highRisk(x.r));
    $('#dlgRisks').innerHTML = (high.length ? `<div class="note bad">${high.length} rule(s) run scripts or remove page security. They will be imported switched off so you can review them first.</div>` : '') +
      (flagged.length ? `<div class="risks">${flagged.slice(0, 12).map(x => `<div><b>${esc(x.r.name || x.r.match)}</b> — ${esc(x.risks.map(k => k.text).join(' '))}</div>`).join('')}${flagged.length > 12 ? `<div class="muted">…and ${flagged.length - 12} more.</div>` : ''}</div>` : '');
    $('#impTrust').checked = false;
    $('#impTrustRow').hidden = !high.length;
    $('#dlgImport').showModal();
  } catch (err) { alert('Could not import: ' + err.message); }
};
$('#impCancel').onclick = () => $('#dlgImport').close();
$('#impReplace').onclick = () => { settleImport(); config = pendingImport; sel = { group: 'all', rule: null }; $('#dlgImport').close(); save(); renderAll(); };
$('#impMerge').onclick = () => {
  settleImport();
  const pMap = {}, gMap = {};
  for (const p of pendingImport.profiles) {
    let mine = config.profiles.find(x => x.name === p.name);
    if (!mine) { mine = { id: uid('p'), name: p.name }; config.profiles.push(mine); }
    pMap[p.id] = mine.id;
  }
  for (const g of pendingImport.groups) { gMap[g.id] = uid('g'); config.groups.push({ ...g, id: gMap[g.id], profileId: pMap[g.profileId] }); }
  for (const r of pendingImport.rules) config.rules.push({ ...r, id: uid(), groupId: gMap[r.groupId] });
  $('#dlgImport').close(); save(); renderAll();
};

// tester + log
$('#tType').innerHTML = '<option value="">any type</option>' + RESOURCE_TYPES.map(t => `<option>${t}</option>`).join('');
for (const id of ['#tUrl', '#tMethod', '#tType']) $(id).addEventListener('input', renderTest);
$('#logClear').onclick = () => chrome.runtime.sendMessage({ type: 'rr:clear-log' });
$('#capClear').onclick = () => chrome.runtime.sendMessage({ type: 'rr:clear-captures' });

// drag and drop: rules onto rules (reorder / move group), rules onto groups, groups onto groups
const clearDrop = () => document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach(x => x.classList.remove('drop-before', 'drop-after', 'drop-into'));
function dropTarget(e) {
  if (!drag) return null;
  const half = el => { const b = el.getBoundingClientRect(); return e.clientY < b.top + b.height / 2 ? 'before' : 'after'; };
  const rule = e.target.closest('.rule[data-id]'), grp = e.target.closest('.grp[data-gid]');
  if (drag.kind === 'rule' && rule && rule.dataset.id !== drag.id) return { el: rule, mode: half(rule) };
  if (drag.kind === 'rule' && grp) return { el: grp, mode: 'into' };
  if (drag.kind === 'group' && grp && grp.dataset.gid !== drag.id) return { el: grp, mode: half(grp) };
  return null;
}
document.addEventListener('dragstart', e => {
  const el = e.target.closest?.('[data-drag]');
  if (!el) return;
  drag = { kind: el.dataset.drag, id: el.dataset.id };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', drag.id);
});
document.addEventListener('dragover', e => {
  const t = dropTarget(e);
  clearDrop();
  if (!t) return;
  e.preventDefault();
  t.el.classList.add('drop-' + t.mode);
});
document.addEventListener('dragend', () => { clearDrop(); drag = null; });
document.addEventListener('drop', e => {
  const t = dropTarget(e);
  clearDrop();
  if (!t) return;
  e.preventDefault();
  const move = (list, item, target, after) => { list.splice(list.indexOf(item), 1); list.splice(list.indexOf(target) + (after ? 1 : 0), 0, item); };
  if (drag.kind === 'group') {
    move(config.groups, config.groups.find(g => g.id === drag.id), config.groups.find(g => g.id === t.el.dataset.gid), t.mode === 'after');
  } else {
    const r = config.rules.find(x => x.id === drag.id);
    if (t.mode === 'into') { r.groupId = t.el.dataset.gid; config.rules.push(config.rules.splice(config.rules.indexOf(r), 1)[0]); }
    else { const target = config.rules.find(x => x.id === t.el.dataset.id); r.groupId = target.groupId; move(config.rules, r, target, t.mode === 'after'); }
  }
  drag = null; save(); renderAll();
});

// ---------- sync ----------
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local') {
    if (c.rrConfig && JSON.stringify(c.rrConfig.newValue) !== lastJson) { config = c.rrConfig.newValue; lastJson = JSON.stringify(config); renderAll(); }
    if (c.rrSettings) { settings = { ...DEFAULT_SETTINGS, ...c.rrSettings.newValue }; renderAll(); }
  } else if (area === 'session') {
    if (c.rrRuntime) { runtime = c.rrRuntime.newValue || { errors: {} }; renderTop(); renderList(); renderDiag(); }
    if (c.rrLog) { logs = c.rrLog.newValue || []; renderLog(); }
    if (c.rrCaptures) { caps = c.rrCaptures.newValue || []; renderCaps(); }
    if (c.rrRec) { recOn = !!c.rrRec.newValue; renderCaps(); }
  }
});

(async () => {
  const st = await chrome.storage.local.get(['rrConfig', 'rrSettings']);
  const ss = await chrome.storage.session.get(['rrRuntime', 'rrLog', 'rrCaptures', 'rrRec']);
  caps = ss.rrCaptures || []; recOn = !!ss.rrRec;
  config = st.rrConfig || seedConfig();
  lastJson = JSON.stringify(config);
  settings = { ...DEFAULT_SETTINGS, ...(st.rrSettings || {}) };
  runtime = ss.rrRuntime || { errors: {} };
  logs = ss.rrLog || [];
  renderAll();
})();
