'use strict';
// 정적 파일 압축 전송(server_game.js·server_online.js 공용). Accept-Encoding 협상으로 br(우선) 또는 gzip 을 보내고, 압축 결과는 파일·ETag 기준 메모리 캐시.
//   대상: 글자 계열(.html .js .json .css .svg .webmanifest)과 글꼴(.ttf). 그림(.png .webp)·ROM(.nes)은 이미 압축됐거나 이득이 작아 그대로 보낸다.
//   첫 요청: 빠른 품질(br 5 / gzip 6)로 비동기 압축(스레드 풀, 이벤트 루프 안 막음)해 보내고, 뒤에서 높은 품질(br 11, 1MB 초과는 br 9 / gzip 9)로 다시 만들어 캐시를 바꾼다.
//   높은 품질 재압축은 전역 1개씩 줄을 세우고, 진행 중인 정적 응답이 없고 IDLE_MS 동안 새 요청이 없을 때만 다음 것을 시작한다(스레드 풀 4개를 오래 점유해 그림·모듈 읽기가 밀리지 않게).
//   br 11 은 큰 파일에서 수 초~십수 초 걸린다(Galmuri14 5.6MB 약 11~15초, code.js 3.2MB 약 5초). br 9 는 0.1~0.4초. 그래서 1MB 초과는 br 9.
//   같은 파일(크기·수정 시각 = ETag)이면 다시 압축하지 않는다. 파일이 바뀌면 ETag 가 달라져 다시 만들고, 줄에 남은 옛 작업은 버린다. 캐시 상한을 넘으면 압축 없이 그대로 보낸다.
const zlib = require('zlib'), fs = require('fs'), path = require('path');
const EXT = new Set(['.html', '.js', '.json', '.css', '.svg', '.webmanifest', '.ttf']);
const MIN = 1024, CAP = 160 * 1024 * 1024; // 1KB 미만은 압축 안 함 / 캐시 상한(바이트)
const BIG = 1024 * 1024, IDLE_MS = 300; // br 11 대신 br 9 로 낮추는 크기 / 재압축을 시작하기 전 요청이 없어야 하는 시간
const C = zlib.constants, cache = new Map(); // file → { tag, br, gzip } (각 Buffer 또는 Promise)
let used = 0;
const run = (enc, buf, best, font) => new Promise((ok, no) => {
  const cb = (e, b) => e ? no(e) : ok(b);
  if (enc === 'br') zlib.brotliCompress(buf, { params: { [C.BROTLI_PARAM_QUALITY]: best ? (buf.length > BIG ? 9 : 11) : 5, [C.BROTLI_PARAM_SIZE_HINT]: buf.length, [C.BROTLI_PARAM_MODE]: font ? C.BROTLI_MODE_FONT : C.BROTLI_MODE_GENERIC } }, cb);
  else zlib.gzip(buf, { level: best ? 9 : 6 }, cb);
});
// 높은 품질 재압축 줄: key(file|enc) → job. 같은 key 는 하나만(나중 것이 덮어씀). 한 번에 하나만 돌린다.
const queue = new Map();
let active = 0, last = 0, busy = false, timer = null;
function kick() {
  if (busy || timer || !queue.size) return;
  const wait = active ? IDLE_MS : Math.max(0, last + IDLE_MS - Date.now());
  timer = setTimeout(() => {
    timer = null;
    if (busy || !queue.size) return;
    if (active || Date.now() - last < IDLE_MS) return kick(); // 아직 바쁘면 다시 기다린다
    const [key, job] = queue.entries().next().value; queue.delete(key);
    if (!job.live()) return kick(); // 파일이 바뀌었거나 이미 교체된 옛 작업
    busy = true;
    run(job.enc, job.buf, true, job.font).then(job.done, () => {}).then(() => { busy = false; kick(); });
  }, wait);
  if (timer.unref) timer.unref();
}
function enqueue(file, enc, job) { queue.delete(file + '|' + enc); queue.set(file + '|' + enc, job); kick(); }
// Accept-Encoding → 'br' | 'gzip' | null (q=0 은 거절로 본다)
function pick(ae) {
  const q = {}; for (const p of String(ae || '').toLowerCase().split(',')) { const [n, ...a] = p.trim().split(';'); const m = /q=([\d.]+)/.exec(a.join(';')); q[n.trim()] = m ? +m[1] : 1; }
  const ok = n => (n in q ? q[n] : (q['*'] || 0)) > 0;
  return ok('br') ? 'br' : ok('gzip') ? 'gzip' : null;
}
const compressible = (file, size) => size >= MIN && EXT.has(path.extname(file).toLowerCase());
// 압축본(Buffer) 또는 null(압축 안 함). 실패·상한 초과면 null → 호출 쪽이 원본을 보낸다
async function get(file, tag, enc) {
  let e = cache.get(file);
  if (!e || e.tag !== tag) { if (e) for (const k of ['br', 'gzip']) { if (Buffer.isBuffer(e[k])) used -= e[k].length; queue.delete(file + '|' + k); } e = { tag }; cache.set(file, e); }
  if (Buffer.isBuffer(e[enc])) return e[enc];
  if (!e[enc]) {
    if (used > CAP) return null;
    e[enc] = fs.promises.readFile(file).then(async buf => {
      const font = /\.ttf$/i.test(file), fast = await run(enc, buf, false, font);
      if (cache.get(file) !== e) return fast;
      e[enc] = fast; used += fast.length;
      const live = () => cache.get(file) === e && e[enc] === fast;
      enqueue(file, enc, { enc, buf, font, live, done: best => { if (live() && best.length < fast.length) { used += best.length - fast.length; e[enc] = best; } } });
      return fast;
    }).catch(() => { if (cache.get(file) === e) e[enc] = null; return null; });
  }
  return e[enc];
}
// 정적 응답 공통. st = fs.stat, hd = 공통 헤더(ETag·COOP/COEP 등, 이미 304 판정 끝난 뒤), type = Content-Type
function send(req, res, file, st, hd, type) {
  // 진행 중인 정적 응답 수(재압축 줄이 한가할 때만 돌도록). 끝나거나 끊기면 한 번만 뺀다
  active++; last = Date.now(); let open = true;
  const fin = () => { if (!open) return; open = false; active--; last = Date.now(); kick(); };
  res.once('finish', fin); res.once('close', fin);
  const enc = compressible(file, st.size) ? pick(req.headers['accept-encoding']) : null;
  const plain = () => { res.writeHead(200, Object.assign({ 'Content-Type': type, 'Content-Length': st.size }, hd)); if (req.method === 'HEAD') return res.end(); fs.createReadStream(file).on('error', () => res.destroy()).pipe(res); };
  if (!enc) return plain();
  get(file, hd.ETag, enc).then(b => {
    if (!b) return plain();
    res.writeHead(200, Object.assign({ 'Content-Type': type, 'Content-Encoding': enc, 'Content-Length': b.length }, hd, { ETag: hd.ETag.replace(/"$/, '-' + enc + '"') }));
    res.end(req.method === 'HEAD' ? undefined : b);
  }, plain);
}
// If-None-Match 비교용: 압축본 ETag(…-br" / …-gzip")도 원본 태그와 같은 것으로 본다
const sameTag = (v, tag) => v.trim().replace(/-(br|gzip)"$/, '"') === tag;
// Vary: 압축 대상 파일은 Accept-Encoding 에 따라 본문이 달라진다(304 에도 같이 붙인다)
const vary = (file, size) => compressible(file, size) ? { Vary: 'Accept-Encoding' } : {};
module.exports = { send, sameTag, vary, pick, get, stats: () => ({ files: cache.size, used, queued: queue.size, busy, active }) };
