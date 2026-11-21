'use strict';
// 키 리매핑(analysis/15_ui_manga_impl.md 21절, 현대화 A1). 키보드 1P·2P 와 게임패드 버튼을 원작 패드 비트(A 1 · B 2 · 점프 3 = A|B · 선택 4 · 시작 8 · 위 16 · 아래 32 · 왼쪽 64 · 오른쪽 128)로 바꾸는 표만 바꾼다.
//   game.js 는 entries()(종전 KEYS 와 같은 [코드, 플레이어, 비트] 줄)로 kmap 을 다시 만들고, 게임패드 버튼은 padBits() 로 읽는다. 짧은 탭 보정(KEEP)·방향 겹침 정리·온라인 락스텝·스토리 기록은
//   변환된 패드 값만 받으므로 그대로다(엔진·판정·입력 버퍼 무변경). 기본값 = 종전 고정 표(+ 게임패드 버튼 1 = 점프).
//   저장 localStorage nk_keymap(실패하면 이번 세션만, 토스트). 조작 설정 화면(open)은 신규 층(#nkm) 안에 만화풍 창으로 뜬다: 칸 클릭·결정 → 「키를 누르세요」 → 누른 키로 바꿈(Esc 취소, 겹침·예약 키는 토스트로 거절)
(function () {
  const KEY = 'nk_keymap';
  const ACT = [['up', '위', 16], ['down', '아래', 32], ['left', '왼쪽', 64], ['right', '오른쪽', 128], ['a', 'A', 1], ['b', 'B', 2], ['jump', '점프', 3], ['select', '선택', 4], ['start', '시작', 8]], NDIR = 4; // 앞 4줄 = 방향(게임패드는 십자·스틱 고정)
  // 기본 표(2026-11-21 사용자 지시 「ZXC 를 ASD 로」): 1P A·B·점프 = A·S·D(방향키·Shift·Enter 그대로). 2P 는 종전 WASD 가 1P 와 겹쳐 T·F·G·H 방향 + U=A · I=B · O=점프 · Y=선택 · L=시작(K 는 한글 층 예약)
  const DEF_K = [{ up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], a: ['KeyA'], b: ['KeyS'], jump: ['KeyD'], select: ['ShiftRight', 'ShiftLeft'], start: ['Enter'] },
    { up: ['KeyT'], down: ['KeyG'], left: ['KeyF'], right: ['KeyH'], a: ['KeyU'], b: ['KeyI'], jump: ['KeyO'], select: ['KeyY'], start: ['KeyL'] }];
  const OLD_K = [{ up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], a: ['KeyZ'], b: ['KeyX'], jump: ['KeyC'], select: ['ShiftRight', 'ShiftLeft'], start: ['Enter'] },
    { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], a: ['KeyG'], b: ['KeyH'], jump: [], select: ['KeyY'], start: ['KeyT'] }]; // 옛 기본(저장값이 이것과 똑같으면 새 기본으로 옮긴다)
  const DEF_P = { a: 0, b: 2, jump: 1, select: 8, start: 9 }; // 표준 배치 버튼 번호(-1 = 없음). 십자 12~15 는 방향 고정
  const EXTRA = [['Numpad8', 0, 16], ['Numpad2', 0, 32], ['Numpad4', 0, 64], ['Numpad6', 0, 128], ['Numpad7', 0, 80], ['Numpad9', 0, 144], ['Numpad1', 0, 96], ['Numpad3', 0, 160]]; // 숫자패드 = 1P 8방향(고정, 사용자가 그 키를 다른 버튼에 쓰면 빠진다)
  const RESERVED = /^(Escape|KeyP|KeyM|KeyR|KeyK|Tab|F\d+|Meta\w*|OS\w*|ContextMenu|CapsLock|NumLock|ScrollLock|Pause|PrintScreen)$/; // game.js 시스템 키(정지·음소거·처음부터·한글 층)와 브라우저 키
  const PADN = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'LS', 'RS', '↑', '↓', '←', '→', 'Home'];
  const clone = o => JSON.parse(JSON.stringify(o));
  let km = { k: clone(DEF_K), p: clone(DEF_P) };
  const subs = [];
  const okCode = c => typeof c === 'string' && /^[A-Za-z0-9]{1,24}$/.test(c) && !RESERVED.test(c);
  function valid(j) { // 저장 값 검사: 모양이 틀리거나 같은 키가 두 곳에 있으면 버린다(기본값)
    if (!j || typeof j !== 'object' || !Array.isArray(j.k) || j.k.length !== 2 || !j.p || typeof j.p !== 'object') return null;
    const seen = new Set(), out = { k: [{}, {}], p: {} };
    for (let q = 0; q < 2; q++) for (const [id] of ACT) {
      const v = j.k[q] && j.k[q][id]; if (!Array.isArray(v) || v.length > 2) return null;
      for (const c of v) { if (!okCode(c) || seen.has(c)) return null; seen.add(c); }
      if (ACT.findIndex(a => a[0] === id) < NDIR && !v.length) return null; // 방향은 비울 수 없다
      out.k[q][id] = v.slice();
    }
    const ps = new Set();
    for (const [id] of ACT.slice(NDIR)) { const b = j.p[id]; if (!Number.isInteger(b) || b < -1 || b > 31 || (b >= 12 && b <= 15)) return null; if (b >= 0) { if (ps.has(b)) return null; ps.add(b); } out.p[id] = b; }
    return out;
  }
  try { const v = valid(JSON.parse(localStorage.getItem(KEY) || 'null')); if (v) { km = v; if (JSON.stringify(v.k) === JSON.stringify(valid({ k: OLD_K, p: DEF_P }).k)) { km.k = clone(DEF_K); localStorage.setItem(KEY, JSON.stringify(km)); } } } catch (e) { /* 저장소를 못 쓰면 기본값 */ }
  const toast = t => { const M = window.NKManga; if (M && M.toast) M.toast(t, 'hp-low'); };
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(km)); } catch (e) { toast('설정을 저장하지 못했습니다'); }
    for (const f of subs) try { f(); } catch (e) { console.warn('키 설정 구독 오류: ' + (e && e.message || e)); }
  }
  function entries() { // [코드, 플레이어 0·1, 비트] (game.js kmap)
    const out = [], used = new Set();
    for (let q = 0; q < 2; q++) for (const [id, , bit] of ACT) for (const c of km.k[q][id]) { out.push([c, q, bit]); used.add(c); }
    for (const e of EXTRA) if (!used.has(e[0])) out.push(e.slice());
    return out;
  }
  function padBits(g, allowStart) { // 게임패드 버튼(방향 제외) → 비트. allowStart = 시작 버튼을 원작 START 로 넣을지(game.js gpSt)
    const b = g.buttons, P = i => i >= 0 && !!b[i] && b[i].pressed, p = km.p; let v = 0;
    if (P(p.a)) v |= 1; if (P(p.b)) v |= 2; if (P(p.jump)) v |= 3; if (P(p.select)) v |= 4; if (allowStart && P(p.start)) v |= 8;
    return v;
  }
  function label(c) {
    if (!c) return '—';
    const A = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ShiftLeft: 'LShift', ShiftRight: 'RShift', ControlLeft: 'LCtrl', ControlRight: 'RCtrl', AltLeft: 'LAlt', AltRight: 'RAlt', Space: 'Space', Enter: 'Enter', NumpadEnter: 'NumEnter', Backspace: 'BS', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };
    if (A[c]) return A[c]; let m = /^Key([A-Z])$/.exec(c) || /^Digit(\d)$/.exec(c); if (m) return m[1];
    m = /^Numpad(.+)$/.exec(c); if (m) return 'Num' + ({ Add: '+', Subtract: '-', Multiply: '*', Divide: '/', Decimal: '.' }[m[1]] || m[1]);
    return c.length > 8 ? c.slice(0, 8) : c;
  }
  const keysLabel = v => !v.length ? '—' : v.length === 2 && v.every(c => /^Shift/.test(c)) ? 'Shift' : v.map(label).join('/');
  const padLabel = (r, b) => r < NDIR ? '십자' : b < 0 ? '—' : PADN[b] || 'B' + b;

  // ── 조작 설정 화면(신규 층 #nkm 안, 1280x720 논리 좌표. 세로 화면은 설정 창과 같은 가운데 구간 370~910) ──
  let scr = null, cells = [], btns = [], under = null, isOpen = false, row = 0, col = 0, wait = null, raf = 0, gpPrev = 0, onClose = null;
  const el = (tag, cls, parent, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; if (parent) parent.appendChild(e); return e; };
  const abs = (e, x, y, w, h) => { const s = e.style; s.left = x + 'px'; s.top = y + 'px'; s.width = w + 'px'; s.height = h + 'px'; return e; };
  const CX = [500, 634, 768], RY = r => 136 + 46 * r, NR = ACT.length; // 줄 NR = 아래 단추 줄(0 기본값 · 1 뒤로)
  const off = (r, c) => c === 2 && r < NDIR;
  function build(stage) {
    const st = document.createElement('style');
    st.textContent = '#nkm .nkk-c{position:absolute;box-sizing:border-box;border:2px solid rgba(255,255,255,.35);border-radius:4px;text-align:center;font:700 20px/38px Galmuri11,monospace;color:#fff;cursor:pointer;white-space:nowrap;overflow:hidden}'
      + '#nkm .nkk-c.cur{background:var(--row-sel);border-color:var(--focus);box-shadow:0 0 12px rgba(255,225,77,.45)}#nkm .nkk-c.off{opacity:.38;cursor:default}'
      + '#nkm .nkk-c.wait{font-size:15px;color:var(--focus);animation:nkk-blink .9s steps(2,start) infinite}@keyframes nkk-blink{50%{opacity:.45}}'
      + '#nkm .nkk-l{position:absolute;font:20px/42px Galmuri11,monospace;color:var(--sub);white-space:nowrap}#nkm .nkk-h{position:absolute;text-align:center;font:700 18px/28px Galmuri11,monospace;color:var(--sub)}';
    document.head.appendChild(st);
    scr = el('div', 'nkm-scr nkk', stage); el('div', 'nkm-win nkm-head', scr, '조작 설정'); abs(el('div', 'nkm-win', scr), 370, 88, 540, 556);
    ['1P', '2P', '패드'].forEach((t, c) => abs(el('div', 'nkk-h', scr, t), CX[c], 100, 128, 28));
    cells = ACT.map(([, t], r) => { abs(el('div', 'nkk-l', scr, t), 392, RY(r), 104, 42); return CX.map((x, c) => { const e = abs(el('div', 'nkk-c', scr), x, RY(r), 128, 42); e.dataset.r = r; e.dataset.c = c; hover(e, r, c); e.addEventListener('click', ev => { ev.stopPropagation(); if (!isOpen) return; row = r; col = c; begin(); }); return e; }); });
    btns = ['기본값', '뒤로'].map((t, c) => { const b = abs(el('div', 'nkm-btn', scr, t), c ? 648 : 392, 576, 240, 52); b.dataset.id = c ? 'back' : 'default'; hover(b, NR, c); b.addEventListener('click', ev => { ev.stopPropagation(); if (!isOpen) return; row = NR; col = c; act(); }); return b; });
    scr.addEventListener('click', () => { if (wait) stop(); }); // 칸 밖을 누르면 입력 대기 취소
  }
  function hover(e, r, c) { e.addEventListener('pointermove', ev => { if (ev.pointerType !== 'mouse' || !isOpen || wait || (row === r && col === c) || off(r, c)) return; row = r; col = c; render(); }); }
  function render() {
    if (!scr) return;
    ACT.forEach(([id], r) => cells[r].forEach((e, c) => {
      const w = !!wait && wait.r === r && wait.c === c;
      e.textContent = w ? (c === 2 ? '버튼을 누르세요' : '키를 누르세요') : c === 2 ? padLabel(r, km.p[id]) : keysLabel(km.k[c][id]);
      e.classList.toggle('cur', row === r && col === c); e.classList.toggle('off', off(r, c)); e.classList.toggle('wait', w);
    }));
    btns.forEach((b, c) => b.classList.toggle('cur', row === NR && col === c));
  }
  function begin() { // 입력 대기 시작
    if (row >= NR || off(row, col)) return;
    wait = { r: row, c: col, t: performance.now(), prev: snap() }; render();
  }
  function stop() { wait = null; render(); }
  function snap() { const o = {}; for (const g of (navigator.getGamepads ? navigator.getGamepads() : [])) if (g) o[g.index] = g.buttons.map(b => b.pressed); return o; }
  function setKey(code) {
    const q = wait.c, id = ACT[wait.r][0];
    if (!okCode(code)) { wait.t = performance.now(); return toast('쓸 수 없는 키'); }
    for (let p = 0; p < 2; p++) for (const [a, t] of ACT) if (!(p === q && a === id) && km.k[p][a].indexOf(code) >= 0) { wait.t = performance.now(); return toast('이미 쓰는 키: ' + (p + 1) + 'P ' + t); }
    km.k[q][id] = [code]; wait = null; persist(); render();
  }
  function setPad(b) {
    const id = ACT[wait.r][0];
    if (b >= 12 && b <= 15) { wait.t = performance.now(); return toast('쓸 수 없는 버튼'); }
    for (const [a, t] of ACT.slice(NDIR)) if (a !== id && km.p[a] === b) { wait.t = performance.now(); return toast('이미 쓰는 버튼: ' + t); }
    km.p[id] = b; wait = null; persist(); render();
  }
  function act() { // 결정
    if (row < NR) return begin();
    if (col === 0) { km = { k: clone(DEF_K), p: clone(DEF_P) }; persist(); return render(); }
    close();
  }
  function move(dx, dy) {
    if (dy) { row = (row + dy + NR + 1) % (NR + 1); if (row === NR) col = Math.min(col, 1); }
    if (dx) { const n = row === NR ? 2 : 3; col = (col + dx + n) % n; }
    if (off(row, col)) col = dx < 0 ? 1 : dx > 0 ? 0 : 1; // 방향 줄의 패드 칸은 건너뛴다
    render();
  }
  function onKey(e) { // 창이 떠 있는 동안 키는 여기서만(신규 층·game.js 로 넘기지 않는다)
    if (!isOpen) return;
    e.preventDefault(); e.stopImmediatePropagation(); if (e.repeat) return;
    const c = e.code;
    if (wait) { if (c === 'Escape' || wait.c === 2) { if (c === 'Escape') stop(); return; } return setKey(c); }
    const n = nav(c);
    if (n.dx || n.dy) return move(n.dx, n.dy);
    if (n.ok) return act();
    if (n.bk) return close();
  }
  window.addEventListener('keydown', onKey, true);
  function gpLoop() { // 게임패드: 메뉴 이동(누른 순간) · 패드 칸 입력 대기 = 새로 눌린 버튼
    if (!isOpen) { raf = 0; return; }
    raf = requestAnimationFrame(gpLoop);
    const M = window.NKManga; if (M && !M.active) return close(); // 신규 층이 걷혔다(온라인 시작 등)
    if (wait && performance.now() - wait.t > 6000) stop(); // 6초 동안 입력이 없으면 취소
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    if (wait && wait.c === 2) {
      for (const g of gps) {
        if (!g) continue; const pv = wait.prev[g.index] || [];
        for (let i = 0; i < g.buttons.length; i++) if (g.buttons[i].pressed && !pv[i]) { wait.prev = snap(); return setPad(i); }
      }
      wait.prev = snap(); gpPrev = -1; return;
    }
    let v = 0;
    for (const g of gps) {
      if (!g) continue; const p = i => !!(g.buttons[i] && g.buttons[i].pressed);
      if (p(12) || g.axes[1] < -0.5) v |= 1; if (p(13) || g.axes[1] > 0.5) v |= 2; if (p(14) || g.axes[0] < -0.5) v |= 16; if (p(15) || g.axes[0] > 0.5) v |= 32; if (p(0)) v |= 4; if (p(1) || p(2)) v |= 8;
    }
    const hit = gpPrev < 0 ? 0 : v & ~gpPrev; gpPrev = v; if (wait) return; // 입력 대기 직후(gpPrev -1)는 누르고 있던 버튼을 새 입력으로 보지 않는다
    if (hit & 1) move(0, -1); else if (hit & 2) move(0, 1); else if (hit & 16) move(-1, 0); else if (hit & 32) move(1, 0); else if (hit & 4) act(); else if (hit & 8) close();
  }
  function open(o) { // o = { onClose }. 신규 층 설정 화면에서 부른다
    const stage = document.querySelector('#nkm .nkm-root'); if (!stage || isOpen) return false;
    if (!scr) build(stage);
    onClose = o && o.onClose || null; under = stage.querySelector('.nkm-scr.on:not(.nkk)'); if (under) under.style.visibility = 'hidden';
    isOpen = true; row = 0; col = 0; wait = null; gpPrev = -1; scr.classList.add('on'); render();
    if (!raf) raf = requestAnimationFrame(gpLoop);
    return true;
  }
  function close() {
    if (!isOpen) return; isOpen = false; wait = null; if (scr) scr.classList.remove('on'); if (under) under.style.visibility = ''; under = null;
    const f = onClose; onClose = null; if (f) f();
  }
  function nav(c) { // 메뉴 키(신규 층·종전 층·이 창 공통): 방향키 · Enter = 결정 · Esc = 뒤로 + 키 표(1P·2P)의 방향 한 칸 키 = 이동, A = 결정, B = 뒤로. Z·X 는 표에 없을 때만 종전대로 결정·뒤로
    const o = { dx: 0, dy: 0, ok: false, bk: false };
    if (c === 'ArrowUp') o.dy = -1; else if (c === 'ArrowDown') o.dy = 1; else if (c === 'ArrowLeft') o.dx = -1; else if (c === 'ArrowRight') o.dx = 1;
    else if (c === 'Enter' || c === 'NumpadEnter') o.ok = true; else if (c === 'Escape') o.bk = true;
    else {
      let hit = null; for (let q = 0; q < 2 && !hit; q++) for (const [id, , bit] of ACT) if (km.k[q][id].indexOf(c) >= 0) { hit = bit; break; }
      if (hit === 16) o.dy = -1; else if (hit === 32) o.dy = 1; else if (hit === 64) o.dx = -1; else if (hit === 128) o.dx = 1; else if (hit === 1) o.ok = true; else if (hit === 2) o.bk = true;
      else if (hit === null && c === 'KeyZ') o.ok = true; else if (hit === null && c === 'KeyX') o.bk = true;
    }
    return o;
  }
  function hint() { // 조작 안내문(#msg, index.html): 지금 키 표의 이름으로
    const m = document.getElementById('msg'); if (!m) return;
    const k = km.k, K = (p, id) => keysLabel(k[p][id]);
    m.textContent = '';
    const t = s => m.appendChild(document.createTextNode(s)), b = s => { const e = document.createElement('kbd'); e.textContent = s; m.appendChild(e); };
    const dirs = p => { if (p === 0 && k[0].up[0] === 'ArrowUp' && k[0].down[0] === 'ArrowDown' && k[0].left[0] === 'ArrowLeft' && k[0].right[0] === 'ArrowRight') return t('방향키 '); ['up', 'left', 'down', 'right'].forEach(id => b(K(p, id))); t(' '); };
    t('아무 키: 소리 켜기 | 1P: '); dirs(0); b(K(0, 'a')); t('=A '); b(K(0, 'b')); t('=B '); b(K(0, 'jump')); t('=점프 '); b(K(0, 'start')); t('=시작 '); b(K(0, 'select')); t('=선택 | 2P: ');
    dirs(1); b(K(1, 'a')); t('=A '); b(K(1, 'b')); t('=B '); b(K(1, 'start')); t('=시작 | '); b('P'); t(' 일시정지 '); b('R'); t(' 처음부터 '); b('M'); t(' 음소거');
  }
  hint(); subs.push(hint);
  window.NKKeymap = { entries, padBits, label, nav, keyName: (p, id) => keysLabel((km.k[p] || {})[id] || []), open, close, on(f) { if (typeof f === 'function') subs.push(f); }, reset() { km = { k: clone(DEF_K), p: clone(DEF_P) }; persist(); render(); },
    get startBtn() { return km.p.start; }, get isOpen() { return isOpen; }, get map() { return clone(km); }, get state() { return { open: isOpen, row, col, wait: wait ? { r: wait.r, c: wait.c } : null }; } };
})();
