'use strict';
// 배포 폴더(deploy/dist)만으로 로컬 임시 포트에 기동해 확인하는 스모크. 사용: node deploy/smoke.js [포트, 기본 8861]
// 운영과 같은 환경변수(ALLOWED_HOSTS·STATIC·NK_REMOTE_ASSETS=session·NK_TRUST_PROXY)로 띄우고,
//   (A) 루프백 요청 = 개발자 PC 처럼 /rom·/state·/ui 가 열림  (B) nginx 뒤 원격 요청을 헤더로 흉내(Host·X-Forwarded-*) = 세션 게이트 동작을 확인한다.
// DB 는 임시 폴더에 새로 만든다(개발 data/nekketsu.db 는 건드리지 않는다). 끝나면 서버 프로세스를 종료한다.
const { spawn } = require('child_process'), http = require('http'), path = require('path'), os = require('os'), fs = require('fs'), { createRequire } = require('module');
const DIST = path.resolve(__dirname, 'dist'), PORT = +process.argv[2] || 8861, HOST = 'nekketsu.oddplay.kr';
const { WebSocket } = createRequire(path.join(DIST, 'package.json'))('ws');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nk_smoke_'));
const env = Object.assign({}, process.env, { HOST: '127.0.0.1', ALLOWED_HOSTS: HOST, STATIC: '1', NK_REMOTE_ASSETS: 'session', NK_TRUST_PROXY: '1', NK_TRUST_PROXY_HOPS: '1', NK_DB_PATH: path.join(tmp, 'nekketsu.db') });
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const get = (p, h) => new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port: PORT, path: p, headers: h || {} }, x => { const a = []; x.on('data', d => a.push(d)); x.on('end', () => res({ code: x.statusCode, h: x.headers, len: Buffer.concat(a).length, body: Buffer.concat(a) })); }); r.on('error', rej); r.end(); });
const remote = (extra) => Object.assign({ Host: HOST, 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https' }, extra); // nginx 가 붙이는 헤더
const wsOpen = (url, headers) => new Promise(res => { const w = new WebSocket(url, { headers }); w.on('open', () => res(w)); w.on('error', e => res({ err: e.message })); w.on('unexpected-response', (q, r) => res({ err: 'HTTP ' + r.statusCode })); });
const msg = (w, pred) => new Promise(res => { const t = setTimeout(() => res(null), 4000); w.on('message', d => { const m = JSON.parse(d); if (pred(m)) { clearTimeout(t); res(m); } }); });

(async () => {
  const p = spawn(process.execPath, ['server_online.js', String(PORT)], { cwd: DIST, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  try {
    for (let i = 0; i < 50 && !/http:\/\//.test(out); i++) await new Promise(r => setTimeout(r, 100));
    console.log('기동 로그: ' + out.trim().split('\n').filter(l => !/ExperimentalWarning|trace-warnings/.test(l)).join(' | '));
    ok(/DB .*nekketsu\.db/.test(out), 'DB 켜짐(계정·랭킹, 임시 경로 새 DB)');
    // (A) 루프백
    for (const u of ['/', '/index.html', '/rom/nekketsu.nes', '/state/boot_title.json', '/state/title_fight.json', '/state/opening.json', '/ui/characters.json', '/ui/stage_0.png', '/ui/portraits_orig/hud/kunio_hud_base_1x.png', '/engine/core.js', '/engine/gen/code.js', '/ko_table.json', '/hd/stage0_hd_3x.webp', '/fonts/Galmuri11.ttf', '/logo/logo_ko_1x.png', '/game.js', '/ui_manga.js', '/online/status']) {
      const r = await get(u, { Host: '127.0.0.1:' + PORT }); ok(r.code === 200 && r.len > 0, '루프백 GET ' + u + ' → ' + r.code + ' (' + r.len + 'B)');
    }
    const idx = await get('/', { Host: '127.0.0.1:' + PORT });
    ok(idx.h['cross-origin-opener-policy'] === 'same-origin' && idx.h['cross-origin-embedder-policy'] === 'require-corp', 'COOP/COEP 헤더를 Node 가 직접 붙임(nginx 는 추가·삭제 금지)');
    // (B) 원격 흉내
    let r = await get('/', remote()); ok(r.code === 200, '원격(Host=' + HOST + ', https) GET / → ' + r.code);
    r = await get('/game.js', remote()); ok(r.code === 200, '원격 GET /game.js(보호 경로 아님) → ' + r.code);
    for (const u of ['/rom/nekketsu.nes', '/state/boot_title.json', '/ui/characters.json', '/engine/gen/code.js']) { r = await get(u, remote()); ok(r.code === 403, '원격·세션 없음 GET ' + u + ' → ' + r.code + ' (403 기대)'); }
    r = await get('/', { Host: 'evil.example' }); ok(r.code === 403, '허용 안 된 Host → ' + r.code);
    // 웹소켓
    let w = await wsOpen('ws://127.0.0.1:' + PORT + '/ws', remote({ Origin: 'https://' + HOST })); ok(!w.err, '원격 흉내 /ws 접속(Origin https://' + HOST + ')' + (w.err ? ' ' + w.err : ''));
    let sid = null;
    if (!w.err) {
      const welcome = msg(w, m => m.t === 'welcome'); w.send(JSON.stringify({ t: 'hello', name: '스모크', sid: '' })); const m = await welcome;
      ok(m && /^[0-9a-f]{32}$/.test(m.sid || ''), 'hello → welcome(손님 sid 발급)'); sid = m && m.sid;
      r = await get('/rom/nekketsu.nes', remote({ Cookie: 'nk_sess=' + sid })); ok(r.code === 200 && r.h['cache-control'] === 'private, no-cache', '원격 + 세션 쿠키 + https → /rom/ ' + r.code + ' (private)');
      r = await get('/rom/nekketsu.nes', remote({ Cookie: 'nk_sess=' + sid, 'X-Forwarded-Proto': 'http' })); ok(r.code === 403, '원격 + 세션 + http → ' + r.code + ' (403 기대)');
      const st = await get('/online/status', remote()); ok(st.code === 200 && /"proto":3/.test(st.body.toString()), '/online/status → ' + st.body.toString().slice(0, 80));
      w.close();
    }
    w = await wsOpen('ws://127.0.0.1:' + PORT + '/ws', remote({ Origin: 'https://evil.example' })); ok(!!w.err, '다른 Origin /ws 거절 → ' + (w.err || '열림'));
    w = await wsOpen('ws://127.0.0.1:' + PORT + '/ws', { Host: 'evil.example' }); ok(!!w.err, '다른 Host /ws 거절 → ' + (w.err || '열림'));
    // 접속 IP 가 X-Forwarded-For 로 구분되는지(8개 상한 = NK_TRUST_PROXY 동작): 다른 IP 두 개로 각각 접속
    const a = await wsOpen('ws://127.0.0.1:' + PORT + '/ws', remote({ Origin: 'https://' + HOST, 'X-Forwarded-For': '203.0.113.21' })), b = await wsOpen('ws://127.0.0.1:' + PORT + '/ws', remote({ Origin: 'https://' + HOST, 'X-Forwarded-For': '203.0.113.22' }));
    ok(!a.err && !b.err, 'XFF 가 다른 두 접속 모두 허용'); if (a.close) a.close(); if (b.close) b.close();
    // 서버 쪽 ROM 재현 경로(스토리 이어하기 워커가 읽는 ROM·boot_title 이 배포 폴더에 있는지)
    const RS = require(path.join(DIST, 'server/engine/replay_save.js')); const ids = RS.ids ? RS.ids() : null; ok(!!ids && !!ids.eng, 'replay_save.ids() 로드(ROM·시작 상태 해시) eng=' + (ids && String(ids.eng).slice(0, 8)));
  } catch (e) { fail++; console.log('FAIL 예외 ' + e.stack); }
  p.kill(); await new Promise(r => setTimeout(r, 300)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 무시 */ }
  console.log('\n결과: PASS ' + pass + ' / FAIL ' + fail + ' (포트 ' + PORT + ', 서버 종료함)');
  process.exit(fail ? 1 : 0);
})();
