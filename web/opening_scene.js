'use strict';
// 오프닝 장면(원작 오프닝 데모 = 화면 키 $0641 4:0~4:7, 편지·도전장·쿠니오/리키. 원작은 전원 켬 → 로고 → 이 데모 → 타이틀 순서로 무입력일 때 나온다).
// 스토리 새 게임에서 에디트 「확인」 직후(1인) 또는 원작 에디트 2명이 끝난 직후(2인 협력, 1회) 한 번 재생한다. 이어하기·배틀·온라인은 재생하지 않는다.
// 구조(본 엔진·저장 기록·락스텝 불변):
//   - 별도 워커(web/worker.js 그대로, 공유 메모리 ctl 도 따로)를 시작 상태 /state/opening.json(tools/make_opening_state.js: 오라클 전원 켬 무입력 → 4:0 첫 메인 루프 진입)으로 만든다.
//     그 엔진은 무입력으로만 돈다(패드 칸 0). 본 엔진(game.js 워커)과 메모리·패드·기록을 공유하지 않는다. 오라클 대비 화면·소리 비트 동일: tools/opening_state_verify.js
//   - 재생하는 동안 본 엔진은 프레임 허가를 멈춘다(window.__game.hold, 정지(P)와 같은 경로). 멈춘 동안 본 엔진은 한 프레임도 진행하지 않으므로 스토리 저장 기록(rec 1 입력열)에 아무것도 더해지지 않는다.
//     본 엔진 소리도 정지 상태라 나지 않는다(소리는 이 장면 쪽만).
//   - 화면 = 코어 256x240 최근접 정수배 + 한글 덧그리기(web/korean.js 를 그대로 호출. 표 web/ko_table.json 의 화면 4:0~4:7·스크립트 1~12, tools/ko_build_table.js). 한글 층이 꺼져 있으면 원작 그대로.
//   - 소리 = 이 워커의 APU 출력을 자기 AudioContext + web/audio_worklet.js(같은 출력단)로 낸다.
//   - 미리 준비: 스토리 「새 게임」을 고를 때 워커를 만들어 첫 프레임까지 돌려 둔다(에디트 확인 시점에는 바로 시작). 준비가 안 끝났으면 그 사이는 신규 층의 진행 막대(busy)가 보인다.
//   - 건너뛰기: Enter(START)·Z·1P A 키(기본 A)·Esc·Space·클릭·터치·게임패드 A/START. 원작 데모가 끝나 타이틀(3:x)이 되면 그 프레임을 그리지 않고 끝낸다.
//   - 설정 「오프닝 장면」(nk_manga_settings.op, 0 = 끔, 기본 켬). ?op=0 · ?op=1 = 설정과 무관하게 끔·켬(검증용)
(function () {
  const SET_KEY = 'nk_manga_settings', RATE = 60.0988, MAX_AHEAD = 3, CREDIT = 0, AUDIO = 4, KO = 5, SR = 44100;
  const OP_Q = (/[?&]op=([01])(&|$)/.exec(location.search) || [])[1];
  const RING = 65536, PREBUF = 2205;
  let pre = null, played = false, armed = false, on = false, sawEdit2 = false;
  const stat = { prepared: 0, plays: 0, frames: 0, samples: 0, peak: 0, skipped: '', ended: '', readyMs: -1, waitMs: -1, holdOk: null, koErr: '' };
  function settings() { try { return JSON.parse(localStorage.getItem(SET_KEY) || 'null') || {}; } catch (e) { return {}; } }
  const enabled = () => OP_Q !== undefined ? OP_Q === '1' : settings().op !== 0;
  const canRun = () => typeof SharedArrayBuffer !== 'undefined' && !!window.crossOriginIsolated && typeof Worker === 'function';

  // ── 준비: 워커 만들기 + 첫 프레임까지(허가 0 이라 그 뒤에는 멈춰 기다린다)
  function prepare() {
    if (pre || !enabled() || !canRun()) return;
    const t0 = performance.now(), p = pre = { ctl: new Int32Array(new SharedArrayBuffer(64)), worker: null, ready: false, last: null, granted: 0, received: 0, fatal: null, waiters: [] };
    Atomics.store(p.ctl, AUDIO, SR); Atomics.store(p.ctl, KO, window.NKKorean ? 1 : 0); stat.prepared++;
    Promise.all([
      fetch('/rom/nekketsu.nes').then(r => { if (!r.ok) throw new Error('ROM ' + r.status); return r.arrayBuffer(); }),
      fetch('/state/opening.json').then(r => { if (!r.ok) throw new Error('opening.json ' + r.status + ' (node tools/make_opening_state.js 필요)'); return r.json(); }),
    ]).then(([rom, boot]) => {
      if (pre !== p) return;
      const w = p.worker = new Worker('worker.js');
      w.onmessage = ev => onFrame(p, ev.data);
      w.onerror = e => fail(p, String(e && e.message || e));
      w.postMessage({ ctl: p.ctl.buffer, rom: new Uint8Array(rom), boot });
    }).catch(e => fail(p, String(e && e.message || e)));
    p.t0 = t0;
    p.idle = setTimeout(() => { if (pre === p && !(cur && cur.p === p)) dispose(); }, 300000); // 미리 만든 워커가 5분 동안 쓰이지 않으면(에디트까지 가지 않음) 버린다. 그 뒤 재생 때는 play 가 다시 준비한다
  }
  function fail(p, why) { p.fatal = why; console.warn('오프닝 장면 준비 실패(건너뜀): ' + why); p.waiters.splice(0).forEach(f => f()); if (on && cur && cur.p === p) finish('fail'); }
  function dispose() { if (pre) { clearTimeout(pre.idle); if (pre.worker) pre.worker.terminate(); pre = null; } }

  // ── 재생 상태
  let cur = null; // { p, done, root, cv, ctx, img, img32, ac, ring, st, node, acc, last, raf, gp }
  function onFrame(p, d) {
    if (d.fatal) return fail(p, d.fatal);
    if (d.ready) return;
    p.received++;
    if (!p.ready) { p.ready = true; p.last = d; p.granted = 1; stat.readyMs = Math.round(performance.now() - p.t0); p.waiters.splice(0).forEach(f => f()); return; } // 첫 프레임(4:0 검정): 재생 시작 때 그린다
    p.last = d;
    if (!cur || cur.p !== p) return;
    if (d.ram[0x641] === 3) return finish('end'); // 원작 데모 끝 → 타이틀(그리지 않는다)
    draw(d);
  }
  function draw(d) {
    const c = cur; if (!c || !d.fb) return;
    c.img32.set(d.fb); c.ctx.putImageData(c.img, 0, 0);
    const K = window.NKKorean;
    if (K && K.ready && d.ko) { try { K.draw(c.ctx, 0, d.ko, d.ram); } catch (e) { stat.koErr = String(e && e.message || e); Atomics.store(c.p.ctl, KO, 0); c.ctx.putImageData(c.img, 0, 0); } }
    stat.frames++;
    if (d.audio && d.audio.length) pushAudio(d.audio);
  }
  function pushAudio(a) {
    const c = cur; if (!c || !c.ring) return;
    let w = Atomics.load(c.st, 0); const n = a.length;
    for (let k = 0; k < n; k++) { const s = a[k]; c.ring[(w + k) & (RING - 1)] = s; if (s > stat.peak) stat.peak = s; }
    w += n; stat.samples += n; Atomics.store(c.st, 0, w);
  }
  function initAudio(c) { // 이 장면 전용 출력(본 엔진 소리는 정지 상태라 나지 않는다)
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    let vol = 0.8; { const s = settings(); if (s.vol >= 0 && s.vol <= 10) vol = s.vol / 10; if (s.mute === 1) vol = 0; } // mute = 설정 「음소거」(web/settings.js)
    try { c.ac = new AC({ sampleRate: SR }); } catch (e) { c.ac = null; return; }
    if (c.ac.state === 'suspended') c.ac.resume().catch(() => {});
    const sab = new SharedArrayBuffer(RING * 4); c.ring = new Float32Array(sab); c.st = new Int32Array(new SharedArrayBuffer(32)); c.adj = 0;
    const A = c.ac;
    if (A.audioWorklet && typeof AudioWorkletNode === 'function') {
      A.audioWorklet.addModule('audio_worklet.js').then(() => {
        if (cur !== c) return;
        const q = (Atomics.load(c.st, 0) - Atomics.load(c.st, 1)) | 0; if (q > PREBUF) Atomics.store(c.st, 1, Atomics.load(c.st, 0) - PREBUF);
        const nd = c.node = new AudioWorkletNode(A, 'nk-out', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { ring: sab, st: c.st.buffer, vol } });
        nd.port.onmessage = e => { c.adj = e.data.adj || 0; };
        nd.connect(A.destination);
      }).catch(e => console.warn('오프닝 소리 출력 실패: ' + (e && e.message || e)));
    }
  }

  // ── 본 엔진 멈춤(window.__game.hold, web/game.js)
  const hold = v => { const g = window.__game; if (g && typeof g.hold === 'function') { g.hold(v); return true; } return false; };

  // play(done): 재생해야 하면 재생하고 끝난 뒤 done(), 아니면 바로 done(). 반환 = 재생(또는 준비 대기)을 시작했으면 true
  function play(done) {
    if (on) return true;
    if (played || !enabled() || !canRun()) { done(); return false; }
    played = true; if (!pre) prepare(); if (!pre) { done(); return false; }
    on = true; stat.plays++; stat.skipped = ''; stat.ended = '';
    const p = pre; cur = { p, done, w0: performance.now() };
    stat.holdOk = hold(true);
    addEventListener('keydown', onKey, true); addEventListener('keyup', blockKey, true);
    const go = () => { if (cur && cur.p === p && !cur.root) { if (p.fatal) return finish('fail'); stat.waitMs = Math.round(performance.now() - cur.w0); show(); } };
    if (p.ready || p.fatal) go(); else { p.waiters.push(go); cur.tm = setTimeout(() => { if (cur && cur.p === p && !cur.root) finish('timeout'); }, 8000); }
    return true;
  }
  function show() {
    const c = cur, p = c.p; clearTimeout(c.tm);
    const root = c.root = document.createElement('div'); root.id = 'nk-opening';
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#000;display:flex;align-items:center;justify-content:center;cursor:pointer;touch-action:none;user-select:none';
    const cv = c.cv = document.createElement('canvas'); cv.width = 256; cv.height = 240; cv.style.cssText = 'image-rendering:pixelated;image-rendering:crisp-edges';
    const sk = document.createElement('div'); sk.textContent = '건너뛰기 ▶▶'; sk.style.cssText = 'position:absolute;right:16px;bottom:12px;font:14px NKM9,Galmuri9,sans-serif;color:#fff;opacity:.55;letter-spacing:1px';
    root.appendChild(cv); root.appendChild(sk); document.body.appendChild(root);
    c.ctx = cv.getContext('2d'); c.img = c.ctx.createImageData(256, 240); c.img32 = new Uint32Array(c.img.data.buffer);
    root.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); finish('tap'); });
    root.addEventListener('click', e => { e.stopPropagation(); });
    c.fit = () => { const dpr = window.devicePixelRatio || 1, m = Math.min(innerWidth / 256, innerHeight / 240); let s = Math.floor(m * dpr) / dpr; if (s * dpr < 1) s = m; cv.style.width = 256 * s + 'px'; cv.style.height = 240 * s + 'px'; };
    c.fit(); addEventListener('resize', c.fit);
    Atomics.store(p.ctl, KO, window.NKKorean && window.NKKorean.ready ? 1 : 0); initAudio(c);
    c.gp = gpState(); c.acc = 0; c.last = 0;
    if (p.last) draw(p.last);
    const tick = t => {
      if (cur !== c) return; c.raf = requestAnimationFrame(tick);
      const g = gpState(), hit = g & ~c.gp; c.gp = g; if (hit) return finish('pad');
      if (!c.last) c.last = t; let dt = t - c.last; c.last = t; if (dt > 100) dt = 100;
      c.acc = Math.min(c.acc + dt * RATE * (1 + (c.adj || 0)) / 1000, MAX_AHEAD);
      let n = 0; while (c.acc >= 1 && p.granted - p.received < MAX_AHEAD) { c.acc -= 1; n++; p.granted++; } // 첫 프레임은 허가 없이 온다(받은 뒤 granted 1 로 셈)
      if (n) { Atomics.store(p.ctl, CREDIT, p.granted); Atomics.notify(p.ctl, CREDIT); }
    };
    c.raf = requestAnimationFrame(tick);
  }
  function gpState() { let v = 0; const gps = navigator.getGamepads ? navigator.getGamepads() : []; for (const g of gps) { if (!g) continue; if (g.buttons[0] && g.buttons[0].pressed) v |= 1; if (g.buttons[9] && g.buttons[9].pressed) v |= 2; } return v; }
  const SKIP_KEYS = new Set(['Enter', 'NumpadEnter', 'Escape', 'KeyZ', 'Space']); // + 키 표의 1P A 키(기본 A, web/keymap.js)
  function onKey(e) { // 재생(또는 준비 대기) 중 키는 전부 이 장면이 받는다(본 게임·신규 층으로 새지 않게). F1~F12 만 브라우저에 둔다
    if (!on || /^F\d+$/.test(e.code)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!e.repeat && (SKIP_KEYS.has(e.code) || (window.NKKeymap && window.NKKeymap.nav(e.code).ok)) && cur && cur.root) finish('key');
  }
  function blockKey(e) { if (on && !/^F\d+$/.test(e.code)) { e.stopImmediatePropagation(); } }
  function finish(why) {
    if (!on) return; on = false;
    const c = cur; cur = null; clearTimeout(c.tm); if (c.raf) cancelAnimationFrame(c.raf);
    if (why === 'end') stat.ended = 'end'; else stat.skipped = why;
    removeEventListener('keydown', onKey, true); removeEventListener('keyup', blockKey, true);
    if (c.fit) removeEventListener('resize', c.fit);
    if (c.root) c.root.remove();
    if (c.node) try { c.node.disconnect(); } catch (e) { /* 무시 */ }
    if (c.ac) c.ac.close().catch(() => {});
    if (pre === c.p) dispose();
    hold(false);
    try { c.done(); } catch (e) { console.error(e); }
  }

  // 스토리 메뉴에서 새 게임·이어하기를 고를 때(web/ui_manga.js storyPick): 새 게임이면 재생 자격을 다시 주고 미리 준비한다
  function arm(isNew) {
    if (on) return;
    played = false; sawEdit2 = false; armed = !!isNew;
    if (!isNew) { played = true; dispose(); return; }
    prepare();
  }
  // 2인 협력: 원작 에디트 화면(5:2, 생일·혈액형 단계 $0670 3·4 를 거침 = 에디트)을 두 사람이 마치고 5:3 이후로 넘어간 첫 순간 한 번. 본 엔진 RAM 사본(읽기만)을 본다
  setInterval(() => {
    if (!armed || played || on) return;
    const g = window.__game, m = g && g.mirror && g.mirror.m; if (!m || m[0x645] !== 1 || m[0x641] !== 5) return;
    const sub = m[0x642] & 0x7F;
    if (sub === 2) { const s = m[0x670] & 0x7F; if (s === 3 || s === 4) sawEdit2 = true; return; }
    if (sawEdit2 && sub >= 3 && sub <= 5) { armed = false; play(() => {}); }
  }, 50);
  window.NKOpening = { arm, prepare, play, get on() { return on; }, get enabled() { return enabled(); }, stat, get ready() { return !!(pre && pre.ready); } };
})();
