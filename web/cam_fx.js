'use strict';
// 카메라 줌 층 Z1(analysis/27 Z1 절, 표시 전용). 전투 영역(코어 캔버스 #c + HD 덮개 #nk-hd + 선수 표식 #nk-tags + 타격 이펙트 #nk-hitfx)을 래퍼 하나로 묶어
//   CSS transform(scale·translate)만 건다. 엔진·워커·RAM·입력·락스텝·소리·게임 시간(프레임 허가)과 무관하고 코어 캔버스 픽셀도 손대지 않는다.
// 구조(이 파일이 불러올 때 DOM 에서 만든다. index.html 에서 game.js 보다 먼저 = 덮개 3장이 생길 때 cv.parentNode 가 이미 래퍼):
//   #stage > #nk-camclip(절대 위치 inset 0, 줌 중에만 clip-path = 보이는 코어 필드 자리) > #nk-cam(절대 위치 inset 0, #stage 와 같은 가운데 정렬 flex, transform-origin 0 0) > #c · 덮개들
//   래퍼 밖(줌되지 않음): #stage::before/::after(배경·창틀), 승리 연출 건너뛰기 표시, #nkm(신규 UI 층·HUD 게이지 패널·토스트)·#msg·#info.
//   래퍼 두 장은 위치·크기가 #stage 와 같고 줌이 없으면 transform·clip-path 를 아예 두지 않는다 → 배치·쌓임 순서·픽셀이 종전과 같다(설정 끔 = 픽셀 동일).
// API(개발용 콘솔, 트리거 연결은 Z2): NKCam.zoomTo({ scale, cx, cy, ms, ease }) · NKCam.reset(ms) · NKCam.state · NKCam.rect(el) · NKCam.level
//   cx·cy = 코어 화면 좌표(필드 x 0~256, y 0~188 — RAM 화면 좌표와 같은 축). 그 점을 보이는 필드 가운데로 끌어오되 필드 밖(검은 테두리)이 드러나지 않게 이동을 자른다.
//   scale ≥ 1(1 미만은 1). ms 기본 200, ease = 'linear' | 'in' | 'out'(기본) | 'inOut'. requestAnimationFrame 보간(실시간, 게임 프레임과 무관).
//   NKCam.rect(el) = 변환 전 배치 rect(래퍼 안 요소는 현재 transform 을 거꾸로 풀어 돌려준다). 덮개·HUD 배치 계산은 getBoundingClientRect 대신 이것을 쓴다(줌 중 정렬 유지).
// 설정 「카메라 연출」(web/settings.js 칸 cam): 0 끔(어떤 transform 도 두지 않음, zoomTo 무시) · 1 약(기본: 확대분 절반, 최대 1.15배) · 2 보통(요청 그대로, 최대 1.6배).
//   OS 「동작 줄이기」(prefers-reduced-motion: reduce) = 끔과 같다. 클래식 화면(?classic=1) = 래퍼를 만들지 않고 늘 끔.
// 정수배 규칙의 예외: 줌 중에만 비정수 배율을 허용한다(코어 캔버스 CSS image-rendering: pixelated 는 그대로 = 최근접 확대). 배율 1 로 돌아오면 transform·clip-path 를 지워
//   game.js fit() 의 정수배·디바이스 픽셀 스냅 배치가 그대로 보인다(경계 흐림·1px 오프셋이 남지 않는다).
// 온라인(락스텝 대전 중 __game.online): 약 이하로 제한한다(상대와 같은 화면 정보 — 확대로 화면 밖 상대를 가리는 이점·불리를 줄인다). 줌은 표시만 바꾸므로 지문·입력과 무관.
// 히트스톱 금지: 이 층은 표시 프레임을 멈추거나 늦추지 않는다(프레임 허가·워커·paint 호출에 손대지 않는다). 슬로우(Z2)는 로컬 전용 별도 경로로 하고 온라인에서는 쓰지 않는다.
(function (root) {
  const MAX = [1, 1.15, 1.6], GAIN = [0, 0.5, 1], FW = 256, FH = 188, OX = 88;
  const EASE = { linear: t => t, in: t => t * t, out: t => 1 - (1 - t) * (1 - t), inOut: t => t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t) };
  const CLASSIC = /[?&]classic=1(&|$)/.test(location.search);
  const calmQ = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let cv = null, clip = null, wrap = null, raf = 0, applied = false, err = null;
  const cur = { k: 1, cx: FW / 2, cy: FH / 2 }, anim = { on: false, t0: 0, ms: 0, ease: EASE.out, a: null, b: null };
  const T = { k: 1, tx: 0, ty: 0 }; // 지금 걸린 transform(applied 일 때만 뜻이 있다)
  const st = { calls: 0, applies: 0, clears: 0, maxK: 1 };
  const online = () => { const g = root.__game; try { return !!(g && g.online); } catch (e) { return false; } };
  function level() {
    if (CLASSIC || !wrap || (calmQ && calmQ.matches)) return 0;
    const S = root.NKSettings, v = S ? S.get('cam') : 1, lv = v === 0 || v === 1 || v === 2 ? v : 1;
    return online() ? Math.min(lv, 1) : lv;
  }
  const cap = k => { const lv = level(); return lv ? Math.max(1, Math.min(MAX[lv], 1 + (k - 1) * GAIN[lv])) : 1; };
  function clear() { // 배율 1 = 종전 배치 그대로(transform·clip-path 없음)
    if (wrap && (applied || wrap.style.transform)) { wrap.style.transform = ''; clip.style.clipPath = ''; st.clears++; }
    applied = false; T.k = 1; T.tx = 0; T.ty = 0;
  }
  function wrapped(el) { return !!(el && wrap && wrap.contains(el)); }
  function rect(el) { // 변환 전 배치 rect(뷰포트 좌표). 래퍼 밖 요소·줌 없음 = getBoundingClientRect 그대로
    const r = el.getBoundingClientRect(); if (!applied || !wrapped(el)) return r;
    const O = clip.getBoundingClientRect(), q = v => Math.round(v * 1e6) / 1e6; // 역변환의 부동소수 잔차가 Math.round 경계를 넘지 않게
    const x = q(O.left + (r.left - O.left - T.tx) / T.k), y = q(O.top + (r.top - O.top - T.ty) / T.k), w = q(r.width / T.k), h = q(r.height / T.k);
    return { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y };
  }
  function apply() { // cur → transform. 필드 밖이 드러나지 않게 이동을 자른다
    const k = cap(cur.k);
    if (k <= 1 + 1e-4) return clear();
    const O = clip.getBoundingClientRect(), L = rect(cv); if (!L.width) return clear();
    const s = L.width / 432, fh = Math.min(+cv.dataset.fh || 240, 240), dpr = root.devicePixelRatio || 1, snap = v => Math.round(v * dpr) / dpr;
    const a = L.left - O.left + OX * s, b = a + FW * s, c = L.top - O.top, d = c + fh * s; // 보이는 코어 필드(래퍼 좌표)
    const px = a + cur.cx * s, py = c + cur.cy * s, cxv = (a + b) / 2, cyv = (c + d) / 2;
    const tx = snap(Math.max(b * (1 - k), Math.min(a * (1 - k), cxv - k * px))), ty = snap(Math.max(d * (1 - k), Math.min(c * (1 - k), cyv - k * py)));
    const tf = 'translate(' + tx + 'px,' + ty + 'px) scale(' + k + ')';
    const W = O.width, H = O.height, cp = 'inset(' + c + 'px ' + (W - b) + 'px ' + (H - d) + 'px ' + a + 'px)';
    if (wrap.style.transform !== tf) wrap.style.transform = tf; if (clip.style.clipPath !== cp) clip.style.clipPath = cp;
    applied = true; T.k = k; T.tx = tx; T.ty = ty; st.applies++; if (k > st.maxK) st.maxK = k;
  }
  function tick(t) {
    raf = 0;
    try {
      if (!level()) { anim.on = false; cur.k = 1; return clear(); }
      if (anim.on) {
        const p = anim.ms > 0 ? Math.min(1, (t - anim.t0) / anim.ms) : 1, e = anim.ease(p), A = anim.a, B = anim.b;
        cur.k = A.k + (B.k - A.k) * e; cur.cx = A.cx + (B.cx - A.cx) * e; cur.cy = A.cy + (B.cy - A.cy) * e;
        if (p >= 1) { anim.on = false; cur.k = B.k; cur.cx = B.cx; cur.cy = B.cy; }
      }
      apply(); // 멈춰 있어도 줌 중이면 매 화면 다시 잰다(fit 의 배치 변경·창 크기 변경·필드 확대 전환을 따라간다)
      if (anim.on || applied) raf = requestAnimationFrame(tick);
    } catch (x) { err = String(x && x.message || x); anim.on = false; cur.k = 1; clear(); console.warn('카메라 층 오류(끔): ' + err); }
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
  function go(b, ms, ease) {
    const now = performance.now();
    anim.a = { k: cur.k, cx: cur.cx, cy: cur.cy }; anim.b = b; anim.ms = Math.max(0, +ms || 0); anim.ease = EASE[ease] || EASE.out; anim.t0 = now; anim.on = true;
    if (!anim.ms) { if (raf) { cancelAnimationFrame(raf); raf = 0; } tick(now); } else kick(); // ms 0 = 즉시(같은 호출 안에서 적용)
  }
  const num = (v, d) => Number.isFinite(+v) ? +v : d;
  const api = {
    get level() { return level(); }, get blocked() { return CLASSIC || !wrap || !!(calmQ && calmQ.matches); } /* 설정과 무관하게 늘 끔(설정 행 흐리게) */, get error() { return err; }, get stats() { return st; }, rect,
    get state() { return { scale: T.k, cx: cur.cx, cy: cur.cy, tx: T.tx, ty: T.ty, target: anim.on ? Object.assign({}, anim.b) : null, animating: anim.on, applied, level: level(), online: online() }; },
    zoomTo(o) { // 반환: 받아들였으면 true(끔·동작 줄이기·클래식이면 false 이고 transform 없음)
      st.calls++; o = o || {};
      if (!level()) { anim.on = false; cur.k = 1; clear(); return false; }
      const k = Math.max(1, num(o.scale, 1)), cx = Math.max(0, Math.min(FW, num(o.cx, cur.cx))), cy = Math.max(0, Math.min(FH, num(o.cy, cur.cy)));
      go({ k: Math.min(k, MAX[2]), cx, cy }, o.ms === undefined ? 200 : o.ms, o.ease); return true; // 요청 배율 그대로 보간하고 단계 상한(약 = 확대분 절반·1.15, 온라인 = 약)은 apply 에서 한 번만 건다
    },
    reset(ms) { st.calls++; if (!level() || !applied && !anim.on) { anim.on = false; cur.k = 1; clear(); return; } go({ k: 1, cx: cur.cx, cy: cur.cy }, ms === undefined ? 200 : ms, 'out'); },
  };
  function init() {
    cv = document.getElementById('c'); const stage = document.getElementById('stage');
    if (CLASSIC || !cv || !stage || cv.parentNode !== stage) return; // 클래식·구조가 다름 = 래퍼 없음(늘 끔)
    clip = document.createElement('div'); clip.id = 'nk-camclip'; clip.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    wrap = document.createElement('div'); wrap.id = 'nk-cam'; wrap.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transform-origin:0 0;pointer-events:none';
    stage.insertBefore(clip, cv); clip.appendChild(wrap); wrap.appendChild(cv); cv.style.pointerEvents = 'auto'; // 캔버스 클릭·포커스는 종전 그대로
    if (root.NKSettings && root.NKSettings.on) root.NKSettings.on(() => { if (!level()) { anim.on = false; cur.k = 1; clear(); } else if (applied) kick(); }); // 설정 끔 = 즉시 제거, 약으로 낮춤 = 다음 화면에 상한
    if (calmQ && calmQ.addEventListener) calmQ.addEventListener('change', () => { if (!level()) { anim.on = false; cur.k = 1; clear(); } });
    root.addEventListener('resize', () => { if (applied) kick(); });
  }
  try { init(); } catch (e) { err = String(e && e.message || e); wrap = null; console.warn('카메라 층 준비 실패(끔): ' + err); }
  root.NKCam = api;
})(window);
