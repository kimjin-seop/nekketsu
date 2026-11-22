'use strict';
// 원격 ROM 파생물 세션(analysis/27 「M0 접근 정책」, 서버 server/asset_gate.js). index.html 에서 맨 먼저 읽는다.
//   서버(NK_REMOTE_ASSETS=session)는 원격 요청의 /rom/ /state/ /ui/ /engine/gen/ 을 HTTPS + 세션(쿠키 nk_sess 또는 헤더 X-NK-Session)일 때만 준다.
//   서버는 Set-Cookie 를 주지 않는다 → 이 파일이 전용 웹소켓으로 손님 hello 를 보내 welcome{sid} 를 받고 document.cookie 로 nk_sess=<sid> 를 세운다.
//   <img>·CSS 배경·워커 fetch 는 헤더를 못 붙이므로 쿠키 방식. 손님 sid 는 소켓이 붙어 있거나 끊긴 뒤 GRACE_MS(20초) 안에만 유효 → 소켓을 페이지 내내 유지한다.
//   - 대상: https: 이고 호스트가 루프백이 아닐 때만(need). 루프백·http(로컬 개발, NK_REMOTE_ASSETS=off)는 아무것도 하지 않는다(whenReady 가 즉시 실행 = 종전과 같은 순서).
//   - 이름: '손님' + 6자리 숫자(서버 hello 규칙 2~8자). 겹치면 새 이름으로 다시. 탭별 sessionStorage 에 {name,sid} → 새로 고침 때 같은 sid 를 되찾는다.
//   - 유지: 4분마다 lobby{on:false}(서버 로비 유휴 10분 방지, 부작용 없음), 15초마다·탭 복귀 때 쿠키를 자기 sid 로 다시 세운다(여러 탭이 쿠키 하나를 나눠 쓰므로).
//   - 실패·끊김: 토스트(한 줄) + 1→2→4→8→10초 간격 재접속. 다시 붙으면 토스트를 지운다. 게임 코어·전투·락스텝·입력과는 아무 연결이 없다.
//   - 소켓 = /ws?k=asset(서버가 온라인 플레이 소켓과 한도를 따로 센다: IP당 32·전체 2000). 한도 초과 = 서버가 4029 로 닫음 → 「접속 인원 초과」 토스트 + 15~25초 뒤 다시.
//     열리지도 못한 실패가 3번 이어지면(HTTP 429·503 등, 브라우저는 이유를 모른다) 「연결할 수 없습니다(접속 인원 초과일 수 있음)」. hello 속도 제한(err rate) = 20초 뒤 다시.
//   - 복귀(M2): 끊긴 뒤 SAFE_MS(15초, 서버 GRACE_MS 20초 안쪽)가 지나면 sid 가 만료됐을 수 있다 → NKSess.ready()·fetch() 는 welcome 까지 보호 경로 요청을 미룬다.
//     403 = renew 뒤 1번 다시(fetch), 보호 경로 <img> 오류 = renew 뒤 주소에 ?nkr= 를 붙여 1번 다시, sid 가 바뀐 welcome = 보호 경로 CSS 배경·깨진 <img> 를 다시 받는다.
(function () {
  const LOOP = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/i, KEY = 'nk_asset_sess', COOKIE = 'nk_sess', SID = /^[0-9a-f]{32}$/, SAFE_MS = 15000;
  const PROT = /^\/+(rom|state|ui|engine\/+gen)\//i, BG = /url\((["']?)(\/(?:rom|state|ui|engine\/gen)\/[^"')?]+)(?:\?[^"')]*)?\1\)/gi;
  const need = location.protocol === 'https:' && !LOOP.test(location.hostname);
  let sid = '', name = '', ws = null, ok = false, tries = 0, retryTm = 0, helloTm = 0, renames = 0, toastEl = null;
  let live = false, lostAt = 0, noOpen = 0, holdUntil = 0, nkr = 0, goodSid = ''; // live = 지금 소켓이 welcome 을 받음, lostAt = 끊긴 시각, noOpen = 열리지 못한 연속 실패, holdUntil = 한도 초과 뒤 다시 붙지 않을 시각
  const waiters = [], renewers = [], readyQ = [];
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
  const FULL = '접속 인원 초과 — 잠시 뒤 자동으로 다시 연결합니다';
  function retry(hold) { // hold = 이만큼(ms) 기다렸다 다시(한도 초과·속도 제한). 없으면 1→2→4→8→10초
    clearTimeout(retryTm); const d = hold || Math.min(10000, 1000 * (1 << Math.min(tries, 4))); tries++;
    if (hold) toast(FULL);
    else if (noOpen >= 3) toast('연결할 수 없습니다(접속 인원 초과일 수 있음) — 자동으로 다시 시도합니다'); // HTTP 429·503·서버 꺼짐은 브라우저가 구분하지 못한다
    else if (tries >= 2 || !ok) toast(ok ? '서버 연결이 끊겼습니다 — 다시 연결하는 중' : '서버에 연결하는 중 — 잠시만 기다려 주세요');
    if (hold) holdUntil = Date.now() + d;
    retryTm = setTimeout(connect, d);
  }
  const stale = () => !live && (!lostAt || Date.now() - lostAt >= SAFE_MS); // 지금 쿠키 sid 가 서버에서 만료됐을 수 있다
  const flushReady = () => readyQ.splice(0).forEach(f => f());
  function refresh() { // sid 가 바뀐 welcome 뒤: 만료 구간에 실패했을 수 있는 보호 경로 CSS 배경·<img> 를 다시 받는다(주소에 ?nkr= 를 붙여 실패 기록을 피한다)
    nkr++;
    for (const el of document.querySelectorAll('[style*="url("]')) { const b = el.style.backgroundImage, nb = b ? b.replace(BG, (s, q, p) => 'url(' + p + '?nkr=' + nkr + ')') : b; if (nb !== b) el.style.backgroundImage = nb; }
    for (const im of document.images) { let u; try { u = new URL(im.src, location.href); } catch (e) { continue; } if (u.origin === location.origin && PROT.test(u.pathname) && im.complete && !im.naturalWidth) { im.dataset.nkr = u.pathname; im.src = u.pathname + '?nkr=' + nkr; } }
  }
  function connect() {
    clearTimeout(retryTm); retryTm = 0;
    let w, opened = false; try { w = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?k=asset'); } catch (e) { ws = null; return retry(); }
    w.onopen = () => { opened = true; noOpen = 0; if (ws === w) hello(w); };
    w.onmessage = ev => {
      if (ws !== w) return; let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m.t !== 'string') return;
      if (m.t === 'welcome' && SID.test(m.sid || '')) {
        const prev = goodSid; goodSid = m.sid; // 앞서 welcome 으로 받은 sid(이름 다시 고르기·4002 로 sid 를 비워도 남는다)
        clearTimeout(helloTm); sid = m.sid; if (typeof m.name === 'string' && m.name) name = m.name; renames = 0; tries = 0; live = true; lostAt = 0; save(); setCookie(); hideToast();
        if (!ok) { ok = true; waiters.splice(0).forEach(f => { try { f(); } catch (e) { console.error(e); } }); }
        else if (prev && prev !== sid) try { refresh(); } catch (e) { /* 다시 받기 실패 = 다음 그리기 때 */ }
        flushReady(); renewers.splice(0).forEach(f => f(true));
      } else if (m.t === 'err' && /^(name_taken|name_registered|name_bad)$/.test(m.code) && renames++ < 5) { name = rndName(); sid = ''; hello(w); } // 같은 이름 사용 중·가입된 이름 = 새 이름으로
      else if (m.t === 'err' && m.code === 'rate') { clearTimeout(helloTm); w.rate = true; try { w.close(); } catch (e) { /* 무시 */ } } // hello 속도 제한 = 끊고 20초 뒤
    };
    w.onclose = ev => {
      if (ws !== w) return; ws = null; clearTimeout(helloTm); if (live) lostAt = Date.now(); live = false;
      if (!opened) noOpen++;
      if (renames >= 5) name = rndName(); renames = 0; // 이름 다시 고르기를 다 쓰고 끊겼으면 새 이름으로 처음부터(고착 방지)
      if (ev.code === 4002) { name = rndName(); sid = ''; } // 다른 탭(탭 복제 = 같은 sessionStorage)이 같은 이름·sid 로 붙었다 = 이 탭은 새 손님 세션
      if (ev.code === 4029) return retry(15000 + Math.floor(Math.random() * 10000)); // 서버 에셋 세션 한도 초과
      retry(w.rate ? 20000 : 0);
    };
  }
  // 보호 경로 요청 전에 기다린다: 로컬·세션 살아 있음·끊긴 지 SAFE_MS 안 = 바로, 그 밖 = welcome 까지(15초 상한, 그 뒤엔 그냥 보낸다 = 403 이면 renew 경로)
  function ready() {
    if (!need || !stale()) return Promise.resolve();
    return new Promise(res => { let done = false; const f = () => { if (!done) { done = true; res(); } }; readyQ.push(f); setTimeout(() => { const i = readyQ.indexOf(f); if (i >= 0) readyQ.splice(i, 1); f(); }, 15000); if (!ws && Date.now() >= holdUntil) connect(); });
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
      return new Promise(res => {
        const first = !renewers.length; renewers.push(res);
        setTimeout(() => { const i = renewers.indexOf(res); if (i >= 0) { renewers.splice(i, 1); res(false); } }, 15000); // 끊겨 있으면 다시 붙어 welcome 이 올 때까지(15초 상한)
        if (!first) return; // 이미 갱신 중 = 같은 welcome 을 기다린다(hello 1번)
        if (ws && ws.readyState === 1) hello(ws); else if (!ws && Date.now() >= holdUntil) connect();
      });
    },
    ready,
    // 보호 경로 지연 fetch 공용 래퍼: 복귀 중이면 welcome 까지 미루고, 403 이면 renew 뒤 1번 다시. 로컬 = fetch 그대로
    fetch(u, o) {
      if (!need) return fetch(u, o);
      return ready().then(() => fetch(u, o)).then(r => r.status !== 403 ? r : window.NKSess.renew().then(() => fetch(u, o)));
    },
    toast, hideToast,
    get stats() { return { live, lostAt, noOpen, holdUntil, nkr, tries }; },
  };
  if (!need) return;
  connect();
  setInterval(() => { if (ws && ws.readyState === 1 && ok) ws.send(JSON.stringify({ t: 'lobby', on: false })); }, 240000); // 로비 유휴(서버 LOBBY_IDLE_MS 10분) 방지
  setInterval(setCookie, 15000);
  const back = () => { if (!document.hidden) { setCookie(); if (!ws && ok && Date.now() >= holdUntil) connect(); } }; // 복귀 = 바로 다시 붙는다(한도 초과 대기 중이면 그 타이머대로)
  document.addEventListener('visibilitychange', back); window.addEventListener('focus', back); window.addEventListener('pageshow', back);
  // 보호 경로 <img> 가 실패하면(만료 구간 403): renew 뒤 ?nkr= 를 붙여 1번 다시. 같은 주소는 한 번만(무한 반복 방지)
  document.addEventListener('error', ev => {
    const im = ev.target; if (!im || im.tagName !== 'IMG') return;
    let u; try { u = new URL(im.src, location.href); } catch (e) { return; }
    if (u.origin !== location.origin || !PROT.test(u.pathname) || im.dataset.nkr === u.pathname) return;
    im.dataset.nkr = u.pathname; const want = im.src;
    window.NKSess.renew().then(() => { if (im.src === want) { nkr++; im.src = u.pathname + '?nkr=' + nkr; } });
  }, true);
})();
