/* 部材検査 iPhone中継：サービスワーカー
   app/ の中の画面（タブレットのアプリ）が出すすべての読み込みを横取りし、
   phone.html → タブレットの bridge.html → localhost:3800 へ中継する。
   アプリ本体やデータは GitHub には置かない（毎回タブレットから届く）。 */
'use strict';
const PREFIX = new URL(self.registration.scope).pathname;   // 例：/リポジトリ名/app/

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function hubClient() {
  const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return cs.find(c => new URL(c.url).pathname.endsWith('/phone.html')) || null;
}

/* 図面PDF：pdf.js は別スレッドで読みに行くので、画面側から読んで渡すようにする（iPhoneでも確実に届くように） */
const PDF_PATCH = `<script>(function(){try{var L=window.pdfjsLib;if(!L||!L.getDocument)return;var g=L.getDocument.bind(L);
L.getDocument=function(src){if(src&&typeof src==='object'&&typeof src.url==='string'&&src.url.charAt(0)==='/'){var s=Object.assign({},src),u=s.url;delete s.url;var inner=null;
var p=fetch(u).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.arrayBuffer();}).then(function(b){s.data=new Uint8Array(b);inner=g(s);return inner.promise;});
return{promise:p,destroy:function(){return inner?inner.destroy():Promise.resolve();},onProgress:null,onPassword:null};}return g(src);};}catch(e){}})();</script>`;

function injectHtml(html) {
  const tag = '<script src="/pdf.min.js"></script>';
  return html.includes(tag) ? html.replace(tag, tag + PDF_PATCH) : html;
}

function errorResponse(status, msg) {
  return new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;           // 外のサイトはそのまま
  let p = u.pathname;
  if (p.startsWith(PREFIX)) p = '/' + p.slice(PREFIX.length);
  e.respondWith(relay(e.request, p + u.search));
});

async function relay(req, path) {
  const hub = await hubClient();
  if (!hub) return errorResponse(503, 'phone.html が開いていません');
  const body = (req.method === 'GET' || req.method === 'HEAD') ? null : await req.arrayBuffer();
  const isPage = req.mode === 'navigate';
  const ch = new MessageChannel();
  hub.postMessage({ t: 'req', method: req.method, path, ctype: req.headers.get('content-type') || '', body }, body ? [ch.port1, body] : [ch.port1]);

  return new Promise(resolve => {
    let ctrl = null, head = null, buf = [];
    const NOBODY = [101, 204, 205, 304];
    const stream = new ReadableStream({
      start(c) { ctrl = c; },
      cancel() { try { ch.port2.postMessage({ t: 'abort' }); } catch (_) {} },
    });
    const timer = setTimeout(() => { if (!head) resolve(errorResponse(504, 'タブレットから返事がありません')); }, 60000);
    ch.port2.onmessage = ev => {
      const m = ev.data || {};
      if (m.t === 'head') {
        clearTimeout(timer); head = m;
        const html = isPage && /text\/html/i.test((m.headers || {})['content-type'] || '');
        if (html) { head.html = true; return; }                       // 画面のHTMLは全部そろってから少し書き足す
        if (NOBODY.includes(m.status)) { resolve(new Response(null, { status: m.status, headers: m.headers })); return; }
        resolve(new Response(stream, { status: m.status, headers: m.headers }));
      } else if (m.t === 'chunk') {
        if (head && head.html) buf.push(new Uint8Array(m.data));
        else try { ctrl.enqueue(new Uint8Array(m.data)); } catch (_) {}
      } else if (m.t === 'end') {
        if (head && head.html) {
          const all = new Blob(buf);
          all.text().then(t => resolve(new Response(injectHtml(t), { status: head.status, headers: head.headers })));
        } else { try { ctrl.close(); } catch (_) {} }
        ch.port2.close();
      } else if (m.t === 'err') {
        clearTimeout(timer);
        if (!head || head.html) resolve(errorResponse(m.status || 502, m.msg || '中継できませんでした'));
        else try { ctrl.error(new Error(m.msg || 'error')); } catch (_) {}
        ch.port2.close();
      }
    };
  });
}
