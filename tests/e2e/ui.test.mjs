// Rule manager and popup: editing, ordering, testing a URL, recording and the site indicator.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, serve, send, rule, config, sleep } from '../helpers.mjs';

let h, site;

const groups = [
  { id: 'g1', profileId: 'p1', name: 'Pages', enabled: true },
  { id: 'g2', profileId: 'p1', name: 'Assets', enabled: true },
  { id: 'g3', profileId: 'p1', name: 'Mocks', enabled: true },
];

before(async () => {
  site = await serve((req, res, u) => {
    if (u.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      return;
    }
    // Chunked plain text with no length, like a streamed LLM answer. Never ends.
    if (u.pathname === '/api/text-stream') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial answer');
      return;
    }
    if (u.pathname.startsWith('/api/'))
      return send(
        res,
        u.pathname.includes('fail') ? 500 : 200,
        'application/json',
        JSON.stringify({ from: 'server', path: u.pathname + u.search }),
      );
    send(
      res,
      200,
      'text/html',
      `<body>site<script>
      window.go = () => Promise.all([
        fetch('/api/cart?x=1').then(r => r.json()),
        fetch('/api/fail').then(r => r.status),
        fetch('/api/gql', { method: 'POST', body: JSON.stringify({ operationName: 'GetCart', query: 'query GetCart { a }' }) }).then(r => r.json()),
      ]);
    </script>`,
    );
  });
  h = await launch();
  await h.setConfig(
    config(
      [
        rule({
          groupId: 'g1',
          name: 'one',
          type: 'map-remote',
          match: 'https://www.app.example/a',
          dest: 'http://localhost:3001/a',
        }),
        rule({
          groupId: 'g1',
          name: 'two',
          type: 'map-remote',
          match: 'https://www.app.example/b',
          dest: 'http://localhost:3001/b',
        }),
        rule({
          groupId: 'g2',
          name: 'assets',
          type: 'map-remote',
          match: 'https://www.app.example/static/*',
          dest: 'http://localhost:3001/static/*',
        }),
        rule({ groupId: 'g3', name: 'block-site', type: 'block', match: site.url + '/nothing' }),
      ],
      groups,
    ),
  );
});
after(async () => {
  await h?.close();
  await site?.close();
});

const names = (opt) => opt.locator('.rule .nm').allTextContents();

test('creating a mock rule from the editor saves every field', async () => {
  const opt = await h.extPage('options.html');
  await opt.waitForSelector('.rule');
  await opt.click('[data-act=r-add]');
  await opt.fill('[data-f=name]', 'Made in the editor');
  await opt.fill('[data-f=match]', 'https://api.app.example/v1/*');
  await opt.selectOption('[data-f=type]', 'mock');
  await opt.fill('[data-f="response.body"]', '{"a":1}');
  await opt.click('[data-act=h-add]');
  await opt.fill('[data-hf=name]', 'X-Y');
  await opt.click('summary');
  await opt.fill('[data-f="when.methods"]', 'get, post');
  await opt.check('[data-rt=xmlhttprequest]');
  await sleep(500);
  const r = (await h.stored()).rules.find((x) => x.name === 'Made in the editor');
  assert.equal(r.type, 'mock');
  assert.equal(r.response.body, '{"a":1}');
  assert.deepEqual(r.response.headers, [{ name: 'X-Y', value: '' }]);
  assert.deepEqual(r.when.methods, ['GET', 'POST']);
  assert.deepEqual(r.when.resourceTypes, ['xmlhttprequest']);
  assert.deepEqual(opt.errors, []);
  await opt.close();
});

test('drag and drop reorders rules, moves them between groups and reorders groups', async () => {
  const opt = await h.extPage('options.html');
  await opt.waitForSelector('.rule');
  assert.deepEqual((await names(opt)).slice(0, 2), ['one', 'two']);
  await opt
    .locator('.rule')
    .nth(1)
    .dragTo(opt.locator('.rule').nth(0), { targetPosition: { x: 200, y: 4 } });
  assert.deepEqual((await names(opt)).slice(0, 2), ['two', 'one']);

  await opt.locator('.rule', { hasText: 'two' }).dragTo(opt.locator('.grp[data-gid=g3]'));
  await sleep(300);
  assert.equal((await h.stored()).rules.find((r) => r.name === 'two').groupId, 'g3');

  await opt
    .locator('.grp[data-gid=g3]')
    .dragTo(opt.locator('.grp[data-gid=g1]'), { targetPosition: { x: 60, y: 3 } });
  await sleep(300);
  assert.deepEqual(
    (await h.stored()).groups.map((g) => g.name),
    ['Mocks', 'Pages', 'Assets'],
  );
  assert.deepEqual(opt.errors, []);
  await opt.close();
});

test('Test a URL shows the winning rule and its outcome', async () => {
  const opt = await h.extPage('options.html');
  await opt.click('[data-tab=test]');
  await opt.fill('#tUrl', 'https://www.app.example/static/js/app.js');
  assert.match(
    await opt.textContent('#tOut'),
    /assets.*→ http:\/\/localhost:3001\/static\/js\/app\.js/s,
  );
  assert.ok(
    await opt.locator('#tab-rules').isHidden(),
    'the rules pane must not show under the Test tab',
  );
  await opt.close();
});

test('recording captures API responses and Save as mock replays them', async () => {
  const page = await h.ctx.newPage();
  await page.goto(site.url + '/');
  const res = await h.message({ type: 'rr:rec-toggle', tabId: await h.tabId(site.url) });
  assert.deepEqual(res, { on: true, dbg: true });
  await page.bringToFront();
  await page.reload();
  await page.evaluate(() => window.go());
  await sleep(800);

  const opt = await h.extPage('options.html');
  await opt.click('[data-tab=log]');
  // Captures arrive as each response finishes; wait for all three.
  await opt.waitForFunction(() => document.querySelectorAll('.caprow').length >= 3, null, {
    timeout: 10000,
  });
  const rows = (await opt.locator('.caprow').allTextContents()).join(' | ');
  assert.match(rows, /GET 500/);
  assert.match(rows, /GetCart/);
  await opt.locator('.caprow', { hasText: 'GetCart' }).locator('button').click();
  await sleep(400);
  const saved = (await h.stored()).rules.at(-1);
  assert.equal(saved.type, 'mock');
  assert.deepEqual(saved.when.gql, 'GetCart');
  assert.deepEqual(saved.when.methods, ['POST']);
  assert.equal(JSON.parse(saved.response.body).from, 'server');

  await opt.fill('[data-f="response.body"]', '{"from":"mock"}');
  await sleep(800);
  await h.message({ type: 'rr:rec-toggle', tabId: await h.tabId(site.url) });
  await page.bringToFront();
  await page.reload();
  const out = await page.evaluate(() => window.go());
  assert.deepEqual(out, [{ from: 'server', path: '/api/cart?x=1' }, 500, { from: 'mock' }]);
  await opt.close();
  await page.close();
});

test('recording passes streams through and keeps the status text', async () => {
  const page = await h.ctx.newPage();
  await page.goto(site.url + '/');
  const res = await h.message({ type: 'rr:rec-toggle', tabId: await h.tabId(site.url) });
  assert.equal(res.on, true);
  await page.bringToFront();
  await page.reload();
  const statusOf = (path) =>
    page.evaluate(
      (url) =>
        Promise.race([
          fetch(url).then((r) => r.status),
          new Promise((r) => setTimeout(() => r('timed out'), 3000)),
        ]),
      path,
    );

  assert.equal(await statusOf('/api/stream'), 200);
  assert.equal(await statusOf('/api/text-stream'), 200);
  assert.equal(
    await page.evaluate(() => fetch('/api/fail').then((r) => r.statusText)),
    'Internal Server Error',
  );
  await h.message({ type: 'rr:rec-toggle', tabId: await h.tabId(site.url) });
  await page.close();
});

test('popup shows how many enabled rules can touch the current site', async () => {
  const page = await h.ctx.newPage();
  await page.goto(site.url + '/');
  const pop = await h.ctx.newPage();
  // The popup reads the active tab; point it at the site tab.
  await pop.addInitScript((u) => {
    const q = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async () => (await q({})).filter((t) => t.url?.startsWith(u));
  }, site.url);
  await pop.goto(`chrome-extension://${h.id}/popup.html`);
  await sleep(400);
  assert.match(
    await pop.textContent('#here'),
    /^\d+ enabled rules? can change requests on localhost\.$/,
  );
  await pop.close();
  await page.close();
});
