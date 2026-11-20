// Generates Chrome Web Store screenshots (1280×800) of the real extension UI into store/screenshots/.
// www.example.com and api.example.com are served by a local server through Chromium's host resolver
// rules, so the screenshots show fictional hosts and nothing touches the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from './lib.mjs';
import { serve, send, sleep } from '../tests/helpers.mjs';

const WIDTH = 1280;
const HEIGHT = 800;
const OUT_DIR = path.join(ROOT, 'store', 'screenshots');

const SHOP_PAGE = `<!doctype html><meta charset="utf-8"><title>Example Shop</title>
<style>
  body { font: 15px system-ui, sans-serif; margin: 0; color: #1d2433; background: #f6f7fb; }
  header { background: #fff; border-bottom: 1px solid #e3e6ee; padding: 18px 40px; font-weight: 700; font-size: 20px; }
  main { padding: 32px 40px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; max-width: 900px; }
  .card { background: #fff; border: 1px solid #e3e6ee; border-radius: 10px; padding: 18px; }
  .img { height: 110px; border-radius: 8px; background: linear-gradient(135deg, #c9d6ff, #e2e2e2); margin-bottom: 12px; }
</style>
<header>Example Shop</header>
<main>
  <div class="card"><div class="img"></div>Desk lamp<br><b>€39</b></div>
  <div class="card"><div class="img"></div>Notebook<br><b>€12</b></div>
  <div class="card"><div class="img"></div>Backpack<br><b>€74</b></div>
</main>
<script>
  window.loadShop = () => Promise.all([
    fetch('http://api.example.com/v1/products').then((r) => r.text()),
    fetch('http://api.example.com/v1/orders').then((r) => r.text()),
    fetch('http://api.example.com/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationName: 'GetRecommendations', query: 'query GetRecommendations { items { id } }' }),
    }).then((r) => r.text()),
    // Answered by Full interception from the example rules, so they never reach the network.
    fetch('https://api.example.com/v1/cart?user=42').then((r) => r.text()),
    fetch('https://api.example.com/v1/payments', { method: 'POST', body: '{}' }).then((r) => r.text()),
    fetch('https://analytics.example.com/collect').catch(() => 'blocked'),
  ]);
</script>`;

const API_RESPONSES = {
  '/v1/products': [
    200,
    {
      products: [
        { id: 1, name: 'Desk lamp', price: 39 },
        { id: 2, name: 'Notebook', price: 12 },
      ],
    },
  ],
  '/v1/orders': [500, { error: 'Order service unavailable' }],
  '/graphql': [200, { data: { items: [{ id: 'p-1' }, { id: 'p-7' }] } }],
};

/**
 * Builds an example config that shows each rule type on fictional hosts.
 *
 * @returns {object}
 */
function exampleConfig() {
  const group = (id, name) => ({ id, profileId: 'p1', name, enabled: true });
  const rule = (fields) => ({ enabled: true, regex: false, actions: [], when: {}, ...fields });
  const jsonMock = (fields, body, status = 200) =>
    rule({
      type: 'mock',
      ...fields,
      response: {
        status,
        contentType: 'application/json',
        body: JSON.stringify(body, null, 2),
        headers: [{ name: 'Cache-Control', value: 'no-store' }],
        delay: 0,
      },
    });
  return {
    version: 2,
    activeProfile: 'p1',
    profiles: [{ id: 'p1', name: 'Default' }],
    groups: [
      group('g-dev', 'Local development'),
      group('g-mocks', 'API mocks'),
      group('g-exp', 'Experiments'),
    ],
    rules: [
      rule({
        id: 'r-assets',
        groupId: 'g-dev',
        name: 'Shop assets → local dev server',
        type: 'map-remote',
        match: 'https://www.example.com/static/*',
        dest: 'http://localhost:3000/static/*',
        cors: true,
      }),
      rule({
        id: 'r-cors',
        groupId: 'g-dev',
        name: 'Allow CORS on API',
        type: 'rewrite',
        match: 'https://api.example.com/*',
        actions: [
          { kind: 'resp-header', name: 'Access-Control-Allow-Origin', value: '*' },
          { kind: 'delay', name: '', value: '300' },
        ],
      }),
      jsonMock(
        {
          id: 'r-cart',
          groupId: 'g-mocks',
          name: 'Cart with two items',
          match: 'https://api.example.com/v1/cart*',
          when: { methods: ['GET'] },
        },
        {
          items: [
            { sku: 'LAMP-01', qty: 1 },
            { sku: 'NOTE-03', qty: 2 },
          ],
          total: 63,
        },
      ),
      jsonMock(
        {
          id: 'r-empty',
          groupId: 'g-mocks',
          name: 'Empty cart',
          match: 'https://api.example.com/v1/cart*',
        },
        { items: [], total: 0 },
      ),
      jsonMock(
        {
          id: 'r-pay',
          groupId: 'g-mocks',
          name: 'Payment fails',
          match: 'https://api.example.com/v1/payments',
          when: { methods: ['POST'] },
        },
        { error: 'card_declined' },
        402,
      ),
      rule({
        id: 'r-banner',
        groupId: 'g-exp',
        name: 'Highlight the sale banner',
        type: 'inject',
        match: 'https://www.example.com/*',
        inject: {
          lang: 'css',
          runAt: 'document_idle',
          code: '.sale-banner { outline: 3px solid #e11d48; }',
        },
      }),
      rule({
        id: 'r-tracking',
        groupId: 'g-exp',
        name: 'Block analytics',
        type: 'block',
        match: 'https://analytics.example.com/*',
      }),
    ],
  };
}

/**
 * Copies the extension with full site access, because headless Chromium cannot answer the prompt.
 *
 * @returns {string} The copy's directory.
 */
function extensionWithAccess() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-shots-ext-'));
  fs.cpSync(path.join(ROOT, 'extension'), dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

/**
 * Saves a screenshot of a page.
 *
 * @param {import('playwright').Page} page
 * @param {string} name File name without extension.
 * @returns {Promise<void>}
 */
async function capture(page, name) {
  await page.screenshot({ path: path.join(OUT_DIR, name + '.png') });
  console.log('Saved', path.relative(ROOT, path.join(OUT_DIR, name + '.png')));
}

const site = await serve((req, res, url) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', cors);
  const api = API_RESPONSES[url.pathname];
  if (req.headers.host?.startsWith('api.') && api) {
    return send(res, api[0], 'application/json', JSON.stringify(api[1]), cors);
  }
  send(res, 200, 'text/html', SHOP_PAGE);
});
const hostRules = `MAP www.example.com 127.0.0.1:${site.port}, MAP api.example.com 127.0.0.1:${site.port}`;
const extensionDir = extensionWithAccess();
const browser = await chromium.launchPersistentContext(
  fs.mkdtempSync(path.join(os.tmpdir(), 'rr-shots-')),
  {
    channel: 'chromium',
    headless: true,
    viewport: { width: WIDTH, height: HEIGHT },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      `--host-resolver-rules=${hostRules}`,
    ],
  },
);

try {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const worker = browser.serviceWorkers()[0] || (await browser.waitForEvent('serviceworker'));
  const extensionId = worker.url().split('/')[2];
  const extensionUrl = (file) => `chrome-extension://${extensionId}/${file}`;
  // On first start the worker writes its own example config; keep writing ours until it sticks.
  for (let attempt = 0; attempt < 20; attempt++) {
    await worker.evaluate(
      (config) => chrome.storage.local.set({ rrConfig: config }),
      exampleConfig(),
    );
    await sleep(500);
    const storedIds = await worker.evaluate(async () =>
      ((await chrome.storage.local.get('rrConfig')).rrConfig?.rules || []).map((rule) => rule.id),
    );
    if (storedIds.includes('r-assets')) break;
  }

  // 1 and 2: the rule manager with a map-remote rule, then a mock, open in the editor.
  const manager = await browser.newPage();
  await manager.goto(extensionUrl('options.html'));
  await manager.waitForSelector('.rule');
  await manager.click('[data-act="rule"][data-id="r-assets"]');
  await sleep(300);
  await capture(manager, '1-rules-map-remote');
  await manager.click('[data-act="rule"][data-id="r-cart"]');
  await sleep(300);
  await capture(manager, '2-mock-response');

  // 3: Test a URL, where "Cart with two items" wins and "Empty cart" is shadowed.
  await manager.click('[data-tab="test"]');
  await manager.fill('#tUrl', 'https://api.example.com/v1/cart?user=42');
  await sleep(300);
  await capture(manager, '3-test-a-url');

  // 4 and 5: record the shop's API calls, then show the popup and Activity.
  const shop = await browser.newPage();
  await shop.goto('http://www.example.com/');
  const messenger = await browser.newPage();
  await messenger.goto(extensionUrl('popup.html'));
  const shopTabId = await messenger.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://www.example.com/*' });
    return tab.id;
  });
  await messenger.evaluate(
    (tabId) => chrome.runtime.sendMessage({ type: 'rr:rec-toggle', tabId }),
    shopTabId,
  );
  await messenger.close();
  await shop.bringToFront();
  await shop.reload();
  await shop.evaluate(() => window.loadShop());
  await sleep(1000);

  const popup = await browser.newPage();
  await popup.setViewportSize({ width: 340, height: 600 });
  await popup.addInitScript(() => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = () => query({ url: 'http://www.example.com/*' });
  });
  await popup.goto(extensionUrl('popup.html'));
  await sleep(600);
  const popupHeight = await popup.evaluate(() => document.documentElement.scrollHeight);
  const popupImage = (
    await popup.screenshot({ clip: { x: 0, y: 0, width: 340, height: popupHeight } })
  ).toString('base64');
  // Show the popup where Chrome opens it, over the shop page it describes.
  await shop.bringToFront();
  await shop.evaluate((src) => {
    const image = document.createElement('img');
    image.src = src;
    image.style.cssText =
      'position:fixed;top:6px;right:16px;border:1px solid #c9ced8;border-radius:8px;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.25)';
    document.body.append(image);
    return image.decode();
  }, 'data:image/png;base64,' + popupImage);
  await capture(shop, '4-popup');

  await manager.click('[data-tab="log"]');
  await manager.waitForSelector('.caprow');
  await sleep(300);
  await capture(manager, '5-activity-recording');
} finally {
  await browser.close();
  await site.close();
}
