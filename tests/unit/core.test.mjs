// Fast checks of the pure rule engine (extension/core.js). No browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  destFor,
  jsRegex,
  matchHost,
  siteOf,
  neededOrigins,
  riskOf,
  redactConfig,
  normalizeConfig,
  compileRule,
  compileDnr,
  compilePage,
  testUrl,
  sortedRules,
  gqlMatch,
  whenOk,
  armAutoOff,
} from '../../extension/core.js';
import { rule, config, mock } from '../builders.mjs';

const ON = { masterEnabled: true };

test('wildcard match is exact, * captures carry into the destination', () => {
  const r = rule({
    type: 'map-remote',
    match: 'https://a.example/assets/*',
    dest: 'http://localhost:3000/static/*',
  });
  assert.ok(jsRegex(r).test('https://a.example/assets/app.js?v=1'));
  assert.ok(!jsRegex(r).test('https://a.example/other/app.js'));
  assert.equal(
    destFor(r, 'https://a.example/assets/js/app.js'),
    'http://localhost:3000/static/js/app.js',
  );
  const exact = rule({ type: 'map-remote', match: 'https://a.example/page', dest: 'http://x/' });
  assert.ok(
    !jsRegex(exact).test('https://a.example/page?q=1'),
    'no trailing * means a query string does not match',
  );
});

test('regex destinations use $1', () => {
  const r = rule({
    type: 'map-remote',
    regex: true,
    match: '^https://a\\.example/u/(\\d+)$',
    dest: 'http://localhost/users/$1',
  });
  assert.equal(destFor(r, 'https://a.example/u/42'), 'http://localhost/users/42');
});

test('siteOf groups subdomains and two-part country suffixes', () => {
  assert.equal(siteOf('www.shop.example.com'), 'example.com');
  assert.equal(siteOf('api.example.co.uk'), 'example.co.uk');
  assert.equal(siteOf('localhost'), 'localhost');
  assert.equal(siteOf('127.0.0.1'), '127.0.0.1');
});

test('page/bridge.js carries the same siteOf as core.js', () => {
  const body = (src) =>
    src
      .match(
        /\{\s*const labels = (String\()?hostname\)?\.split[\s\S]*?return labels\.slice\(-labelCount\)\.join\('\.'\);/,
      )?.[0]
      .replace(/String\((hostname)\)/g, '$1')
      .replace(/\s+/g, ' ');
  const core = body(fs.readFileSync(new URL('../../extension/core.js', import.meta.url), 'utf8'));
  const bridge = body(
    fs.readFileSync(new URL('../../extension/page/bridge.js', import.meta.url), 'utf8'),
  );
  assert.ok(core && bridge, 'siteOf not found in one of the files');
  assert.equal(bridge, core);
});

test('matchHost finds the pinned host, or null for open patterns', () => {
  assert.equal(matchHost(rule({ match: 'https://www.a.example/x/*' })), 'www.a.example');
  assert.equal(matchHost(rule({ match: 'https://*.a.example/x' })), 'a.example');
  assert.equal(matchHost(rule({ match: 'https://*/api/*' })), null);
  assert.equal(
    matchHost(rule({ regex: true, match: '^https://api\\.a\\.example/v1/.*' })),
    'api.a.example',
  );
});

test('neededOrigins asks only for the sites the enabled rules name', () => {
  const c = config([
    rule({
      type: 'map-remote',
      match: 'https://www.a.example/js/*',
      dest: 'http://localhost:3001/js/*',
    }),
    rule({ type: 'block', match: 'https://ads.b.example/*', enabled: false }),
  ]);
  assert.deepEqual(neededOrigins(c, ON).sort(), ['*://*.a.example/*', '*://localhost/*']);
  c.rules.push(rule({ type: 'block', match: 'https://*/track' }));
  assert.deepEqual(neededOrigins(c, ON), ['<all_urls>']);
  assert.deepEqual(neededOrigins(c, { masterEnabled: false }), []);
});

test('riskOf flags scripts and CSP removal as high, other things as info', () => {
  const high = (r) => riskOf(r).filter((x) => x.level === 'high').length;
  assert.equal(
    high(rule({ type: 'inject', match: 'https://a.example/*', inject: { lang: 'js', code: 'x' } })),
    1,
  );
  assert.equal(
    high(
      rule({ type: 'inject', match: 'https://a.example/*', inject: { lang: 'css', code: 'x' } }),
    ),
    0,
  );
  assert.equal(
    high(
      rule({
        type: 'rewrite',
        match: 'https://a.example/*',
        actions: [{ kind: 'resp-header', name: 'Content-Security-Policy', value: '' }],
      }),
    ),
    1,
  );
  const away = riskOf(
    rule({
      type: 'map-remote',
      match: 'https://a.example/app.js',
      dest: 'https://b.example/app.js',
    }),
  );
  assert.ok(away.some((x) => /another site/.test(x.text)));
  assert.equal(
    riskOf(
      rule({
        type: 'map-remote',
        match: 'https://a.example/app.js',
        dest: 'http://localhost:3000/app.js',
      }),
    ).length,
    0,
  );
});

test('redactConfig drops bodies and masks secret headers', () => {
  const c = config([
    mock('https://a.example/api', '{"token":"SECRET"}', {
      response: {
        headers: [
          { name: 'Set-Cookie', value: 'sid=1' },
          { name: 'X-Plain', value: 'keep' },
        ],
      },
    }),
    rule({
      type: 'rewrite',
      match: 'https://a.example/*',
      actions: [{ kind: 'req-header', name: 'Authorization', value: 'Bearer abc' }],
    }),
  ]);
  const out = redactConfig(c);
  assert.ok(!JSON.stringify(out).includes('SECRET'));
  assert.ok(!JSON.stringify(out).includes('Bearer abc'));
  assert.equal(out.rules[0].response.headers[1].value, 'keep');
  assert.ok(JSON.stringify(c).includes('SECRET'), 'the original is untouched');
});

test('normalizeConfig accepts the v1 rules.json format and fixes duplicates', () => {
  const c = normalizeConfig({
    activeProfile: 'p1',
    port: 8888,
    profiles: [{ id: 'p1', name: 'One' }],
    groups: [{ id: 'g1', profileId: 'p1', name: 'G', enabled: true }],
    rules: [
      {
        id: 'a',
        groupId: 'g1',
        type: 'map-remote',
        enabled: true,
        match: ' https://a.example/x ',
        dest: 'http://localhost/x',
        actions: [{ kind: 'strip-req-cookie' }],
      },
      { id: 'a', groupId: 'missing', type: 'weird', enabled: false, match: 'https://a.example/y' },
    ],
  });
  assert.equal(c.rules.length, 2);
  assert.notEqual(c.rules[0].id, c.rules[1].id);
  assert.equal(c.rules[0].match, 'https://a.example/x');
  assert.deepEqual(c.rules[0].actions[0], { kind: 'req-header', name: 'Cookie', value: '' });
  assert.equal(c.rules[1].groupId, 'g1');
  assert.equal(c.rules[1].type, 'map-remote');
  assert.throws(() => normalizeConfig({}), /rules/);
});

test('compileRule reports problems instead of throwing', () => {
  assert.match(
    compileRule(rule({ type: 'map-remote', match: 'https://a.example/*' })).error,
    /destination/,
  );
  assert.match(
    compileRule(rule({ type: 'map-remote', regex: true, match: '(', dest: 'x' })).error,
    /regular expression/,
  );
  assert.match(
    compileRule(rule({ type: 'map-local', match: 'https://a.example/x', response: { body: '' } }))
      .error,
    /No content/,
  );
  assert.match(
    compileRule(rule({ type: 'rewrite', match: 'https://a.example/x', actions: [] })).error,
    /action/,
  );
  assert.equal(compileRule(rule({ type: 'block', match: 'https://a.example/x' })).error, undefined);
});

test('priority: groups top to bottom, then rules top to bottom', () => {
  const groups = [
    { id: 'g2', profileId: 'p1', name: 'Second', enabled: true },
    { id: 'g1', profileId: 'p1', name: 'First', enabled: true },
  ];
  const a = rule({ type: 'block', match: 'https://a.example/x', groupId: 'g1', name: 'a' });
  const b = rule({ type: 'block', match: 'https://a.example/x', groupId: 'g2', name: 'b' });
  const c = config([a, b], groups);
  assert.deepEqual(
    sortedRules(c).map((r) => r.name),
    ['b', 'a'],
  );
  const { rules } = compileDnr(c, ON);
  assert.ok(rules[0].priority > rules[1].priority);
  const t = testUrl(c, ON, { url: 'https://a.example/x' });
  assert.deepEqual(
    t.map((x) => [x.rule.name, x.shadowed]),
    [
      ['b', false],
      ['a', true],
    ],
  );
});

test('only enabled rules in enabled groups of the active profile go live', () => {
  const groups = [
    { id: 'g1', profileId: 'p1', name: 'On', enabled: true },
    { id: 'g2', profileId: 'p1', name: 'Off', enabled: false },
    { id: 'g3', profileId: 'p2', name: 'Other profile', enabled: true },
  ];
  const c = config(
    [
      rule({ type: 'block', match: 'https://a.example/1', groupId: 'g1' }),
      rule({ type: 'block', match: 'https://a.example/2', groupId: 'g1', enabled: false }),
      rule({ type: 'block', match: 'https://a.example/3', groupId: 'g2' }),
      rule({ type: 'block', match: 'https://a.example/4', groupId: 'g3' }),
    ],
    groups,
  );
  assert.equal(compileDnr(c, ON).rules.length, 1);
  assert.equal(compileDnr(c, { masterEnabled: false }).rules.length, 0);
});

test('compilePage hands the fetch/XHR hook only mocks and body/status/delay rewrites', () => {
  const c = config([
    mock('https://a.example/api', '{}'),
    rule({
      type: 'rewrite',
      match: 'https://a.example/*',
      actions: [{ kind: 'req-header', name: 'X-A', value: '1' }],
    }),
    rule({
      type: 'rewrite',
      match: 'https://a.example/b',
      actions: [{ kind: 'status', value: '503' }],
    }),
    rule({ type: 'map-remote', match: 'https://a.example/c', dest: 'http://localhost/c' }),
  ]);
  const page = compilePage(c, ON);
  assert.deepEqual(
    page.map((p) => p.kind),
    ['mock', 'rewrite'],
  );
});

test('GraphQL operation matching', () => {
  assert.ok(gqlMatch('GetCart', JSON.stringify({ operationName: 'GetCart', query: '' })));
  assert.ok(gqlMatch('GetCart', JSON.stringify([{ query: 'query GetCart { a }' }])));
  assert.ok(
    !gqlMatch('GetCart', JSON.stringify({ operationName: 'Other', query: 'query Other { a }' })),
  );
  assert.ok(!gqlMatch('GetCart', 'not json'));
});

test('whenOk checks method, type and page domain', () => {
  const r = rule({
    when: { methods: ['POST'], resourceTypes: ['xmlhttprequest'], pageDomains: ['a.example'] },
  });
  assert.ok(whenOk(r, { method: 'post', type: 'xmlhttprequest', pageHost: 'www.a.example' }));
  assert.ok(!whenOk(r, { method: 'GET' }));
  assert.ok(!whenOk(r, { type: 'script' }));
  assert.ok(!whenOk(r, { pageHost: 'b.example' }));
});

test('armAutoOff sets and clears the deadline', () => {
  const s = armAutoOff({ masterEnabled: true, autoOffMin: 60 });
  assert.ok(s.autoOffAt > Date.now() + 59 * 60000);
  assert.equal(armAutoOff({ masterEnabled: false, autoOffMin: 60 }).autoOffAt, 0);
  assert.equal(armAutoOff({ masterEnabled: true, autoOffMin: 0 }).autoOffAt, 0);
});

test('a mock with status 0 fails instead of serving its body through a data: URL', () => {
  const served = compileRule(mock('https://api.a.example/lib.js', 'x'));
  assert.equal(served.dnr.length, 1, 'a 200 mock gets a data: redirect');

  for (const status of [0, '0']) {
    const failing = mock('https://api.a.example/lib.js', 'x', { response: { status } });
    assert.deepEqual(compileRule(failing).dnr, []);
    const [result] = testUrl(config([failing]), ON, { url: 'https://api.a.example/lib.js' });
    assert.equal(result.outcome, 'Responds with a network error');
  }
});
