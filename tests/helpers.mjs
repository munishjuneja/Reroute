// Shared harness for the end-to-end tests: launches Chromium with the extension
// loaded, serves throwaway sites, and talks to the service worker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

export const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Copy of the extension with site access granted at install time. Headless Chromium
// cannot answer the permission prompt, so tests that need rules applied use this.
function grantedCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ext-'));
  fs.cpSync(EXT_DIR, dir, { recursive: true });
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  mf.host_permissions = ['<all_urls>'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf));
  return dir;
}

export async function launch({ siteAccess = true, viewport } = {}) {
  const ext = siteAccess ? grantedCopy() : EXT_DIR;
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-profile-')), {
    channel: 'chromium', headless: true, acceptDownloads: true, viewport: viewport || { width: 1320, height: 860 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  await ctx.grantPermissions(['local-network-access']).catch(() => {});
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  await sleep(500);

  const h = {
    ctx, sw, id,
    // Replace the whole config and wait for the worker to apply it.
    async setConfig(config) {
      const before = await h.runtime().then(r => r?.at || 0);
      await sw.evaluate(c => chrome.storage.local.set({ rrConfig: c }), config);
      for (let i = 0; i < 50; i++) { await sleep(100); if (((await h.runtime())?.at || 0) > before) break; }
      await sleep(150);
    },
    runtime: () => sw.evaluate(async () => (await chrome.storage.session.get('rrRuntime')).rrRuntime),
    stored: () => sw.evaluate(async () => (await chrome.storage.local.get('rrConfig')).rrConfig),
    session: key => sw.evaluate(async k => (await chrome.storage.session.get(k))[k], key),
    async extPage(file, { viewport } = {}) {
      const p = await ctx.newPage();
      p.errors = [];
      p.on('pageerror', e => p.errors.push(e.message));
      if (viewport) await p.setViewportSize(viewport);
      await p.goto(`chrome-extension://${id}/${file}`);
      return p;
    },
    // Sends a runtime message the way the popup does (the worker cannot message itself).
    async message(msg) {
      const p = h._msgPage ||= await h.extPage('popup.html');
      return p.evaluate(m => chrome.runtime.sendMessage(m), msg);
    },
    async tabId(urlPrefix) {
      return sw.evaluate(async u => (await chrome.tabs.query({})).find(t => t.url?.startsWith(u))?.id, urlPrefix);
    },
    close: () => ctx.close(),
  };
  return h;
}

// Starts a server on a free port. handler(req, res, url) — return nothing.
export async function serve(handler) {
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, 'http://x')));
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  return {
    port,
    // Same server under two names: different "sites" as far as the browser is concerned.
    url: `http://localhost:${port}`,
    otherSite: `http://127.0.0.1:${port}`,
    close: () => new Promise(r => { server.close(r); server.closeAllConnections(); }),
  };
}
export const send = (res, code, type, body, extra = {}) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
};

export { rule, config, mock } from './builders.mjs';
