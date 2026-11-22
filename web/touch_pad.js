'use strict';
// 터치 가상 패드(M1, analysis/27_mobile_rewards_zoom_tutorial.md M1절). 엔진·락스텝·입력 버퍼·대시 판정 무변경: 터치를 원작 패드 비트로만 바꾼다.
//   경로: game.js 가 kmap 에 터치 전용 가상 키 코드(#tU·#tD·#tL·#tR·#tA·#tB·#tJ·#tS, 1P)를 넣어 두고 __game.touch.key(코드, 켬) 로 키보드와 같은 keyAt()
//   (짧은 탭 보정 KEEP·방향 겹침 정리 cleanDirs·held)으로 받는다 → localPads() → pollPads()/writePads()·온라인 sample·스토리 recGrant 가 키보드와 같은 값을 본다.
//   왼쪽 = 플로팅 스틱(첫 터치 위치에 생김, 8방향), 오른쪽 = A·B·점프(A|B = 3, keymap 점프와 같은 비트), ≡ = 일시정지 메뉴(전투 밖 원작 화면에서는 START).
//   달리기 보조(설정 tdash): 스틱을 끝까지 밀면 원작 대시 판정($B356: 새로 누른 좌/우 + 3틱 창 안에 같은 키 다시 누름)에 맞는 「뗌-누름」 탭을
//   KEEP 간격(키보드로 빠르게 두 번 누른 것과 같은 비트열)으로 만든다. 판정·창 길이는 그대로.
//   멀티터치(스틱+버튼), 취소·회전·탭 숨김·창 포커스 잃음 = 모든 터치 입력 해제. 진동(설정 tvib, Android 만. iOS 는 navigator.vibrate 없음 = 무시).
//   설정 NKSettings.touch 0 자동(굵은 포인터·터치 감지 시) · 1 켬 · 2 끔, tdash · tvib 0/1. 설정 창 = NKTouch.open()(신규 층 설정 「터치 패드」 줄)
(function () {
  const S = window.NKSettings || null;
  const C = { U: '#tU', D: '#tD', L: '#tL', R: '#tR', A: '#tA', B: '#tB', J: '#tJ', S: '#tS' }, ALL = Object.values(C);
  const MODE_T = ['자동', '켬', '끔'];
  const DEAD_IN = 14, DEAD_OUT = 10, EDGE = 0.9, REARM = 0.6, HYST = Math.PI / 22; // 데드존(들어감·나옴), 끝(반지름 비), 달리기 보조 다시 무장, 방향 경계 흔들림 방지(약 8도)
  let seen = false;
  const coarse = () => { try { return matchMedia('(hover: none) and (pointer: coarse)').matches; } catch (e) { return false; } };
  window.addEventListener('touchstart', () => { seen = true; }, { capture: true, passive: true });
  const mode = () => { const v = S ? S.get('touch') : 0; return v === 1 || v === 2 ? v : 0; };
  const enabled = () => { const m = mode(); return m === 1 || (m === 0 && (seen || coarse())); };
  const opt = k => !S || S.get(k) !== 0;
  const G = () => window.__game && window.__game.touch ? window.__game.touch : null;
  const frame = () => window.__game && window.__game.mirror ? window.__game.mirror.frame : 0;
  const buzz = ms => { if (!opt('tvib') || !navigator.vibrate) return; try { navigator.vibrate(ms); } catch (e) { /* 미지원 */ } };

  let root = null, zl = null, zr = null, ring = null, knob = null, hint = null, pz = null, fz = null, btn = {}, shown = false, L = null, layKey = '';
  // 전체 화면(M6): 터치 UI 안의 버튼. 미지원 브라우저(iPhone Safari 등 fullscreenEnabled 없음)는 숨긴다. 사용자 활성화가 필요해 click 에서 부른다(터치 pointerdown 은 활성화 이벤트가 아님)
  const fsOk = () => !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  function fsToggle() {
    try {
      if (fsEl()) { const x = document.exitFullscreen || document.webkitExitFullscreen; if (x) { const p = x.call(document); if (p && p.catch) p.catch(() => {}); } return; }
      const e = document.documentElement, f = e.requestFullscreen || e.webkitRequestFullscreen; if (f) { const p = f.call(e, { navigationUI: 'hide' }); if (p && p.catch) p.catch(() => {}); }
    } catch (er) { /* 거부 = 그대로 */ }
  }
  const ptr = new Map(); // pointerId → { k: 'stick' | 'btn' | 'start' | 'dead', b }
  let stick = null, seq = null, sector = -1; // stick = { id, x0, y0, x, y, on, armed, armH }, seq = { c, st: [켬/끔...] } 달리기 보조 진행
  const sent = {}, pressAt = {};
  const el = (cls, parent, text) => { const e = document.createElement('div'); e.className = cls; if (text !== undefined) e.textContent = text; parent.appendChild(e); return e; };
  function build() {
    const ln = document.createElement('link'); ln.rel = 'stylesheet'; ln.href = 'touch_pad.css'; document.head.appendChild(ln);
    root = document.createElement('div'); root.id = 'nktp'; document.body.appendChild(root);
    zl = el('nktp-z nktp-zl', root); zr = el('nktp-z nktp-zr', root);
    hint = el('nktp-ring hint', root); ring = el('nktp-ring', root); knob = el('nktp-knob', root); ring.style.display = knob.style.display = 'none';
    btn[C.B] = el('nktp-btn', root, 'B'); btn[C.A] = el('nktp-btn', root, 'A'); btn[C.J] = el('nktp-btn', root, '점프');
    pz = el('nktp-btn p', root, '≡');
    fz = el('nktp-btn fs', root); if (!fsOk()) fz.style.display = 'none';
    fz.addEventListener('pointerdown', e => e.stopPropagation()); fz.addEventListener('click', e => { e.stopPropagation(); if (shown) { fsToggle(); buzz(10); } });
    zl.addEventListener('pointerdown', downStick); zr.addEventListener('pointerdown', downBtn); pz.addEventListener('pointerdown', downPause);
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
    root.addEventListener('contextmenu', e => e.preventDefault());
  }
  function safe() { // env(safe-area-inset-*) 읽기(viewport-fit=cover 전에는 0. M2 가 켠다)
    const p = document.createElement('div'); p.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(p); const c = getComputedStyle(p), v = { t: parseFloat(c.paddingTop) || 0, r: parseFloat(c.paddingRight) || 0, b: parseFloat(c.paddingBottom) || 0, l: parseFloat(c.paddingLeft) || 0 }; p.remove(); return v;
  }
  const box = (e, x, y, w, h) => { const s = e.style; s.left = x + 'px'; s.top = y + 'px'; s.width = w + 'px'; s.height = (h === undefined ? w : h) + 'px'; };
  function place() { // 지금 fit() 결과(캔버스 자리) 위에 얹는다: 세로 = 코어 아래 띠, 가로 = 코어 양옆(모자라면 아래 귀퉁이에 반투명으로 겹침)
    const cv = document.getElementById('c'); if (!cv || !root) return;
    const W = innerWidth, H = innerHeight, r = window.NKCam ? window.NKCam.rect(cv) : cv.getBoundingClientRect(), s = r.height / 240 || 1, fh = +cv.dataset.fh || 240;
    const core = { l: r.left + 88 * s, r: r.left + 344 * s, t: r.top, b: r.top + fh * s };
    const k = [W, H, Math.round(core.l), Math.round(core.t), Math.round(core.b)].join(','); if (k === layKey) return; layKey = k;
    const sa = safe(), m = 14; let u = Math.round(Math.max(52, Math.min(84, Math.min(W, H) * 0.15))), R = Math.round(u * 0.78); const below = H - sa.b - core.b;
    const port = below >= u * 2.6, top = port ? Math.ceil(core.b) : Math.round(H * 0.28);
    if (!port) { const side = Math.min(core.l - sa.l, W - core.r - sa.r) - 2 * m; if (side > 0) { u = Math.max(48, Math.min(u, Math.floor(side / 2.3))); R = Math.round(u * 0.78); } } // 가로: 버튼 묶음(폭 약 2.3u)이 코어 옆 여백에 들어가게(모자라면 48px 하한으로 겹침)
    L = { W, H, u, R, port, top, sa, core };
    box(zl, 0, top, Math.floor(W / 2), H - top); box(zr, Math.floor(W / 2), top, W - Math.floor(W / 2), H - top);
    const ax = W - sa.r - m - u / 2, ay = H - sa.b - m - u * 0.95;
    L.btn = { [C.A]: [ax, ay, u / 2], [C.B]: [ax - u * 1.2, ay + u * 0.3, u / 2], [C.J]: [ax - u * 0.62, ay - u * 1.08, u * 0.42] };
    for (const c in L.btn) { const [x, y, rr] = L.btn[c]; box(btn[c], x, y, rr * 2); }
    btn[C.J].style.fontSize = Math.round(u * 0.22) + 'px'; btn[C.A].style.fontSize = btn[C.B].style.fontSize = Math.round(u * 0.32) + 'px';
    const pw = 48; L.p = [W - sa.r - m - pw / 2, Math.max(sa.t + m + pw / 2, port ? Math.min(core.t - pw / 2 - 6, sa.t + m + pw / 2) : sa.t + m + pw / 2)]; box(pz, L.p[0], L.p[1], pw);
    L.f = port ? [L.p[0] - pw - 10, L.p[1]] : [L.p[0], L.p[1] + pw + 10]; box(fz, L.f[0], L.f[1], pw); // 전체 화면: 세로 = ≡ 왼쪽, 가로 = ≡ 아래(코어 옆 여백)
    L.hint = [sa.l + m + R + 6, H - sa.b - m - R - 6]; box(hint, L.hint[0], L.hint[1], R * 2);
    box(ring, 0, 0, R * 2); box(knob, 0, 0, Math.round(R * 0.9));
  }
  function hitBtn(x, y) { // 가장 가까운 버튼(반지름 1.35배 안). 점프는 A·B 사이 위
    let best = null, bd = Infinity;
    for (const c in L.btn) { const [bx, by, rr] = L.btn[c], d = Math.hypot(x - bx, y - by); if (d <= rr * 1.35 && d / rr < bd) { bd = d / rr; best = c; } }
    return best;
  }
  function downStick(e) {
    if (!shown) return; e.preventDefault();
    if (stick) { ptr.set(e.pointerId, { k: 'dead' }); return; }
    const R = L.R, x0 = Math.max(R, Math.min(L.W - R, e.clientX)), y0 = Math.max(L.top + R * 0.5, Math.min(L.H - R, e.clientY));
    stick = { id: e.pointerId, x0, y0, x: e.clientX, y: e.clientY, on: false, armed: true, armH: null }; sector = -1; ptr.set(e.pointerId, { k: 'stick' });
    try { zl.setPointerCapture(e.pointerId); } catch (er) { /* 무시 */ }
    step();
  }
  function downBtn(e) {
    if (!shown) return; e.preventDefault();
    const b = hitBtn(e.clientX, e.clientY); ptr.set(e.pointerId, { k: 'btn', b });
    try { zr.setPointerCapture(e.pointerId); } catch (er) { /* 무시 */ }
    if (b) buzz(10); step();
  }
  function downPause(e) {
    if (!shown) return; e.preventDefault(); e.stopPropagation();
    const g = G(); if (!g || g.online) return;
    if (g.pause()) { buzz(10); ptr.set(e.pointerId, { k: 'dead' }); releaseAll(); return; } // 일시정지 메뉴가 떴다(game.js openPause: 신규 층 전투 1:2)
    if (!g.fight) { ptr.set(e.pointerId, { k: 'start' }); try { pz.setPointerCapture(e.pointerId); } catch (er) { /* 무시 */ } buzz(10); step(); } // 전투 밖 원작 화면 = START(누르는 동안)
  }
  function move(e) {
    const p = ptr.get(e.pointerId); if (!p) return;
    if (p.k === 'stick' && stick && stick.id === e.pointerId) { stick.x = e.clientX; stick.y = e.clientY; step(); }
    else if (p.k === 'btn') { const b = hitBtn(e.clientX, e.clientY); if (b !== p.b) { p.b = b; if (b) buzz(8); step(); } } // 손가락을 밀어 다른 버튼으로
  }
  function up(e) {
    const p = ptr.get(e.pointerId); if (!p) return; ptr.delete(e.pointerId);
    if (p.k === 'stick' && stick && stick.id === e.pointerId) { stick = null; sector = -1; }
    if (e.type === 'pointercancel') return releaseAll(); // 시스템이 터치를 가져감(제스처·알림 등) = 전부 뗀다
    step();
  }
  function want() { // 지금 손가락 → 가상 키 켬/끔
    const w = {}; for (const c of ALL) w[c] = false;
    if (stick) {
      const dx = stick.x - stick.x0, dy = stick.y - stick.y0, d = Math.hypot(dx, dy);
      stick.on = d >= (stick.on ? DEAD_OUT : DEAD_IN); stick.d = d;
      if (stick.on) {
        const a = Math.atan2(-dy, dx), q = Math.PI / 4;
        let sc = ((Math.round(a / q) % 8) + 8) % 8;
        if (sector >= 0) { let df = Math.abs(a - sector * q); df = Math.min(df, 2 * Math.PI - df); if (df <= q / 2 + HYST) sc = sector; } // 경계 흔들림으로 방향이 떴다 붙었다 하지 않게(우연한 더블탭 방지)
        sector = sc; // 0 오른쪽 · 1 오른쪽 위 · 2 위 · 3 왼쪽 위 · 4 왼쪽 · 5 왼쪽 아래 · 6 아래 · 7 오른쪽 아래
        if (sc === 7 || sc === 0 || sc === 1) w[C.R] = true; if (sc >= 3 && sc <= 5) w[C.L] = true; if (sc >= 1 && sc <= 3) w[C.U] = true; if (sc >= 5 && sc <= 7) w[C.D] = true;
      } else sector = -1;
    }
    for (const p of ptr.values()) { if (p.k === 'btn' && p.b) w[p.b] = true; else if (p.k === 'start') w[C.S] = true; }
    return w;
  }
  function send(c, v) { const g = G(); if (!g) return; g.key(c, v); sent[c] = v; if (v) pressAt[c] = frame(); }
  function step() { // 손가락이 바뀔 때 + 화면 주기마다(달리기 보조의 밀린 탭)
    if (!shown || !L) return; const g = G(); if (!g) return;
    const w = want();
    for (const c of ALL) if (!(seq && seq.c === c) && !!sent[c] !== w[c]) send(c, w[c]);
    if (seq) {
      if (!w[seq.c]) seq = null; // 스틱을 놓거나 방향을 바꿨다: 중단(위 동기화가 다음 주기에 맞춘다)
      else if (g.ripe(seq.c)) { send(seq.c, seq.st.shift()); if (!seq.st.length) seq = null; }
    }
    if (stick && opt('tdash')) { // 달리기 보조: 끝까지 민 순간 한 번(다시 안쪽으로 오거나 좌우가 바뀌면 다시 무장)
      const h = w[C.R] ? C.R : w[C.L] ? C.L : null;
      if (!h || stick.d < L.R * REARM || (stick.armH && h !== stick.armH)) { stick.armed = true; stick.armH = null; }
      if (h && stick.armed && stick.d >= L.R * EDGE && !seq && g.fight && sent[h]) {
        stick.armed = false; stick.armH = h;
        seq = { c: h, st: frame() - (pressAt[h] || 0) <= 5 ? [false, true] : [false, true, false, true] }; // 막 누른 방향 = 뗌·누름 한 번, 오래 누르고 있던 방향 = 탭 두 번(원작 3틱 창이 첫 누름부터라서)
        buzz(8);
      }
    }
    render(w);
  }
  function render(w) {
    for (const c in btn) btn[c].classList.toggle('on', !!w[c]);
    const g = G(); pz.classList.toggle('off', !!(g && g.online)); pz.classList.toggle('on', !!w[C.S]);
    if (stick) {
      const R = L.R, dx = stick.x - stick.x0, dy = stick.y - stick.y0, d = Math.hypot(dx, dy), f = d > R ? R / d : 1;
      ring.style.display = knob.style.display = ''; hint.style.display = 'none';
      ring.style.left = stick.x0 + 'px'; ring.style.top = stick.y0 + 'px'; knob.style.left = stick.x0 + dx * f + 'px'; knob.style.top = stick.y0 + dy * f + 'px';
      knob.classList.toggle('edge', d >= R * EDGE);
    } else { ring.style.display = knob.style.display = 'none'; hint.style.display = ''; }
  }
  function releaseAll() { // 모든 터치 입력 해제(누르고 있던 손가락은 뗄 때까지 무시)
    for (const [id] of ptr) ptr.set(id, { k: 'dead' });
    stick = null; seq = null; sector = -1; for (const c of ALL) sent[c] = false;
    const g = G(); if (g) g.clear();
    if (root && L) render(want());
  }
  let lastW = innerWidth, lastP = innerWidth > innerHeight;
  window.addEventListener('resize', () => { const p = innerWidth > innerHeight; if (innerWidth !== lastW || p !== lastP) releaseAll(); lastW = innerWidth; lastP = p; layKey = ''; }); // 회전·창 폭 변화 = 해제(주소창 높이만 바뀌는 것은 유지)
  window.addEventListener('orientationchange', releaseAll);
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', releaseAll);
  window.addEventListener('blur', releaseAll); window.addEventListener('pagehide', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  function loop() {
    requestAnimationFrame(loop);
    const g = G(), on = !!g && enabled() && g.show;
    if (on !== shown) { shown = on; if (!root) build(); root.classList.toggle('on', on); document.documentElement.classList.toggle('nk-tpad', on); if (on) { layKey = ''; place(); } else releaseAll(); }
    if (shown) { place(); step(); }
  }
  requestAnimationFrame(loop);

  // ── 설정 창(신규 층 설정의 「터치 패드」 줄 → open). 1280x720 논리 좌표, keymap.js 조작 설정 창과 같은 방식(아래 화면을 숨기고 그 위에 뜬다)
  const ROWS = [['touch', '터치 패드'], ['tdash', '달리기 보조'], ['tvib', '진동']];
  let scr = null, rows = [], back = null, isOpen = false, cur = 0, under = null, onClose = null, raf = 0, gpPrev = -1;
  const abs = (e, x, y, w, h) => { const s = e.style; s.left = x + 'px'; s.top = y + 'px'; s.width = w + 'px'; s.height = h + 'px'; return e; };
  const val = k => k === 'touch' ? MODE_T[mode()] : opt(k) ? '켬' : '끔';
  function sbuild(stage) {
    scr = el('nkm-scr nktp-scr', stage); el('nkm-win nkm-head', scr, '터치 패드'); abs(el('nkm-win', scr), 390, 196, 500, 316);
    rows = ROWS.map(([k, t], i) => {
      const r = abs(el('nkm-set', scr, t), 410, 214 + 62 * i, 460, 56); r.dataset.id = k;
      const mk = (tag, t) => { const e = document.createElement(tag); if (t) e.textContent = t; return e; }, a = r.appendChild(mk('em', '◀')), v = r.appendChild(mk('span')), b = r.appendChild(mk('em', '▶'));
      r.num = v.appendChild(mk('b')); b.style.right = '0';
      const tap = d => ev => { ev.stopPropagation(); if (!isOpen) return; cur = i; adj(d); };
      a.addEventListener('click', tap(-1)); b.addEventListener('click', tap(1)); r.addEventListener('click', tap(1));
      return r;
    });
    back = abs(el('nkm-btn', scr, '뒤로'), 476, 424, 328, 56); back.dataset.id = 'back';
    back.addEventListener('click', ev => { ev.stopPropagation(); if (isOpen) close(); });
  }
  function adj(d) {
    if (cur >= ROWS.length) return close();
    const k = ROWS[cur][0];
    if (S) { if (k === 'touch') S.data.touch = (mode() + d + 3) % 3; else S.data[k] = opt(k) ? 0 : 1; if (!S.save()) { const M = window.NKManga; if (M && M.toast) M.toast('설정을 저장하지 못했습니다', 'hp-low'); } }
    srender();
  }
  function srender() { if (!scr) return; rows.forEach((r, i) => { r.classList.toggle('cur', i === cur); r.num.textContent = val(ROWS[i][0]); }); back.classList.toggle('cur', cur === ROWS.length); }
  function onKey(e) {
    if (!isOpen) return; e.preventDefault(); e.stopImmediatePropagation(); if (e.repeat) return;
    const c = e.code, K = window.NKKeymap, n = K && K.nav ? K.nav(c) : { dy: c === 'ArrowUp' ? -1 : c === 'ArrowDown' ? 1 : 0, dx: c === 'ArrowLeft' ? -1 : c === 'ArrowRight' ? 1 : 0, ok: c === 'Enter' || c === 'KeyZ', bk: c === 'Escape' || c === 'KeyX' }; // 메뉴 키 = 키 표(keymap.js nav)
    if (n.dy) { cur = (cur + n.dy + ROWS.length + 1) % (ROWS.length + 1); return srender(); }
    if (n.dx < 0) return cur < ROWS.length ? adj(-1) : undefined;
    if (n.dx > 0 || n.ok) return adj(1);
    if (n.bk) return close();
  }
  window.addEventListener('keydown', onKey, true); // ui_manga.js 보다 먼저 불러와 그 키 처리보다 앞선다(index.html 순서)
  function gpLoop() { // 게임패드: 위·아래·A 바꾸기·B 닫기(누른 순간)
    if (!isOpen) { raf = 0; return; } raf = requestAnimationFrame(gpLoop);
    const M = window.NKManga; if (M && !M.active) return close();
    let v = 0; for (const g of (navigator.getGamepads ? navigator.getGamepads() : [])) { if (!g) continue; const p = i => !!(g.buttons[i] && g.buttons[i].pressed); if (p(12) || g.axes[1] < -0.5) v |= 1; if (p(13) || g.axes[1] > 0.5) v |= 2; if (p(0)) v |= 4; if (p(1)) v |= 8; if (p(14) || g.axes[0] < -0.5) v |= 16; if (p(15) || g.axes[0] > 0.5) v |= 32; }
    const hit = gpPrev < 0 ? 0 : v & ~gpPrev; gpPrev = v;
    if (hit & 1) { cur = (cur + ROWS.length) % (ROWS.length + 1); srender(); } else if (hit & 2) { cur = (cur + 1) % (ROWS.length + 1); srender(); } else if (hit & 4 || hit & 32) adj(1); else if (hit & 16) { if (cur < ROWS.length) adj(-1); } else if (hit & 8) close();
  }
  function open(o) {
    const stage = document.querySelector('#nkm .nkm-root'); if (!stage || isOpen) return false;
    if (!scr) sbuild(stage);
    onClose = o && o.onClose || null; under = stage.querySelector('.nkm-scr.on:not(.nktp-scr)'); if (under) under.style.visibility = 'hidden';
    isOpen = true; cur = 0; gpPrev = -1; scr.classList.add('on'); srender(); if (!raf) raf = requestAnimationFrame(gpLoop);
    return true;
  }
  function close() {
    if (!isOpen) return; isOpen = false; if (scr) scr.classList.remove('on'); if (under) under.style.visibility = ''; under = null;
    const f = onClose; onClose = null; if (f) f();
  }
  window.NKTouch = { open, close, label: () => MODE_T[mode()], get isOpen() { return isOpen; }, release: releaseAll, get enabled() { return enabled(); }, // enabled = 모바일 배치 기준(web/mobile.js)
    get state() { return { shown, enabled: enabled(), mode: mode(), dash: opt('tdash'), vib: opt('tvib'), stick: stick ? { x0: stick.x0, y0: stick.y0, d: Math.round(stick.d || 0), on: stick.on, sector } : null, sent: Object.assign({}, sent), seq: seq ? { c: seq.c, left: seq.st.length } : null, ptrs: ptr.size, layout: L ? { u: L.u, R: L.R, port: L.port, top: L.top, btn: L.btn, p: L.p, f: L.f, fs: !!fz && fz.style.display !== 'none', hint: L.hint, core: L.core } : null, open: isOpen }; } };
})();
