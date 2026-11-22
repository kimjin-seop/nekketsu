'use strict';
// 카메라 줌 트리거 Z2(analysis/27 Z절, 표시 전용). web/cam_fx.js(Z1)의 NKCam.zoomTo·reset 만 부른다. 엔진·워커·RAM·입력·락스텝·소리와 무관하다.
// 신호(RAM 읽기만, web/hit_fx.js 구독자 NKFxSubs): KO(체력 >0 → 0) · 필살 시작(dmg_fx.js marks) · 강타(hit_fx 이벤트 strong·ring). 화면이 RAM 보다 4프레임 늦어 감지 + 4 프레임에 건다.
//   우선순위 KO 3 > 필살 2 > 강타 1(높은 줌이 걸려 있는 동안 낮은 것은 무시). 배율은 요청값이고 설정 단계 상한은 NKCam 이 건다(약 = 확대분 절반·최대 1.15, 보통 = 최대 1.6).
//   KO = 1.3배(판이 끝나는 KO 1.45배·길게), 필살 = 사람 공격자 쪽 1.3배(CPU 필살은 잦아 줌 없음), 강타 = 미세 1.04배(약 = 1.02). 전투 밖·메뉴 덮개가 되면 바로 돌아온다.
// 슬로우(판이 끝나는 KO, 오프라인만): game.js spd() 가 NKCamTrig.speed(배속) 을 부른다 → 약 1초 동안 배속을 1배까지 낮춘다(1배 아래로는 내리지 않는다:
//   worker.js(엔진 불변 목록)의 소리 시계가 1배 미만을 1배로 다뤄 소리가 끊기기 때문. 설정 배속 1 이면 슬로우 없음). 엔진 RAM·패드열은 그대로(허가 시점만 바뀜).
// 온라인(__game.online): 슬로우 없음, 줌은 NKCam 이 약 이하로 제한. 히트스톱(표시 프레임 정지) 없음. 설정 cam 0 · 동작 줄이기 · 클래식 = NKCam.level 0 → 아무것도 하지 않는다(비용 = 프레임당 설정 읽기 1번).
(function (root) {
  const LAG = 4, SLOW_MS = 1000, SLOW_K = 0.6;
  const ZO = { // [배율, 들어가는 ms, 머무는 ms, 돌아오는 ms, 우선순위, 같은 종류 최소 간격 ms]
    kof: [1.45, 160, 900, 420, 3, 0], ko: [1.3, 140, 420, 300, 3, 0], sp: [1.3, 150, 380, 260, 2, 2500], hit: [1.04, 50, 50, 130, 1, 300] };
  const inFight = m => m[0x641] === 1 && (m[0x642] & 0x7F) === 2;
  const online = () => { const g = root.__game; try { return !!(g && g.online); } catch (e) { return false; } };
  const level = () => root.NKCam ? root.NKCam.level : 0;
  const pend = [], lastAt = {};
  let cur = 0, until = 0, tm = 0, slowUntil = 0, err = null;
  const st = { zooms: 0, ko: 0, kof: 0, sp: 0, hit: 0, slows: 0, slowApplied: 0, resets: 0, last: null, log: [] };
  const show = k => { const f = api.onShow; if (f) try { f(k); } catch (e) { /* 점검 도구 훅 */ } };
  function back(ms) { clearTimeout(tm); tm = 0; if (cur) { cur = 0; st.resets++; if (root.NKCam) root.NKCam.reset(ms); } }
  function fire(e) {
    const z = ZO[e.k], now = performance.now();
    if (cur > z[4] && now < until) return;
    if (z[5] && now - (lastAt[e.k] || -1e9) < z[5]) return;
    if (!root.NKCam.zoomTo({ scale: z[0], cx: e.x, cy: e.y, ms: z[1], ease: 'out' })) return;
    lastAt[e.k] = now; cur = z[4]; until = now + z[1] + z[2]; st.zooms++; st[e.k]++;
    st.last = { k: e.k, f: e.f, s: e.s, act: e.act, x: Math.round(e.x), y: Math.round(e.y), scale: z[0] }; st.log.push(st.last); if (st.log.length > 100) st.log.shift();
    clearTimeout(tm); tm = setTimeout(() => { tm = 0; cur = 0; st.resets++; root.NKCam.reset(z[3]); }, z[1] + z[2]);
    if (e.k === 'kof' && !online()) { slowUntil = now + SLOW_MS; st.slows++; }
    show(e.k);
  }
  function sub(f, m, p, ev) {
    if (err) return;
    if (!level()) { if (pend.length) pend.length = 0; if (cur) back(0); slowUntil = 0; return; }
    const M = root.NKManga;
    if (m[0x641] !== 1 || (M && M.active && !M.overlay)) { pend.length = 0; if (cur) back(200); return; } // 1:5(승패 연출)까지는 KO 줌·남은 대기열을 이어 두고, 모드가 바뀌거나 덮개가 뜨면 돌아온다
    if (p && inFight(p) && inFight(m)) {
      const D = root.NKDmgFx, H = root.NKHitFx;
      if (D) for (const k of D.marks(p, m)) { if (k.t === 'sp' && !k.hu) continue; /* 필살 줌 = 사람의 필살만(CPU 필살은 잦아서 dmg_fx 집중선만) */ const q = H ? H.pos(H.boxes, m, k.s) : { x: m[0x411 + k.s], y: m[0x421 + k.s], top: m[0x421 + k.s] - 28 }; pend.push({ f, k: k.t === 'ko' ? (k.final ? 'kof' : 'ko') : 'sp', s: k.s, act: k.act, x: q.x, y: q.top + (q.y - q.top) * 0.5 }); }
      if (ev) for (const e of ev) if ((e.kind === 'strong' || e.kind === 'ring') && e.x !== undefined) pend.push({ f, k: 'hit', x: e.x, y: e.y });
      if (pend.length > 16) pend.splice(0, pend.length - 16);
    }
    let best = null;
    while (pend.length && pend[0].f <= f - LAG) { const e = pend.shift(); if (!best || ZO[e.k][4] > ZO[best.k][4]) best = e; } // 같은 프레임에 여럿이면 우선순위 높은 것 하나
    if (best) try { fire(best); } catch (x) { err = String(x && x.message || x); back(0); console.warn('카메라 트리거 오류(끔): ' + err); }
  }
  // game.js spd(): 로컬 시합 진행(1:2) 중 배속 → 슬로우 반영 배속. 온라인·끔·슬로우 아님 = 그대로
  function speed(base) {
    if (!slowUntil) return base;
    if (online() || !level() || performance.now() >= slowUntil) { slowUntil = 0; return base; }
    const v = Math.min(base, Math.max(1, base * SLOW_K)); if (v < base) st.slowApplied++; return v;
  }
  (root.NKFxSubs = root.NKFxSubs || []).push(sub);
  const api = { speed, ZO, onShow: null, get slowing() { return !!slowUntil && performance.now() < slowUntil; }, get stats() { return st; }, get error() { return err; } };
  root.NKCamTrig = api;
})(window);
