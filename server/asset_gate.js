'use strict';
// 원격 ROM 파생물 제공 정책(모바일 M0, analysis/27 「M0 접근 정책」). server_online.js·server_game.js 공용.
//   보호 경로 = /rom/ · /state/ · /ui/ · /engine/gen/ (원작 ROM 과 그 파생물: ROM·시작 상태·초상·스테이지 프레임·캐릭터 자료·ROM 에서 뽑은 코드).
//   NK_REMOTE_ASSETS(또는 opt.mode):
//     off(기본·그 밖의 값) = 종전 동작 그대로. 게이트는 아무것도 하지 않는다(호출 쪽이 종전 local 판정을 그대로 쓴다).
//     session = 루프백 요청(상대 주소·Host 루프백 + 프록시 전달 헤더 없음)은 종전처럼 통과. 그 밖의 요청이 보호 경로를 달라고 하면
//               HTTPS(직접 TLS 또는 NK_TRUST_PROXY=1 일 때 X-Forwarded-Proto: https) + 유효한 세션(쿠키 nk_sess 또는 헤더 X-NK-Session)일 때만 통과.
//               실패는 403(HTTPS 아님·세션 없음/무효), IP당 분당 실패가 NK_ASSET_FAILS_PER_MIN(기본 30)을 넘으면 429.
//               보호 경로 응답은 Cache-Control: private, no-cache + Vary: Cookie, X-NK-Session(공유 캐시·CDN 에 올리지 않는다).
//   세션 판정(validate)은 호출 쪽이 준다(server_online.js = 손님 sid 또는 계정 토큰, server_game.js = NK_DB_PATH 가 있을 때 계정 토큰만).
const net = require('net');

const PROTECTED = /^\/+(rom|state|ui|engine\/+gen)(\/|$)/i;
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];
const COOKIE = 'nk_sess', HEADER = 'x-nk-session';

// 요청 경로가 보호 경로인가(퍼센트 인코딩·역슬래시 포함). 해석 못 하는 경로는 resolve() 가 400 으로 거절하므로 false
function isProtected(url) {
  let u; try { u = decodeURIComponent(String(url || '/').split('?')[0]); } catch (e) { return false; }
  return PROTECTED.test(u.replace(/\\/g, '/'));
}
// 세션 자격: 헤더 X-NK-Session 우선, 없으면 쿠키 nk_sess. 길이 상한 200
function credential(req) {
  const h = req.headers[HEADER];
  if (typeof h === 'string' && h) return h.trim().slice(0, 200);
  for (const p of String(req.headers.cookie || '').split(';')) {
    const i = p.indexOf('='); if (i < 0) continue;
    if (p.slice(0, i).trim() === COOKIE) { try { return decodeURIComponent(p.slice(i + 1).trim()).slice(0, 200); } catch (e) { return ''; } }
  }
  return '';
}
const hasProxyHeaders = req => PROXY_HEADERS.some(k => req.headers[k] !== undefined);

/**
 * @param {object} o { mode?, trustProxy?, trustProxyHops?, failsPerMin?, validate(cred, req) -> bool, now? }
 * @returns {{ mode, on, check(req, local) -> { local:boolean, code?:number, priv:boolean } }}
 *   check: local = 종전 루프백 판정(호출 쪽 계산). 결과 local 을 resolve() 에 넘기면 된다. code 가 있으면 그 코드로 거절.
 */
function createGate(o) {
  o = o || {};
  const raw = String(o.mode !== undefined ? o.mode : (process.env.NK_REMOTE_ASSETS || 'off')).trim().toLowerCase();
  const mode = raw === 'session' ? 'session' : 'off';
  const trustProxy = o.trustProxy !== undefined ? !!o.trustProxy : process.env.NK_TRUST_PROXY === '1';
  const hops = Math.max(1, (o.trustProxyHops !== undefined ? +o.trustProxyHops : +(process.env.NK_TRUST_PROXY_HOPS || 1)) | 0 || 1);
  const failsPerMin = o.failsPerMin !== undefined ? o.failsPerMin : (+process.env.NK_ASSET_FAILS_PER_MIN > 0 ? +process.env.NK_ASSET_FAILS_PER_MIN : 30);
  const validate = typeof o.validate === 'function' ? o.validate : () => false, now = o.now || Date.now;
  const fails = new Map(); // IP → 최근 1분 실패 시각들
  const pickHop = v => { const xs = String(v || '').split(',').map(s => s.trim()).filter(Boolean); return xs.length >= hops ? xs[xs.length - hops] : ''; };
  const ipOf = req => { const ra = req.socket.remoteAddress || ''; if (!trustProxy) return ra; const x = pickHop(req.headers['x-forwarded-for']); return net.isIP(x) ? x : ra; };
  const https = req => !!req.socket.encrypted || (trustProxy && pickHop(req.headers['x-forwarded-proto']).toLowerCase() === 'https');
  const recent = ip => { const t = now(), a = (fails.get(ip) || []).filter(x => t - x < 60000); if (a.length) fails.set(ip, a); else fails.delete(ip); return a; };
  const fail = ip => {
    const a = recent(ip); a.push(now()); fails.set(ip, a);
    if (fails.size > 10000) for (const k of [...fails.keys()]) recent(k);
  };

  function check(req, local) {
    if (mode !== 'session') return { local, priv: false };
    const prot = isProtected(req.url);
    const loc = local && !hasProxyHeaders(req); // 같은 PC 프록시·터널이 Host 를 루프백 이름으로 바꿔 넘겨도 전달 헤더가 있으면 원격으로 본다
    if (!prot || loc) return { local: loc, priv: prot };
    const ip = ipOf(req);
    if (recent(ip).length >= failsPerMin) return { local: false, code: 429, priv: true };
    if (!https(req)) { fail(ip); return { local: false, code: 403, priv: true }; }
    const c = credential(req);
    let ok = false; try { ok = !!c && !!validate(c, req); } catch (e) { ok = false; }
    if (!ok) { fail(ip); return { local: false, code: 403, priv: true }; }
    return { local: true, priv: true };
  }
  return { mode, on: mode === 'session', check };
}
// 보호 경로 응답 헤더(session 모드). 압축 대상이면 Vary 에 Accept-Encoding 이 이미 있을 수 있어 합친다
function privateHeaders(hd) {
  hd['Cache-Control'] = 'private, no-cache';
  hd.Vary = [hd.Vary, 'Cookie', 'X-NK-Session'].filter(Boolean).join(', ');
  return hd;
}

module.exports = { createGate, isProtected, credential, privateHeaders, COOKIE, HEADER };
