'use strict';
// 전투 연출 E2(데미지 숫자)·E3(KO·필살 연출) 층(analysis/26 2-1절·27 Z절, 표시 전용). 엔진·워커·RAM·입력·락스텝·소리·게임 시간과 무관하고 코어 캔버스 픽셀은 손대지 않는다.
// 신호(RAM 읽기만): web/hit_fx.js 가 프레임마다 구독자(NKFxSubs)에게 넘기는 (f, RAM, 직전 RAM, 이벤트). 이벤트 = hit_fx.detect 결과(dmg = $04C2+s 체력 감소, 자리 x·y 포함).
//   데미지 숫자 = dmg > 0 인 이벤트(다운 먼지 제외). KO = 전투 중 체력 >0 → 0 인 슬롯. 필살 = 행동($049E+s)이 hit_fx.SPECIAL(필살기·팀 돌진기, 마하 펀치·킥 제외)에 새로 든 슬롯.
//   화면은 RAM 보다 4프레임 늦어(unit_tags.js 측정) 감지 프레임 + 4 의 RAM 이 올 때 띄운다(hit_fx 와 같은 방식). 글자는 숫자만.
// 덮개: 코어 필드(256x188) 자리 캔버스 #nk-dmgfx(카메라 래퍼 #nk-cam 안 = 줌을 같이 받는다). 처음 띄울 때 만들고, 그릴 것이 없으면 requestAnimationFrame 도 돌지 않는다(끔 = 비용 0).
// 설정: NKSettings fxlv(0 끔 · 1 약 = 작고 옅게 · 2 보통 · 3 강 = 크게), hitfx 0 = 끔. 메뉴 덮개 중 숨김. OS 「동작 줄이기」 = 필드 섬광·집중선 없음(숫자·고리만).
// API: NKDmgFx.marks(직전 RAM, RAM) → [{ t: 'ko' | 'sp', s, final, hu(사람 슬롯) }](DOM 없음, cam_triggers.js 도 쓴다) · stats · layer(id)(combo_fx.js 가 같은 덮개 배치를 쓴다) · onShow(점검 도구용)
(function (root) {
  const OX = 88, FIELD = 188, LAG = 4;
  const inFight = m => m[0x641] === 1 && (m[0x642] & 0x7F) === 2;
  const LIFE = { n: 820, ko: 1150, sp: 340, kofx: 520 };
  const COL = { weak: '#ffffff', guard: '#c8d0e0', strong: '#ffe14d', ring: '#ff9a2e', ko: '#ff5a4a' };
  const MACH = new Set([0x4A, 0x4B, 0x69, 0x6A]); // 마하 펀치·킥(지상·공중): 가진 캐릭터는 보통 A·B 를 대신해 매번 나온다(analysis/29 6·7) → 필살 연출에서 뺀다
  const calmQ = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const fxLv = () => { const S = root.NKSettings, v = S ? S.get('fxlv') : 2; return Number.isInteger(v) ? v : 2; };
  const enabled = () => { const M = root.NKManga, S = root.NKSettings; if (!M || !S) return false; return S.get('hitfx') !== 0 && fxLv() > 0 && !(M.active && !M.overlay); };
  // 전투 표식(DOM 없음): KO·필살 시작. KO = 탈락 확정으로 새로 든 슬롯($04A2+s bit6 · 행동 66/67, tutorial.js 와 같은 식. HP 0 만으로는 탈락이 아니다 — 원작은 HP 0 인 채로 싸우다 다운·착지 때 확정).
  //   final = 그 KO 로 판이 끝나는 쪽(배틀 = 탈락 안 한 선수 1 이하 또는 사람 모두 탈락, 스토리 = 그 팀 둘 다 탈락)
  const isOut = (m, s) => !!(m[0x4A2 + s] & 0x40) || (m[0x49E + s] & 0x7F) === 0x66 || (m[0x49E + s] & 0x7F) === 0x67;
  function marks(p, m) {
    const out = []; if (!p || !inFight(p) || !inFight(m)) return out;
    const SP = root.NKHitFx && root.NKHitFx.SPECIAL, cut = a => SP.has(a) && !MACH.has(a);
    for (let s = 0; s < 4; s++) {
      if (!isOut(p, s) && isOut(m, s)) {
        const v = m[0x645]; let final;
        if (v >= 2) { let alive = 0, hum = 0; const H = Math.min(4, v - 1); for (let k = 0; k < 4; k++) if (!isOut(m, k)) { alive++; if (k < H) hum++; } final = alive <= 1 || hum === 0; }
        else { const t = s & 2; final = isOut(m, t) && isOut(m, t + 1); }
        out.push({ t: 'ko', s, final, hu: human(m, s) });
      } else if (SP && !isOut(m, s) && cut(m[0x49E + s] & 0x7F) && !SP.has(p[0x49E + s] & 0x7F)) out.push({ t: 'sp', s, final: false, hu: human(m, s), act: m[0x49E + s] & 0x7F });
    }
    return out;
  }
  // 사람 슬롯(unit_tags.js style 과 같은 식): 배틀($0645 ≥ 2) = 앞 $0645 − 1 슬롯, 스토리 = $04A2+s bit7 꺼짐
  function human(m, s) { const v = m[0x645]; if (v > 5) return false; return v >= 2 ? s < Math.min(4, v - 1) : !(m[0x4A2 + s] & 0x80); }
  // 코어 필드 자리 덮개(hit_fx.js place 와 같은 식, 카메라 줌 중에는 변환 전 배치 rect)
  function layer(id) {
    let ov = null, ctx = null, shown = false;
    return {
      get ctx() { return ctx; }, get el() { return ov; }, get shown() { return shown; },
      place() { // 반환: 코어 1픽셀의 디바이스 픽셀 수(0 = 캔버스 없음)
        const cv = document.getElementById('c'); if (!cv || !cv.parentNode) return 0;
        if (!ov) { ov = document.createElement('canvas'); ov.id = id; ov.style.cssText = 'position:absolute;display:none;pointer-events:none'; cv.parentNode.appendChild(ov); ctx = ov.getContext('2d'); }
        const r = root.NKCam ? root.NKCam.rect(cv) : cv.getBoundingClientRect(), dpr = root.devicePixelRatio || 1, s = r.width / 432;
        const L = Math.round((r.left + OX * s) * dpr), T = Math.round(r.top * dpr), W = Math.round(256 * s * dpr), H = Math.round(FIELD * s * dpr);
        if (!W || !H) return 0;
        if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; } else ctx.clearRect(0, 0, W, H);
        const os = ov.style, sl = L / dpr + 'px', st = T / dpr + 'px', sw = W / dpr + 'px', sh = H / dpr + 'px';
        if (os.left !== sl) os.left = sl; if (os.top !== st) os.top = st; if (os.width !== sw) os.width = sw; if (os.height !== sh) os.height = sh;
        return W / 256;
      },
      show() { if (!shown && ov) { ov.style.display = ''; shown = true; } },
      hide() { if (shown && ov) { ov.style.display = 'none'; shown = false; } },
    };
  }
  const posOf = (m, s) => { const H = root.NKHitFx; if (!H) return { x: m[0x411 + s], y: m[0x421 + s], top: m[0x421 + s] - 28 }; return H.pos(H.boxes, m, s); };

  // 카메라 X(하위 바이트) = (월드 X $6B+s − 화면 X $0411+s) & FF 의 네 슬롯 최빈값(analysis/06 1절. 실측: 슬롯끼리 같고 가끔 한 슬롯만 틱 차이로 어긋남).
  //   연출은 감지 프레임의 화면 좌표 + 카메라를 기억했다가, 지금 보이는 프레임(최근 RAM − LAG)의 카메라와의 차만큼 옮긴다 → 화면이 가로로 밀려도 월드 자리에 남는다
  function camX(m) { let best = 0, bn = 0; for (let s = 0; s < 4; s++) { const v = (m[0x6B + s] - m[0x411 + s]) & 255; let n = 0; for (let k = 0; k < 4; k++) if (((m[0x6B + k] - m[0x411 + k]) & 255) === v) n++; if (n > bn) { bn = n; best = v; } } return best; }
  const sgn8 = d => ((d & 255) ^ 128) - 128, camH = []; let camNow = 0;
  const shiftOf = cam => sgn8(camNow - cam); // 감지 때 카메라 → 지금 보이는 화면까지 밀린 픽셀
  const L = layer('nk-dmgfx'), pend = [], live = [], spAt = [-99, -99, -99, -99];
  let raf = 0, err = null;
  const st = { frames: 0, spawned: 0, ko: 0, sp: 0, draws: 0, ms: [], msMax: 0, log: [] };
  const show = k => { const f = api.onShow; if (f) try { f(k); } catch (e) { /* 점검 도구 훅 */ } };
  function sub(f, m, p, ev) {
    if (err) return;
    if (!enabled()) { pend.length = 0; if (live.length) { live.length = 0; L.hide(); } return; }
    st.frames++;
    const fight = inFight(m), cam = camX(m);
    camH.push(f, cam); if (camH.length > 16) camH.splice(0, 2);
    for (let i = camH.length - 2; i >= 0; i -= 2) { camNow = camH[i + 1]; if (camH[i] <= f - LAG) break; } // 지금 보이는 프레임의 카메라(없으면 가장 오래된 것)
    if (fight && p && ev) for (const e of ev) {
      if (e.kind === 'dust' || !(e.dmg > 0)) continue;
      pend.push({ f, cam, ty: m[0x4C2 + e.s] === 0 ? 'ko' : 'n', kind: e.kind, s: e.s, dmg: e.dmg, dir: e.dir || 0, x: e.x, y: e.y });
    }
    if (fight && p) for (const k of marks(p, m)) {
      if (k.t === 'sp') { if (f - spAt[k.s] < 40) continue; spAt[k.s] = f; }
      const q = posOf(m, k.s); pend.push({ f, cam, ty: k.t === 'ko' ? 'kofx' : 'sp', s: k.s, final: k.final, x: q.x, y: Math.round(q.top + (q.y - q.top) * 0.5) });
    }
    if (pend.length > 24) pend.splice(0, pend.length - 24);
    const now = performance.now();
    while (pend.length && pend[0].f <= f - LAG) {
      const e = pend.shift(); e.t0 = now;
      if (e.ty === 'n' || e.ty === 'ko') { let k = 0; for (const o of live) if ((o.ty === 'n' || o.ty === 'ko') && o.s === e.s && now - o.t0 < 220) k++; e.stack = k; } // 같은 선수 연속 숫자 = 한 칸씩 위로
      live.push(e); if (live.length > 16) live.shift(); st.spawned++; if (e.ty === 'kofx') st.ko++; if (e.ty === 'sp') st.sp++;
      st.log.push({ f: e.f, ty: e.ty, s: e.s, dmg: e.dmg, x: Math.round(e.x), y: Math.round(e.y) }); if (st.log.length > 200) st.log.shift();
      show(e.ty);
    }
    if (live.length && !raf) raf = requestAnimationFrame(tick);
  }
  function tick() {
    raf = 0;
    try { draw(); } catch (e) { err = String(e && e.message || e); live.length = 0; L.hide(); console.warn('데미지 숫자 층 오류(끔): ' + err); return; }
    if (live.length) raf = requestAnimationFrame(tick); else L.hide();
  }
  const eo = t => 1 - (1 - t) * (1 - t);
  function draw() {
    const now = performance.now();
    for (let i = live.length - 1; i >= 0; i--) if (now - live[i].t0 >= LIFE[live[i].ty]) live.splice(i, 1);
    if (!live.length || !enabled()) { live.length = 0; return; }
    const t0 = performance.now(), S = L.place(); if (!S) return;
    const c = L.ctx, lv = fxLv(), z = lv === 1 ? 0.85 : lv === 3 ? 1.2 : 1, ka = lv === 1 ? 0.75 : 1, calm = !!(calmQ && calmQ.matches), W = L.el.width, H = L.el.height;
    // 1) KO 필드 섬광(가장 아래), 2) 고리·집중선, 3) 숫자(가장 위)
    for (const e of live) if (e.ty === 'kofx' && !calm && lv >= 2) { const a = now - e.t0; if (a < 170) { c.globalAlpha = (e.final ? 0.34 : 0.2) * (1 - a / 170); c.fillStyle = '#fff'; c.fillRect(0, 0, W, H); } }
    c.lineCap = 'round';
    for (const e of live) {
      const a = now - e.t0, ph = a / LIFE[e.ty], X = (e.x - shiftOf(e.cam)) * S, Y = e.y * S;
      if (e.ty === 'kofx') { // 겹고리 + 방사선 12줄
        const r = (6 + 26 * eo(ph)) * S * z;
        c.globalAlpha = ka * (1 - ph); c.strokeStyle = ph < 0.3 ? '#fff' : '#ffe14d'; c.lineWidth = Math.max(1, 2 * S * (1 - ph * 0.6));
        c.beginPath(); c.arc(X, Y, r, 0, Math.PI * 2); c.stroke();
        if (ph < 0.6) { c.globalAlpha = ka * (0.6 - ph); c.beginPath(); c.arc(X, Y, r * 0.6, 0, Math.PI * 2); c.stroke(); }
        c.strokeStyle = '#fff'; c.lineWidth = Math.max(1, S);
        for (let i = 0; i < 12; i++) { const an = i * Math.PI / 6 + 0.26, r0 = r * 0.9, r1 = r * 0.9 + (10 * (1 - ph)) * S * z; c.globalAlpha = ka * (1 - ph) * 0.9; c.beginPath(); c.moveTo(X + Math.cos(an) * r0, Y + Math.sin(an) * r0); c.lineTo(X + Math.cos(an) * r1, Y + Math.sin(an) * r1); c.stroke(); }
      } else if (e.ty === 'sp' && !calm) { // 필살 집중선(바깥에서 선수 쪽으로 좁혀 든다)
        const n = 18, R1 = (46 - 10 * eo(ph)) * S * z, R0 = (20 - 4 * ph) * S * z;
        c.globalAlpha = ka * 0.75 * (1 - ph); c.lineWidth = Math.max(1, S * 0.9);
        for (let i = 0; i < n; i++) { const an = i * 2 * Math.PI / n + (i & 1) * 0.11, r0 = R0 + (i % 3) * 2 * S; c.strokeStyle = i % 3 ? '#fff' : '#ff9a2e'; c.beginPath(); c.moveTo(X + Math.cos(an) * r0, Y + Math.sin(an) * r0); c.lineTo(X + Math.cos(an) * R1, Y + Math.sin(an) * R1); c.stroke(); }
      }
    }
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
    for (const e of live) {
      if (e.ty !== 'n' && e.ty !== 'ko') continue;
      const a = now - e.t0, Lf = LIFE[e.ty], big = e.ty === 'ko' ? 15 : e.kind === 'strong' || e.kind === 'ring' ? 11 : 9;
      const pop = a < 90 ? 1.5 - 0.5 * a / 90 : 1, k = eo(Math.min(1, a / 520)), al = a > Lf - 260 ? Math.max(0, (Lf - a) / 260) : 1;
      const px = Math.max(6, Math.round(big * z * pop * S)), x = Math.max(px, Math.min(W - px, (e.x - shiftOf(e.cam) + e.dir * 5 * k) * S)), y = Math.max(px * 0.6, (e.y - 6 - 9 * e.stack - (e.ty === 'ko' ? 16 : 12) * k) * S);
      c.font = 'bold ' + px + 'px NKM9, Galmuri11, monospace'; const tx = String(e.dmg);
      c.globalAlpha = al * ka; c.lineWidth = Math.max(2, px * 0.22); c.strokeStyle = '#000'; c.strokeText(tx, x, y);
      c.fillStyle = e.ty === 'ko' ? COL.ko : COL[e.kind] || COL.weak; c.fillText(tx, x, y);
    }
    c.globalAlpha = 1; L.show();
    const dt = performance.now() - t0; st.draws++; if (dt > st.msMax) st.msMax = dt; st.ms.push(dt); if (st.ms.length > 600) st.ms.shift();
  }
  (root.NKFxSubs = root.NKFxSubs || []).push(sub);
  const api = { marks, human, camX, layer, LAG, inFight, enabled, onShow: null, get stats() { return st; }, get error() { return err; }, get live() { return live.length; } };
  root.NKDmgFx = api;
})(window);
