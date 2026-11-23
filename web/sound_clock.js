'use strict';
// 전투 배속용 소리 시계(로컬 전투 1.15·1.3·1.5 배속 전용). 엔진(core.js·gen/code.js·apu.js)은 한 줄도 바꾸지 않는다.
// 문제: 원작 사운드 드라이버(뱅크 0/1)는 NMI 마다 1번 갱신($FC16 → $8003)되어 음악 템포가 프레임 수에 묶여 있다. 화면을 1.3배로 돌리면 음악도 1.3배가 된다.
// 방식: 본 엔진은 종전 그대로 돈다(드라이버 포함 — 사이클 예산·NMI 시점·RAM 이 1배속 구동과 같은 규칙, 게임 로직 불변). 배속 중에는 본 엔진의 APU 쓰기를
//   합성기에 넣지 않고, 같은 드라이버 코드를 따로 돌리는 그림자 엔진(같은 생성 코드의 두 번째 인스턴스, 자기 RAM)이 소리를 낸다.
//   그림자는 본 엔진이 낸 사운드 요청($8000 진입, id = $07FF)과 게임 메인 루프의 $0700 쓰기(analysis/12_sound.md 2.2절 주의)를 그대로 받되,
//   드라이버 갱신은 자기 60Hz 시계(합성기 시간 29780.67 사이클마다)로 한다. 합성기 시간은 게임 1프레임당 (프레임 사이클 / 배율)만 진행하므로
//   샘플 수 = 실시간 초당 약 44,100(배율과 무관), 음 높이·템포 = 1배속과 같다.
// 1배속(배율 1)에서는 그림자를 만들지도 부르지도 않는다: 합성기 = 본 엔진 APU 쓰기 그대로(종전과 비트 단위로 같은 샘플열).
// 배속이 끝나면(배율 1) 그림자는 본 엔진의 갱신 시점까지 그대로 따라 하며(거울 모드), 새 곡 시작(id 20~36)·전체 정지(id 00) 요청이 있었던 프레임
//   (보통 승패 징글 32·33) 또는 드라이버 RAM($0700~$07FF)이 본 엔진과 같아진 프레임의 경계에서 합성기를 본 엔진에 되돌린다.
//   곡 시작 뒤에는 BGM 위치가 같다(배속 동안 다르게 흘러간 효과음 꼬리만 다를 수 있음). MIRROR_MAX 프레임 안에 둘 다 없으면 그 자리에서 되돌린다(음악 위치가 건너뛸 수 있음, stats.forced).
// 드라이버와 게임이 공유하는 것(코드 대조, 2026-11-21): RAM $0700(게임 메인 루프 $C262~$C269 가 $4C 최댓값을 적고 $C119·$C172·$C468·$C558·$C643 이 쓴다, 읽기는 $C264 CMP 뿐)
//   과 $07FF(요청 id, $C100·$FBFF 가 쓰고 $FC0B 가 읽음). 드라이버 임시 영역 $FC~$FF 는 게임 코드가 쓰지 않는다. 드라이버는 난수·게임 RAM 을 읽지 않는다.
const FRAME_CYC = 262 * 113.6667, BIG = 1e9, MIRROR_MAX = 1800;
const REQ_OFF = 0x0000, UPD_OFF = 0x0003;         // 생성 코드 F 표 키(PRG 파일 오프셋): 뱅크 0 의 $8000(요청 본체)·$8003(갱신 본체)
const FBFF = 0x1C000 + 0xFBFF - 0xC000, FC16 = 0x1C000 + 0xFC16 - 0xC000; // 고정 뱅크 진입점(요청·갱신)
// 효과음 끔(2026-11-22, 타이틀 밖 메뉴 = 배경음악만): web/game.js 가 ctl[16] = 1 로 알린다. 켜져 있으면 1배속이어도 그림자(거울 모드, 갱신 시점 = 본 엔진 그대로)로 넘어가
//   그림자에 효과음 요청(id 01~1F, analysis/12_sound.md 2.2절)만 넘기지 않는다. 곡 요청·$0700 쓰기·갱신은 그대로라 BGM 위치는 본 엔진과 같다.
//   본 엔진(RAM·드라이버·게임 로직)은 손대지 않는다. 0 으로 돌아오면 효과음 요청을 다시 넘기고 종전 거울 규칙으로 본 엔진에 되돌린다. 칸이 없으면(Node 도구·다른 워커) 늘 꺼짐
const SFXQ = 16, isSfx = id => id >= 0x01 && id <= 0x1F;
const sfxQuiet = () => typeof ctl !== 'undefined' && !!ctl && ctl.length > SFXQ && Atomics.load(ctl, SFXQ) === 1;

// main = 본 엔진(core.js Engine, attachApu 된 상태), makeShadow() = 같은 시작 상태로 만든 두 번째 Engine(처음 배속에 들어갈 때만 부른다)
function create(main, makeShadow) {
  const synth = main.apu; let F = main.code.F, origReq = F[REQ_OFF], origUpd = F[UPD_OFF]; // main·F·orig* 는 rollback.rebind(롤백 복원으로 엔진 인스턴스가 바뀔 때)만 바뀐다
  if (!synth || !origReq || !origUpd) throw new Error('sound_clock: 엔진·합성기·드라이버 진입점 없음');
  let mode = 0;                    // 0 = 본 엔진이 합성기에 씀(종전), 1 = 그림자가 씀
  let ev = [], depth = 0, exp = main.m[0x700], lastUpdC = 0;
  let shadow = null, sc = 0, nextU = 0, lastU = 0, mirrorN = 0, C0 = null, kick = false;
  const st = { handoffs: 0, handbacks: 0, forced: 0, shadowUpd: 0, shadowReq: 0, remap: 0, sfxReq: 0, sfxDrop: 0, sfxQuiet: 0, mode: 0 }; // sfxReq = 본 엔진이 낸 효과음 요청 수(모드 무관), sfxDrop = 효과음 끔으로 그림자에 넘기지 않은 요청 수, sfxQuiet·mode = 마지막 프레임 값
  // 온라인 팀전 승패 징글 보정(analysis/30 D3, 2026-11-22 사용자 결정 「진 쪽은 패배음」): 엔진(TeamEngine C6AC)은 양 팀에 사람이 있으면 이긴 팀 기준 0x32(승리) 한 번을 낸다.
  //   그림자(배속) 경로가 받는 요청 id 만 이 클라이언트의 팀 기준으로 바꾼다 — 본 엔진 RAM·락스텝 지문은 그대로. 내 팀 = 공유 메모리 ctl[14](web/game.js: 0 = 보정 없음, 1 + 팀),
  //   승리 팀 = $0611 bit3(팀 0 전멸 → 팀 1 승)·$0612 bit3(→ 팀 0 승), 둘 다거나 없으면 그대로. 1배속(그림자 없음)에서는 보정하지 않는다(온라인 배율 1.3 이라 해당 없음)
  const jingle = id => {
    if (id !== 0x32 && id !== 0x33) return id;
    const c = typeof ctl !== 'undefined' && ctl && ctl.length > 14 ? Atomics.load(ctl, 14) : 0; if (!c) return id; // ctl = web/worker.js 전역(같은 워커 전역 범위에서 읽기만)
    const m = main.m, a = !!(m[0x611] & 8), b = !!(m[0x612] & 8), w = a && !b ? 1 : b && !a ? 0 : -1;
    return w < 0 ? id : w === c - 1 ? 0x32 : 0x33;
  };
  let cycOff = 0; // 롤백 복원으로 엔진을 새로 만들면 code.cyc 가 0 부근에서 다시 시작한다. cycOff = (되감기 전 연속 시간축) - (새 엔진 code.cyc). 롤백을 안 쓰면 늘 0
  const cyc = () => main.code.cyc + cycOff;
  let rb = null; // 롤백 모드 상태(아래 rollback 훅 주석). null = 꺼짐 = 종전과 같은 호출 순서·사이클·샘플
  const put = e => { if (rb) rbPut(e); else ev.push(e); };
  const see700 = () => { const v = main.m[0x700]; if (v !== exp) { exp = v; if (mode || rb) put({ t: 2, c: cyc(), v }); } }; // 드라이버 밖(게임)이 쓴 $0700
  // 관측 덮개: 원래 함수를 그대로 부르고 값만 읽는다(본 엔진의 RAM·레지스터·사이클에 손대지 않음)
  const install = () => {
  F[REQ_OFF] = function (s0) {
    if (!depth) see700();
    if (isSfx(main.m[0x7FF])) st.sfxReq++;
    if (mode || rb) { const id = main.m[0x7FF], to = jingle(id); if (to !== id) st.remap++; put({ t: 0, c: cyc(), id: to }); }
    depth++; let r; try { r = origReq(s0); } finally { depth--; }
    if (!depth) exp = main.m[0x700];
    return r;
  };
  F[UPD_OFF] = function (s0) {
    if (!depth) see700();
    const c = cyc(); lastUpdC = c; if (mode || rb) put({ t: 1, c });
    depth++; let r; try { r = origUpd(s0); } finally { depth--; }
    if (!depth) exp = main.m[0x700];
    return r;
  };
  };
  install();
  let base0 = 0, at = 0, gridOn = false;
  // 게임 프레임이 멈춘 동안(온라인 락스텝·롤백의 입력 대기) 그림자 드라이버만 합성기 시간 dS(사이클)만큼 더 돌려 그 샘플을 돌려준다 = 프레임이 서도 BGM 은 이어진다(2026-11-23).
  //   배속 격자 모드(mode 1, 배율 > 1) 또는 롤백 방(그림자 고정)에서만. 본 엔진·RAM·지문에는 손대지 않는다(그림자는 자기 RAM). 다음 frameEnd 는 늘어난 sc 에서 이어 가므로 시간이 되돌아가지 않는다. 안 되는 때(1배속·거울·재시뮬·드라이버 실행 중)는 null
  function idle(dS) {
    if (!mode || !(gridOn || (rb && rb.force)) || depth || (rb && rb.resim) || !(dS > 0)) return null; // 롤백 방(force = 그림자 고정)은 1배속(거울)이어도 된다: 그림자가 본 엔진보다 앞서 가지만 되돌아가지 않으므로 무해
    const s1 = sc + dS; if (nextU < sc) nextU = sc;
    while (nextU < s1) { const u = nextU; at = Math.round(u); shadowCall(FC16, 0); lastU = u; nextU += FRAME_CYC; st.shadowUpd++; }
    sc = s1; synth.runTo(Math.round(s1)); st.idle = (st.idle | 0) + 1; return synth.drain();
  }
  function shadowCall(entry, A) {
    const sh = shadow, m = sh.m;
    m[0x1FD] = 0xFF; m[0x1FC] = 0xFF;
    sh.code.st = { A, X: 0, Y: 0, S: 0xFB, P: 0x24, bud: BIG, line: 0, frameNo: 0, nmiP: false, irqLine: false, ctrl: 0, mask: 0, stat: 0, irqLatch: 0, irqCnt: 0, irqEn: false, irqReload: false };
    base0 = sh.code.cyc;
    if (sh.code.F[entry](0xFB) !== 0) throw new Error('sound_clock: 그림자 드라이버 비정상 복귀');
  }
  function enter() { // 본 엔진 → 그림자(프레임 경계). 드라이버 상태 = 본 엔진 RAM 전체 사본
    if (!shadow) {
      shadow = makeShadow();
      shadow.env.ioWr = (a, v, c) => { if (a >= 0x4000 && a <= 0x4017) synth.write(at + (c - base0), a, v); else if (a >= 0x8000 && a < 0xA000) { if (!(a & 1)) shadow.bsel = v; else { shadow.reg[shadow.bsel & 7] = v; shadow._banks(); } } };
      shadow.env.onSound = () => {}; shadow.env.frameEnd = () => {}; shadow.env.scan = () => {};
    }
    shadow.m.set(main.m);
    sc = synth.cyc; lastU = lastUpdC; nextU = lastU + FRAME_CYC; mirrorN = 0;
    main.apu = null; mode = 1; ev = []; st.handoffs++;
  }
  function leave(C1, forced) { // 그림자 → 본 엔진(프레임 경계)
    synth.cyc = C1; main.apu = synth; mode = 0; ev = []; kick = false; st.handbacks++; if (forced) st.forced++;
  }
  // 프레임 경계(워커 onFrameEnd)에서 부른다. C1 = 이 프레임 끝의 본 엔진 누적 사이클, r = 이 프레임에 적용할 배율(1 = 1배속).
  // 돌려주는 값 = 이 프레임의 소리 샘플(종전 apu.runTo(C1) + drain() 자리)
  function frameEnd(C1, r) {
    if (rb && rb.resim) { if (!depth) see700(); return new Float32Array(0); } // 롤백 재시뮬 프레임: 그림자 시계 정지(C0·sc 그대로), 이벤트만 rbPut 이 거른다($0700 관측은 프레임 경계에서 하므로 본 경로와 같은 프레임에 귀속되게 부른다)
    if (!depth) see700();
    if (C0 === null) C0 = C1 - FRAME_CYC;
    const q = sfxQuiet(); st.sfxQuiet = q ? 1 : 0;
    let out;
    if (!mode) { synth.runTo(C1); out = synth.drain(); }
    else {
      const L = C1 - C0, s0 = sc, s1 = sc + L / r, grid = r > 1, map = c => s0 + (c - C0) / r;
      const run = (s, fn) => { at = Math.round(s); fn(); };
      if (grid && nextU < s0) nextU = s0;
      if (grid) kick = false; // 곡이 처음부터 다시 시작되는 요청: 그 뒤로는 BGM 위치가 본 엔진과 같다(SE 꼬리만 다를 수 있음)
      for (const e of ev) {
        const s = map(e.c);
        if (!grid && e.t === 0 && (e.id === 0 || (e.id >= 0x20 && e.id <= 0x36))) kick = true;
        if (grid) while (nextU <= s && nextU < s1) { const u = nextU; run(u, () => shadowCall(FC16, 0)); lastU = u; nextU += FRAME_CYC; st.shadowUpd++; }
        if (e.t === 0) { if (q && isSfx(e.id)) st.sfxDrop++; else { run(s, () => shadowCall(FBFF, e.id)); st.shadowReq++; } }
        else if (e.t === 2) shadow.m[0x700] = e.v;
        else if (!grid) { run(s, () => shadowCall(FC16, 0)); lastU = s; nextU = s + FRAME_CYC; st.shadowUpd++; }
      }
      if (grid) while (nextU < s1) { const u = nextU; run(u, () => shadowCall(FC16, 0)); lastU = u; nextU += FRAME_CYC; st.shadowUpd++; }
      ev = []; sc = s1; gridOn = grid;
      synth.runTo(Math.round(s1)); out = synth.drain();
      if (!grid) { // 거울 모드: 새 곡 시작(id 20~36)·전체 정지(00) 요청이 있었거나 드라이버 RAM 이 같아지면 본 엔진으로 되돌린다
        mirrorN++;
        let same = true; for (let a = 0x700; a < 0x800; a++) if (shadow.m[a] !== main.m[a]) { same = false; break; }
        if (q) mirrorN = 0;
        else if (!(rb && rb.force) && !depth && (same || kick || mirrorN >= MIRROR_MAX)) leave(C1, !same && !kick);
      } else mirrorN = 0;
    }
    if (!mode && (r > 1 || q || (rb && rb.force)) && !depth) enter(); // 요청·갱신 도중(프레임 경계가 드라이버 실행 중에 걸림)이면 다음 경계로 미룬다(반쯤 처리된 드라이버 RAM 을 복사하지 않게)
    C0 = C1; st.mode = mode;
    if (typeof ctl !== 'undefined' && ctl && ctl.length > SFXQ + 3) { Atomics.store(ctl, SFXQ + 1, st.sfxReq); Atomics.store(ctl, SFXQ + 2, st.sfxDrop); Atomics.store(ctl, SFXQ + 3, mode); } // 점검용 ctl[17~19] = 효과음 요청 수·차단 수·모드(web/game.js __game.sfxStat 이 읽기만)
    return out;
  }
  // ---- 롤백 넷코드 대응 훅(2026-11-22, 1단계. 기본 꺼짐: enable() 전에는 위 코드 경로가 종전과 호출 순서·사이클·샘플까지 같다) ----
  // 롤백(되감기 후 재시뮬)에서 엔진은 같은 프레임을 여러 번 돈다. 효과음은 예측 프레임에서 이미 그림자에 먹여 소리가 났으므로 재시뮬이 같은 요청을 다시 내면 두 번 울린다.
  //   중복 제거 표 played[프레임][종류:id] = 이미 그림자에 넘긴 횟수. 이벤트 키 = (엔진 프레임 번호, 종류·id, 같은 프레임 안에서 같은 종류·id 의 순번).
  //   순번 n 이 표의 횟수 이내면 이미 낸 것 → 버림(dup). 넘으면 새 것 → 표에 올리고 ev 로(재시뮬이면 c = 다음 실제 프레임 시작 C0 로 당겨 다음 frameEnd 시작에 투입).
  //   예측에서 났는데 재시뮬에는 없는 것 = 유령(ghost): 이미 울렸으니 되돌리지 않는다(허용).
  //   재시뮬 중 frameEnd 는 빈 샘플을 돌려주고 아무것도 하지 않는다(그림자 시계·C0 정지). 호스트는 재시뮬 프레임에서 화면·소리를 내보내지 않는다.
  //   소거 범위: 표는 가장 최근 이벤트 프레임 - limit(기본 120, 롤백 한도보다 크게) 보다 오래된 프레임을 버린다(pruned). 그보다 깊이 되감으면 그 프레임 이벤트는 새 것으로 보여 다시 울린다.
  //   스냅샷은 프레임 중간(onLoop)에서 뜨므로 mark() 가 그 시점까지 이 프레임에서 센 순번을 같이 담고, beginResim(mark) 가 거기서 이어 센다.
  //   enable(limit, { force: true }) 면 배율 1·효과음 끔이 아니어도 첫 프레임 경계에서 그림자로 넘어가 거울 모드에서 돌아오지 않는다(2단계: 합성기에 직접 쓰는 mode 0 에서는 되감기 뒤 새 시간선의 소리를 낼 수 없어서).
  //   enable(limit, { mute: false }) 면 mode 0 재시뮬에서도 main.apu 를 떼지 않는다(도구용: 시뮬이 자기 apu 로 스냅샷을 뜰 때).
  //   본 엔진이 1배속(mode 0, 그림자 진입 전: 온라인 배속 1.3 에서는 첫 프레임들뿐)이면 이벤트가 없어 표도 비어 있고, 재시뮬 동안 main.apu 를 떼어 소리를 막는다(endResim 에서 복구).
  function rbPut(e) {
    const f = main.code.frameNo, key = e.t === 0 ? '0:' + e.id : e.t === 2 ? '2:' + e.v : '1:';
    if (rb.cur.f !== f) { rb.cur = { f, counts: new Map() }; rb.seen.set(f, rb.cur.counts); }
    const n = (rb.cur.counts.get(key) || 0) + 1; rb.cur.counts.set(key, n);
    let pl = rb.played.get(f); if (!pl) { pl = new Map(); rb.played.set(f, pl); }
    if (f > rb.maxF) { rb.maxF = f; for (const g of rb.played.keys()) { if (g >= f - rb.limit) break; rb.played.delete(g); rb.seen.delete(g); rb.gh.delete(g); rb.stats.pruned++; } }
    if (n <= (pl.get(key) || 0)) { rb.stats.dup++; return; } // 이미 낸 이벤트
    pl.set(key, n); rb.stats.fresh++; if (rollback.tap) rollback.tap(e, f, rb.resim);
    if (!mode) return; // 본 엔진이 합성기에 직접 쓰는 구간(그림자 진입 전)은 표에만 적고 그림자로 넘기지 않는다
    if (rb.resim) { rb.stats.late++; if (C0 !== null) e.c = C0; }
    ev.push(e);
  }
  const rollback = {
    stats: null, tap: null, // tap(e, 프레임, 재시뮬 여부) = 새 이벤트마다 부르는 점검용 갈고리(시뮬·시험이 읽기만 함)
    get on() { return !!rb; }, get resim() { return !!(rb && rb.resim); },
    // 켠다. limit = 표 보존 프레임 수(롤백 최대 깊이보다 크게)
    enable(limit, opt) {
      rb = { force: !!(opt && opt.force), limit: limit > 0 ? limit : 120, mute: !(opt && opt.mute === false), played: new Map(), seen: new Map(), gh: new Map(), cur: { f: -1, counts: new Map() }, maxF: -1, resim: false, muted: false, stats: { resims: 0, fresh: 0, dup: 0, late: 0, ghost: 0, ghostLive: 0, pruned: 0 } };
      rollback.stats = rb.stats;
    },
    disable() { if (rb && rb.muted) { main.apu = synth; } rb = null; },
    // 스냅샷을 뜰 때(onLoop 안) 함께 부른다. 돌려준 값을 beginResim 에 넘긴다
    mark() { if (!rb) return null; const f = main.code.frameNo; return { f, counts: rb.cur.f === f ? new Map(rb.cur.counts) : new Map() }; },
    // 엔진을 되감은 직후(복원이 끝난 뒤, 첫 loop() 전) 부른다. mk = 그 스냅샷의 mark() 값
    beginResim(mk) {
      if (!rb || rb.resim) return false;
      rb.resim = true; rb.stats.resims++; rb.mk = mk;
      rb.cur = mk ? { f: mk.f, counts: new Map(mk.counts) } : { f: -1, counts: new Map() }; if (mk) rb.seen.set(mk.f, rb.cur.counts);
      if (!mode && main.apu && rb.mute) { main.apu = null; rb.muted = true; }
      depth = 0; exp = main.m[0x700]; return true;
    },
    // 재시뮬이 되감기 전 최전선(프레임)까지 따라잡았을 때 부른다. 이 뒤의 frameEnd 는 다시 실제로 동작한다
    endResim() {
      if (!rb || !rb.resim) return false;
      rb.resim = false; if (rb.muted) { main.apu = synth; rb.muted = false; }
      const from = rb.mk ? rb.mk.f : -1; rb.mk = null;
      for (const [f, pl] of rb.played) { if (f < from) continue; const sn = rb.seen.get(f) || new Map(); let gm = rb.gh.get(f); if (!gm) { gm = new Map(); rb.gh.set(f, gm); } for (const [k, c] of pl) { const g = Math.max(0, c - (sn.get(k) || 0)), pv = gm.get(k) || 0; if (g > pv) rb.stats.ghost += g - pv; gm.set(k, g); } }
      let live = 0; for (const gm of rb.gh.values()) for (const g of gm.values()) live += g; rb.stats.ghostLive = live;
      exp = main.m[0x700]; return true;
    },
    // 복원이 새 Engine 인스턴스를 만들 때(snapshot.restore): 새 엔진에 관측 덮개를 다시 건다. 합성기·그림자·표는 그대로. 새 엔진의 apu 는 이 모듈이 정한다(그림자 중 = 없음)
    rebind(eng, off) { // off = 연속 시간축 보정(cycOff). 워커는 frameEnd 의 C1 에도 같은 값을 더해 넘긴다
      cycOff = off | 0; main = eng; F = main.code.F; origReq = F[REQ_OFF]; origUpd = F[UPD_OFF]; install();
      if (!rb || rb.mute) { main.apu = mode || (rb && rb.resim) ? null : synth; if (rb && rb.resim && !mode) rb.muted = true; } depth = 0; exp = main.m[0x700];
    },
  };
  return { frameEnd, idle, stats: st, rollback, get mode() { return mode; } };
}
const api = { create, FRAME_CYC, MIRROR_MAX, SFXQ };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
