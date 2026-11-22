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
  const synth = main.apu, F = main.code.F, origReq = F[REQ_OFF], origUpd = F[UPD_OFF];
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
  const cyc = () => main.code.cyc;
  const see700 = () => { const v = main.m[0x700]; if (v !== exp) { exp = v; if (mode) ev.push({ t: 2, c: cyc(), v }); } }; // 드라이버 밖(게임)이 쓴 $0700
  // 관측 덮개: 원래 함수를 그대로 부르고 값만 읽는다(본 엔진의 RAM·레지스터·사이클에 손대지 않음)
  F[REQ_OFF] = function (s0) {
    if (!depth) see700();
    if (isSfx(main.m[0x7FF])) st.sfxReq++;
    if (mode) { const id = main.m[0x7FF], to = jingle(id); if (to !== id) st.remap++; ev.push({ t: 0, c: cyc(), id: to }); }
    depth++; let r; try { r = origReq(s0); } finally { depth--; }
    if (!depth) exp = main.m[0x700];
    return r;
  };
  F[UPD_OFF] = function (s0) {
    if (!depth) see700();
    const c = cyc(); lastUpdC = c; if (mode) ev.push({ t: 1, c });
    depth++; let r; try { r = origUpd(s0); } finally { depth--; }
    if (!depth) exp = main.m[0x700];
    return r;
  };
  let base0 = 0, at = 0;
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
      ev = []; sc = s1;
      synth.runTo(Math.round(s1)); out = synth.drain();
      if (!grid) { // 거울 모드: 새 곡 시작(id 20~36)·전체 정지(00) 요청이 있었거나 드라이버 RAM 이 같아지면 본 엔진으로 되돌린다
        mirrorN++;
        let same = true; for (let a = 0x700; a < 0x800; a++) if (shadow.m[a] !== main.m[a]) { same = false; break; }
        if (q) mirrorN = 0;
        else if (!depth && (same || kick || mirrorN >= MIRROR_MAX)) leave(C1, !same && !kick);
      } else mirrorN = 0;
    }
    if (!mode && (r > 1 || q) && !depth) enter(); // 요청·갱신 도중(프레임 경계가 드라이버 실행 중에 걸림)이면 다음 경계로 미룬다(반쯤 처리된 드라이버 RAM 을 복사하지 않게)
    C0 = C1; st.mode = mode;
    if (typeof ctl !== 'undefined' && ctl && ctl.length > SFXQ + 3) { Atomics.store(ctl, SFXQ + 1, st.sfxReq); Atomics.store(ctl, SFXQ + 2, st.sfxDrop); Atomics.store(ctl, SFXQ + 3, mode); } // 점검용 ctl[17~19] = 효과음 요청 수·차단 수·모드(web/game.js __game.sfxStat 이 읽기만)
    return out;
  }
  return { frameEnd, stats: st, get mode() { return mode; } };
}
const api = { create, FRAME_CYC, MIRROR_MAX, SFXQ };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
