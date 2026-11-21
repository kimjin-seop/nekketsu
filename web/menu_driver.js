'use strict';
// 메뉴 구동기(UI 3·4단계). 설계·측정 근거: analysis/13_korean_ui.md 11절(모드 선택)·12절(배틀 설정: 인원·캐릭터 에디트 여부).
// 신규 메뉴 층에서 고른 모드·설정을 가상 패드 입력열로 바꿔, 덮개 아래의 원작 메뉴를 원하는 화면까지 넘긴다. RAM 은 읽기만 한다(쓰지 않는다).
// 프레임마다 step(RAM 사본, 배경 팔레트 사본 또는 null) 을 부르면 그 프레임에 넣을 패드 값(pad = 1P, pad2 = 2P)과 상태(run/done/fail)를 돌려준다.
//   pads = 같은 값의 4칸 [1P, 2P, 3P, 4P](단계의 port 0~3. 3P·4P 는 사람 3·4명 계획 battle_full4 만 쓴다 — web/ui_manga.js addPlan, analysis/17_online_4p.md 2절). pad = pads[0], pad2 = pads[1].
// create(모드, 설정): 설정 없음 = 모드 확정까지만(원작 인원 선택 5:1:3 에서 끝). 배틀 설정 { players: 1 | 2, edit: false | 'ask' }:
//   edit false = 전원 '안 한다'로 답해 캐릭터 선택(5:4)까지, 'ask' = 인원까지만 답하고 원작 에디트 여부 질문(5:1:4)에서 끝(사용자가 원작 화면에서 답한다).
//   측정한 분기만 구동한다: 인원 1P·2P, 에디트 '안 한다'. 그 밖의 설정(3P·4P, 에디트 '한다' 자동 응답)은 create 가 실패를 돌려준다(game.js 가 덮개를 걷어 원작 화면을 보여 준다).
// 고정 프레임 대기가 아니라 상태를 보고 진행한다: 단계마다 on(누를 수 있는 상태) 일 때만 버튼을 HOLD 프레임 누르고 ok(결과 상태)를 기다린다.
//   ok 가 RETRY 프레임 안에 안 오면 on 인 동안 다시 누른다(안내문이 찍히는 동안은 원작이 입력을 받지 않는다). 단계가 STEP_MAX 프레임을 넘기면 fail → game.js 가 덮개를 걷어 원작 메뉴를 그대로 보여 준다(안전망).
// 화면 키: $0641(모드) : $0642 하위 7비트 : $0670 하위 7비트. $0642·$0670 의 bit7 = 그 화면이 입력 대기에 들어감.
// 커서: $0672(모드 선택 0=스토리 1=배틀), $0674(인원 0=1P 1=2P), $06AB(에디트 여부 0=한다 1=안 한다). $0697 = 에디트 여부를 묻는 대상(관측: 1P 질문 2, 2P 질문 3. 2P 질문은 2P 패드만 받는다).
// 결과: $0645 = 배틀 1인 2, 배틀 2인 3.
// Node(검증 스크립트)·브라우저 공용.
(function (root) {
  const A = 1, START = 8, U = 16, D = 32, L = 64, R = 128;
  const HOLD = 4, GAP = 6, RETRY = 12, STEP_MAX = 300, PAL_STABLE = 6, NOPAL_SETTLE = 24, END_MAX = 300;
  const scr = (m, a, b) => m[0x641] === 5 && (m[0x642] & 0x7F) === a && (b === undefined || (m[0x670] & 0x7F) === b);
  const modeSel = m => scr(m, 1, 1), players = m => scr(m, 1, 3) && m[0x670] >= 0x80;
  const editQ = (m, who) => scr(m, 1, 4) && m[0x670] >= 0x80 && (who === undefined || m[0x697] === who);
  const left14 = m => scr(m, 2) || scr(m, 4); // 에디트 여부 질문이 끝나 다음 화면(5:2 페이드아웃 → 5:4)으로 넘어감
  const set = o => !!o && !!o.players, noEdit = o => set(o) && o.edit === false, two = o => noEdit(o) && o.players === 2;
  // 단계: on = 버튼을 눌러도 되는 상태, btn = 누를 버튼, port = 패드(없으면 1P, 1 = 2P, 2 = 3P, 3 = 4P), ok = 다음 단계로 넘어가는 상태, when = 이 설정일 때만 넣는 단계(없으면 항상).
  // end = 덮개를 걷어도 되는 화면(추가로 팔레트가 페이드인을 마칠 때까지 기다린다), check = 끝 화면에서 확인하는 결과 값(다르면 실패 사유), valid = 구동할 수 있는 설정인지(아니면 사유).
  const plans = {
    // 배틀 모드. 설정 없음: 커서 ↓ → A(배틀) 까지만 구동하고 원작 인원 선택(5:1:3, 한글 덧그리기)에서 덮개를 걷는다.
    // 설정 있음(UI 4단계): 인원(1P·2P) → 에디트 여부('안 한다'를 각 플레이어 패드로)까지 답해 캐릭터 선택(5:4)에서 걷는다. edit 'ask' 면 인원까지만 답하고 에디트 여부 질문(5:1:4)에서 걷는다.
    battle: {
      valid: o => !set(o) ? '' : o.players !== 1 && o.players !== 2 ? '인원 ' + o.players + ' 은 측정하지 않은 분기' : o.edit !== false && o.edit !== 'ask' ? '에디트 설정 ' + o.edit + ' 은 측정하지 않은 분기' : '',
      steps: [
        { name: '커서 → 배틀', on: m => modeSel(m) && m[0x672] === 0, btn: D, ok: m => modeSel(m) && m[0x672] === 1 },
        { name: '배틀 확정', on: m => modeSel(m) && m[0x672] === 1, btn: A, ok: m => scr(m, 1, 3) },
        { name: '인원 커서 → 1P', when: o => set(o) && o.players === 1, on: m => players(m) && m[0x674] > 0, btn: U, ok: m => scr(m, 1, 3) && m[0x674] === 0 },
        { name: '인원 커서 → 2P', when: o => set(o) && o.players === 2, on: m => players(m) && m[0x674] === 0, btn: D, ok: m => scr(m, 1, 3) && m[0x674] === 1 },
        { name: '인원 확정', when: set, on: (m, o) => players(m) && m[0x674] === o.players - 1, btn: A, ok: m => scr(m, 1, 4) },
        { name: '1P 커서 → 안 한다', when: noEdit, on: m => editQ(m, 2) && m[0x6AB] === 0, btn: R, ok: m => editQ(m, 2) && m[0x6AB] === 1 },
        { name: '1P 안 한다 확정', when: noEdit, on: m => editQ(m, 2) && m[0x6AB] === 1, btn: A, ok: (m, o) => o.players === 2 ? editQ(m, 3) : left14(m) },
        { name: '2P 커서 → 안 한다', when: two, on: m => editQ(m, 3) && m[0x6AB] === 0, btn: R, port: 1, ok: m => editQ(m, 3) && m[0x6AB] === 1 },
        { name: '2P 안 한다 확정', when: two, on: m => editQ(m, 3) && m[0x6AB] === 1, btn: A, port: 1, ok: left14 },
      ],
      end: (m, o) => !set(o) ? players(m) : o.edit === 'ask' ? editQ(m) : scr(m, 4) && m[0x642] >= 0x80,
      check: (m, o) => set(o) && m[0x645] !== o.players + 1 ? '$0645 = ' + m[0x645] + ' (기대 ' + (o.players + 1) + ')' : '',
    },
    // 스토리 모드: A(스토리) 까지만 구동하고 원작 인원 선택(5:1:3)에서 덮개를 걷는다. 인원(1P/2P 협력)은 사용자가 직접 고른다.
    story: {
      steps: [
        { name: '커서 → 스토리', on: m => modeSel(m) && m[0x672] === 1, btn: U, ok: m => modeSel(m) && m[0x672] === 0 },
        { name: '스토리 확정', on: m => modeSel(m) && m[0x672] === 0, btn: A, ok: m => scr(m, 1, 3) },
      ],
      end: players,
    },
  };
  function create(mode, opt) {
    const plan = plans[mode], o = opt || null, bad = plan ? (plan.valid ? plan.valid(o) : '') : '알 수 없는 모드 ' + mode;
    const steps = plan && !bad ? plan.steps.filter(s => !s.when || s.when(o)) : [];
    let i = 0, t = 0, c = -1, gap = GAP, endT = 0, stable = 0, lastPal = '', frames = 0, port = 0, state = bad ? 'fail' : 'run', why = bad;
    const fail = w => { state = 'fail'; why = w; return 0; };
    const finish = m => { const w = plan.check ? plan.check(m, o) : ''; if (w) fail('결과 불일치: ' + w); else state = 'done'; };
    function pad(m, pal) {
      port = 0;
      while (i < steps.length && steps[i].ok(m, o)) { i++; t = 0; c = -1; gap = GAP; } // 이미 그 상태면 건너뛴다(예: 커서가 이미 맞는 자리)
      if (i < steps.length) {
        const s = steps[i];
        if (++t > STEP_MAX) return fail(s.name + ': ' + STEP_MAX + '프레임 안에 진행되지 않음');
        if (gap > 0) { gap--; return 0; }                     // 앞 버튼을 뗀 뒤 최소 GAP 프레임(엔진은 화면보다 최대 3프레임 앞서 있다)
        if (c < 0) { if (!s.on(m, o)) return 0; c = 0; }
        if (c < HOLD) { c++; port = s.port || 0; return s.btn; }
        if (++c >= RETRY) c = -1;                             // 반응이 없으면 다시(on 인 동안만)
        return 0;
      }
      // 마지막 화면 대기: 화면 키 도달 + 배경 팔레트가 검정이 아니고 PAL_STABLE 프레임 동안 그대로(페이드인 끝). 팔레트 사본이 없으면(한글 층 꺼짐) NOPAL_SETTLE 프레임.
      if (++endT > END_MAX) return fail('마지막 화면: ' + END_MAX + '프레임 안에 준비되지 않음');
      if (!plan.end(m, o)) { stable = 0; return 0; }
      if (!pal) { if (++stable >= NOPAL_SETTLE) finish(m); return 0; }
      let k = '', lit = false; for (let j = 0; j < 16; j++) { k += pal[j] + ','; if ((pal[j] & 0x3F) !== 0x0F) lit = true; }
      if (lit && k === lastPal) { if (++stable >= PAL_STABLE) finish(m); } else stable = 0;
      lastPal = k; return 0;
    }
    return {
      step(m, pal) {
        if (state !== 'run') return { pad: 0, pad2: 0, pads: [0, 0, 0, 0], state, why };
        frames++; const p = pad(m, pal || null), v = state === 'run' ? p : 0, pads = [0, 0, 0, 0]; pads[port > 0 && port < 4 ? port : 0] = v;
        return { pad: pads[0], pad2: pads[1], pads, state, why };
      },
      get info() { return { mode, opt: o, state, why, step: plan ? (i < steps.length ? steps[i].name : '마지막 화면 대기') : '', frames }; },
    };
  }
  const api = { create, plans, BTN: { A, START, U, D, L, R } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NKDriver = api;
})(typeof self !== 'undefined' ? self : this);
