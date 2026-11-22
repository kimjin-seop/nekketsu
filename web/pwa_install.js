'use strict';
// PWA 설치·새 버전 링크(2026-11-22). 타이틀 화면(#nkm .nkm-title) 오른쪽 위 작은 글자 링크 하나. ui_manga.js 는 고치지 않고 DOM 만 붙인다(타이틀이 꺼지면 같이 숨는다).
//   「앱 설치」 = beforeinstallprompt 를 받았을 때(안드로이드·데스크톱 Chrome/Edge). 이미 앱 창·appinstalled·설치 창을 닫은 뒤 30일 = 숨김.
//   iOS Safari(자동 설치 창 없음) = 같은 링크, 누르면 한 줄 안내 토스트. 그 밖의 미지원 브라우저 = 숨김.
//   「새 버전」 = pwa_register.js 가 대기 중인 새 서비스 워커를 찾았을 때(설치 링크보다 우선). 누르면 적용 + 새로 고침.
(function () {
  const P = window.NKPwa = window.NKPwa || { update: false, subs: [] };
  const KEY = 'nk.pwaDismiss', DAY30 = 30 * 864e5;
  let deferred = null, link = null;
  const standalone = () => ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'].some(m => matchMedia('(display-mode: ' + m + ')').matches) || navigator.standalone === true;
  const dismissed = () => { try { return Date.now() - Number(localStorage.getItem(KEY) || 0) < DAY30; } catch (e) { return false; } };
  const dismiss = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) { /* 저장소 없음 */ } };
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const mode = () => P.update ? 'update' : standalone() || dismissed() ? '' : deferred ? 'install' : ios ? 'ios' : '';

  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; paint(); });
  addEventListener('appinstalled', () => { deferred = null; paint(); });
  (P.subs = P.subs || []).push(() => paint());

  function paint() {
    if (!link) return;
    const m = mode();
    link.hidden = !m;
    link.firstChild.textContent = m === 'update' ? '새 버전' : '앱 설치';
  }
  async function tap(e) {
    e.preventDefault(); e.stopPropagation();
    const m = mode();
    if (m === 'update') return P.apply && P.apply();
    if (m === 'install') {
      const d = deferred; deferred = null; paint();
      try { await d.prompt(); const r = await d.userChoice; if (!r || r.outcome !== 'accepted') dismiss(); } catch (er) { /* 무시 */ }
      return paint();
    }
    if (m === 'ios') { const M = window.NKManga; if (M && M.toast) M.toast('공유 → 홈 화면에 추가', 'te', 4000); dismiss(); paint(); }
  }
  function mount() {
    const t = document.querySelector('#nkm .nkm-title');
    if (!t) return false;
    const st = document.createElement('style');
    st.textContent = '.nkm-pwa{position:absolute;right:24px;top:16px;min-width:48px;min-height:max(48px,calc(46px / var(--tk,1)));display:flex;justify-content:center;align-items:flex-start;padding:4px 8px 0;box-sizing:border-box;cursor:pointer;z-index:3;-webkit-tap-highlight-color:transparent}'
      + '.nkm-pwa[hidden]{display:none}'
      + '.nkm-pwa span{font:400 calc(max(20px,calc(12px / var(--tk,1))) * var(--nkfs,1))/1.2 Galmuri11,monospace;color:#fff;text-shadow:2px 2px 0 #20002E,0 0 4px rgba(0,0,0,.7);text-decoration:underline dotted 2px;text-underline-offset:5px;white-space:nowrap}'
      + '.nkm-pwa:hover span{color:var(--focus,#ffe14d);text-decoration-style:solid}';
    document.head.appendChild(st);
    link = document.createElement('div'); link.className = 'nkm-pwa'; link.setAttribute('role', 'button'); link.dataset.id = 'pwa';
    link.appendChild(document.createElement('span'));
    for (const k of ['pointerdown', 'mousedown', 'touchstart']) link.addEventListener(k, e => e.stopPropagation(), { passive: true });
    link.addEventListener('click', tap);
    t.appendChild(link);
    paint();
    return true;
  }
  let n = 0;
  const tm = setInterval(() => { if (mount() || ++n > 240) clearInterval(tm); }, 500); // 타이틀 층은 game.js 가 자료를 읽은 뒤 만든다(최대 2분 기다림)
})();
