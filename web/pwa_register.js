'use strict';
// PWA 서비스 워커 등록(2026-11-22). 정책 = web/sw.js 머리 주석. 실패해도 게임과 무관(경고만).
//   - 보안 컨텍스트(HTTPS·localhost·127.0.0.1)에서 load 뒤 등록, updateViaCache 'none'(sw.js 는 HTTP 캐시를 건너 매번 서버와 비교).
//   - 새 SW 가 대기하면 NKPwa.update 를 세운다 → pwa_install.js 가 타이틀에 「새 버전」을 보이고, 누르면 apply() = 대기 SW 실행 + 새로 고침.
//   - 점검: 브라우저 기본(화면 이동·24시간) + 30분마다 + 탭이 다시 보일 때(5분 간격 이상).
(function () {
  const P = window.NKPwa = window.NKPwa || { update: false, subs: [] };
  P.emit = () => { for (const f of P.subs) { try { f(); } catch (e) { /* 무시 */ } } };
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  let reg = null, asked = false, last = 0;
  const offer = () => { if (reg && reg.waiting && navigator.serviceWorker.controller) { P.update = true; P.emit(); } };
  P.apply = () => { if (!reg || !reg.waiting) return; asked = true; reg.waiting.postMessage('skip'); };
  const check = () => { if (!reg || Date.now() - last < 5 * 60 * 1000) return; last = Date.now(); reg.update().catch(() => { /* 오프라인 등 */ }); };
  function go() {
    try {
      navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(r => {
        reg = r; last = Date.now(); offer();
        r.addEventListener('updatefound', () => { const w = r.installing; if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') offer(); }); });
        setInterval(check, 30 * 60 * 1000);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
      }).catch(e => console.warn('sw', e));
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (asked) location.reload(); });
    } catch (e) { console.warn('sw', e); }
  }
  if (document.readyState === 'complete') go(); else addEventListener('load', go, { once: true });
})();
