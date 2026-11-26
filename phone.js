'use strict';
/* iPhone側：タブレットとつなぎ、アプリの画面（iframe）が出す読み込みを全部タブレットへ中継する */
if (window.top !== window.self) { document.documentElement.style.display = 'none'; throw new Error('framed'); }

const $ = id => document.getElementById(id);
const target = (location.hash || '').slice(1);
const q = new URLSearchParams(location.search);
let peer = null, conn = null, approved = false, seq = 0, retryN = 0;
const ports = new Map();   // 中継中の読み込み：番号 → サービスワーカーへの返事の口
const myCode = String(1000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9000));
let mode = (() => { try { return localStorage.getItem('buzai_remote_mode') || 'mirror'; } catch (e) { return 'mirror'; } })();

function cover(msg, opt = {}) {
  $('cover').classList.remove('hide'); $('msg').textContent = msg;
  $('codeBox').hidden = !opt.code; $('code').textContent = myCode;
  $('retry').hidden = !opt.retry;
}
function bar(t, cls) { $('barTxt').textContent = t; $('dot').className = cls || ''; }

function peerOptions() {
  const o = { debug: 1 };
  if (q.get('host')) { o.host = q.get('host'); o.port = +(q.get('port') || 9000); o.path = q.get('path') || '/'; o.secure = q.get('secure') === '1'; }
  return o;
}

/* ---- サービスワーカー（アプリの画面の読み込みを横取りする） ---- */
async function startSW() {
  if (!('serviceWorker' in navigator)) throw new Error('このブラウザでは使えません（Safariのプライベートモードでは動きません）');
  const reg = await navigator.serviceWorker.register('sw.js', { scope: './app/' });
  const sw = reg.active || reg.waiting || reg.installing;
  if (sw && sw.state !== 'activated') await new Promise(r => sw.addEventListener('statechange', () => { if (sw.state === 'activated') r(); }));
}
navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', ev => {
  const m = ev.data; const port = ev.ports && ev.ports[0];
  if (!m || m.t !== 'req' || !port) return;
  if (!(conn && conn.open && approved)) { port.postMessage({ t: 'err', status: 503, msg: 'タブレットとつながっていません' }); return; }
  const id = ++seq;
  ports.set(id, port);
  port.onmessage = e => { if (e.data && e.data.t === 'abort') { ports.delete(id); try { conn.send({ t: 'abort', id }); } catch (_) {} } };
  conn.send({ t: 'req', id, method: m.method, path: m.path, ctype: m.ctype, body: m.body || null });
});
navigator.serviceWorker && navigator.serviceWorker.startMessages && navigator.serviceWorker.startMessages();

/* ---- タブレットとつなぐ ---- */
function connect() {
  if (!/^buzai-[0-9a-f]{32}$/.test(target)) { cover('タブレットの中継画面（bridge.html）に出ているQRコードを、iPhoneのカメラで読み取って開いてください。'); return; }
  cover('タブレットにつないでいます…');
  approved = false;
  if (peer) { try { peer.destroy(); } catch (_) {} }
  peer = new Peer(peerOptions());
  peer.on('open', () => {
    conn = peer.connect(target, { reliable: true, serialization: 'binary' });
    conn.on('open', () => { retryN = 0; conn.send({ t: 'hello', code: myCode, ua: navigator.userAgent.slice(0, 120) }); cover('タブレットの許可を待っています', { code: true }); bar('許可待ち'); });
    conn.on('data', onData);
    conn.on('close', lost);
    conn.on('error', lost);
    const c0 = conn;
    setTimeout(() => {
      if (conn === c0 && !c0.open) {
        cover('タブレットとつながりませんでした。会社のネットワーク（VPN）に止められている可能性があります。タブレットの「iPhone連動」の画面で「中継サーバー（443番）」を設定してから、QRを読み直してください。', { retry: true });
        bar('未接続', 'off');
      }
    }, 25000);
  });
  peer.on('error', e => {
    if (e.type === 'peer-unavailable') { cover('タブレットの中継画面が見つかりません。タブレットで bridge.html が開いているか確かめて、QRを読み直してください。', { retry: true }); bar('未接続', 'off'); }
    else lost();
  });
}
function lost() {
  approved = false; bar('切断（つなぎ直しています）', 'off');
  for (const [, p] of ports) { try { p.postMessage({ t: 'err', status: 503, msg: '切断' }); } catch (_) {} }
  ports.clear();
  if (retryN++ < 5) setTimeout(connect, Math.min(15000, 1500 * retryN));
  else cover('タブレットとの接続が切れました。', { retry: true });
}

function onData(m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'ok') { approved = true; bar(mode === 'mirror' ? 'タブレットと連動中' : 'スマホ単独で検査中', 'on'); $('cover').classList.add('hide'); $('modeBtn').hidden = false; openApp(); return; }
  if (m.t === 'deny') { approved = false; cover('タブレットで断られました。', { retry: true }); try { conn.close(); } catch (_) {} return; }
  const port = ports.get(m.id); if (!port) return;
  if (m.t === 'head') port.postMessage({ t: 'head', status: m.status, headers: m.headers || {} });
  else if (m.t === 'chunk') { const d = (m.data instanceof ArrayBuffer ? new Uint8Array(m.data) : m.data).slice().buffer; port.postMessage({ t: 'chunk', data: d }, [d]); }
  else if (m.t === 'end') { port.postMessage({ t: 'end' }); ports.delete(m.id); }
  else if (m.t === 'err') { port.postMessage({ t: 'err', status: m.status, msg: m.msg }); ports.delete(m.id); }
}

let appOpened = '';
function openApp() {
  const src = 'app/' + (mode === 'mirror' ? '?mirror' : '');
  if (appOpened === src) return;
  appOpened = src; $('app').src = src;
  $('modeBtn').textContent = mode === 'mirror' ? '単独で使う' : '連動に戻す';
}
$('modeBtn').onclick = () => {
  mode = mode === 'mirror' ? 'solo' : 'mirror';
  try { localStorage.setItem('buzai_remote_mode', mode); } catch (_) {}
  bar(mode === 'mirror' ? 'タブレットと連動中' : 'スマホ単独で検査中', 'on'); openApp();
};
$('retry').onclick = () => { retryN = 0; connect(); };

startSW().then(connect).catch(e => cover('準備できませんでした：' + e.message));
