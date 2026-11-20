// Main-world half of the fetch/XHR hook. It holds no rules: for each request it asks
// bridge.js (isolated world) what to do and gets back only that request's outcome —
// a mock response to return, or status/body/delay changes to apply to the real one.
(() => {
  if (window.__rerouteHook) return;
  window.__rerouteHook = true;

  let active = false, needBody = false, isReady = false, markReady;
  const ready = new Promise(r => (markReady = r));
  const done = () => { if (!isReady) { isReady = true; markReady(); } };

  document.addEventListener('rr:ready', e => {
    try { const s = JSON.parse(e.detail); active = !!s.active; needBody = !!s.needBody; } catch { active = false; }
    done();
  });
  document.dispatchEvent(new CustomEvent('rr:hello'));
  setTimeout(done, 1000); // never hold the page up if the bridge is missing

  // The bridge answers inside dispatchEvent, so this is synchronous.
  let seq = 0, answer = null;
  document.addEventListener('rr:a', e => { try { answer = JSON.parse(e.detail); } catch { answer = null; } });
  const ask = (url, method, body) => {
    const id = ++seq;
    answer = null;
    document.dispatchEvent(new CustomEvent('rr:q', { detail: JSON.stringify({ id, url, method, body: needBody ? body : '' }) }));
    const a = answer;
    answer = null;
    return (a && a.id === id && a.out) || {};
  };

  const NULL_BODY = [101, 204, 205, 304];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const abs = u => { try { return new URL(String(u), location.href).href; } catch { return String(u); } };

  const bytesOf = resp => {
    if (!resp.base64) return resp.body;
    const bin = atob(resp.body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const headersOf = resp => {
    const h = { 'content-type': resp.contentType };
    for (const x of resp.headers) h[x.name.toLowerCase()] = x.value;
    return h;
  };
  const replaceBody = (text, acts) => {
    for (const a of acts) {
      if (a.kind !== 'resp-body' || !a.name) continue;
      try { text = a.regex ? text.replace(new RegExp(a.name, 'g'), a.value || '') : text.split(a.name).join(a.value || ''); } catch { /* bad regex */ }
    }
    return text;
  };
  const statusOf = acts => { const s = acts.filter(a => a.kind === 'status' && Number(a.value)).pop(); return s ? Number(s.value) : 0; };
  const delayOf = acts => Math.max(0, ...acts.filter(a => a.kind === 'delay').map(a => Number(a.value) || 0));

  // ----- fetch -----
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    if (!isReady) await ready;
    if (!active) return origFetch.apply(this, arguments);
    const isReq = input instanceof Request;
    const url = abs(isReq ? input.url : input);
    const method = String((init && init.method) || (isReq ? input.method : 'GET')).toUpperCase();
    let body = '';
    if (needBody) {
      try { body = init && typeof init.body === 'string' ? init.body : isReq ? await input.clone().text() : ''; } catch { /* unreadable */ }
    }
    const { mock, acts } = ask(url, method, body);
    if (mock) {
      if (mock.delay) await sleep(mock.delay);
      if (mock.status === 0) throw new TypeError('Failed to fetch');
      const res = new Response(NULL_BODY.includes(mock.status) ? null : bytesOf(mock), { status: mock.status, headers: headersOf(mock) });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }
    if (!acts) return origFetch.apply(this, arguments);
    const delay = delayOf(acts);
    if (delay) await sleep(delay);
    const res = await origFetch.apply(this, arguments);
    const st = statusOf(acts);
    const bodyActs = acts.filter(a => a.kind === 'resp-body');
    if ((!st && !bodyActs.length) || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
    try {
      const status = st || res.status;
      const headers = new Headers(res.headers);
      let out = null;
      if (!NULL_BODY.includes(status)) {
        if (bodyActs.length) {
          out = replaceBody(await res.clone().text(), bodyActs);
          headers.delete('content-length'); headers.delete('content-encoding');
        } else out = res.clone().body;
      }
      const next = new Response(out, { status, statusText: st ? '' : res.statusText, headers });
      Object.defineProperty(next, 'url', { value: res.url });
      return next;
    } catch { return res; }
  };

  // ----- XMLHttpRequest -----
  const XP = XMLHttpRequest.prototype;
  const xOpen = XP.open, xSend = XP.send;
  const desc = name => Object.getOwnPropertyDescriptor(XP, name);
  const dText = desc('responseText'), dResp = desc('response'), dStatus = desc('status');
  const def = (xhr, name, get) => Object.defineProperty(xhr, name, { configurable: true, get });

  XP.open = function (method, url, async) {
    this.__rr = { method: String(method).toUpperCase(), url: abs(url), async: async !== false };
    return xOpen.apply(this, arguments);
  };

  XP.send = function (body) {
    const info = this.__rr;
    if (!info || !info.async || (isReady && !active)) return xSend.apply(this, arguments);
    const xhr = this, args = arguments;
    const go = () => {
      if (!active) return xSend.apply(xhr, args);
      const { mock, acts } = ask(info.url, info.method, typeof body === 'string' ? body : '');
      if (mock) { setTimeout(() => fake(xhr, mock, info.url), mock.delay || 0); return; }
      if (!acts) return xSend.apply(xhr, args);
      const st = statusOf(acts);
      const bodyActs = acts.filter(a => a.kind === 'resp-body');
      if (st) def(xhr, 'status', () => (xhr.readyState === 4 ? st : dStatus.get.call(xhr)));
      if (bodyActs.length) {
        def(xhr, 'responseText', () => { const t = dText.get.call(xhr); return xhr.readyState === 4 ? replaceBody(t, bodyActs) : t; });
        def(xhr, 'response', () => {
          const v = dResp.get.call(xhr);
          if (xhr.readyState !== 4) return v;
          if (xhr.responseType === '' || xhr.responseType === 'text') return replaceBody(v, bodyActs);
          if (xhr.responseType === 'json' && v != null) { try { return JSON.parse(replaceBody(JSON.stringify(v), bodyActs)); } catch { return v; } }
          return v;
        });
      }
      setTimeout(() => xSend.apply(xhr, args), delayOf(acts));
    };
    if (isReady) go(); else ready.then(go);
  };

  function fake(xhr, r, url) {
    if (r.status === 0) {
      def(xhr, 'readyState', () => 4);
      xhr.dispatchEvent(new Event('readystatechange'));
      xhr.dispatchEvent(new ProgressEvent('error'));
      xhr.dispatchEvent(new ProgressEvent('loadend'));
      return;
    }
    const headers = headersOf(r);
    const data = NULL_BODY.includes(r.status) ? '' : bytesOf(r);
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const type = xhr.responseType;
    let response = text;
    if (type === 'json') { try { response = JSON.parse(text); } catch { response = null; } }
    else if (type === 'arraybuffer') response = (typeof data === 'string' ? new TextEncoder().encode(data) : data).buffer;
    else if (type === 'blob') response = new Blob([data], { type: r.contentType });
    else if (type === 'document') { try { response = new DOMParser().parseFromString(text, 'text/html'); } catch { response = null; } }
    def(xhr, 'readyState', () => 4);
    def(xhr, 'status', () => r.status);
    def(xhr, 'statusText', () => '');
    def(xhr, 'responseURL', () => url);
    def(xhr, 'response', () => response);
    if (type === '' || type === 'text') def(xhr, 'responseText', () => text);
    xhr.getResponseHeader = name => headers[String(name).toLowerCase()] ?? null;
    xhr.getAllResponseHeaders = () => Object.entries(headers).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n';
    const size = typeof data === 'string' ? data.length : data.byteLength;
    xhr.dispatchEvent(new Event('readystatechange'));
    xhr.dispatchEvent(new ProgressEvent('load', { loaded: size, total: size, lengthComputable: true }));
    xhr.dispatchEvent(new ProgressEvent('loadend', { loaded: size, total: size, lengthComputable: true }));
  }
})();
