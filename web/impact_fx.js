'use strict';
// 타격감 층(표시 전용, 2026-11-22): 히트스톱 · 화면 흔들림 · 타격 방향 속도선·파편 · 피격 반짝임·순간 찌그러짐 · 쓰러짐 충격파·먼지 · 터치 진동.
//   엔진·워커·RAM·입력·락스텝·소리는 건드리지 않는다. 코어 캔버스 픽셀도 그대로(자기 덮개 캔버스에만 그린다). 신호 = web/hit_fx.js 의 detect·pos(RAM 읽기만).
//   히트스톱: 오프라인(로컬·스토리·타이틀 대련)만. game.js 화면 주기(tick)가 NKImpact.stop() 이 참인 동안 새 프레임을 허가하지 않는다(프레임 스케줄러 단계, 엔진 상태는 프레임 번호별로 같다).
//     길이(화면 프레임, 60Hz): 약 2 · 강 3 · 필살·던지기 4(설정 약 = 1 · 2 · 3). 연속 다단 히트는 직전 정지가 끝난 뒤 6프레임 안이면 다시 멈추지 않는다.
//     web/cam_triggers.js 와 겹침 방지: KO 슬로우 중 = 정지 없음, KO 타격·KO/필살 줌 중 = 2프레임 이하. 정지 동안 워클릿 소리도 멈춘다(game.js aSync bit2 → audio_worklet.js, 바닥남·선버퍼 재대기 없음).
//   온라인(락스텝): 정지 없음 → 피격 자리 흰 반짝임(1~2프레임) + 섬광 강화로 대신한다.
//   흔들림 = 내 선수(mine: 온라인 = 내 자리, 오프라인 = 사람 슬롯)가 때리거나 맞은 타격만(2026-11-22 사용자 결정). 남들끼리·타이틀 대련 = 흔들림만 없음(정지·반짝임·파편·소리 그대로).
//   흔들림: #nk-camclip(카메라 줌 래퍼 바깥 칸, web/cam_fx.js 는 이 칸의 transform 을 쓰지 않는다)에 정수 코어 픽셀 × 코어 1픽셀 크기(디바이스 픽셀 스냅) translate. 끝나면 transform 을 지운다(픽셀 종전 그대로).
//   타이틀(신규 층 메인 메뉴의 원작 대련 실시간 판 .nkm-tbg-live, web/ui_manga.js titleBg): 같은 신호(모드 3:5, 슬롯 0·1)로 같은 연출(진동 없음).
// 설정 NKSettings.impact: 0 끔(프레임 처리·DOM·정지 모두 없음 = 픽셀·RAM 지문 동일) · 1 약 · 2 보통(기본) · 3 강. OS 「동작 줄이기」 = 흔들림·찌그러짐·속도선 끔. 품질 단계(web/quality.js) 낮음 = 끔(타이틀 포함) · 보통 = 파편 절반.
// API: NKImpact.attach(el, { ox, tw, fh, name }) → 그 요소(코어 화면을 가로 ox 픽셀부터 tw 폭 캔버스에 1:1 로 그리는 캔버스) 위에 덮개를 붙인다 · NKImpact.trigger(kind, x, y, dir, o) 직접 연출
//   kind = 'weak' | 'strong' | 'big' | 'guard' | 'down', x·y = 코어 화면 좌표, dir = 날아가는 쪽(1 오른쪽 · -1 왼쪽 · 0), o = { host: 'fight' | 'title' | 이름, top(몸 위 끝 y), stop(false = 정지 없음), age(ms 고정 = 캡처용) }
//   NKImpact.frame = hit_fx.js 구독자(NKFxSubs, 프레임마다) · NKImpact.stop(t) = game.js 화면 주기 · NKImpact.stats
(function (root) {
  const FMS = 1000 / 60.0988, LAG = 4, MAXP = 32, GAP = 6;
  const STOP = { 1: { weak: 1, strong: 2, big: 3 }, 2: { weak: 2, strong: 3, big: 4 }, 3: { weak: 2, strong: 3, big: 4 } };
  const SHAKE = { weak: 1, strong: 2, big: 3, down: 2, guard: 0 }, SPARK = { guard: 3, weak: 6, strong: 10, big: 14, down: 0 }, VIB = { weak: 12, strong: 22, big: 40, down: 18, guard: 0 };
  const W = '#ffffff', Y = '#ffe14d', O = '#ff9a2e', C = '#f3e6c4', G = '#cdb890';
  const SPECIAL = new Set([0x43, 0x4A, 0x4B, 0x4F, 0x51, 0x53, 0x54, 0x55, 0x56, 0x57, 0x5E, 0x62, 0x69, 0x6A]); // 필살기·팀 돌진기(hit_fx.js 와 같은 표)
  const calmQ = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const CLASSIC = /[?&]classic=1(&|$)/.test(location.search);
  const Q = () => root.NKQuality ? root.NKQuality.level : 'high'; // 품질 단계(web/quality.js): 낮음 = 끔, 보통 = 파편 절반
  const lowQ = () => Q() === 'mid';
  const st = { frames: 0, events: 0, fired: { weak: 0, strong: 0, big: 0, guard: 0, down: 0 }, stops: [], stopTicks: 0, onlineFired: 0, shakes: 0, shakeMine: 0, shakeOther: 0, vib: 0, draws: 0, msMax: 0, last: null };
  let err = null, boxes = null, raf = 0, until = 0, stopEndF = -1e9, stopCur = null, lastRecvT = 0;
  const pend = [], fx = [], hosts = {};
  const level = () => { if (CLASSIC || err || (root.NKQuality && root.NKQuality.off('fx'))) return 0; const S = root.NKSettings, v = S ? S.get('impact') : undefined; return v === 0 || v === 1 || v === 2 || v === 3 ? v : 2; };
  const online = () => { try { return !!(root.__game && root.__game.online); } catch (e) { return false; } };
  const calm = () => !!(calmQ && calmQ.matches);
  // 내 선수 = 이름표(web/unit_tags.js style)와 같은 판정: 온라인 = 내 자리(room.you), 오프라인 = 사람 슬롯(배틀 = 앞 $0645-1 슬롯, 스토리 = $04A2+s bit7 꺼짐). RAM 읽기만
  const mine = (m, s) => { if (!(s >= 0 && s < 4)) return false; const T = root.NKTags, M = root.NKManga, i = M && M.tagInfo; if (!T || !T.style || !i) return false; try { return !!T.style(m, s, i).mine; } catch (x) { return false; } };
  const inFight = m => m[0x641] === 1 && (m[0x642] & 0x7F) === 2, inTitle = m => m[0x641] === 3 && (m[0x642] & 0x7F) === 5;

  // ── 덮개: 대상 캔버스 위 코어 화면 자리(256 x fh)에 디바이스 해상도 캔버스(그리기는 코어 좌표 × S 변환, 위치는 정수 코어 픽셀)
  function attach(el, o) {
    o = o || {}; const name = o.name || 'x' + Object.keys(hosts).length;
    const h = hosts[name] || (hosts[name] = { name, el: null, ov: null, ctx: null, shown: false });
    h.el = el; h.ox = o.ox || 0; h.tw = o.tw || 256; h.fh = o.fh || 240; h.shakeEl = o.shakeEl || null; h.rect = o.rect || null;
    if (!h.ov || h.ov.parentNode !== el.parentNode) {
      if (h.ov && h.ov.parentNode) h.ov.parentNode.removeChild(h.ov);
      const c = h.ov = document.createElement('canvas'); c.className = 'nk-impact'; c.style.cssText = 'position:absolute;display:none;pointer-events:none';
      el.parentNode.insertBefore(c, el.nextSibling); h.ctx = c.getContext('2d');
    }
    return h;
  }
  function layout(h) { // { L, T, s(코어 1픽셀 CSS 크기), H(보이는 줄 수) }. 대상 캔버스 배치 rect(카메라 줌 전, web/cam_fx.js NKCam.rect)
    const r = h.rect ? h.rect() : root.NKCam ? root.NKCam.rect(h.el) : h.el.getBoundingClientRect(); if (!r || !r.width) return null;
    const s = r.width / h.tw, H = typeof h.fh === 'function' ? h.fh() : h.fh;
    return { L: r.left + h.ox * s, T: r.top, s, H };
  }
  function fightHost() {
    if (hosts.fight) return hosts.fight;
    const cv = document.getElementById('c'); if (!cv || !cv.parentNode) return null;
    return attach(cv, { name: 'fight', ox: 88, tw: 432, fh: () => Math.min(+cv.dataset.fh || 240, 240), shakeEl: document.getElementById('nk-camclip') });
  }
  function titleHost() { // 메인 메뉴 배경의 원작 대련 판(ui_manga.js 가 만든 .nkm-tbg-live). 보일 때만
    const el = document.querySelector('#nkm.tbg .nkm-tbg-live'); if (!el || el.style.display === 'none' || !el.style.width) return null;
    const h = hosts.title && hosts.title.el === el ? hosts.title : attach(el, { name: 'title', ox: 192, tw: 640, fh: 240, rect: () => { const s = el.style; return { left: parseFloat(s.left), top: parseFloat(s.top), width: parseFloat(s.width) }; } });
    h.shakeEl = el; return h; // 판 좌표 = 부모(#nkm .nkm-tbg) 기준 left·top(ui_manga.js placeTbg)
  }

  // ── 연출 하나 = { k(종류), host, x, y, top, dir, t0, life, parts[], snap(찌그러짐 그림) }
  let seed = 1; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296; // 표시 전용 난수(Math.random 대신 = 캡처 재현)
  function spawn(k, h, x, y, top, dir, lv, o) {
    const now = performance.now(), isOn = online(), q = calm(), z = lv === 1 ? 0.6 : lv === 3 ? 1.35 : 1;
    const e = { k, host: h, x: Math.round(x), y: Math.round(y), top: Math.round(top), dir: dir || 0, t0: now, age: o && Number.isFinite(o.age) ? o.age : null, life: k === 'down' ? 380 : k === 'big' ? 320 : 260, parts: [], snap: null, flash: o && o.flash === 2 || isOn ? 2 : 1, lines: !q && k !== 'guard' && k !== 'weak' && k !== 'down' };
    let n = Math.round(SPARK[k] * z * (lowQ() ? 0.5 : 1));
    const live = fx.reduce((a, f) => a + f.parts.length, 0); n = Math.max(0, Math.min(n, MAXP - live));
    for (let i = 0; i < n; i++) { // 파편: 날아가는 쪽(dir)으로 원뿔, 중력
      const a = (rnd() - 0.5) * (dir ? 1.6 : 6.28), sp = (0.06 + rnd() * 0.12) * (k === 'big' ? 1.3 : 1) * z;
      const vx = dir ? Math.cos(a) * sp * dir : Math.cos(a) * sp, vy = Math.sin(a) * sp - 0.05;
      e.parts.push({ vx, vy, sz: rnd() < 0.3 && k !== 'guard' ? 2 : 1, c: i % 3 === 0 ? W : i % 3 === 1 ? Y : O, life: 140 + rnd() * 160 });
    }
    if (k === 'down') for (let i = 0; i < 6; i++) e.parts.push({ dust: 1, vx: (i & 1 ? 1 : -1) * (0.03 + 0.012 * i), vy: -0.012 - rnd() * 0.02, sz: 3, c: C, life: 300 + rnd() * 80 });
    if (!isOn && e.flash === 1 && !q && lv >= 2 && (k === 'strong' || k === 'big')) e.snap = grab(h, e); // 순간 찌그러짐(로컬만: 정지 중 그 그림이 그대로라 어긋나지 않는다)
    fx.push(e); if (fx.length > 10) fx.shift();
    const A = q ? 0 : Math.round(SHAKE[k] * (lv === 1 ? 0.5 : lv === 3 ? 1.25 : 1) * (isOn ? 0.5 : 1));
    if (A > 0 && h.shakeEl && o && o.mine === false) { st.shakeOther++; } // 흔들림 = 내 선수가 때리거나 맞은 타격만(2026-11-22 사용자 요청). 남들끼리·타이틀 대련 = 흔들림만 생략(나머지 연출·정지·소리 그대로)
    else if (A > 0 && h.shakeEl) { if (o && o.mine) st.shakeMine++; h.shake = { t0: now, A, dur: 70 + 30 * A, dir: dir || 1, vert: k === 'down' }; st.shakes++; }
    kick();
    return e;
  }
  function hdOf(h) { const d = h.name === 'fight' && root.NKHd && root.NKHd.shown ? document.getElementById('nk-hd') : null; return d && d.style.display !== 'none' && d.width ? d : null; } // HD 배경 층(web/hd_layer.js)이 보이면 그 그림이 화면 = 필드 전체 합성
  function grab(h, e) { // 피격 선수 몸 상자(발 ~ 몸 위 끝, 폭 24)를 지금 보이는 그림(HD 층 또는 대상 캔버스)에서 떠 둔다
    try {
      const w = 24, hh = Math.max(16, e.y - e.top + 2), sx = e.x - (w >> 1), sy = e.top - 1, hd = hdOf(h), k = hd ? hd.width / 256 : 1, c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(hh * k); const x = c.getContext('2d');
      if (hd) x.drawImage(hd, sx * k, sy * k, c.width, c.height, 0, 0, c.width, c.height); else { x.imageSmoothingEnabled = false; x.drawImage(h.el, h.ox + sx, sy, w, hh, 0, 0, w, hh); }
      return { c, sx, sy, w, h: hh, smooth: !!hd };
    } catch (x) { return null; }
  }
  function draw1(ctx, e, t) {
    const R = (x, y, w, h, c, a) => { ctx.globalAlpha = a === undefined ? 1 : a; ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); };
    let alive = false;
    if (e.snap && t < 3 * FMS) { // 찌그러짐: 가로 +18%·세로 -10%(발 기준) → 다음 프레임 가로 +8%
      alive = true; const s = e.snap, kx = t < 1.5 * FMS ? 1.18 : 1.08, ky = t < 1.5 * FMS ? 0.9 : 0.96, w = Math.round(s.w * kx), hh = Math.round(s.h * ky);
      ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = s.smooth; ctx.drawImage(s.c, 0, 0, s.c.width, s.c.height, e.x - (w >> 1), s.sy + s.h - hh, w, hh);
    }
    const fl = e.flash === 2 ? 2 * FMS : 1.2 * FMS;
    if (t < fl) { // 흰 반짝임: 온라인 = 몸 자리 타원(2프레임), 로컬 = 맞은 자리 작은 섬광(정지 중 보인다)
      alive = true; ctx.globalCompositeOperation = 'lighter';
      const cy = e.k === 'down' ? e.y - 4 : Math.round(e.top + (e.y - e.top) * 0.4), ry = e.flash === 2 ? Math.max(8, (e.y - e.top) >> 1) : 5, rx = e.flash === 2 ? 8 : 6;
      ctx.globalAlpha = e.flash === 2 ? 0.5 : 0.6; ctx.fillStyle = W; ctx.beginPath(); ctx.ellipse(e.x, e.flash === 2 ? Math.round((e.y + e.top) / 2) : cy, rx, ry, 0, 0, 6.283); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    if (e.lines && t < 160) { // 속도선: 맞은 자리에서 날아가는 쪽으로 가로 줄 4개
      alive = true; const ph = t / 160, d = e.dir || 1, hy = Math.round(e.top + (e.y - e.top) * 0.4);
      for (let i = 0; i < 4; i++) { const oy = [-5, -1, 3, 7][i], L = [10, 16, 12, 8][i] * (e.k === 'big' ? 1.4 : 1), x0 = e.x + d * (4 + ph * 14 + (i & 1) * 3); R(d > 0 ? x0 : x0 - L, hy + oy, Math.round(L * (1 - ph * 0.5)), 1, i & 1 ? Y : W, 0.9 * (1 - ph)); }
    }
    if (e.k === 'down' && t < e.life) { // 바닥 충격파(납작한 두 겹 고리)
      alive = true; const ph = t / e.life, rx = 5 + 26 * Math.pow(ph, 0.7), a = 1 - ph;
      for (let i = 0; i < 20; i++) { const an = i * Math.PI / 10, px = e.x + Math.cos(an) * rx, py = e.y + Math.sin(an) * rx * 0.2; R(px, py, 2, 1, ph < 0.25 ? W : C, a); }
      if (ph < 0.5) for (let i = 0; i < 12; i++) { const an = i * Math.PI / 6, r2 = rx * 0.6; R(e.x + Math.cos(an) * r2, e.y + Math.sin(an) * r2 * 0.2, 1, 1, W, a); }
    }
    const hy = e.k === 'down' ? e.y - 2 : Math.round(e.top + (e.y - e.top) * 0.4);
    for (const p of e.parts) {
      if (t >= p.life) continue; alive = true; const ph = t / p.life;
      if (p.dust) { const sz = ph < 0.4 ? 3 : ph < 0.75 ? 2 : 1; R(e.x + p.vx * t - (sz >> 1), e.y - 1 + p.vy * t, sz, sz, ph < 0.5 ? C : G, 1 - ph); }
      else R(e.x + p.vx * t, hy + p.vy * t + 0.00035 * t * t, p.sz, p.sz, ph < 0.3 ? W : p.c, 1 - ph * ph);
    }
    ctx.globalAlpha = 1;
    return alive;
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
  function tick() {
    raf = 0;
    try {
      const now = performance.now(), t0 = now; let any = false;
      for (const k in hosts) {
        const h = hosts[k], list = fx.filter(e => e.host === h); let on = false;
        if (list.length) {
          const P = layout(h);
          if (P) {
            const c = h.ov, cs = c.style, H = P.H | 0, d = root.devicePixelRatio || 1, Wd = Math.round(256 * P.s * d), Hd = Math.round(H * P.s * d);
            if (c.width !== Wd || c.height !== Hd) { c.width = Wd; c.height = Hd; }
            h.ctx.setTransform(1, 0, 0, 1, 0, 0); h.ctx.clearRect(0, 0, Wd, Hd); const S = Wd / 256; h.ctx.setTransform(S, 0, 0, S, 0, 0); // 코어 좌표로 그린다
            const px = v => Math.round(v * d) / d + 'px', l = px(P.L), tp = px(P.T), w = Wd / d + 'px', hh = Hd / d + 'px'; if (cs.left !== l) cs.left = l; if (cs.top !== tp) cs.top = tp; if (cs.width !== w) cs.width = w; if (cs.height !== hh) cs.height = hh;
            const hd = hdOf(h); if (hd && hd.parentNode === c.parentNode && hd.nextSibling !== c) c.parentNode.insertBefore(c, hd.nextSibling); // HD 층(불투명) 바로 위, 타격 이펙트·표식 층 아래
            for (const e of list) { const a = e.age !== null ? e.age : now - e.t0; if (draw1(h.ctx, e, a) || e.age !== null) on = true; else e.dead = true; }
            h.P = P;
          }
        }
        if (on && !h.shown) { h.ov.style.display = ''; h.shown = true; } else if (!on && h.shown) { h.ov.style.display = 'none'; h.shown = false; }
        // 흔들림: 감쇠 진동, 정수 코어 픽셀
        if (h.shake && h.shakeEl) {
          const sh = h.shake, ph = (now - sh.t0) / sh.dur;
          if (ph >= 1 || !h.P) { h.shakeEl.style.transform = ''; if (h.name === 'title') h.ov.style.transform = ''; h.shake = null; }
          else {
            const amp = Math.round(sh.A * (1 - ph) * (1 - ph) + 0.49), alt = Math.floor((now - sh.t0) / FMS) & 1 ? -1 : 1, d = root.devicePixelRatio || 1, s = h.P.s;
            const dx = sh.vert ? 0 : amp * alt * sh.dir, dy = sh.vert ? amp * alt : Math.round(amp * 0.5) * -alt;
            const tf = dx || dy ? 'translate(' + Math.round(dx * s * d) / d + 'px,' + Math.round(dy * s * d) / d + 'px)' : '';
            if (h.shakeEl.style.transform !== tf) h.shakeEl.style.transform = tf; if (h.name === 'title' && h.ov.style.transform !== tf) h.ov.style.transform = tf; // 타이틀: 판과 덮개가 형제라 같이 민다
            any = true;
          }
        }
        if (on) any = true;
      }
      for (let i = fx.length - 1; i >= 0; i--) if (fx[i].dead) fx.splice(i, 1);
      const dt = performance.now() - t0; st.draws++; if (dt > st.msMax) st.msMax = dt;
      if (any) raf = requestAnimationFrame(tick);
    } catch (x) { fail(x); }
  }
  function fail(x) { err = String(x && x.message || x); fx.length = 0; pend.length = 0; until = 0; for (const k in hosts) { const h = hosts[k]; if (h.ov) h.ov.style.display = 'none'; if (h.shakeEl) h.shakeEl.style.transform = ''; } console.warn('타격감 층 오류(끔): ' + err); }

  // ── 실제 타격(신호) → 연출·정지·진동
  function fire(p, f) {
    const lv = level(); if (!lv) return;
    const h = p.host === 'title' ? titleHost() : fightHost(); if (!h) return;
    const isOn = p.host === 'fight' && online();
    spawn(p.k, h, p.x, p.y, p.top, p.dir, lv, { mine: !!p.me });
    st.fired[p.k]++; if (isOn) st.onlineFired++;
    if (p.host === 'fight' && p.snd && root.NKAudioFx) try { root.NKAudioFx.play(p.snd, { s: p.s }); } catch (x) { /* 타격음 실패 = 무음, 연출은 그대로 */ } // 타격음(전투만, 연출과 같은 표시 프레임. 엔진 소리 경로 무관)
    let n = !isOn && STOP[lv][p.k] && !(root.__game && root.__game.turbo) ? STOP[lv][p.k] : 0;
    if (n) { // 카메라 트리거(web/cam_triggers.js)와 겹치지 않게: KO 슬로우 중 = 정지 없음, KO 타격·KO/필살 줌(1.05배 넘음) 중 = 2프레임 이하
      const CT = root.NKCamTrig, C = root.NKCam, cs = C ? C.state : null, zk = cs ? Math.max(cs.scale, cs.target ? cs.target.k : 1) : 1;
      if (CT && CT.slowing) n = 0; else if (p.ko || zk > 1.05) n = Math.min(n, 2);
    }
    if (n && f - stopEndF >= GAP) { // 히트스톱: 화면 프레임 n 개 동안 새 프레임 허가 없음(game.js tick)
      const now = performance.now(); until = Math.max(until, now + n * FMS); stopEndF = f;
      stopCur = { f, k: p.k, n, t: Math.round(now), ticks: 0, gap: -1, host: p.host }; st.stops.push(stopCur); if (st.stops.length > 200) st.stops.shift();
    }
    if (p.host === 'fight' && VIB[p.k] && root.NKTouch && root.NKTouch.state.shown && root.NKSettings && root.NKSettings.get('tvib') !== 0 && navigator.vibrate) {
      try { navigator.vibrate(Math.round(VIB[p.k] * (lv === 1 ? 0.6 : lv === 3 ? 1.4 : 1))); st.vib++; } catch (x) { /* 미지원 */ }
    }
  }
  function frame(f, m, pm, hev) { // hit_fx.js 구독자(NKFxSubs): 워커 프레임마다(로컬·온라인 공통, 읽기만). pm = 직전 RAM 또는 null, hev = 전투 명중 이벤트(hit_fx.detect). 끔 = 바로 돌아간다
    if (!level()) { if (pend.length) pend.length = 0; return; }
    const H = root.NKHitFx; if (!H || !H.FL) return;
    try {
      st.frames++;
      const now = performance.now(); if (stopCur && f > stopCur.f && f <= stopCur.f + 3) stopCur.gap = Math.max(stopCur.gap, Math.round(now - lastRecvT)); lastRecvT = now; // 정지 뒤 3프레임 안 가장 긴 프레임 간격(측정, 이미 허가된 프레임이 먼저 올 수 있다)
      const host = inFight(m) ? 'fight' : inTitle(m) ? 'title' : null;
      if (host && pm && (host === 'fight' ? inFight(pm) : inTitle(pm))) {
        const ev = host === 'fight' ? hev || [] : H.detect(pm, m, H.FL, true); const prev = { m: pm };
        for (const e of ev) {
          if (host === 'title' && (e.s > 1 || e.a > 1)) continue; // 타이틀 대련 = 두 사람(슬롯 0·1)
          if (!boxes && root.NKTags && root.NKTags.parseBoxes && H.rom) try { boxes = root.NKTags.parseBoxes(H.rom); } catch (x) { boxes = []; }
          const ps = H.pos(boxes, m, e.s), aAct = e.a >= 0 ? prev.m[0x49E + e.a] & 0x7F : -1, SP = H.SPECIAL || SPECIAL;
          const k = e.kind === 'dust' ? 'down' : e.kind === 'guard' ? 'guard' : e.kind === 'ring' || SP.has(aAct) ? 'big' : e.kind === 'strong' ? 'strong' : 'weak';
          const snd = e.kind === 'dust' ? 'down_thud' : e.kind === 'guard' ? 'guard_clank' : SP.has(aAct) ? 'hit_special' : e.kind === 'ring' ? 'throw_impact' : e.kind === 'strong' ? 'hit_heavy' : 'hit_light'; // 타격음 키(web/audio_fx.js, manifest)
          st.events++; pend.push({ f, k, snd, s: e.s, x: e.kind === 'dust' ? ps.x : ps.x - e.dir * 2, y: ps.y, top: ps.top, dir: e.dir, host, me: host === 'fight' && (mine(m, e.s) || mine(m, e.a)), ko: e.kind !== 'dust' && pm[0x4C2 + e.s] > 0 && m[0x4C2 + e.s] === 0 }); if (pend.length > 16) pend.shift();
        }
      } else if (!host) pend.length = 0;
      while (pend.length && pend[0].f + LAG <= f) { const p = pend.shift(); if (p.host === host) fire(p, f); } // 화면은 RAM 보다 4프레임 늦다(hit_fx.js LAG)
    } catch (x) { fail(x); }
  }
  (root.NKFxSubs = root.NKFxSubs || []).push(frame);
  function stop(t) { // game.js tick: 참 = 이번 화면 주기에는 프레임 허가 없음(오프라인 경로에서만 부른다)
    if (!until) return false;
    if (performance.now() < until && level() && !online()) { if (stopCur) stopCur.ticks++; st.stopTicks++; return true; }
    until = 0; return false;
  }
  root.NKImpact = {
    attach, frame, stop, LAG,
    trigger(kind, x, y, dir, o) { // 직접 연출(검증·타이틀 공용). 반환: 연출 객체 또는 null(끔)
      o = o || {}; const lv = level(); if (!lv || !SPARK.hasOwnProperty(kind)) return null;
      const h = o.host === 'title' ? titleHost() : !o.host || o.host === 'fight' ? fightHost() : hosts[o.host]; if (!h) return null;
      if (o.age !== undefined) for (const e of fx) if (e.age !== null) e.dead = true;
      const e = spawn(kind, h, x, y, o.top === undefined ? y - 28 : o.top, dir, lv, o);
      if (o.stop !== false && !online() && STOP[lv][kind]) { until = Math.max(until, performance.now() + STOP[lv][kind] * FMS); }
      return { kind, host: h.name, parts: e.parts.length, snap: !!e.snap };
    },
    clear() { for (const e of fx) e.dead = true; until = 0; kick(); },
    get level() { return level(); }, get quality() { return Q(); }, get error() { return err; }, get stats() { return st; }, get stopping() { return !!until && performance.now() < until; },
  };
})(window);
