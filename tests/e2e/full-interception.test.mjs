// Serving a local app under a deployed site's URL: the main use case.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve, send, rule, config, sleep } from '../helpers.mjs';

let h, site, app;

before(async () => {
  site = await serve((req, res, u) =>
    send(res, 200, 'text/html', 'REMOTE ' + u.pathname, { 'set-cookie': 'sid=abc; Path=/' }),
  );
  app = await serve((req, res, u) => {
    if (u.pathname.startsWith('/app/_next/'))
      return send(res, 200, 'text/javascript', 'window.CHUNK="local"');
    send(
      res,
      200,
      'text/html',
      `<body>LOCAL ${u.pathname} cookie=${req.headers.cookie || 'none'}
      <script src="/app/_next/main.js"></script>
      <script>window.done = fetch('/api/me').then(r => r.text()).then(t => window.API = t)</script>`,
    );
  });
  h = await launch();
});
after(async () => {
  await h?.close();
  await site?.close();
  await app?.close();
});

// Page rule + asset rule, written against a container-style host that a host rule then maps.
const rules = (viaHostRule) =>
  config([
    rule({
      type: 'map-remote',
      match: site.url + '/checkout',
      dest: (viaHostRule ? 'http://app:3000' : app.url) + '/app/en/checkout',
    }),
    rule({
      type: 'map-remote',
      match: site.url + '/app/_next/*',
      dest: (viaHostRule ? 'http://app:3000' : app.url) + '/app/_next/*',
    }),
    ...(viaHostRule
      ? [rule({ type: 'map-remote', match: 'http://app:3000/*', dest: app.url + '/*', cors: true })]
      : []),
  ]);

async function openCheckout(fullInterception) {
  const page = await h.ctx.newPage();
  await page.goto(site.url + '/other'); // gets the site's cookie
  const tabId = await h.tabId(site.url);
  if (fullInterception) assert.equal((await h.message({ type: 'rr:dbg-toggle', tabId })).on, true);
  await page.bringToFront();
  await page.goto(site.url + '/checkout');
  await page.evaluate(() => window.done).catch(() => {});
  await sleep(200);
  const out = {
    url: page.url(),
    body: (await page.textContent('body')).trim().split(/\s+/).slice(0, 3).join(' '),
    chunk: await page.evaluate(() => window.CHUNK),
    api: await page.evaluate(() => window.API),
    origin: await page.evaluate(() => location.origin),
  };
  if (fullInterception) await h.message({ type: 'rr:dbg-toggle', tabId });
  await page.close();
  return out;
}

test('without Full interception a mapped page moves to the local URL', async () => {
  await h.setConfig(rules(false));
  const o = await openCheckout(false);
  assert.equal(o.url, app.url + '/app/en/checkout');
});

test('with Full interception the URL, origin and cookies stay on the site', async () => {
  await h.setConfig(rules(false));
  const o = await openCheckout(true);
  assert.equal(o.url, site.url + '/checkout');
  assert.equal(o.origin, site.url);
  assert.equal(o.body, 'LOCAL /app/en/checkout cookie=sid=abc');
  assert.equal(o.chunk, 'local', "the local app's own assets are mapped too");
  assert.equal(o.api, 'REMOTE /api/me', 'unmapped calls still reach the site');
});

test('chained rules resolve a container hostname to its published port', async () => {
  await h.setConfig(rules(true));
  const o = await openCheckout(true);
  assert.equal(o.url, site.url + '/checkout');
  assert.equal(o.body, 'LOCAL /app/en/checkout cookie=sid=abc');
  assert.equal(o.chunk, 'local');
});
