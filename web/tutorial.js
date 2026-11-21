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

  // ── 표시(한 줄: 단계 점 6개 + 키캡 + 짧은 말 + 건너뛰기) ──
  let el = null, dots = [], txt = null, btn = null, raf = 0, layKey = '', vis = false;
  const touchOn = () => { const T = root.NKTouch; try { return !!(T && T.state.shown); } catch (e) { return false; } };
  const KM = () => root.NKKeymap || null;
  const kn = id => { const k = KM(); const v = k ? k.keyName(0, id) : { a: 'A', b: 'S', jump: 'D', left: '←', right: '→' }[id]; return v && v !== '—' ? v : ''; }; // 1P 현재 키(리매핑을 따른다)
  function cap(t) { return '<kbd>' + String(t).replace(/[<>&]/g, '') + '</kbd>'; }
  function line() {
    const tch = touchOn(), name = STEPS[S.step];
    if (S.st === 'done') return '완료!';
    const A = tch ? 'A' : kn('a') || 'A', B = tch ? 'B' : kn('b') || 'B', J = tch ? '점프' : kn('jump'), L = kn('left') || '←', R = kn('right') || '→';
    if (name === 'move') return (tch ? cap('스틱') : cap(L) + cap(R)) + ' 이동';
    if (name === 'run') return (tch ? cap(root.NKSettings && root.NKSettings.get('tdash') === 0 ? '스틱 두 번' : '스틱 끝까지') : cap(L) + cap(L) + ' / ' + cap(R) + cap(R)) + ' 달리기';
    if (name === 'jump') return (J ? cap(J) : cap(A) + '+' + cap(B)) + ' 점프';
    if (name === 'punch') return cap(A) + ' 펀치';
    if (name === 'kick') return cap(B) + ' 킥';
    return cap(A) + cap(B) + ' 맞히기 ' + S.hits + '/' + HITS;
  }
  function build() {
    const css = document.createElement('style');
    css.textContent = '#nktut{position:fixed;z-index:4;left:0;top:0;transform:translateX(-50%);display:none;align-items:center;gap:10px;box-sizing:border-box;padding:0 6px 0 10px;border:2px solid #FFE14D;border-radius:6px;background:rgba(10,10,16,.86);color:#fff;font:var(--tf,15px)/1 Galmuri11,monospace;white-space:nowrap;pointer-events:none;-webkit-user-select:none;user-select:none}'
      + '#nktut.on{display:flex}#nktut .d{display:flex;gap:4px}#nktut .d i{width:8px;height:8px;border-radius:50%;background:#4A4660}#nktut .d i.ok{background:#3DDC84}#nktut .d i.cur{background:#FFE14D}'
      + '#nktut .t kbd{display:inline-block;min-width:1.3em;margin:0 2px;padding:3px 5px;border:1px solid #cfcfe0;border-bottom-width:3px;border-radius:4px;background:#2A2838;color:#fff;font:inherit;text-align:center}'
      + '#nktut .t.flash{animation:nktut-f .35s ease-out}@keyframes nktut-f{from{color:#3DDC84}to{color:#fff}}#nktut.fin{border-color:#3DDC84}#nktut.fin .x{display:none}'
      + '#nktut .x{pointer-events:auto;cursor:pointer;border:0;border-left:1px solid #4A4660;background:none;color:#BEBAD2;font:inherit;font-size:.85em;padding:0 4px 0 10px;min-height:var(--th,32px);touch-action:manipulation}#nktut .x kbd{font:inherit;opacity:.7;margin-left:4px}';
    document.head.appendChild(css);
    el = document.createElement('div'); el.id = 'nktut'; el.setAttribute('role', 'status');
    const d = document.createElement('span'); d.className = 'd'; dots = STEPS.map(() => { const i = document.createElement('i'); d.appendChild(i); return i; });
    txt = document.createElement('span'); txt.className = 't';
    btn = document.createElement('button'); btn.className = 'x'; btn.type = 'button'; btn.tabIndex = -1;
    btn.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); skip(); });
    el.appendChild(d); el.appendChild(txt); el.appendChild(btn); document.body.appendChild(el);
    window.addEventListener('keydown', e => { if (e.code === 'Tab' && vis && S.st === 'run') { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) skip(); } }, true);
  }
  function render(flash) {
    if (!HAS_DOM) return;
    if (!el) { if (S.st === 'idle') return; build(); }
    dots.forEach((i, k) => { i.className = S.st === 'done' || k < S.step ? 'ok' : k === S.step ? 'cur' : ''; });
    txt.innerHTML = line(); btn.innerHTML = touchOn() ? '건너뛰기' : '건너뛰기<kbd>Tab</kbd>';
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
  function place() { // 코어(보이는 필드) 아래 여백 → 없거나 터치 패드가 아래를 쓰면 위 여백 → 둘 다 없으면 필드 안 위쪽
    const cv = document.getElementById('c'); if (!cv) return;
    const r = root.NKCam ? root.NKCam.rect(cv) : cv.getBoundingClientRect(), s = r.height / 240 || 1, fh = +cv.dataset.fh || 240, fr = 3 * s;
    const W = innerWidth, H = innerHeight, tch = touchOn(), top0 = r.top, bot0 = r.top + fh * s, cx = r.left + 216 * s;
    const k = [W, H, Math.round(top0), Math.round(bot0), Math.round(cx), tch ? 1 : 0].join(','); if (k === layKey) return; layKey = k;
    const fs = Math.max(13, Math.min(18, Math.round(Math.min(W, H) / 40))), h = Math.round(fs * 2.1);
    const below = H - (bot0 + fr), above = top0 - fr; let y;
    if (!tch && below >= h + 6) y = bot0 + fr + Math.max(3, Math.min(12, (below - h) / 2));
    else if (above >= h + 6) y = top0 - fr - h - Math.max(3, Math.min(12, (above - h) / 2));
    else y = top0 + fr + 4;
    el.style.setProperty('--tf', fs + 'px'); el.style.setProperty('--th', h + 'px'); el.style.height = h + 'px';
    el.style.left = Math.round(cx) + 'px'; el.style.top = Math.round(y) + 'px'; el.style.maxWidth = Math.floor(Math.max(256 * s, Math.min(W - 8, 360))) + 'px';
  }
  function ensureRaf() { if (!HAS_DOM || raf) return; const f = () => { raf = 0; if (S.st === 'idle') { if (el && vis) { vis = false; el.classList.remove('on'); } return; } if (S.st === 'done' && performance.now() - S.doneT > DONE_MS) { S.st = 'idle'; if (el) { vis = false; el.classList.remove('on'); } return; } if (el) show(); raf = requestAnimationFrame(f); }; raf = requestAnimationFrame(f); }
  if (HAS_DOM && root.addEventListener) root.addEventListener('resize', () => { layKey = ''; });

  const api = {
    OPT, PICKS, STEPS, detector,
    auto: () => !NO_AUTO && !CLASSIC && !!SET() && (SET().get('tut') | 0) === 0, // 첫 1회 자동 대상(배틀 → 1인)
    arm: () => arm('battle'), // 튜토리얼 판 구동 직전(ui_manga.js tutGo)
    start: () => arm('replay'), // 지금 판에서(일시정지 → 설정)
    skip, frame, onDone: null,
    get state() { return { st: S.st, src: S.src, step: S.step, name: STEPS[S.step] || '', hits: S.hits, readyF: S.readyF, stepAt: S.stepAt.slice(), shown: vis, text: el ? el.textContent : '', rect: el && vis ? (() => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; })() : null, log: S.log.slice() }; },
  };
  root.NKTutorial = api;
})(typeof window !== 'undefined' ? window : globalThis);
