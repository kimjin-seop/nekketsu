'use strict';
// 전투 연출 U1 콤보 카운터(analysis/26 2-1절, 표시 전용). 엔진·워커·RAM·입력·락스텝·소리와 무관하고 코어 캔버스 픽셀은 손대지 않는다.
// 신호: web/hit_fx.js 구독자(NKFxSubs)로 받는 명중 이벤트(hit_fx.detect: s = 맞은 슬롯, a = 때린 슬롯, kind). 같은 공격자의 명중이 WIN 프레임 안에 이어지면 연속 피격 = 콤보 +1.
//   끊김: WIN 프레임 동안 다음 명중 없음 · 공격자가 맞음 · 공격자 체력 0 · 방어(guard) 당함 · 전투 밖. 공격자를 모르는 체력 감소(a = -1)는 세지 않는다.
//   화면은 RAM 보다 4프레임 늦어 감지 프레임 + 4 에 올린다(hit_fx 와 같은 방식).
// 표시: 2 이상일 때 코어 필드 위쪽 띠(라인 6~30, 원작 하단 HUD 띠·신규 게이지 패널과 겹치지 않음)에 공격자 가로 자리로 「N 콤보」. 사람 = 노랑, CPU = 하늘색. 늘 때 튀어 오르고 끊기면 0.5초 뒤 사라진다.
// 덮개 #nk-combo(dmg_fx.js 의 layer, 카메라 래퍼 안). 그릴 것이 없으면 requestAnimationFrame 도 돌지 않는다. 설정 fxlv 0(hitfx 0) = 끔, 메뉴 덮개 중 숨김.
(function (root) {
  const WIN = 50, LAG = 4, FADE = 520, POP = 110;
  const D = root.NKDmgFx;
  if (!D) { console.warn('콤보 층: dmg_fx.js 없음(끔)'); return; }
  const L = D.layer('nk-combo'), ch = [null, null, null, null], pend = [], vis = [], hist = []; // hist = [프레임, RAM] 최근 8쌍(읽기만, 보관만)
  let raf = 0, err = null;
  const st = { frames: 0, shown: 0, max: 0, draws: 0, msMax: 0, log: [] };
  const human = D.human;
  const show = n => { const f = api.onShow; if (f) try { f(n); } catch (e) { /* 점검 도구 훅 */ } };
  function end(a, f) { if (ch[a]) { pend.push({ f, a, n: 0 }); ch[a] = null; } }
  function sub(f, m, p, ev) {
    if (err) return;
    if (!D.enabled()) { ch.fill(null); pend.length = 0; if (vis.length) { vis.length = 0; L.hide(); } return; }
    st.frames++;
    if (!D.inFight(m)) { for (let a = 0; a < 4; a++) end(a, f); }
    else {
      if (ev) for (const e of ev) {
        if (e.kind === 'dust') continue;
        if (ch[e.s]) end(e.s, f); // 맞은 쪽의 콤보는 끊긴다
        if (e.a < 0) continue;
        if (e.kind === 'guard') { end(e.a, f); continue; }
        const c = ch[e.a];
        if (c && f - c.f <= WIN) { c.n++; c.f = f; } else ch[e.a] = { n: 1, f };
        const n = ch[e.a].n; if (n >= 2) { const H = root.NKHitFx, q = H ? H.pos(H.boxes, m, e.a) : { x: m[0x411 + e.a] }; pend.push({ f, a: e.a, n, x: q.x, hu: human(m, e.a) }); }
      }
      for (let a = 0; a < 4; a++) if (ch[a] && (f - ch[a].f > WIN || m[0x4C2 + a] === 0)) end(a, f);
    }
    if (pend.length > 32) pend.splice(0, pend.length - 32);
    const now = performance.now();
    while (pend.length && pend[0].f <= f - LAG) {
      const e = pend.shift(); let v = vis.find(o => o.a === e.a && !o.endT);
      if (!e.n) { if (v) v.endT = now; continue; }
      if (!v) { v = { a: e.a, n: 0, x: e.x, hu: e.hu, t0: now, endT: 0 }; vis.push(v); if (vis.length > 4) vis.shift(); }
      v.n = e.n; v.x = e.x; v.t0 = now; st.shown++; if (e.n > st.max) st.max = e.n;
      st.log.push({ f: e.f, a: e.a, n: e.n }); if (st.log.length > 200) st.log.shift();
      show(e.n);
      if (e.hu && root.NKAudioFx) try { root.NKAudioFx.combo(e.n); } catch (x) { /* 무음 */ } // 콤보 단계음(사람 공격자만, 표시 2·3·4+ = 단계 1·2·3, web/audio_fx.js)
    }
    hist.push(f, m); if (hist.length > 16) hist.splice(0, 2);
    if (vis.length) { // 이어지는 콤보는 공격자를 따라간다(지금 보이는 프레임 = 최근 RAM − LAG, 화면 가로 밀림 포함)
      let R = m; for (let i = hist.length - 2; i >= 0; i -= 2) { R = hist[i + 1]; if (hist[i] <= f - LAG) break; }
      const H = root.NKHitFx; if (H) for (const v of vis) if (!v.endT && R[0x4C2 + v.a] > 0) v.x = H.pos(H.boxes, R, v.a).x;
      if (!raf) raf = requestAnimationFrame(tick);
    }
  }
  function tick() {
    raf = 0;
    try { draw(); } catch (e) { err = String(e && e.message || e); vis.length = 0; L.hide(); console.warn('콤보 층 오류(끔): ' + err); return; }
    if (vis.length) raf = requestAnimationFrame(tick); else L.hide();
  }
  function draw() {
    const now = performance.now();
    for (let i = vis.length - 1; i >= 0; i--) if (vis[i].endT && now - vis[i].endT >= FADE) vis.splice(i, 1);
    if (!vis.length || !D.enabled()) { vis.length = 0; return; }
    const t0 = performance.now(), S = L.place(); if (!S) return;
    const c = L.ctx, S2 = root.NKSettings, lv = S2 ? S2.get('fxlv') : 2, z = lv === 1 ? 0.85 : lv === 3 ? 1.15 : 1, ka = lv === 1 ? 0.8 : 1, W = L.el.width;
    const rows = []; // 겹침 피하기: 가로 44픽셀 안에 이미 있으면 한 줄 아래
    c.textBaseline = 'alphabetic'; c.lineJoin = 'round';
    for (const v of vis.slice().sort((p, q) => p.x - q.x)) {
      const a = now - v.t0, pop = a < POP ? 1.45 - 0.45 * a / POP : 1, al = v.endT ? Math.max(0, 1 - (now - v.endT) / FADE) : 1;
      let row = 0; while (rows.some(r => r[0] === row && Math.abs(r[1] - v.x) < 44)) row++; rows.push([row, v.x]);
      const nPx = Math.round(13 * z * pop * S), lPx = Math.round(7 * z * S), base = (20 + row * 15) * S;
      c.font = 'bold ' + nPx + 'px NKM9, Galmuri11, monospace'; const nw = c.measureText(String(v.n)).width;
      c.font = lPx + 'px NKM9, Galmuri11, monospace'; const lw = c.measureText('콤보').width, gap = 2 * S, tw = nw + gap + lw;
      const x0 = Math.max(2 * S, Math.min(W - tw - 2 * S, v.x * S - tw / 2));
      c.globalAlpha = al * ka; c.textAlign = 'left';
      c.font = 'bold ' + nPx + 'px NKM9, Galmuri11, monospace'; c.lineWidth = Math.max(2, nPx * 0.2); c.strokeStyle = '#000'; c.strokeText(String(v.n), x0, base); c.fillStyle = v.hu ? '#ffe14d' : '#9fd3ff'; c.fillText(String(v.n), x0, base);
      c.font = lPx + 'px NKM9, Galmuri11, monospace'; c.lineWidth = Math.max(2, lPx * 0.3); c.strokeText('콤보', x0 + nw + gap, base); c.fillStyle = '#fff'; c.fillText('콤보', x0 + nw + gap, base);
    }
    c.globalAlpha = 1; L.show();
    const dt = performance.now() - t0; st.draws++; if (dt > st.msMax) st.msMax = dt;
  }
  (root.NKFxSubs = root.NKFxSubs || []).push(sub);
  const api = { WIN, onShow: null, get stats() { return st; }, get error() { return err; }, get visible() { return vis.map(v => ({ a: v.a, n: v.n, x: v.x, ending: !!v.endT })); } };
  root.NKComboFx = api;
})(window);
