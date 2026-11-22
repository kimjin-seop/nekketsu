'use strict';
// 전투 화면 터치 확대 방지(2026-11-22 사용자 요청 「공격 키를 눌렀는데 그 부분이 확대됨」). 입력·표시 층만: 엔진·락스텝·터치 패드 입력 경로 무변경.
//   잠금 = 원작 화면이 보이고 사람 입력을 받는 동안(__game.touch.show) + 터치 기기일 때만. 메뉴·설정(#nkm 등)은 잠그지 않는다(핀치 확대 유지, 더블탭 확대만 touch-action:manipulation 으로 끔).
//   잠금 중: viewport maximum-scale=1·user-scalable=no(안드로이드 크롬), html.nk-tguard = touch-action:none·글자 선택·길게 누름 메뉴/확대경·탭 강조 끔,
//   iOS 사파리(user-scalable=no 무시) = gesturestart/change/end, 300ms 안 두 번째 touchend, 두 손가락 touchmove, contextmenu·selectstart·dragstart 를 preventDefault.
//   터치 패드 버튼은 pointer 이벤트(touch_pad.js)라 touchend 취소와 무관하다. 클릭이 필요한 요소(아래 UI)는 touchend 를 막지 않는다.
(function () {
  const ST = document.createElement('style');
  ST.textContent = [
    '#stage,#stage canvas{touch-action:manipulation;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none}',
    'html.nk-tguard,html.nk-tguard body,html.nk-tguard #stage,html.nk-tguard #stage canvas{touch-action:none;overscroll-behavior:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none}',
    'html.nk-tguard img,html.nk-tguard canvas{-webkit-user-drag:none}'
  ].join('\n');
  document.head.appendChild(ST);
  const VP = document.querySelector('meta[name="viewport"]');
  const VP0 = VP ? VP.getAttribute('content') || '' : '';
  const VP1 = VP0.replace(/,?\s*(maximum-scale|minimum-scale|user-scalable)\s*=[^,]*/g, '') + ',maximum-scale=1,user-scalable=no';
  let seen = false, locked = false, lastEnd = 0;
  const blocked = { gesture: 0, dbl: 0, pinch: 0, menu: 0, select: 0 };
  const coarse = () => { try { return matchMedia('(hover: none) and (pointer: coarse)').matches; } catch (e) { return false; } };
  const touchy = () => seen || coarse() || (navigator.maxTouchPoints | 0) > 0;
  const G = () => window.__game && window.__game.touch ? window.__game.touch : null;
  const UI = '#nkm, #nktut, #nko-ff, #nko-fq, .nktp-btn.fs, input, textarea, select, a, button, [role="button"]';
  const inUi = t => !!(t && t.closest && t.closest(UI));
  function lock(v) {
    if (v === locked) return;
    locked = v;
    document.documentElement.classList.toggle('nk-tguard', v);
    if (VP && VP0) VP.setAttribute('content', v ? VP1 : VP0);
    if (!v) lastEnd = 0;
  }
  window.addEventListener('touchstart', () => { seen = true; }, { capture: true, passive: true });
  for (const n of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(n, e => { if (locked) { e.preventDefault(); blocked.gesture++; } }, { passive: false });
  }
  document.addEventListener('touchend', e => {
    if (!locked) return;
    const t = performance.now();
    if (t - lastEnd < 300 && e.cancelable && !inUi(e.target)) { e.preventDefault(); blocked.dbl++; }
    lastEnd = t;
  }, { passive: false, capture: true });
  document.addEventListener('touchmove', e => {
    if (locked && e.touches && e.touches.length > 1 && e.cancelable && !inUi(e.target)) { e.preventDefault(); blocked.pinch++; }
  }, { passive: false, capture: true });
  document.addEventListener('contextmenu', e => { if (locked && !inUi(e.target)) { e.preventDefault(); blocked.menu++; } }, true);
  document.addEventListener('selectstart', e => { if (locked && !inUi(e.target)) { e.preventDefault(); blocked.select++; } }, true);
  document.addEventListener('dragstart', e => { if (locked && !inUi(e.target)) e.preventDefault(); }, true);
  function loop() {
    requestAnimationFrame(loop);
    const g = G();
    lock(!!g && !!g.show && touchy());
  }
  requestAnimationFrame(loop);
  window.NKTouchGuard = { get state() { return { on: locked, touchy: touchy(), vp: VP ? VP.getAttribute('content') : '', blocked: Object.assign({}, blocked) }; } };
})();
