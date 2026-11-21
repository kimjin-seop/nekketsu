'use strict';
// 원격 ROM 파생물 세션(analysis/27 「M0 접근 정책」, 서버 server/asset_gate.js). index.html 에서 맨 먼저 읽는다.
//   서버(NK_REMOTE_ASSETS=session)는 원격 요청의 /rom/ /state/ /ui/ /engine/gen/ 을 HTTPS + 세션(쿠키 nk_sess 또는 헤더 X-NK-Session)일 때만 준다.
//   서버는 Set-Cookie 를 주지 않는다 → 이 파일이 전용 웹소켓으로 손님 hello 를 보내 welcome{sid} 를 받고 document.cookie 로 nk_sess=<sid> 를 세운다.
//   <img>·CSS 배경·워커 fetch 는 헤더를 못 붙이므로 쿠키 방식. 손님 sid 는 소켓이 붙어 있거나 끊긴 뒤 GRACE_MS(20초) 안에만 유효 → 소켓을 페이지 내내 유지한다.
//   - 대상: https: 이고 호스트가 루프백이 아닐 때만(need). 루프백·http(로컬 개발, NK_REMOTE_ASSETS=off)는 아무것도 하지 않는다(whenReady 가 즉시 실행 = 종전과 같은 순서).
//   - 이름: '손님' + 6자리 숫자(서버 hello 규칙 2~8자). 겹치면 새 이름으로 다시. 탭별 sessionStorage 에 {name,sid} → 새로 고침 때 같은 sid 를 되찾는다.
//   - 유지: 4분마다 lobby{on:false}(서버 로비 유휴 10분 방지, 부작용 없음), 15초마다·탭 복귀 때 쿠키를 자기 sid 로 다시 세운다(여러 탭이 쿠키 하나를 나눠 쓰므로).
//   - 실패·끊김: 토스트(한 줄) + 1→2→4→8→10초 간격 재접속. 다시 붙으면 토스트를 지운다. 게임 코어·전투·락스텝·입력과는 아무 연결이 없다.
(function () {
  const LOOP = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/i, KEY = 'nk_asset_sess', COOKIE = 'nk_sess', SID = /^[0-9a-f]{32}$/;
  const need = location.protocol === 'https:' && !LOOP.test(location.hostname);
  let sid = '', name = '', ws = null, ok = false, tries = 0, retryTm = 0, helloTm = 0, renames = 0, toastEl = null;
  const waiters = [], renewers = [];
  const rndName = () => '손님' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  try { const v = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (v && SID.test(v.sid) && typeof v.name === 'string') { sid = v.sid; name = v.name; } } catch (e) { /* 저장소 없음 */ }
  if (!name) name = rndName();
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify({ name, sid })); } catch (e) { /* 저장소 없음 */ } };
  const setCookie = () => { if (SID.test(sid)) document.cookie = COOKIE + '=' + sid + '; Path=/; Secure; SameSite=Strict'; };

  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div'); toastEl.className = 'nkm-toast'; toastEl.setAttribute('role', 'status');
      toastEl.style.cssText = 'position:fixed;left:50%;top:16px;width:auto;max-width:92vw;margin-left:0;--c:#FF5A4E;color:#fff;font:16px/46px Galmuri11,monospace;z-index:2147483000';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text; toastEl.style.transform = 'translateX(-50%)'; toastEl.classList.add('on');
  }
  const hideToast = () => { if (toastEl) { toastEl.classList.remove('on'); toastEl.style.transform = 'translateX(-50%) translateY(-12px)'; } };

  function hello(w) {
    if (!w || w.readyState !== 1) return;
    w.send(JSON.stringify(Object.assign({ t: 'hello', name }, SID.test(sid) ? { sid } : null)));
    clearTimeout(helloTm); helloTm = setTimeout(() => { if (ws === w) try { w.close(); } catch (e) { /* 무시 */ } }, 8000); // 답이 없으면 끊고 다시
  }
  function retry() {
    clearTimeout(retryTm); const d = Math.min(10000, 1000 * (1 << Math.min(tries, 4))); tries++;
    if (tries >= 2 || !ok) toast(ok ? '서버 연결이 끊겼습니다 — 다시 연결하는 중' : '서버에 연결하는 중 — 잠시만 기다려 주세요');
    retryTm = setTimeout(connect, d);
  }
  function connect() {
    clearTimeout(retryTm); retryTm = 0;
    let w; try { w = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); } catch (e) { ws = null; return retry(); }
    w.onopen = () => { if (ws === w) hello(w); };
    w.onmessage = ev => {
      if (ws !== w) return; let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m.t !== 'string') return;
      if (m.t === 'welcome' && SID.test(m.sid || '')) {
        clearTimeout(helloTm); sid = m.sid; if (typeof m.name === 'string' && m.name) name = m.name; renames = 0; tries = 0; save(); setCookie(); hideToast();
        if (!ok) { ok = true; waiters.splice(0).forEach(f => { try { f(); } catch (e) { console.error(e); } }); }
        renewers.splice(0).forEach(f => f(true));
      } else if (m.t === 'err' && /^(name_taken|name_registered|name_bad)$/.test(m.code) && renames++ < 5) { name = rndName(); sid = ''; hello(w); } // 같은 이름 사용 중·가입된 이름 = 새 이름으로
    };
    w.onclose = ev => {
      if (ws !== w) return; ws = null; clearTimeout(helloTm);
      if (ev.code === 4002) { name = rndName(); sid = ''; } // 다른 탭(탭 복제 = 같은 sessionStorage)이 같은 이름·sid 로 붙었다 = 이 탭은 새 손님 세션
      renewers.splice(0).forEach(f => f(false)); retry();
    };
  }

  window.NKSess = {
    need,
    get ok() { return ok; },
    get sid() { return need ? sid : ''; },
    // fn 을 세션 확보 뒤에 실행. 세션이 필요 없으면(로컬) 바로 동기 실행 = 종전 순서 그대로
    whenReady(fn) { if (!need || ok) return fn(); waiters.push(fn); },
    // 보호 경로가 403 일 때: 쿠키를 다시 세우고 같은 sid 로 hello(서버가 모르면 새 sid) → welcome 까지 기다린다. 결과 true = 새로 받음
    renew() {
      if (!need) return Promise.resolve(false);
      setCookie();
      return new Promise(res => { renewers.push(res); if (ws && ws.readyState === 1) hello(ws); else if (!ws) connect(); setTimeout(() => { const i = renewers.indexOf(res); if (i >= 0) { renewers.splice(i, 1); res(false); } }, 10000); });
    },
    toast, hideToast,
  };
  if (!need) return;
  connect();
  setInterval(() => { if (ws && ws.readyState === 1 && ok) ws.send(JSON.stringify({ t: 'lobby', on: false })); }, 240000); // 로비 유휴(서버 LOBBY_IDLE_MS 10분) 방지
  setInterval(setCookie, 15000);
  const back = () => { if (!document.hidden) { setCookie(); if (!ws && ok) connect(); } };
  document.addEventListener('visibilitychange', back); window.addEventListener('focus', back); window.addEventListener('pageshow', back);
})();
