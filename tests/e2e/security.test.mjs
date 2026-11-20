// The security guarantees promised in README "Security and privacy".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, serve, send, rule, mock, config, sleep } from '../helpers.mjs';

const open = [];
after(async () => {
  for (const x of open) await x.close();
});

// A page that records every event the extension could leak to it.
const SPY = `<script>
  window.SEEN = [];
  for (const n of ['rr:rules', 'rr:ready', 'rr:a', 'rr:q', 'rr:hit']) document.addEventListener(n, e => SEEN.push(n + ':' + e.detail));
  window.probe = async u => (await fetch(u)).text();
</script><script src="SCRIPT"></script>`;

async function spySite() {
  const s = await serve((req, res, u) => {
    if (u.pathname.startsWith('/api/'))
      return send(res, 200, 'application/json', '{"from":"server"}', {
        'access-control-allow-origin': '*',
      });
    if (u.pathname === '/lib.js')
      return send(res, 200, 'text/javascript', 'window.LIB="server"', {
        'access-control-allow-origin': '*',
      });
    send(res, 200, 'text/html', SPY.replace('SCRIPT', s.url + '/lib.js'));
  });
  open.push(s);
  return s;
}

test('pages never see the rule list, and only get mocks for their own site', async () => {
  const s = await spySite(),
    h = await launch();
  open.push(h);
  const secretRules = (when) =>
    config([
      mock(s.url + '/api/profile', '{"token":"SECRET-1"}', { when }),
      mock(s.url + '/api/other', '{"token":"OTHER-2"}'),
      rule({
        type: 'map-local',
        match: s.url + '/lib.js',
        response: {
          status: 200,
          contentType: 'text/javascript',
          body: 'window.LIB="file"',
          fileName: 'lib.js',
          headers: [],
        },
      }),
    ]);
  const visit = async (origin) => {
    const p = await h.ctx.newPage();
    await p.goto(origin + '/');
    await sleep(200);
    const out = {
      got: await p.evaluate((u) => window.probe(u), s.url + '/api/profile'),
      seen: await p.evaluate(() => SEEN.join(' | ')),
      lib: await p.evaluate(() => window.LIB),
    };
    await p.close();
    return out;
  };
  await h.setConfig(secretRules({}));

  const same = await visit(s.url);
  assert.equal(same.got, '{"token":"SECRET-1"}');
  assert.equal(same.lib, 'file');
  assert.ok(
    !same.seen.includes('OTHER-2') && !same.seen.includes('/api/other'),
    'other rules leaked to the page: ' + same.seen,
  );

  const other = await visit(s.otherSite);
  assert.equal(other.got, '{"from":"server"}', 'a different site must not receive the mock');
  assert.equal(other.lib, 'server', 'a different site must not receive a script mock');
  assert.ok(!other.seen.includes('SECRET'), 'mock leaked: ' + other.seen);

  await h.setConfig(secretRules({ pageDomains: ['127.0.0.1'] }));
  assert.equal(
    (await visit(s.otherSite)).got,
    '{"token":"SECRET-1"}',
    'a listed page domain opts in',
  );
});

test('without site access nothing applies and the user is told why', async () => {
  const s = await spySite(),
    h = await launch({ siteAccess: false });
  open.push(h);
  await h.setConfig(config([mock(s.url + '/api/profile', '{"token":"SECRET-1"}')]));
  assert.deepEqual((await h.runtime()).needs, ['*://localhost/*']);
  assert.equal(await h.sw.evaluate(() => chrome.action.getBadgeText({})), '!');
  const p = await h.ctx.newPage();
  await p.goto(s.url + '/');
  assert.equal(
    await p.evaluate((u) => window.probe(u), s.url + '/api/profile'),
    '{"from":"server"}',
  );
  const opt = await h.extPage('options.html');
  await opt.waitForSelector('#perm:not([hidden])');
  assert.match(await opt.textContent('#permText'), /localhost/);
  assert.deepEqual(opt.errors, []);
});

test('safe export strips bodies and secrets; full export keeps them', async () => {
  const h = await launch();
  open.push(h);
  await h.setConfig(
    config([
      mock('https://api.app.example/me', '{"token":"SECRET-1"}', {
        response: { headers: [{ name: 'Set-Cookie', value: 'sid=abc' }] },
      }),
    ]),
  );
  const opt = await h.extPage('options.html');
  await opt.waitForSelector('.rule');
  const exported = async (button) => {
    await opt.click('#btnExport');
    const [d] = await Promise.all([opt.waitForEvent('download'), opt.click(button)]);
    return fs.readFileSync(await d.path(), 'utf8');
  };
  const safe = await exported('#expSafe');
  assert.ok(!safe.includes('SECRET-1') && !safe.includes('sid=abc'));
  assert.ok((await exported('#expFull')).includes('SECRET-1'));
});

test('import preview lists risks and imports risky rules switched off', async () => {
  const h = await launch();
  open.push(h);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-imp-')), 'shared.json');
  fs.writeFileSync(
    file,
    JSON.stringify(
      config([
        rule({
          name: 'runs-script',
          type: 'inject',
          match: 'https://bank.example/*',
          inject: { lang: 'js', code: 'alert(1)' },
        }),
        rule({
          name: 'drops-csp',
          type: 'rewrite',
          match: 'https://bank.example/*',
          actions: [{ kind: 'resp-header', name: 'Content-Security-Policy', value: '' }],
        }),
        rule({
          name: 'elsewhere',
          type: 'map-remote',
          match: 'https://bank.example/app.js',
          dest: 'https://other.example/app.js',
        }),
        rule({ name: 'plain', type: 'block', match: 'https://ads.example/*' }),
      ]),
    ),
  );
  const opt = await h.extPage('options.html');
  await opt.waitForSelector('.rule');
  await opt.setInputFiles('#fileImport', file);
  await opt.waitForSelector('#dlgImport[open]');
  const preview = await opt.locator('#dlgRisks').innerText();
  assert.match(preview, /runs-script/);
  assert.match(preview, /other\.example/);
  await opt.click('#impMerge');
  await sleep(300);
  const state = Object.fromEntries((await h.stored()).rules.map((r) => [r.name, r.enabled]));
  assert.deepEqual(
    [state['runs-script'], state['drops-csp'], state.elsewhere, state.plain],
    [false, false, true, true],
  );
});

test('auto-off switches everything off when the time is up', async () => {
  const h = await launch();
  open.push(h);
  await h.setConfig(config([rule({ type: 'block', match: 'https://ads.example/*' })]));
  const pop = await h.extPage('popup.html');
  await pop.selectOption('#autoOff', '60');
  await sleep(300);
  assert.match(await pop.textContent('#autoHint'), /Switches off at/);
  assert.ok(await h.sw.evaluate(async () => !!(await chrome.alarms.get('rr-autooff'))));
  await h.sw.evaluate(async () => {
    const s = (await chrome.storage.local.get('rrSettings')).rrSettings;
    s.autoOffAt = Date.now() + 1000;
    await chrome.storage.local.set({ rrSettings: s });
  });
  await sleep(3500);
  assert.equal(
    await h.sw.evaluate(
      async () => (await chrome.storage.local.get('rrSettings')).rrSettings.masterEnabled,
    ),
    false,
  );
  assert.equal(
    await h.sw.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).length),
    0,
  );
});

test('extension pages cannot make network requests', async () => {
  const s = await spySite(),
    h = await launch();
  open.push(h);
  const opt = await h.extPage('options.html');
  const result = await opt.evaluate(
    (u) =>
      fetch(u).then(
        () => 'reached',
        () => 'refused',
      ),
    s.url + '/api/x',
  );
  assert.equal(result, 'refused');
});

test('JavaScript inject rules run only once the user allows user scripts', async () => {
  const site = await serve((req, res) => send(res, 200, 'text/html', '<p>page</p>'));
  const h = await launch();
  open.push(h, site);
  const inject = rule({
    type: 'inject',
    match: site.url + '/*',
    inject: { lang: 'js', runAt: 'document_idle', code: 'window.INJECTED = true;' },
  });
  const injectedAfterLoad = async () => {
    const page = await h.ctx.newPage();
    await page.goto(site.url + '/');
    await sleep(300);
    const injected = await page.evaluate(() => window.INJECTED === true);
    await page.close();
    return injected;
  };

  await h.setConfig(config([inject]));
  assert.equal(await injectedAfterLoad(), false, 'no inline-script fallback without the opt-in');

  await h.allowUserScripts();
  const manager = await h.extPage('options.html'); // the user returns to the rule manager
  for (let i = 0; i < 30 && !(await h.runtime()).userScripts; i++) await sleep(100);
  await manager.close();
  assert.equal(await injectedAfterLoad(), true);
});
