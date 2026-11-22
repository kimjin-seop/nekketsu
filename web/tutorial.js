'use strict';
// 튜토리얼 T2(analysis/27 3절·T2 절, 판정기·권고 조합 = analysis/28 · tools/tutorial_oracle.js detector()). 표시·판정 전용 층(window.NKTutorial).
//   읽기만 한다: game.js onWorker 가 로컬 프레임마다 NKTutorial.frame(프레임 번호, RAM 사본)을 부른다(워커가 이미 보내는 2KB 사본, 온라인에서는 부르지 않는다).
//   RAM 쓰기·패드 주입·엔진·워커 변경 없음 → 같은 입력이면 엔진 상태가 튜토리얼 유무와 같다(tools/tutorial_check.js).
// 흐름: arm()(배틀 1인 튜토리얼 판 구동 직전, ui_manga.js tutGo) 또는 start()(일시정지 → 설정 「튜토리얼 다시 보기」 = 지금 판에서) → 전투(1:2)에서
//   슬롯 0 행동($049E & 0x7F)이 0x65(틱 처리 제외)를 벗어난 첫 프레임에 안내를 띄운다 → 단계 이동·달리기·점프·펀치·킥·맞히기 3회(판정기 이벤트 차례대로) →
//   모두 성립하면 짧게 「완료」 뒤 닫고 설정 tut = 1, tutok = 1 저장, NKTutorial.onDone(정보) 호출(칭호 지급은 프로필 서버 P1 이후).
//   건너뛰기(버튼·Tab) = tut 1 만(보상 없음). 단계 도중 전투가 끝나면 tut 1(첫 1회 자동은 다시 띄우지 않는다, 설정에서 다시 보기).
// 설정 칸(web/settings.js): tut 0 = 아직(다음 「배틀 → 1인」 때 자동) · 1 = 봤음(완료·건너뜀·도중 종료) / tutok 0·1 = 단계를 모두 성립한 적 있음. ?tut=0 = 이 탭에서 자동 시작 안 함(스모크용)
(function (root) {
  const HAS_DOM = typeof document !== 'undefined';
  const Q = HAS_DOM && root.location ? root.location.search : '';
  const NO_AUTO = /[?&]tut=0(&|$)/.test(Q), CLASSIC = /[?&]classic=1(&|$)/.test(Q);
  // ── 참조 판정기(tools/tutorial_oracle.js detector() 그대로) ──
  const key = m => m[0x641] + ':' + (m[0x642] & 0x7F), inFight = m => key(m) === '1:2';
  const act = (m, s) => m[0x49E + s] & 0x7F;
  const out_ = (m, s) => !!(m[0x4A2 + s] & 0x40) || act(m, s) === 0x66 || act(m, s) === 0x67;
  const WALK = new Set([0x03]), RUN = new Set([0x04]), JUMP = new Set([0x05, 0x06]);
  const PUNCH = new Set([0x0F, 0x13, 0x11, 0x17, 0x15, 0x4A, 0x56, 0x69, 0x54]);
  const KICK = new Set([0x10, 0x12, 0x16, 0x14, 0x4B, 0x57, 0x6A, 0x53]);
  function detector() {
    const st = { walkF: 0, runF: 0, koed: [0, 0, 0, 0] };
    return (p, m) => {
      const ev = [];
      if (!inFight(p) || !inFight(m)) return ev;
      const a = act(m, 0), pa = act(p, 0);
      if (WALK.has(a)) { if (++st.walkF === 16) ev.push('move'); }
      if (RUN.has(a)) { if (++st.runF === 8) ev.push('run'); } else st.runF = 0;
      if (JUMP.has(a) && !JUMP.has(pa)) ev.push('jump');
      if (PUNCH.has(a) && !PUNCH.has(pa)) ev.push('punch');
      if (KICK.has(a) && !KICK.has(pa)) ev.push('kick');
      for (let s = 1; s < 4; s++) {
        if (p[0x4BE + s] === 0xFF && m[0x4BE + s] === 0) ev.push('hit');
        if (!st.koed[s] && out_(m, s)) { st.koed[s] = 1; ev.push('ko'); }
      }
      return ev;
    };
  }
  // 권고 조합(analysis/28 3.2절): 쿠니오(0,0) vs 이시즈키(0,2)·야마이시(0,3)·진나이(1,3), 스테이지 커서 0, 룰5(rule 4). ui_manga.js 는 캐릭터 id(줄*4+칸)로 쓴다
  const OPT = { players: 1, edit: false, p1: { row: 0, col: 0 }, enemies: [{ row: 0, col: 2 }, { row: 0, col: 3 }, { row: 1, col: 3 }], stage: 0, rule: 4 };
  const PICKS = [0, 2, 3, 7];
  const STEPS = ['move', 'run', 'jump', 'punch', 'kick', 'hit'], HITS = 3, WAIT_MAX = 7200, DONE_MS = 1400; // WAIT_MAX = arm 뒤 전투 시작을 기다리는 최대 엔진 프레임
  const S = { st: 'idle', src: '', wait: 0, step: 0, hits: 0, det: null, prev: null, readyF: -1, stepAt: [], doneT: 0, log: [] }; // st: idle | wait | run | done
  const SET = () => root.NKSettings || null;
  const save = (k, v) => { const N = SET(); if (!N) return; try { N.data[k] = v; N.save(); } catch (e) { /* 저장 실패 = 이번 세션만 */ } };

  function arm(src) { S.st = 'wait'; S.src = src || 'battle'; S.wait = 0; S.step = 0; S.hits = 0; S.det = null; S.prev = null; S.readyF = -1; S.stepAt = []; ensureRaf(); return true; }
  function frame(f, m) {
    if (S.st === 'idle' || !m) return;
    const p = S.prev; S.prev = m;
    if (S.st === 'wait') {
      if (++S.wait > WAIT_MAX) { S.st = 'idle'; return; }
      if (inFight(m) && act(m, 0) !== 0x65) { S.st = 'run'; S.readyF = f; S.det = detector(); S.prev = m; render(); }
      return;
    }
    if (S.st !== 'run') return;
    if (!inFight(m)) return finish('left'); // 전투 끝(1:5 등) = 도중 종료
    if (!p) return;
    for (const e of S.det(p, m)) {
      const want = STEPS[S.step];
      if (e !== want) continue;
      if (e === 'hit' && ++S.hits < HITS) { render(); continue; }
      S.stepAt.push(f - S.readyF); S.step++;
      if (S.step >= STEPS.length) return finish('done');
      render(true);
    }
  }
  function finish(why) {
    if (why === 'done') {
      S.st = 'done'; S.doneT = HAS_DOM ? performance.now() : 0; save('tutok', 1); save('tut', 1);
      S.log.push({ why, src: S.src, stepAt: S.stepAt.slice() });
      const cb = api.onDone; if (typeof cb === 'function') try { cb({ src: S.src, stepAt: S.stepAt.slice() }); } catch (e) { console.warn('튜토리얼 완료 훅 오류: ' + (e && e.message || e)); }
      render(true); return;
    }
    S.log.push({ why, src: S.src, step: S.step }); S.st = 'idle'; save('tut', 1); render();
  }
  function skip() { if (S.st !== 'run' && S.st !== 'wait') return false; finish('skip'); return true; }

  // ── 표시(T3: 단계 점 6개 + 키캡 + 동작 아이콘 + 짧은 말 + 건너뛰기). 그림 = web/img/tutorial(1x 를 정수배 --u 로, pixelated), 키 이름은 DOM 글자(리매핑 그대로) ──
  // T4 자리: 코어 아래 → 위 여백(가로 줄) → 코어 옆 여백(세로 카드, 게이지 패널·터치 패드를 피함) → 필드 안 위쪽. 게임패드 = 게임에 안 쓰는 버튼(Y·LB·RB·X 중 첫 빈 것)으로 건너뛰기
  let el = null, dots = [], txt = null, btn = null, raf = 0, layKey = '', vis = false, gpPrev = -1, gpAny = false, gpBtn = -1;
  const touchOn = () => { const T = root.NKTouch; try { return !!(T && T.state.shown); } catch (e) { return false; } };
  const KM = () => root.NKKeymap || null;
  const DEFK = { left: ['ArrowLeft'], right: ['ArrowRight'], a: ['KeyA'], b: ['KeyS'], jump: ['KeyD'] }, PADN = ['A', 'B', 'X', 'Y', 'LB', 'RB'];
  const kn = id => { const k = KM(); const v = k ? k.keyName(0, id) : { a: 'A', b: 'S', jump: 'D', left: '←', right: '→' }[id]; return v && v !== '—' ? v : ''; }; // 1P 현재 키(리매핑을 따른다)
  const codes = () => { const k = KM(); try { return k ? k.map.k[0] : DEFK; } catch (e) { return DEFK; } };
  function gpSkip() { let used = []; try { const k = KM(); used = k ? Object.values(k.map.p) : [0, 2, 1, 8, 9]; } catch (e) { used = []; } for (const b of [3, 4, 5, 2]) if (used.indexOf(b) < 0) return b; return -1; } // 게임 버튼과 겹치지 않는 것
  const cap = (t, id) => '<kbd' + (id ? ' data-k="' + id + '"' : '') + '>' + String(t).replace(/[<>&"]/g, '') + '</kbd>';
  const ico = n => '<i class="ic ' + n + '"></i>', w = t => '<b>' + t + '</b>';
  function line() {
    const tch = touchOn(), name = STEPS[S.step];
    if (S.st === 'done') return w('완료!');
    if (tch) {
      if (name === 'move') return ico('t-stick') + w('스틱 이동');
      if (name === 'run') return root.NKSettings && root.NKSettings.get('tdash') === 0 ? ico('t-double') + w('스틱 두 번 달리기') : ico('t-edge') + w('스틱 끝까지 달리기');
      if (name === 'jump') return ico('t-jump') + w('점프');
      if (name === 'punch') return ico('t-a') + ico('punch') + w('펀치');
      if (name === 'kick') return ico('t-b') + ico('kick') + w('킥');
      return ico('t-a') + ico('t-b') + ico('hit') + w('맞히기 ' + S.hits + '/' + HITS);
    }
    const A = kn('a') || 'A', B = kn('b') || 'B', J = kn('jump'), L = kn('left') || '←', R = kn('right') || '→';
    if (name === 'move') return cap(L, 'left') + cap(R, 'right') + w('이동');
    if (name === 'run') return cap(L, 'left') + cap(L, 'left') + w('/') + cap(R, 'right') + cap(R, 'right') + ico('run') + w('달리기');
    if (name === 'jump') return (J ? cap(J, 'jump') : cap(A, 'a') + w('+') + cap(B, 'b')) + ico('jump') + w('점프');
    if (name === 'punch') return cap(A, 'a') + ico('punch') + w('펀치');
    if (name === 'kick') return cap(B, 'b') + ico('kick') + w('킥');
    return cap(A, 'a') + cap(B, 'b') + ico('hit') + w('맞히기 ' + S.hits + '/' + HITS);
  }
  function build() {
    const I = n => 'url(/img/tutorial/' + n + '_1x.png)', css = document.createElement('style'), U = n => 'calc(var(--u,2px)*' + n + ')';
    const ic = { run: 'act_run', jump: 'act_jump', punch: 'act_punch', kick: 'act_kick', hit: 'act_hit', skip: 'skip', 't-stick': 'touch_stick', 't-edge': 'touch_stick_edge', 't-double': 'touch_stick_double', 't-a': 'touch_a', 't-b': 'touch_b', 't-jump': 'touch_jump' };
    const k9 = (n, sl) => 'border-image:' + I(n) + ' ' + sl.join(' ') + ' fill/' + sl.map(U).join(' ') + ';border-width:' + sl.map(U).join(' ');
    css.textContent = '#nktut{position:fixed;z-index:4;left:0;top:0;display:none;align-items:center;gap:8px;box-sizing:border-box;min-height:var(--th,32px);padding:3px 4px 3px 8px;border:2px solid #FFE14D;border-radius:6px;background:rgba(10,10,16,.86);color:#fff;font:var(--tf,15px)/1 Galmuri11,monospace;white-space:nowrap;pointer-events:none;-webkit-user-select:none;user-select:none}'
      + '#nktut.on{display:flex}#nktut.v{flex-direction:column;gap:5px;padding:6px 4px;white-space:normal;text-align:center}#nktut.v .t{flex-wrap:wrap;justify-content:center}'
      + '#nktut .d{display:flex;gap:' + U(2) + '}#nktut .d i{width:' + U(4) + ';height:' + U(4) + ';background:' + I('dot_todo') + ' 0 0/100% 100%;image-rendering:pixelated}#nktut .d i.ok{background-image:' + I('dot_ok') + '}#nktut .d i.cur{background-image:' + I('dot_cur') + '}'
      + '#nktut .t{display:inline-flex;align-items:center;gap:3px}#nktut .t b{font-weight:400;margin:0 2px}'
      + '#nktut kbd{display:inline-block;box-sizing:border-box;min-width:' + U(12) + ';padding:1px 2px;border-style:solid;' + k9('key_9s_lit', [2, 2, 3, 2]) + ';image-rendering:pixelated;background:none;border-radius:0;color:#fff;font:inherit;line-height:1;text-align:center}'
      + '#nktut kbd.pr{' + k9('key_9s_pressed', [3, 2, 2, 2]) + '}#nktut .x kbd{' + k9('key_9s_normal', [2, 2, 3, 2]) + ';color:#BEBAD2;margin-left:4px}'
      + '#nktut .ic{flex:none;display:inline-block;width:' + U(12) + ';height:' + U(12) + ';background:0 0/100% 100% no-repeat;image-rendering:pixelated}' + Object.keys(ic).map(k => '#nktut .ic.' + k + '{background-image:' + I(ic[k]) + '}').join('')
      + '#nktut .t.flash{animation:nktut-f .35s ease-out}@keyframes nktut-f{from{color:#3DDC84}to{color:#fff}}#nktut.fin{border-color:#3DDC84}#nktut.fin .x{display:none}'
      + '#nktut .x{display:inline-flex;align-items:center;gap:2px;pointer-events:auto;cursor:pointer;border:0;border-left:1px solid #4A4660;background:none;color:#BEBAD2;font:inherit;font-size:.85em;padding:0 4px 0 8px;min-height:var(--th,32px);touch-action:manipulation}#nktut .x{position:relative}#nktut .x::after{content:"";position:absolute;left:50%;top:50%;width:max(100%,44px);height:max(100%,44px);transform:translate(-50%,-50%)}#nktut.v .x .ic{display:none}#nktut.v .x{flex-wrap:wrap;justify-content:center;border-left:0;border-top:1px solid #4A4660;padding:4px 2px 0;min-height:0}';
    document.head.appendChild(css);
    el = document.createElement('div'); el.id = 'nktut'; el.setAttribute('role', 'status');
    const d = document.createElement('span'); d.className = 'd'; dots = STEPS.map(() => { const i = document.createElement('i'); d.appendChild(i); return i; });
    txt = document.createElement('span'); txt.className = 't';
    btn = document.createElement('button'); btn.className = 'x'; btn.type = 'button'; btn.tabIndex = -1;
    btn.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); skip(); });
    el.appendChild(d); el.appendChild(txt); el.appendChild(btn); document.body.appendChild(el);
    window.addEventListener('keydown', e => { if (e.code === 'Tab' && vis && S.st === 'run') { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) skip(); } else press(e, true); }, true);
    window.addEventListener('keyup', e => press(e, false), true);
  }
  function press(e, on) { // 누른 키캡 = pressed 그림(읽기만, 키 처리는 그대로 흘려보낸다)
    if (!vis || !txt || (on && e.repeat)) return; const m = codes();
    for (const id in m) if ((m[id] || []).indexOf(e.code) >= 0) txt.querySelectorAll('kbd[data-k="' + id + '"]').forEach(k => k.classList.toggle('pr', on));
  }
  function render(flash) {
    if (!HAS_DOM) return;
    if (!el) { if (S.st === 'idle') return; build(); }
    dots.forEach((i, k) => { i.className = S.st === 'done' || k < S.step ? 'ok' : k === S.step ? 'cur' : ''; });
    gpBtn = gpSkip();
    txt.innerHTML = line(); btn.innerHTML = ico('skip') + '건너뛰기' + (touchOn() ? '' : gpAny && gpBtn >= 0 ? cap(PADN[gpBtn]) : cap('Tab'));
    el.classList.toggle('fin', S.st === 'done');
    if (flash) { txt.classList.remove('flash'); void txt.offsetWidth; txt.classList.add('flash'); }
    layKey = ''; show();
  }
  const G = () => root.__game || null;
  function gameShown() { const g = G(); if (!g) return false; const t = g.touch; return t ? !!t.show && !g.online : !g.paused && !g.online; } // 덮개·일시정지·오류·빨리 감기 중이면 숨김
  function show() {
    const want = (S.st === 'run' || S.st === 'done') && gameShown();
    if (want !== vis) { vis = want; el.classList.toggle('on', want); }
    if (want) place();
  }
  function gpPoll() { // 안내가 보이는 동안만: 연결 여부(표기 바꿈) + 건너뛰기 버튼(누른 순간, 처음부터 눌려 있던 것은 무시)
    let any = false, on = false;
    try { for (const g of (navigator.getGamepads ? navigator.getGamepads() : [])) { if (!g) continue; any = true; if (gpBtn >= 0 && g.buttons[gpBtn] && g.buttons[gpBtn].pressed) on = true; } } catch (e) { return; }
    if (any !== gpAny) { gpAny = any; render(); }
    if (on && gpPrev === 0 && S.st === 'run') { gpPrev = 1; skip(); return; }
    gpPrev = on ? 1 : 0;
  }
  function hudRects() { const o = []; document.querySelectorAll('#nkm-hud .nkh-panel').forEach(p => { const b = p.getBoundingClientRect(); if (b.width > 0 && b.height > 0) o.push([b.left, b.top, b.right, b.bottom]); }); return o; }
  function padRects() { // 터치 패드 버튼·≡·전체 화면·스틱 자리(web/touch_pad.js 배치, 가운데 기준) → [l, t, r, b]
    const o = []; let L = null; try { L = root.NKTouch.state.layout; } catch (e) { L = null; } if (!L) return o;
    const c = (x, y, r) => o.push([x - r - 4, y - r - 4, x + r + 4, y + r + 4]);
    for (const k in L.btn || {}) c(L.btn[k][0], L.btn[k][1], L.btn[k][2]);
    if (L.p) c(L.p[0], L.p[1], 24); if (L.f && L.fs) c(L.f[0], L.f[1], 24); if (L.hint) c(L.hint[0], L.hint[1], L.R);
    return o;
  }
  function place() {
    const cv = document.getElementById('c'); if (!cv) return;
    const r = root.NKCam ? root.NKCam.rect(cv) : cv.getBoundingClientRect(), s = r.height / 240 || 1, fh = +cv.dataset.fh || 240, fr = 3 * s;
    const W = innerWidth, H = innerHeight, tch = touchOn(), A = root.NKA11y, k1 = A && A.scale || 1, hud = hudRects();
    const core = { l: r.left + 88 * s - fr, r: r.left + 344 * s + fr, t: r.top - fr, b: r.top + fh * s + fr }, cx = r.left + 216 * s;
    const k = [W, H, Math.round(core.l), Math.round(core.t), Math.round(core.b), tch ? 1 : 0, k1, hud.map(q => q.map(Math.round)).join(';')].join(','); if (k === layKey) return; layKey = k;
    const f0 = Math.max(13, Math.min(18, Math.round(Math.min(W, H) / 40))), fs = Math.round(f0 * k1);
    const setF = f => { el.style.setProperty('--tf', f + 'px'); el.style.setProperty('--u', (f >= 21 ? 3 : 2) + 'px'); el.style.setProperty('--th', Math.round(f * 2.1) + 'px'); }; setF(fs);
    const obs = hud.concat(tch ? padRects() : []);
    const bad = (x, y, w, h) => x < 2 || y < 2 || x + w > W - 2 || y + h > H - 2 || (x < core.r && core.l < x + w && y < core.b && core.t < y + h) || obs.some(o => x < o[2] && o[0] < x + w && y < o[3] && o[1] < y + h);
    el.classList.remove('v'); el.style.maxWidth = Math.floor(W - 8) + 'px';
    let w = el.offsetWidth, h = el.offsetHeight, pos = null;
    const gx = Math.round(Math.max(4, Math.min(W - 4 - w, cx - w / 2)));
    for (const y of [core.b + Math.max(3, Math.min(12, (H - core.b - h) / 2)), core.t - h - Math.max(3, Math.min(12, (core.t - h) / 2))]) if (!pos && !bad(gx, y, w, h)) pos = [gx, y];
    if (!pos) { // 가로 화면: 코어 옆 여백에 세로 카드(왼쪽 → 오른쪽, 위에서부터 빈 곳)
      el.classList.add('v');
      for (let f = fs; f >= f0 && !pos; f--) for (const side of [0, 1]) { // 글자 배율 때문에 카드가 여백을 넘으면 한 단계씩 줄여 본다(코어를 가리는 것보다 낫다)
        setF(f);
        const room = Math.floor(side ? W - core.r - 12 : core.l - 12); if (room < 96) continue;
        el.style.maxWidth = room + 'px'; w = el.offsetWidth; h = el.offsetHeight;
        const x = Math.round(side ? core.r + (W - core.r - w) / 2 : (core.l - w) / 2);
        for (let y = 8; y + h <= H - 8 && !pos; y += 6) if (!bad(x, y, w, h)) pos = [x, y];
        if (pos) break;
      }
    }
    if (!pos) { setF(fs); el.classList.remove('v'); el.style.maxWidth = Math.floor(W - 8) + 'px'; w = el.offsetWidth; pos = [Math.round(Math.max(4, Math.min(W - 4 - w, cx - w / 2))), core.t + 2 * fr + 4]; } // 자리가 없으면 필드 안 위쪽(종전)
    el.style.left = pos[0] + 'px'; el.style.top = Math.round(pos[1]) + 'px';
  }
  function ensureRaf() { if (!HAS_DOM || raf) return; gpPrev = -1; const f = () => { raf = 0; if (S.st === 'idle') { if (el && vis) { vis = false; el.classList.remove('on'); } return; } if (S.st === 'done' && performance.now() - S.doneT > DONE_MS) { S.st = 'idle'; if (el) { vis = false; el.classList.remove('on'); } return; } if (el) { show(); if (vis) gpPoll(); } raf = requestAnimationFrame(f); }; raf = requestAnimationFrame(f); }
  if (HAS_DOM && root.addEventListener) root.addEventListener('resize', () => { layKey = ''; });

  const api = {
    OPT, PICKS, STEPS, detector,
    auto: () => !NO_AUTO && !CLASSIC && !!SET() && (SET().get('tut') | 0) === 0, // 첫 1회 자동 대상(배틀 → 1인)
    arm: () => arm('battle'), // 튜토리얼 판 구동 직전(ui_manga.js tutGo)
    start: () => arm('replay'), // 지금 판에서(일시정지 → 설정)
    skip, frame, onDone: null,
    get state() { return { st: S.st, src: S.src, step: S.step, name: STEPS[S.step] || '', hits: S.hits, readyF: S.readyF, stepAt: S.stepAt.slice(), shown: vis, text: el ? el.textContent : '', layout: el && vis ? (el.classList.contains('v') ? 'side' : 'line') : '', gpBtn, rect: el && vis ? (() => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; })() : null, log: S.log.slice() }; },
  };
  root.NKTutorial = api;
})(typeof window !== 'undefined' ? window : globalThis);
