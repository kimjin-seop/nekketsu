'use strict';
// 타격 이펙트 층(표시 전용): 전투(1:2) 중 맞는 순간 맞은 선수 자리에 짧은 도트 이펙트를 얹는다. 엔진·워커·RAM·입력·락스텝·소리·게임 시간과 무관하고 코어 캔버스 픽셀은 손대지 않는다.
// 신호(RAM 읽기만, analysis/10_hitbox_knockback.md): 명중 처리 $85B7 이 래치($04A2 bit4)를 통과한 새 명중에서만 $04BE+X(나를 때린 슬롯)를 쓰고, 매 틱 시작($8546)에 FF 로 지운다.
//   → 프레임별 RAM 에서 $04BE+s 가 FF → 0~3 으로 바뀐 프레임 = 새 명중 1건(다단 히트는 래치가 막아 한 번만). 같은 루틴이 피격음(06 = 기술 플래그 bit5, 07 = 그 외)을 낸다.
//   세기: 공격자 행동(직전 프레임 $049E+Y) 의 기술 플래그($C05A, 고정 뱅크 14) · HP 감소($04C2+s) · 피격 뒤 행동(19 큰 경직 · 1D/1E/5F 날아감 = 강).
//   던져진 사람에 맞음(공격자 행동 0E·36·38·1E·5F) = 임팩트 링. 다운(행동 1B·1C 진입) = 먼지·충격파.
// 위치: 발 기준점 화면 X $0411+s · Y $0421+s, 몸 위 끝 = unit_tags.js 의 메타스프라이트 표(NKTags.parseBoxes). 화면은 RAM 보다 4프레임 늦어(unit_tags.js 측정) 감지 프레임 + 4 가 화면에 보일 때 띄운다.
// 수명은 실시간(약 0.17~0.28초). 설정 NKManga.settings.hitfx(0 끔 · 1 보통), OS 「동작 줄이기」면 흰 섬광 단계를 뺀다.
(function (root) {
  const OX = 88, FIELD = 188, LAG = 4, MAXFX = 8;
  const DOWN = new Set([0x1B, 0x1C, 0x20, 0x21]), DOWN_HIT = new Set([0x20, 0x21, 0x41, 0x2E]);
  const THROWN = new Set([0x0E, 0x36, 0x38, 0x1E, 0x5F]);                 // 공격자가 던져졌거나 날아가는 사람(10 문서 4절 (A)·분류 0)
  const SPECIAL = new Set([0x43, 0x4A, 0x4B, 0x4F, 0x51, 0x53, 0x54, 0x55, 0x56, 0x57, 0x5E, 0x62, 0x69, 0x6A]); // 필살기·팀 돌진기(09 문서 6절)
  const STRONG_REQ = new Set([0x19, 0x1D, 0x1E, 0x5F, 0x51, 0x52, 0x63, 0x64]); // 큰 경직·날아감·돌진기 피격
  const NOREACT = new Set([0x0D, 0x1F, 0x35, 0x4F, 0x50]);               // 피격 분류 6(무반응)
  const LIFE = { weak: 170, guard: 120, strong: 240, ring: 220, dust: 280 };
  const W = '#ffffff', Y = '#ffe14d', O = '#ff9a2e', D = '#ff6a1f', C = '#f3e6c4', G = '#cdb890';
  const inFight = m => m[0x641] === 1 && (m[0x642] & 0x7F) === 2;
  function flagsOf(rom) { const u8 = rom instanceof Uint8Array ? rom : new Uint8Array(rom), a = 16 + 0x1C000 + 0x5A; return u8.slice(a, a + 109); } // $C05A(뱅크 14)
  // 직전 프레임 RAM p → 이번 프레임 RAM m 의 이벤트. DOM 없음(Node 검증용). [{ s, a, kind, dmg, dir }]
  function detect(p, m, FL, any) { // any = 전투(1:2) 밖도 본다(web/impact_fx.js 타이틀 대련 3:5)
    const out = [];
    if (!any && (!inFight(p) || !inFight(m))) return out;
    for (let s = 0; s < 4; s++) {
      const y = m[0x4BE + s], vPrev = p[0x49E + s] & 0x7F, vNow = m[0x49E + s] & 0x7F;
      if (p[0x4BE + s] === 0xFF && y < 4 && y !== s) {
        const aAct = p[0x49E + y] & 0x7F, fl = FL[aAct] | 0, dmg = p[0x4C2 + s] - m[0x4C2 + s], dir = m[0x411 + s] >= m[0x411 + y] ? 1 : -1;
        let kind = null;
        if (THROWN.has(aAct)) kind = 'ring';
        else if (fl & 8 && !SPECIAL.has(aAct)) kind = null;              // 던져진 쪽에 남는 맞은 상대 기록(10 문서 (A) $04BE[Y]=X) — 공격 판정이 없는 행동
        else if (NOREACT.has(vPrev) && dmg <= 0) kind = null;
        else if ((vPrev === 0x47 || vPrev === 0x48) && (vNow === 0x47 || vNow === 0x48)) kind = 'guard';
        else if (DOWN.has(vPrev) || DOWN_HIT.has(vNow)) kind = 'weak';        // 다운 중 피격(데미지 1 고정)
        else if (fl & 0x20 || (fl & 3) === 3 || dmg >= 6 || (SPECIAL.has(aAct) && dmg >= 3) || (STRONG_REQ.has(vNow) && !(vNow === 0x19 && (aAct === 0x4A || aAct === 0x4B)))) kind = 'strong'; // 4A·4B 는 맞힐 때마다 큰 경직(다단) → 약
        else kind = 'weak';
        if (kind) out.push({ s, a: y, kind, dmg, dir });
      } else if (m[0x4C2 + s] < p[0x4C2 + s] && y === 0xFF) { // 명중 처리 밖의 데미지(올라타기 연타 2D→2E · 던져져 떨어짐 36·38 등): HP 감소만으로
        const dmg = p[0x4C2 + s] - m[0x4C2 + s];
        out.push({ s, a: -1, kind: vNow === 0x36 || vNow === 0x38 ? 'ring' : dmg >= 6 ? 'strong' : 'weak', dmg, dir: 0 });
      }
      if ((vNow === 0x1B || vNow === 0x1C) && !DOWN.has(vPrev)) out.push({ s, a: -1, kind: 'dust', dmg: 0, dir: 0 });
    }
    return out;
  }
  // 슬롯 s 의 화면 자리: { x(발), y(발), top(몸 위 끝) } (코어 화면 좌표)
  function pos(boxes, m, s) {
    let y = m[0x421 + s]; if (y > 200) y -= 256;
    const x = m[0x411 + s], f = m[0x5B + s], cat = m[0x401 + s], b = boxes && cat < boxes.length && (f & 0x7F) !== 0x7F ? boxes[cat][f & 0x7F] : null;
    if (!b) return { x, y, top: y - 28 };
    const cx = !(f & 0x80) ? -(b[0] + b[1]) / 2 : (b[0] + b[1]) / 2;
    return { x: x + cx, y, top: y + b[2] + 1 };
  }
  // 이펙트 한 장(나이 t ms) → 칸 목록 [x, y, w, h, 색, 알파] (이펙트 중심 기준 코어 픽셀). 칸 수 ≤ 50, 움직이는 조각 ≤ 12
  const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  function cells(fx, t, calm) {
    const L = LIFE[fx.kind], ph = t / L, o = [];
    if (ph >= 1) return o;
    const R = (x, y, w, h, c, a) => o.push([x, y, w, h, c, a === undefined ? 1 : a]);
    const arms = (r0, r1, c, a) => { const n = r1 - r0 + 1; R(0, -r1, 1, n, c, a); R(0, r0, 1, n, c, a); R(-r1, 0, n, 1, c, a); R(r0, 0, n, 1, c, a); };
    const diag = (r, c, a) => { R(r, r, 1, 1, c, a); R(-r, r, 1, 1, c, a); R(r, -r, 1, 1, c, a); R(-r, -r, 1, 1, c, a); };
    if (fx.kind === 'weak' || fx.kind === 'guard') { // 작은 4방향 별 + 흰 섬광
      let k = Math.floor(ph * 4); if (calm && k === 0) k = 1;
      const g = fx.kind === 'guard';
      if (k === 0) { R(-1, -1, 3, 3, W); arms(2, 3, W); }
      else if (k === 1) { R(0, 0, 1, 1, W); arms(2, g ? 4 : 5, g ? W : Y); diag(3, W); }
      else if (k === 2) { arms(4, g ? 5 : 6, g ? Y : O); if (!g) diag(4, Y); }
      else { arms(6, 7, O, 0.6); if (!g) diag(5, O, 0.5); }
    } else if (fx.kind === 'strong') { // 큰 스타버스트: 흰 마름모 + 8방향 방사선(날아가는 쪽이 3픽셀 길다)
      let k = Math.floor(ph * 6); if (calm && k === 0) k = 1;
      const core = r => { for (let dy = -r; dy <= r; dy++) { const w = r - Math.abs(dy); R(-w, dy, 2 * w + 1, 1, W); } };
      const SEG = [[5, 7, W, 1], [4, 9, Y, 1], [6, 12, Y, 1], [9, 14, O, 1], [13, 14, O, 0.7], [15, 15, D, 0.4]][k];
      if (k === 0) core(4); else if (k === 1) core(3); else if (k === 2) R(0, 0, 1, 1, W);
      for (const [dx, dy] of D8) {
        const far = dx === fx.dir ? 3 : 0, q = dx && dy ? 0.72 : 1;
        for (let i = SEG[0] + far; i <= SEG[1] + far; i++) R(Math.round(dx * i * q), Math.round(dy * i * q), 1, 1, SEG[2], SEG[3]);
      }
    } else if (fx.kind === 'ring') { // 임팩트 링 + 처음엔 작은 스파크
      const r = 3 + 11 * Math.pow(ph, 0.7), c = ph < 0.25 ? W : ph < 0.6 ? Y : O, a = ph < 0.6 ? 1 : 1 - (ph - 0.6) / 0.4 * 0.7;
      for (let i = 0; i < 16; i++) { const an = i * Math.PI / 8; R(Math.round(Math.cos(an) * r), Math.round(Math.sin(an) * r), 1, 1, c, a); if (ph < 0.4) R(Math.round(Math.cos(an) * (r - 1)), Math.round(Math.sin(an) * (r - 1)), 1, 1, c, a); }
      if (ph < 0.35 && !(calm && ph < 0.15)) { R(-1, -1, 3, 3, W); arms(2, 3, Y); }
    } else if (fx.kind === 'dust') { // 바닥 충격파(납작한 고리) + 먼지 4덩이
      const rx = 4 + 14 * ph, a = 1 - ph;
      for (let i = 0; i < 10; i++) { const an = i * Math.PI / 5; R(Math.round(Math.cos(an) * rx), Math.round(Math.sin(an) * rx * 0.25), 1, 1, ph < 0.3 ? W : C, a); }
      const sz = ph < 0.3 ? 3 : ph < 0.7 ? 2 : 1, c = ph < 0.5 ? C : G;
      for (let i = 0; i < 4; i++) { const sx = i & 1 ? 1 : -1, dx = sx * (3 + 12 * ph) * (i < 2 ? 1 : 0.6), dy = -1 - 3 * ph * (i < 2 ? 0.5 : 1); R(Math.round(dx - sz / 2), Math.round(dy - sz / 2), sz, sz, c, a); }
    }
    return o;
  }

  let cv = null, ov = null, ctx = null, FL = null, romU8 = null, boxes = null, err = null, shown = false, raf = 0, calmQ = null;
  let prev = null; const pend = [], live = [];
  const st = { frames: 0, events: { weak: 0, guard: 0, strong: 0, ring: 0, dust: 0 }, spawned: 0, draws: 0, ms: [], msMax: 0, log: [], last: null };
  function hide() { if (shown && ov) { ov.style.display = 'none'; shown = false; } }
  function place() { // 덮개 = 코어 필드 자리(unit_tags.js·hd_layer.js 와 같은 식). 반환: 코어 1픽셀의 디바이스 픽셀 수
    const r = root.NKCam ? root.NKCam.rect(cv) : cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, s = r.width / 432; // 변환 전 배치 rect(카메라 줌 web/cam_fx.js)
    const L = Math.round((r.left + OX * s) * dpr), T = Math.round(r.top * dpr), Wd = Math.round(256 * s * dpr), H = Math.round(FIELD * s * dpr);
    if (ov.width !== Wd || ov.height !== H) { ov.width = Wd; ov.height = H; } else ctx.clearRect(0, 0, Wd, H);
    const os = ov.style, sl = L / dpr + 'px', stp = T / dpr + 'px', sw = Wd / dpr + 'px', sh = H / dpr + 'px';
    if (os.left !== sl) os.left = sl; if (os.top !== stp) os.top = stp; if (os.width !== sw) os.width = sw; if (os.height !== sh) os.height = sh;
    return Wd / 256;
  }
  const fxLv = () => { const M = root.NKManga, s = M && M.settings; return s && Number.isInteger(s.fxlv) ? s.fxlv : 2; }; // 0 끔 · 1 약 · 2 보통 · 3 강(없으면 보통)
  const enabled = () => { const M = root.NKManga; if (!M) return false; const s = M.settings; return !!s && s.hitfx !== 0 && !(M.active && !M.overlay) && !(root.NKQuality && root.NKQuality.off('fx')); }; // 품질 낮음(web/quality.js) = 그리기 없음
  function tick() {
    raf = requestAnimationFrame(tick);
    try { draw(); } catch (e) { err = String(e && e.message || e); cancelAnimationFrame(raf); live.length = 0; hide(); console.error('타격 이펙트 층 오류(끔): ' + err); }
  }
  function draw() {
    const now = performance.now(), cf = prev ? prev.f : -1, fight = !!prev && inFight(prev.m), on = fight && enabled();
    while (pend.length && pend[0].f <= cf - LAG) { const e = pend.shift(); if (on) { live.push(Object.assign(e, { t0: now })); if (live.length > MAXFX) live.shift(); st.spawned++; } }
    if (!on) { live.length = 0; return hide(); }
    for (let i = live.length - 1; i >= 0; i--) if (now - live[i].t0 >= LIFE[live[i].kind]) live.splice(i, 1);
    if (!live.length) return hide();
    const t0 = performance.now(), S = place(), calm = !!(calmQ && calmQ.matches);
    const lv = fxLv(), z = lv === 1 ? 0.8 : lv === 3 ? 1.35 : 1, ka = lv === 1 ? 0.55 : 1, R = v => z === 1 ? v : Math.round(v * z), Rs = v => z === 1 ? v : Math.max(1, Math.round(v * z)); // 이펙트 강도(설정 fxlv, 15 문서 21절): 약 = 작고 옅게, 보통 = 종전 그대로, 강 = 크게
    let n = 0;
    for (const e of live) {
      const list = cells(e, now - e.t0, calm), bx = Math.round(e.x), by = Math.round(e.y);
      for (const c of list) {
        const x = (bx + R(c[0])) * S, y = (by + R(c[1])) * S; if (y < 0 || y >= ov.height || x < 0 || x >= ov.width) continue;
        ctx.globalAlpha = c[5] * ka; ctx.fillStyle = c[4]; ctx.fillRect(x, y, Rs(c[2]) * S, Rs(c[3]) * S); n++;
      }
    }
    ctx.globalAlpha = 1;
    if (!shown) { ov.style.display = ''; shown = true; }
    const dt = performance.now() - t0; st.draws++; if (dt > st.msMax) st.msMax = dt; st.ms.push(dt); if (st.ms.length > 600) st.ms.shift();
    st.last = { f: cf, S, live: live.map(e => ({ kind: e.kind, s: e.s, x: e.x, y: e.y, age: Math.round(now - e.t0) })), cells: n };
  }
  const api = {
    flagsOf, detect, pos, cells, LIFE, LAG, SPECIAL, get boxes() { return boxes; }, get FL() { return FL; }, get rom() { return romU8; }, get stats() { return st; }, get error() { return err; }, get shown() { return shown; }, get ready() { return !!FL; },
    init(o) { // o = { canvas(#c), rom(ROM 전체) }. 실패하면 층만 끈다(게임은 그대로)
      try {
        cv = o.canvas; romU8 = o.rom; FL = flagsOf(o.rom);
        ov = document.createElement('canvas'); ov.id = 'nk-hitfx'; ov.style.cssText = 'position:absolute;display:none;pointer-events:none;image-rendering:pixelated';
        cv.parentNode.appendChild(ov); ctx = ov.getContext('2d');
        calmQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
        raf = requestAnimationFrame(tick);
      } catch (e) { err = String(e && e.message || e); FL = null; console.warn('타격 이펙트 층 준비 실패(끔): ' + err); }
    },
    frame(f, m) { // game.js: 워커 프레임마다(로컬·온라인 공통). m 은 그 프레임 RAM 사본(읽기만)
      if (!FL) return; st.frames++;
      const pm = prev && prev.f === f - 1 ? prev.m : null; let ev = null;
      if (pm) {
        ev = detect(prev.m, m, FL);
        if (ev.length) {
          if (!boxes && root.NKTags && root.NKTags.parseBoxes) try { boxes = root.NKTags.parseBoxes(romU8); } catch (x) { boxes = []; } // 몸 위 끝 표(unit_tags.js 와 같은 표). 없으면 발 위 28픽셀
          for (const e of ev) {
            st.events[e.kind]++;
            const p = pos(boxes, m, e.s), hy = e.kind === 'dust' ? p.y : Math.round(p.top + (p.y - p.top) * 0.4);
            const x = e.kind === 'dust' ? p.x : p.x - e.dir * 2; // 맞은 자리 = 몸 위쪽 40%, 공격자 쪽으로 2픽셀
            e.x = x; e.y = hy; // 구독자(아래 NKFxSubs)에게 같은 자리
            pend.push({ f, s: e.s, kind: e.kind, dir: e.dir, x, y: hy }); if (pend.length > 16) pend.shift();
            st.log.push({ f, s: e.s, a: e.a, kind: e.kind, dmg: e.dmg, x: Math.round(x), y: hy }); if (st.log.length > 400) st.log.shift();
          }
        }
      } else pend.length = 0;
      prev = { f, m };
      // 전투 연출 구독자(web/dmg_fx.js · combo_fx.js · cam_triggers.js): (f, 이번 RAM, 직전 RAM 또는 null, 이번 이벤트 또는 null). 읽기만, 오류 난 구독자는 뺀다
      const S = root.NKFxSubs; if (S) for (let i = S.length - 1; i >= 0; i--) try { S[i](f, m, pm, ev); } catch (x) { console.warn('전투 연출 구독자 오류(끔): ' + (x && x.message || x)); S.splice(i, 1); }
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NKHitFx = api;
})(typeof self !== 'undefined' ? self : this);
