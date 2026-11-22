'use strict';
// 접근성 A2(analysis/26 A2·S6, analysis/27 A2 절). 표시 층만: 엔진·워커·RAM·입력·락스텝·원작 팔레트·코어 캔버스 픽셀은 건드리지 않는다.
//   색약(설정 colorblind 1): html.nk-cb → web/a11y.css 가 신규 층 색 변수(--p1~4·--hp*)를 색약 구분 팔레트(Okabe-Ito 계열)로 바꾼다.
//     선수 표식(web/unit_tags.js #nk-tags 덮개)은 이미 모양이 다르다(내 편 ▲ · 상대 ●) → 그 덮개의 붓 색만 같은 팔레트로 바꾼다(그 캔버스 2d 문맥 하나의 fillStyle 만 가로챔).
//   글자 크기(설정 fontscale 0·1·2 = 1.0·1.15·1.3): html.nk-fs1·nk-fs2 + --nkfs → a11y.css 가 HUD·토스트·메뉴의 DOM 글자만 키운다. 튜토리얼 안내는 NKA11y.scale 을 읽는다. 캔버스 안 원작 글자는 그대로.
//   둘 다 끔(기본) = 클래스·CSS 링크·가로채기·루프 없음 → 화면·RAM 지문이 종전과 같고 프레임 비용 0(tools/a11y_check.js).
//   설정 창 = NKA11y.open({ onClose })(신규 층 설정 「접근성」 줄, touch_pad.js 터치 패드 창과 같은 방식). index.html 에서 settings.js 뒤·ui_manga.js 앞(키 처리가 먼저 잡히게)
(function () {
  const S = window.NKSettings || null, FS = [1, 1.15, 1.3], FS_T = ['100%', '115%', '130%'];
  const TAG = { '#e5484d': '#e69f00', '#3b82f6': '#56b4e9' }; // unit_tags.js COL 빨강·파랑 → 주황·하늘(a11y.css --p1·--p2 와 같은 색)
  const cb = () => !!S && S.get('colorblind') === 1;
  const fsi = () => { const v = S ? S.get('fontscale') : 0; return v === 1 || v === 2 ? v : 0; };
  let link = null, tagCtx = null, mo = null, loops = 0;
  function css() { if (link) return; link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'a11y.css'; document.head.appendChild(link); }
  function tags(on) { // 표식 덮개의 붓 색만 바꾼다(덮개가 아직 없으면 생길 때까지 #stage 아래 추가만 지켜본다)
    const cv = document.getElementById('nk-tags');
    if (!on) { if (tagCtx) { delete tagCtx.fillStyle; tagCtx = null; } if (mo) { mo.disconnect(); mo = null; } return; }
    if (!cv) { if (!mo && document.body) { mo = new MutationObserver(() => { if (document.getElementById('nk-tags')) { mo.disconnect(); mo = null; tags(cb()); } }); mo.observe(document.body, { childList: true, subtree: true }); } return; }
    const x = cv.getContext('2d'); if (!x || tagCtx === x) return;
    const d = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'fillStyle');
    Object.defineProperty(x, 'fillStyle', { configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, typeof v === 'string' && TAG[v.toLowerCase()] || v); } });
    tagCtx = x;
  }
  function apply() {
    const c = cb(), f = fsi(), h = document.documentElement;
    if (c || f) css();
    if (h.classList.contains('nk-cb') !== c) h.classList.toggle('nk-cb', c);
    if (h.classList.contains('nk-fs1') !== (f === 1)) h.classList.toggle('nk-fs1', f === 1);
    if (h.classList.contains('nk-fs2') !== (f === 2)) h.classList.toggle('nk-fs2', f === 2);
    tags(c);
  }
  if (S) S.on(apply);
  apply();

  // ── 설정 창(1280x720 논리 좌표, #nkm 안. 줄 모양 = ui_manga.css .nkm-set) ──
  const ROWS = [['colorblind', '색약 보정'], ['fontscale', '글자 크기']];
  let scr = null, rows = [], back = null, isOpen = false, cur = 0, under = null, onClose = null, raf = 0, gpPrev = -1;
  const el = (tag, cls, parent, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; parent.appendChild(e); return e; };
  const abs = (e, x, y, w, h) => { const s = e.style; s.left = x + 'px'; s.top = y + 'px'; s.width = w + 'px'; s.height = h + 'px'; return e; };
  const val = k => k === 'colorblind' ? (cb() ? '켬' : '끔') : FS_T[fsi()];
  function build(stage) {
    scr = el('div', 'nkm-scr nka-scr', stage); el('div', 'nkm-win nkm-head', scr, '접근성'); abs(el('div', 'nkm-win', scr), 390, 196, 500, 254);
    rows = ROWS.map(([k, t], i) => {
      const r = abs(el('div', 'nkm-set', scr, t), 410, 214 + 62 * i, 460, 56); r.dataset.id = k; r.style.lineHeight = '56px';
      const a = el('em', '', r, '◀'), v = el('span', '', r), b = el('em', '', r, '▶'); r.num = el('b', '', v); b.style.right = '0';
      const tap = d => e => { e.stopPropagation(); if (!isOpen) return; cur = i; adj(d); };
      a.addEventListener('click', tap(-1)); b.addEventListener('click', tap(1)); r.addEventListener('click', tap(1));
      return r;
    });
    back = abs(el('div', 'nkm-btn', scr, '뒤로'), 476, 362, 328, 56); back.dataset.id = 'back';
    back.addEventListener('click', e => { e.stopPropagation(); if (isOpen) close(); });
  }
  function adj(d) {
    if (cur >= ROWS.length) return close();
    if (S) {
      if (ROWS[cur][0] === 'colorblind') S.data.colorblind = cb() ? 0 : 1; else S.data.fontscale = (fsi() + d + 3) % 3;
      if (!S.save()) { const M = window.NKManga; if (M && M.toast) M.toast('설정을 저장하지 못했습니다', 'hp-low'); }
    }
    render();
  }
  function render() { if (!scr) return; rows.forEach((r, i) => { r.classList.toggle('cur', i === cur); r.num.textContent = val(ROWS[i][0]); }); back.classList.toggle('cur', cur === ROWS.length); }
  function onKey(e) {
    if (!isOpen) return; e.preventDefault(); e.stopImmediatePropagation(); if (e.repeat) return;
    const c = e.code, K = window.NKKeymap, n = K && K.nav ? K.nav(c) : { dy: c === 'ArrowUp' ? -1 : c === 'ArrowDown' ? 1 : 0, dx: c === 'ArrowLeft' ? -1 : c === 'ArrowRight' ? 1 : 0, ok: c === 'Enter', bk: c === 'Escape' };
    if (n.dy) { cur = (cur + n.dy + ROWS.length + 1) % (ROWS.length + 1); return render(); }
    if (n.dx < 0) return cur < ROWS.length ? adj(-1) : undefined;
    if (n.dx > 0 || n.ok) return adj(1);
    if (n.bk) return close();
  }
  window.addEventListener('keydown', onKey, true);
  function gpLoop() { // 창이 열린 동안만: 위·아래·A/→ 바꾸기·← 반대로·B 닫기(누른 순간)
    if (!isOpen) { raf = 0; loops = 0; return; } raf = requestAnimationFrame(gpLoop);
    const M = window.NKManga; if (M && !M.active) return close();
    let v = 0; for (const g of (navigator.getGamepads ? navigator.getGamepads() : [])) { if (!g) continue; const p = i => !!(g.buttons[i] && g.buttons[i].pressed); if (p(12) || g.axes[1] < -0.5) v |= 1; if (p(13) || g.axes[1] > 0.5) v |= 2; if (p(0)) v |= 4; if (p(1)) v |= 8; if (p(14) || g.axes[0] < -0.5) v |= 16; if (p(15) || g.axes[0] > 0.5) v |= 32; }
    const hit = gpPrev < 0 ? 0 : v & ~gpPrev; gpPrev = v;
    if (hit & 1) { cur = (cur + ROWS.length) % (ROWS.length + 1); render(); } else if (hit & 2) { cur = (cur + 1) % (ROWS.length + 1); render(); } else if (hit & 4 || hit & 32) adj(1); else if (hit & 16) { if (cur < ROWS.length) adj(-1); } else if (hit & 8) close();
  }
  function open(o) {
    const stage = document.querySelector('#nkm .nkm-root'); if (!stage || isOpen) return false;
    if (!scr) build(stage);
    onClose = o && o.onClose || null; under = stage.querySelector('.nkm-scr.on:not(.nka-scr)'); if (under) under.style.visibility = 'hidden';
    isOpen = true; cur = 0; gpPrev = -1; scr.classList.add('on'); render(); if (!raf) { loops = 1; raf = requestAnimationFrame(gpLoop); }
    return true;
  }
  function close() {
    if (!isOpen) return; isOpen = false; if (scr) scr.classList.remove('on'); if (under) under.style.visibility = ''; under = null;
    const f = onClose; onClose = null; if (f) f();
  }
  window.NKA11y = { open, close, apply, label: () => (cb() ? '색약 · ' : '') + FS_T[fsi()], get scale() { return FS[fsi()]; }, get colorblind() { return cb(); }, get isOpen() { return isOpen; },
    get state() { return { colorblind: cb() ? 1 : 0, fontscale: fsi(), scale: FS[fsi()], css: !!link, tagHook: !!tagCtx, watching: !!mo, loops, open: isOpen }; } };
})();
