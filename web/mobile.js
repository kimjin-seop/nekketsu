'use strict';
// 모바일 배치(M2)·오디오 게이트(M6), analysis/27_mobile_rewards_zoom_tutorial.md M2·M6절. 표시·소리 출력 시작만: 엔진·워커·락스텝·입력 경로 무변경.
//   모바일 = 터치 패드가 켜지는 기기(NKTouch.enabled: 설정 「터치 패드」 켬, 또는 자동 + 굵은 포인터·터치 감지). ?classic=1 은 해당 없음.
//   M2: game.js fit() 이 NKMobile.layout(창 폭, 높이) 를 부른다 → 세이프 에어리어(env(safe-area-inset-*), index.html viewport-fit=cover) 안쪽 영역에서 코어 정수배(디바이스 픽셀),
//       게이지 패널·필드 확대 끔(결정 3: 원작 하단 HUD), 세로 = 코어를 위쪽(≡·전체 화면 버튼 아래)에 두고 아래를 패드 띠로, 가로 = 가운데(양옆 여백 = 패드).
//       모바일 여부가 바뀌면(첫 터치·설정) html.nk-mob 을 바꾸고 resize 를 한 번 내 배치를 다시 잡는다. 회전 시 입력 해제는 touch_pad.js 가 그대로 한다.
//   M6: 터치 기기에서만 AudioContext 생성을 지켜보다가(생성자 Proxy, 같은 네이티브 객체를 그대로 돌려준다) 사용자 활성화 이벤트(touchend·pointerup·click)마다
//       멈춰 있는(suspended·interrupted) 컨텍스트를 resume 한다(iOS 는 touchend 안에서만 풀림, 터치 pointerdown 은 활성화 이벤트가 아님). 소리 경로·출력단·음량은 game.js 그대로
(function () {
  const CLASSIC = /[?&]classic=1(&|$)/.test(location.search), TOP_MIN = 70; // 세로: 코어 위 여백 최소(≡ 48px + 바깥 14px + 틈 8px)
  const on = () => { const T = window.NKTouch; return !CLASSIC && !!T && !!T.enabled; };
  let probe = null;
  function safe() { // env(safe-area-inset-*) px(viewport-fit=cover 일 때만 0 이 아닐 수 있음)
    if (!probe) { probe = document.createElement('div'); probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'; document.body.appendChild(probe); }
    const c = getComputedStyle(probe); return { t: parseFloat(c.paddingTop) || 0, r: parseFloat(c.paddingRight) || 0, b: parseFloat(c.paddingBottom) || 0, l: parseFloat(c.paddingLeft) || 0 };
  }
  function layout(w, h) { // game.js fit(): 모바일이 아니면 null(종전 배치 그대로). x0·y0·aw·ah = 코어를 둘 영역(세이프 에어리어 안), top(보이는 코어 높이 px) = 영역 위에서 코어 위 끝까지
    if (!on()) return null;
    const sa = safe(), aw = Math.max(1, w - sa.l - sa.r), ah = Math.max(1, h - sa.t - sa.b), port = h > w;
    return { x0: sa.l, y0: sa.t, aw, ah, port, top: ch => port ? Math.max(0, Math.min(ah - ch, Math.max(TOP_MIN, Math.round((ah - ch) * 0.3)))) : (ah - ch) / 2 };
  }
  // 모바일 = 게이지 패널 끔(원작 하단 HUD 가 정보): web/ui_manga.js placeHud 가 html.nk-mob 이면 hud.k = 0 으로 띄우지 않는다(종전 임시 CSS 숨김은 2026-11-22 제거)
  let was = null;
  function check() { const v = on(); if (v === was) return; const first = was === null; was = v; document.documentElement.classList.toggle('nk-mob', v); if (!first) window.dispatchEvent(new Event('resize')); }
  check();
  window.addEventListener('touchstart', () => setTimeout(check, 0), { capture: true, passive: true }); // 자동 모드의 첫 터치(touch_pad.js 가 먼저 seen 을 세운다)
  if (window.NKSettings && window.NKSettings.on) window.NKSettings.on(check);

  // ── 오디오 게이트(터치 기기만)
  const ctxs = [];
  if ((navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window) {
    for (const k of ['AudioContext', 'webkitAudioContext']) {
      const A = window[k]; if (typeof A !== 'function') continue;
      try { window[k] = new Proxy(A, { construct(t, a, nt) { const c = Reflect.construct(t, a, nt === window[k] ? t : nt); ctxs.push(c); return c; } }); } catch (e) { /* 감시 없이 종전 그대로 */ }
    }
    const gate = () => {
      for (const c of ctxs) if (c.state === 'suspended' || c.state === 'interrupted') { try { const p = c.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* 다음 활성화 때 다시 */ } }
    };
    for (const ev of ['touchend', 'pointerup', 'click']) window.addEventListener(ev, gate, { capture: true, passive: true });
  }
  window.NKMobile = { layout, safe, check, get on() { return on(); }, get audio() { return ctxs.map(c => c.state); } };
})();
