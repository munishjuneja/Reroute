// Every rule type against a throwaway site, without and with Full interception.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve, send, rule, mock, config, sleep } from '../helpers.mjs';

let h, site, dev, R;

const PAGE = `<!doctype html><title>site</title>
<script src="/app.js"></script><script src="/lib.js"></script><script src="/blocked.js"></script>
<script>
  window.R = {};
  const text = async r => ({ status: r.status, body: await r.text(), ct: r.headers.get('content-type') });
  window.done = Promise.all([
    fetch('/api/user').then(text).then(v => R.user = v),
    fetch('/api/plain').then(text).then(v => R.plain = v),
    fetch('/api/echo?drop=1').then(r => r.json()).then(v => R.echo = v),
    fetch('/graphql', { method: 'POST', body: JSON.stringify({ operationName: 'GetCart', query: 'query GetCart { cart }' }) }).then(r => r.text()).then(v => R.gql1 = v),
    fetch('/graphql', { method: 'POST', body: JSON.stringify({ operationName: 'Other', query: 'query Other { x }' }) }).then(r => r.text()).then(v => R.gql2 = v),
    new Promise(ok => { const x = new XMLHttpRequest(); x.open('GET', '/api/xhr'); x.onload = () => ok(R.xhr = { status: x.status, body: x.responseText }); x.send(); }),
    new Promise(ok => { const y = new XMLHttpRequest(); y.open('GET', '/api/user?x=1'); y.responseType = 'json'; y.onload = () => ok(R.xhrMock = { status: y.status, body: y.response }); y.send(); }),
  ]);
</script>`;

before(async () => {
  site = await serve((req, res, u) => {
    if (u.pathname === '/') return send(res, 200, 'text/html', PAGE);
    if (u.pathname === '/doc')
      return send(
        res,
        200,
        'text/html',
        '<title>remote</title>REMOTE DOC<script src="/app.js"></script>',
      );
    if (u.pathname.endsWith('.js'))
      return send(
        res,
        200,
        'text/javascript',
        `window.${u.pathname.slice(1, -3).toUpperCase()}="remote"`,
      );
    if (u.pathname === '/api/echo')
      return send(
        res,
        200,
        'application/json',
        JSON.stringify({ h: req.headers['x-test'] || null, q: u.search }),
      );
    send(res, 200, 'text/plain', 'remote data');
  });
  dev = await serve((req, res) =>
    send(res, 200, 'text/javascript', 'window.APP="local"', { 'access-control-allow-origin': '*' }),
  );
  R = site.url;
  h = await launch();
  await h.setConfig(
    config([
      rule({
        name: 'remote',
        type: 'map-remote',
        match: R + '/app.js',
        dest: dev.url + '/app.js',
        cors: true,
      }),
      mock(R + '/api/user*', '{"name":"mock"}', {
        name: 'mock',
        response: { status: 201, headers: [{ name: 'X-A', value: 'b' }], delay: 30 },
      }),
      rule({
        name: 'rewrite-xhr',
        type: 'rewrite',
        match: R + '/api/xhr',
        actions: [
          { kind: 'resp-body', name: 'remote', value: 'REWRITTEN' },
          { kind: 'status', value: '202' },
        ],
      }),
      rule({
        name: 'rewrite-fetch',
        type: 'rewrite',
        match: R + '/api/plain',
        actions: [
          { kind: 'resp-body', name: 'r(e)mote', value: 'RX$1', regex: true },
          { kind: 'status', value: '203' },
        ],
      }),
      rule({
        name: 'local',
        type: 'map-local',
        match: R + '/lib.js',
        response: {
          status: 200,
          contentType: 'text/javascript',
          body: 'window.LIB="file"',
          fileName: 'lib.js',
          headers: [],
        },
      }),
      rule({ name: 'block', type: 'block', match: R + '/blocked.js' }),
      rule({
        name: 'inject-js',
        type: 'inject',
        match: R + '/*',
        inject: { lang: 'js', runAt: 'document_start', code: 'window.INJ = 1;' },
      }),
      rule({
        name: 'inject-css',
        type: 'inject',
        match: R + '/*',
        inject: { lang: 'css', code: 'body{background:rgb(1, 2, 3)}' },
      }),
      rule({
        name: 'headers',
        type: 'rewrite',
        match: R + '/api/echo*',
        actions: [
          { kind: 'req-header', name: 'X-Test', value: 'yes' },
          { kind: 'query', name: 'added', value: '1' },
          { kind: 'query', name: 'drop', value: '' },
        ],
      }),
      mock(R + '/graphql', '{"cart":"mocked"}', { name: 'gql', when: { gql: 'GetCart' } }),
      mock(R + '/doc', '<title>local</title>LOCAL DOC<script src="/app.js"></script>', {
        name: 'doc',
        response: { contentType: 'text/html' },
      }),
      rule({ name: 'bad-regex', type: 'block', regex: true, match: '(?=x)http://nope' }),
    ]),
  );
});
after(async () => {
  await h?.close();
  await site?.close();
  await dev?.close();
});

async function loadSite(page) {
  await page.goto(R + '/');
  await page.evaluate(() => window.done);
  return page.evaluate(() => ({
    APP: window.APP,
    LIB: window.LIB,
    BLOCKED: window.BLOCKED,
    INJ: window.INJ,
    bg: getComputedStyle(document.body).backgroundColor,
    R: window.R,
  }));
}

function assertAllRules(o) {
  assert.equal(o.APP, 'local', 'map remote swaps the script');
  assert.equal(o.LIB, 'file', 'map local serves the stored file');
  assert.equal(o.BLOCKED, undefined, 'block stops the script');
  assert.deepEqual(o.R.user, { status: 201, body: '{"name":"mock"}', ct: 'application/json' });
  assert.deepEqual(o.R.xhrMock, { status: 201, body: { name: 'mock' } });
  assert.deepEqual(o.R.xhr, { status: 202, body: 'REWRITTEN data' });
  assert.deepEqual(o.R.plain.status, 203);
  assert.equal(o.R.plain.body, 'RXe data', 'regex replace with a capture group');
  assert.deepEqual(
    o.R.echo,
    { h: 'yes', q: '?added=1' },
    'request header set, query param added and removed',
  );
  assert.equal(o.R.gql1, '{"cart":"mocked"}');
  assert.equal(o.R.gql2, 'remote data', 'other GraphQL operations pass through');
}

test('a regex Chrome cannot run is reported, not applied', async () => {
  const rt = await h.runtime();
  assert.match(rt.errors.r12 || Object.values(rt.errors).join(' '), /RE2|regex/);
  assert.deepEqual(rt.needs, []);
});

test('all rule types apply without Full interception', async () => {
  const page = await h.ctx.newPage();
  const o = await loadSite(page);
  assertAllRules(o);
  assert.equal(o.INJ, 1, 'script injected');
  assert.equal(o.bg, 'rgb(1, 2, 3)', 'CSS injected');
  await page.close();
});

test('a mocked document without Full interception is not served', async () => {
  const page = await h.ctx.newPage();
  await page.goto(R + '/doc');
  assert.match(await page.textContent('body'), /REMOTE DOC/);
  await page.close();
});

test('Full interception serves a local document under the original URL and keeps every rule working', async () => {
  const page = await h.ctx.newPage();
  await page.goto(R + '/');
  const res = await h.message({ type: 'rr:dbg-toggle', tabId: await h.tabId(R) });
  assert.equal(res.on, true);
  await page.bringToFront();
  await page.goto(R + '/doc');
  await sleep(300);
  assert.equal(page.url(), R + '/doc');
  assert.match(await page.textContent('body'), /LOCAL DOC/);
  assert.equal(await page.evaluate(() => window.APP), 'local');
  assertAllRules(await loadSite(page));
  await h.message({ type: 'rr:dbg-toggle', tabId: await h.tabId(R) });
  await page.close();
});

test('the activity log records hits from every path', async () => {
  await sleep(400);
  const via = new Set((await h.session('rrLog')).map((l) => l.via));
  for (const v of ['page', 'inject', 'full']) assert.ok(via.has(v), 'missing log entries via ' + v);
});
