import { DEFAULT_SETTINGS, TYPE_LABELS, seedConfig, armAutoOff, liveRules, matchHost, siteOf } from './core.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let config, settings, tab;

function render() {
  $('#master').setAttribute('aria-checked', !!settings.masterEnabled);
  $('#masterLbl').textContent = settings.masterEnabled ? 'On' : 'Off';
  $('#autoOff').value = String(settings.autoOffMin || 0);
  $('#autoHint').textContent = settings.masterEnabled && settings.autoOffAt ? 'Switches off at ' + new Date(settings.autoOffAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.' : '';
  $('#profile').innerHTML = config.profiles.map(p => `<option value="${esc(p.id)}"${p.id === config.activeProfile ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  // How many enabled rules can touch the site in this tab.
  let host = '';
  try { host = /^https?:/.test(tab?.url || '') ? new URL(tab.url).hostname : ''; } catch { /* no tab URL */ }
  const n = host ? liveRules(config, settings).filter(r => { const h = matchHost(r); return !h || siteOf(h) === siteOf(host) || (r.when?.pageDomains || []).some(d => host === d || host.endsWith('.' + d)); }).length : 0;
  $('#here').hidden = !host;
  $('#here').innerHTML = n ? `<b style="color:var(--warn)">${n} enabled rule${n > 1 ? 's' : ''}</b> can change requests on ${esc(host)}.` : `No enabled rule targets ${esc(host)}.`;
  const groups = config.groups.filter(g => g.profileId === config.activeProfile);
  $('#rules').innerHTML = groups.map(g => {
    const rs = config.rules.filter(r => r.groupId === g.id);
    if (!rs.length) return '';
    return `<div class="sub" style="margin-top:4px">${esc(g.name)}${g.enabled ? '' : ' — off'}</div>` + rs.map(r => `<div class="line">
      <button class="sw" role="switch" aria-checked="${!!r.enabled}" data-id="${esc(r.id)}" aria-label="Enable ${esc(r.name || r.match)}"></button>
      <span class="t" title="${esc(r.match)}">${esc(r.name || r.match || '(unnamed)')}</span>
      <span class="tag ${esc(r.type)}">${esc(TYPE_LABELS[r.type] || r.type)}</span></div>`).join('');
  }).join('') || '<div class="muted">No rules in this profile yet.</div>';
}

const save = () => chrome.storage.local.set({ rrConfig: config });

$('#master').onclick = () => { settings.masterEnabled = !settings.masterEnabled; armAutoOff(settings); chrome.storage.local.set({ rrSettings: settings }); render(); };
$('#autoOff').onchange = e => { settings.autoOffMin = Number(e.target.value); armAutoOff(settings); chrome.storage.local.set({ rrSettings: settings }); render(); };
$('#needsOpen').onclick = () => chrome.runtime.openOptionsPage();
$('#profile').onchange = e => { config.activeProfile = e.target.value; save(); render(); };
$('#rules').onclick = e => {
  const b = e.target.closest('[data-id]');
  if (!b) return;
  const r = config.rules.find(r => r.id === b.dataset.id);
  r.enabled = !r.enabled; save(); render();
};
$('#open').onclick = () => chrome.runtime.openOptionsPage();
$('#dbg').onclick = async () => {
  if (!tab) return;
  const res = await chrome.runtime.sendMessage({ type: 'rr:dbg-toggle', tabId: tab.id });
  $('#dbg').setAttribute('aria-checked', !!res.on);
  if (!res.on) $('#rec').setAttribute('aria-checked', !!(await chrome.runtime.sendMessage({ type: 'rr:rec-state' })).on);
  if (res.error) $('#dbgHint').textContent = 'Could not attach: ' + res.error;
  else if (res.on) $('#dbgHint').textContent = 'On. Reload the tab so every request goes through your rules.';
};

$('#rec').onclick = async () => {
  if (!tab) return;
  const res = await chrome.runtime.sendMessage({ type: 'rr:rec-toggle', tabId: tab.id });
  $('#rec').setAttribute('aria-checked', !!res.on);
  if (res.dbg !== undefined) $('#dbg').setAttribute('aria-checked', !!res.dbg);
  if (res.error) $('#recHint').textContent = 'Could not start recording: ' + res.error;
  else if (res.on) $('#recHint').textContent = 'Recording. Use the page, then open Activity in the rule manager.';
};

(async () => {
  const st = await chrome.storage.local.get(['rrConfig', 'rrSettings']);
  config = st.rrConfig || seedConfig();
  settings = { ...DEFAULT_SETTINGS, ...(st.rrSettings || {}) };
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const rt = (await chrome.storage.session.get('rrRuntime')).rrRuntime || {};
  $('#needs').hidden = !(rt.needs || []).length || !settings.masterEnabled;
  const ok = tab && /^https?:/.test(tab.url || '');
  $('#dbg').disabled = $('#rec').disabled = !ok;
  $('#rec').setAttribute('aria-checked', !!(await chrome.runtime.sendMessage({ type: 'rr:rec-state' })).on);
  if (ok) $('#dbg').setAttribute('aria-checked', !!(await chrome.runtime.sendMessage({ type: 'rr:dbg-state', tabId: tab.id })).on);
  else $('#dbgHint').textContent = 'Full interception is only available on http(s) pages.';
  render();
})();
