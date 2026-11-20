// Isolated-world half of the fetch/XHR hook. The rule list and mock bodies stay here,
// out of the page's reach: the page-side hook asks about one request at a time and
// only ever gets the outcome for that request.
(() => {
  let rules = null;

  const ready = () => {
    if (!rules) return;
    // Two booleans are all the page learns up front.
    document.dispatchEvent(
      new CustomEvent('rr:ready', {
        detail: JSON.stringify({ active: rules.length > 0, needBody: rules.some((r) => r.gql) }),
      }),
    );
  };
  const setRules = (list) => {
    rules = (list || [])
      .map((r) => {
        try {
          return { ...r, re: new RegExp(r.src, 'i') };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    ready();
  };

  // Registrable-domain guess (no public suffix list): example.com, example.co.uk.
  const site = (hostname) => {
    const labels = hostname.split('.');
    if (labels.length <= 2 || /^\d+$/.test(labels[labels.length - 1])) return hostname;
    const labelCount =
      labels[labels.length - 1].length === 2 && labels[labels.length - 2].length <= 3 ? 3 : 2;
    return labels.slice(-labelCount).join('.');
  };
  const gql = (op, body) => {
    if (!body || typeof body !== 'string') return false;
    let items;
    try {
      const j = JSON.parse(body);
      items = Array.isArray(j) ? j : [j];
    } catch {
      return false;
    }
    const re = new RegExp(
      '\\b(query|mutation|subscription)\\s+' + op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b',
    );
    return items.some(
      (it) =>
        it && (it.operationName === op || (typeof it.query === 'string' && re.test(it.query))),
    );
  };

  function decide(q) {
    const host = location.hostname; // read here, so the page cannot fake it
    let reqHost;
    try {
      reqHost = new URL(q.url).hostname;
    } catch {
      return null;
    }
    let mock = null;
    const rw = [];
    for (const r of rules) {
      if (!r.re.test(q.url)) continue;
      if (r.methods.length && !r.methods.includes(q.method)) continue;
      // A page only gets rules for its own site, unless the rule names the page's domain.
      // This stops an unrelated site from fetching a mocked URL to read your mock.
      if (
        r.domains.length
          ? !r.domains.some((d) => host === d || host.endsWith('.' + d))
          : site(reqHost) !== site(host)
      )
        continue;
      if (r.gql && !gql(r.gql, q.body)) continue;
      if (r.kind === 'mock') {
        if (!mock) mock = r;
      } else rw.push(r);
    }
    const used = mock ? [mock] : rw;
    for (const r of used) {
      try {
        chrome.runtime.sendMessage({ type: 'rr:hit', id: r.id, name: r.name, url: q.url });
      } catch {
        /* extension reloaded */
      }
    }
    if (mock) return { mock: mock.response };
    return rw.length ? { acts: rw.flatMap((r) => r.actions) } : null;
  }

  document.addEventListener('rr:hello', ready);
  // Answered synchronously, inside the page's dispatchEvent call.
  document.addEventListener('rr:q', (e) => {
    let id,
      out = null;
    try {
      const q = JSON.parse(e.detail);
      id = q.id;
      if (rules) out = decide(q);
    } catch {
      /* malformed */
    }
    document.dispatchEvent(new CustomEvent('rr:a', { detail: JSON.stringify({ id, out }) }));
  });

  try {
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === 'local' && c.rrPage) setRules(c.rrPage.newValue);
    });
    chrome.storage.local.get('rrPage').then(
      (s) => setRules(s.rrPage),
      () => setRules([]),
    );
  } catch {
    setRules([]);
  }
})();
