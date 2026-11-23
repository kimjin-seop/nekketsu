'use strict';
// 엔진 워커. 엔진(server/engine/core.js + gen/code.js) + 렌더러 + APU 합성기를 이 스레드에서 돌리고, 프레임(262 라인) 경계마다
// 화면·소리를 메인 스레드로 보낸 뒤 메인이 다음 프레임을 허가(ctl[CREDIT])할 때까지 Atomics.wait 로 멈춘다.
// 이유: 원작은 전투 중 일시정지(START) 동안 메인 루프($C178)로 돌아가지 않고 한 회전 안에서 패드를 프레임당 수십 번 폴링하며
//   입력 변화를 기다린다. 생성 코드는 JS 호출 스택 위에서 돌아 루프 도중에 반환할 수 없으므로, 스레드째로 프레임 경계에서 세운다.
//   엔진 코어·생성 코드는 그대로다(차분 하네스와 같은 코드, 같은 의미). 패드는 원작이 $4016 을 스트로브하는 그 시점에 공유 메모리에서 읽는다.
// ctl(Int32Array, SharedArrayBuffer): [0] 허가된 프레임 누계, [1] 1P 패드, [2] 2P 패드, [3] 리셋 세대, [4] 소리 샘플레이트(0 = 꺼짐), [5] 한글 덧그리기 층(0 = 꺼짐),
//   [6] 3P 패드, [7] 4P 패드(패미컴 확장 단자 = $4016·$4017 의 bit1. 종전 칸 [0]~[5] 는 그대로이고 리셋 칸도 [3] 그대로다. 공유 메모리가 8칸 미만이면 확장 패드를 연결하지 않는다)
//   [6]·[7] 이 0 이면 결과는 확장 패드가 없을 때와 비트 단위로 같다(코어 extPads 주석). 원작은 $0645 >= 4(배틀 3·4인)일 때만 3P·4P 를 따로 쓰고, 그 밖에는 3P → 1P, 4P → 2P 에 OR 로 합친다(analysis/17_online_4p.md 1절).
// [5] 가 켜져 있을 때만 프레임마다 PPU 상태 사본(ko: 라인 239 시점의 네임테이블·팔레트 + 라인별 스크롤·뱅크 표)을 같이 보낸다(읽기만 함, web/korean.js 입력).
// [10] = 전투 배속(배율 x1000, 0·1000 이하 = 1배속. web/game.js spd()). 1배속을 넘으면 소리만 web/sound_clock.js 의 그림자 드라이버가 실시간 60Hz 로 낸다(음 높이·템포 유지).
//   엔진(게임 로직)은 칸 값과 무관하게 같다. 칸이 없거나 1배속이면 소리도 종전과 비트 단위로 같다(tools/music_speed_check.js).
// [12] = 팀전(2:2) 엔진 선택(온라인 팀전, analysis/30 7절). 0 = 일반 엔진(종전과 같다). 16 이 켜져 있으면 TeamEngine(server/engine/core_team.js + gen/code_team.js, 처음 쓸 때 한 번만 불러온다),
//   하위 4비트 = 슬롯 0~3 의 CPU 표시(start.cfg.team.cpu). 엔진을 새로 만들 때(처음·리셋 ctl[3])만 읽으므로 호스트는 리셋 전에 쓰고 판이 끝나면 0 으로 되돌린다. 칸이 없는 공유 메모리(13칸 미만) = 0.
// [8] 이 켜져 있을 때만 프레임마다 그 프레임에 표시된 스프라이트 상태(spr: 라인 0 시점의 PPU 쪽 OAM 256바이트 + 스프라이트 CHR 뱅크 R2~R5)를 같이 보낸다(읽기만 함, web/sprite_layer.js 입력. analysis/18_interpolation.md). 꺼져 있거나 칸이 없으면 관측도 전송도 하지 않는다.
// [11] = 화면·소리 생략(1 = 켬. web/game.js 가 덮개 아래 빨리 감기 구동 프레임을 허가할 때만 켠다). 켜진 프레임은 렌더러를 부르지 않고(fb 를 보내지 않음, fb: null)
//   합성기는 web/apu_skip.js 로 샘플 없이 같은 채널 상태까지만 진행한다. 엔진(CPU·RAM·패드·PPU 상태)·한글/스프라이트 관측은 그대로다(ko 팔레트 사본은 구동기가 쓴다)
// [20] = 롤백 모드(2026-11-22 2단계, 기본 0 = 꺼짐. 1 = 켬. 아래 "롤백 모드" 주석). 켜려면 시작 메시지에 rb(SharedArrayBuffer, Int32Array 2080칸 이상)를 같이 넘겨야 한다.
//   엔진을 새로 만들 때(처음·리셋)만 읽는다. 0 이거나 rb 가 없거나 ctl 이 21칸 미만이면 아래 모든 롤백 코드는 실행되지 않고 종전과 같다(tools/rollback_worker_check.js 로 출력 비트 동일 증명).
// 롤백 모드: 엔진은 상대 입력이 없어도 예측 패드로 앞서 달리고, 나중에 정정된 입력이 오면 틱 경계 스냅샷으로 되감아 재시뮬한다.
//   rb(Int32Array rbq) = 메인 <-> 워커 공유표. 워커가 멈춘 동안에도 읽도록 postMessage 가 아니라 공유 메모리로 주고받는다(워커는 프레임 끝마다 Atomics.wait 로 선다).
//   패드 이력: rbq[Q_PAD + ((f & 511) << 2) + 포트] = 프레임 f(워커의 프레임 카운터 k = 완료한 프레임 수, 시작 프레임이 0)의 패드. 메인은 프레임 f 를 허가하기 전에 H[f] 를 써 둔다(예측이면 예측값).
//   롤백 모드에서 ctl[1]·[2]·[6]·[7] 패드 칸은 읽지 않는다. 정정은 메인이 H[f] 를 덮어쓰기만 하면 된다: 워커가 프레임마다 "실제로 읽은 값"과 H 를 비교해 가장 이른 불일치 f 를 찾아 되감는다(읽지 않은 프레임의 정정은 무시).
//   메인이 알려 줄 것: rbq[Q_CONF] = 입력이 확정된 프레임 수(f < Q_CONF 는 H[f] 가 최종값이고 다시는 안 바뀐다. H[f] 를 쓴 '뒤에' 올린다. 워커는 그 프레임들을 실제로 읽은 값과 대조해 어긋났으면 먼저 되감고, 검증이 끝난 프레임까지만 스냅샷을 정리한다), rbq[Q_LIMIT] = 예측 한도(k - Q_CONF >= 한도이면 워커가 다음 프레임을 시작하지 않고 Q_STOP = 1 로 선다. 0 = 무제한).
//   정정·확정 갱신 뒤에는 Atomics.notify(ctl, 0, 1) 로 깨운다(안 해도 20ms 안에 알아챈다). 되감기 직접 요청(보통 불필요): rbq[Q_REQ] = 프레임 번호 + 1(0 = 없음, 여러 건이면 최솟값, Atomics.compareExchange 루프).
//   스냅샷 방식: 틱 경계(onLoop)에서 프레임당 최대 1개, APU·소리 상태 없이(워커가 합성기·그림자 시계를 영구 소유, 소리는 롤백 대상이 아님) 엔진 RAM·PPU·MMC3·패드·CPU 상태만 typed array 로 뜬다.
//   복원 = 새 Engine(팀전이면 TeamEngine)을 스냅샷에서 만들고 sound_clock.rollback.rebind(새 엔진, 시간축 보정) → beginResim → 재시뮬. 재시뮬 중에는 postMessage·화면 그리기(마지막 2프레임 제외)·소리 합성을 하지 않는다.
//   재시뮬이 되감기 전 최전선에 닿으면 endResim 하고, 다음 프레임 허가가 아직 없을 때만 정정된 최신 프레임을 {redo: true} 로 한 번 더 보낸다(표시 교체용, 프레임 수에는 안 센다).
//   프레임 메시지에는 rb: { f: 이 메시지의 프레임 번호, n: 누적 롤백 횟수, d: 마지막 롤백 깊이 } 가 붙는다. 재시뮬 뒤 첫 메시지(redo 또는 다음 프레임)에는 rb.h = [{ f: 엔진 프레임 번호, m: RAM }](되감은 구간의 마지막 5프레임, 표시 층 정정용)가 더 붙는다.
//   3단계 추가(온라인 롤백, analysis/online_sync.md 9절): 공유표가 HB + 2 * RING 칸 이상이면 프레임이 끝날 때마다(재시뮬 프레임 포함, 되감기로 덮어쓴다) 끝난 프레임 수 c 의 RAM 지문(FNV-1a, web/game.js fnv 와 같은 값)을 rbq[HB + (c & 511)],
//   결과 판정 비트(전투 종료 1:5 진입·팀 전멸·슬롯별 탈락/HP)를 rbq[SB + (c & 511)] 에 쓰고, 검증이 끝난 프레임 수를 rbq[Q_VER] 에 낸다(c <= Q_VER 이면 그 프레임까지 입력이 최종값과 같게 돈 것 = 지문·결과를 믿을 수 있다). 칸이 모자라면 기록하지 않는다(종전과 같다).
const CREDIT = 0, PAD = 1, RESET = 3, AUDIO = 4, KO = 5, PAD34 = 6, SPR = 8, SPD = 10, SKIP = 11, TEAM = 12, RBF = 20;
const Q_REQ = 0, Q_CONF = 1, Q_LIMIT = 2, Q_FRONT = 3, Q_STOP = 4, Q_NRB = 5, Q_DEPTH = 6, Q_MAXD = 7, Q_RESIMF = 8, Q_RESIM_US = 9, Q_SNAPN = 10, Q_SNAP_US = 11, Q_REST_US = 12, Q_MEM = 13, Q_OVF = 14, Q_SEQ = 15, Q_STALLS = 16, Q_SNAPCAP = 17, Q_MEMCAP = 18, Q_DBG = 19, Q_DBGREQ = 20, Q_POSTS = 21, Q_SNAPMAX_US = 22, Q_RESTMAX_US = 23, Q_RESIMMAX_US = 24, Q_VER = 25, Q_PAD = 32, RING = 512, RMASK = RING - 1, HB = Q_PAD + RING * 4, SB = HB + RING, NONE = 0x7FFFFFFF; // 점검·통계 칸(워커가 씀): FRONT 최전선 k, STOP 정지 중, NRB 롤백 횟수, DEPTH 마지막 깊이, MAXD 최대 깊이, RESIMF 재시뮬 프레임 합, *_US 누적 마이크로초(MAX 는 1회 최대), SNAPN 스냅샷 수, MEM 보관 바이트, OVF 스냅샷 못 뜸 횟수, SEQ 롤백 완료 번호, STALLS 정지 진입 횟수, SNAPCAP 보관 개수 상한(기본 64), MEMCAP 바이트 상한(기본 2MB), DBG 1 = 소리 이벤트 기록, DBGREQ 1 = 기록 요청, POSTS 보낸 메시지 수
// 소리 이어 가기(2026-11-23): ctl[21] = 1(web/game.js 가 온라인 전투 중에만 켠다)이면 프레임 허가를 기다리는 동안 그림자 사운드 드라이버만 실시간으로 더 돌려 { snd } 로 보낸다(sound_clock.idle). 프레임이 서도 BGM 이 끊기지 않게. 엔진·지문 무관
const IDLEA = 21, CYC_MS = 262 * 113.6667 * 60.0988 / 1000; let aT = 0;
function audioMark(r) { const t = now(); aT = t - aT > 200 ? t : Math.min(aT + 1000 / 60.0988 / r, t + 60); } // aT = 소리를 만들어 둔 벽시계 시각
function audioIdle(clock) {
  if (ctl.length <= IDLEA || Atomics.load(ctl, IDLEA) !== 1) return; const t = now(); let lag = t - aT; if (lag < 30) return; if (lag > 150) { aT = t - 30; lag = 30; }
  const ms = lag - 10, a = clock.idle(ms * CYC_MS); aT += ms; if (a && a.length) self.postMessage({ snd: a }, [a.buffer]);
}
const PAD_AT = [PAD, PAD + 1, PAD34, PAD34 + 1]; // 패드 포트(0 = 1P … 3 = 4P) → ctl 칸
const RESET_SIGNAL = { reset: true };
let ctl = null, rbq = null, mods = null, rom = null, boot = null, produced = 0;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const SRC = {}, CACHE = {}; // 불러온 CJS 소스·모듈 캐시(팀전 엔진을 나중에 더 불러도 core.js 를 다시 평가하지 않는다)
const req = base => rel => {
  const u = new URL(rel, self.location.origin + base).pathname;
  if (CACHE[u]) return CACHE[u].exports;
  if (!(u in SRC)) throw new Error('모듈 없음 ' + u);
  const m = CACHE[u] = { exports: {} };
  new Function('module', 'exports', 'require', SRC[u] + '\n//# sourceURL=' + u)(m, m.exports, req(u));
  return m.exports;
};
function fetchCjs(urls) { return Promise.all(urls.map(u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.text(); }))).then(txt => { urls.forEach((u, i) => { SRC[u] = txt[i]; }); }); }
function loadCjs(urls) {
  return fetchCjs(urls).then(() => {
    return { core: req('/')('/engine/core.js'), render: req('/')('/engine/render.js'), apu: req('/')('/engine/apu.js'), clock: req('/')('/sound_clock.js'), skip: req('/')('/apu_skip.js') };
  });
}
function teamOf() { const v = ctl.length > TEAM ? Atomics.load(ctl, TEAM) : 0; return v & 16 ? { cpu: [v & 1, (v >> 1) & 1, (v >> 2) & 1, (v >> 3) & 1] } : null; } // 팀전 요청(ctl[12]) → { cpu[4] } | null
function guardOf() { return ctl.length > 15 && Atomics.load(ctl, 15) === 1 ? 1 : 0; } // 온라인 가드(server/engine/guard_as.js): ctl[15] 1 = 켬(패드 Select 비트 = 가드), 0 = 끔(싱글·오프라인, 원작 비트 동일)
function atkOf() { const v = ctl.length > 13 ? Atomics.load(ctl, 13) : 0; return v === 1 ? 'dir' : v === 2 ? 'auto' : false; }
function makeEngine(gen, team) {
  const b = boot, np = rom[4] * 16384, prg = rom.subarray(16, 16 + np), chr = rom.subarray(16 + np, 16 + np + rom[5] * 8192);
  const mkInit = () => Object.assign({}, b, { prg, chr, ram: Uint8Array.from(b.ram), wram: Uint8Array.from(b.wram), vram: Uint8Array.from(b.vram), pal: Uint8Array.from(b.pal), oam: Uint8Array.from(b.oam), reg: Uint8Array.from(b.reg) });
  const atk = atkOf(); // 기본 공격 전진 이동(server/engine/atk_step.js): ctl[13] 0 = 끔(싱글·오프라인, 원작 비트 동일), 1 = 'dir', 2 = 'auto'. 엔진을 새로 만들 때만 읽는다(온라인 대전 호스트가 리셋 전에 쓰고 끝나면 0)
  const gas = guardOf(); // 엔진을 새로 만들 때만 읽는다(atk 와 같은 규칙)
  const mkEng = ini => { const en = team ? new mods.team.TeamEngine(ini || mkInit(), team) : new mods.core.Engine(ini || mkInit()); en.atkStep = atk; en.guardAS = gas; return en; }; // 팀전 = 하위 클래스(core_team.js), 그림자 엔진도 같은 종류·같은 규칙
  const e = mkEng();
  const renderer = e.renderer = new mods.render.Renderer(); // 롤백 복원 때도 같은 렌더러를 새 엔진에 건다(깜박임 제거 상태 보존)
  const RBM = rbq && ctl.length > RBF && Atomics.load(ctl, RBF) === 1 ? { k: 0, front: 0, sk: 0, resim: false, snaps: [], lastCap: -1, off: 0, snapBytes: 0, usedV: new Int32Array(RING * 4), usedK: new Int32Array(RING * 4).fill(-1), mixed: new Uint8Array(RING), stalled: false, posts: 0, tap: null, t0: 0, ver: 0 } : null; // ver = 검증이 끝난 프레임 수(f < ver 는 읽은 값 = 최종 H[f]. 되감기·스냅샷 정리 기준) // 롤백 상태(꺼짐 = null)
  let rsk = false; // 재시뮬 중 화면 그리기 생략
  // 한글 층용 관측(읽기 전용): 켜져 있을 때만 라인마다 [v, fx | ctrl<<8, R0 | R1<<8, mask | bsel bit7<<8 | mirrorV<<9] 를 적고, 라인 239 에서 네임테이블·팔레트를 복사한다.
  let koOn = Atomics.load(ctl, KO), koFull = false; const lt = new Uint16Array(240 * 4), koVram = new Uint8Array(0x800), koPal = new Uint8Array(32);
  let sprOn = ctl.length > SPR && Atomics.load(ctl, SPR), sprFull = false; const sprOam = new Uint8Array(256), sprReg = new Uint8Array(4);
  const rline = e.renderer.line, skipAt = ctl.length > SKIP; let skipOn = false; // 새 엔진의 허가 없이 도는 앞 프레임은 늘 그린다(칸은 허가를 받은 뒤 읽는다)
  e.renderer.line = function (en, y, mask) {
    if (koOn) {
      const p = en.ppu, o = y * 4;
      lt[o] = p.v; lt[o + 1] = p.fx | (p.ctrl << 8); lt[o + 2] = en.reg[0] | (en.reg[1] << 8); lt[o + 3] = mask | ((en.bsel & 0x80) << 1) | (p.mirrorV ? 0x200 : 0);
      if (y === 0) koFull = true; else if (y === 239 && koFull) { koVram.set(en.vram); koPal.set(en.pal); }
    }
    if (sprOn && y === 0) { sprOam.set(en.oamView ? en.oamView() : en.ppuOam); sprReg.set(en.reg.subarray(2, 6)); sprFull = true; } // 프레임 끝의 ppuOam 은 이미 다음 프레임용(NMI 의 DMA 뒤)이라 라인 0 에서 잡는다
    if (skipOn || rsk) return; // 화면 생략 프레임(ctl[11]): 픽셀만 안 그린다(렌더러는 엔진 상태를 바꾸지 않는다)
    return rline.call(this, en, y, mask);
  };
  const sr = Atomics.load(ctl, AUDIO);
  const synth = e.attachApu(new mods.apu.Apu(prg, sr || 44100), b.apu); // 배속 중에는 e.apu 가 비고 그림자가 synth 에 쓴다(sound_clock)
  synth.enabled = !!sr;
  const runTo = synth.runTo, skipTo = mods.skip.skip; synth.runTo = function (t) { return skipOn ? skipTo(this, t) : runTo.call(this, t); }; // 소리 생략 프레임: 샘플 없이 같은 채널 상태로(apu_skip.js). 쓰기·그림자(sound_clock)도 이 경로를 탄다
  const clock = mods.clock.create(e, mkEng); // 그림자 엔진은 처음 배속에 들어갈 때만 만든다
  let first = true, loops = 0;
  const onLoop = () => { loops++; };
  const onEnd = en => {
    if (first) { first = false; return; } // 시작 프레임은 중간 라인부터라 버림
    const rate = Atomics.load(ctl, AUDIO);
    if (rate && !synth.enabled) { synth.sampleRate = rate; synth.enabled = true; }
    // 프레임 경계의 실제 누적 사이클까지 합성. 이 시점(nextLine 안, 새 라인 예산을 더하기 전)의 code.cyc 는 한 라인(114 사이클) 앞을 가리키므로 뺀다.
    // 1배속 = 종전 그대로 synth.runTo + drain. 배속 = 그림자 드라이버가 이 프레임의 실시간 길이(1/배율)만큼 합성(sound_clock)
    const sv = ctl.length > SPD ? Atomics.load(ctl, SPD) : 0;
    const audio = clock.frameEnd(en.code.cyc - 114, sv > 1000 ? sv / 1000 : 1), fb = skipOn ? null : en.renderer.fb.slice(), ram = en.m.slice();
    const out = { fb, audio, ram, frame: en.frame, loops };
    if (koOn && koFull) out.ko = { vram: koVram.slice(), pal: koPal.slice(), lt: lt.slice() };
    if (sprOn && sprFull) out.spr = { oam: sprOam.slice(), reg: sprReg.slice() };
    self.postMessage(out, fb ? [fb.buffer, audio.buffer, ram.buffer] : [audio.buffer, ram.buffer]);
    produced++; audioMark(sv > 1000 ? sv / 1000 : 1);
    for (;;) { // 다음 프레임 허가 대기(리셋 요청이면 엔진을 버리고 새로 만든다)
      if (Atomics.load(ctl, RESET) !== gen) throw RESET_SIGNAL;
      const c = Atomics.load(ctl, CREDIT);
      if (produced < c) break;
      const ia = ctl.length > IDLEA && Atomics.load(ctl, IDLEA) === 1; if (ia) audioIdle(clock);
      Atomics.wait(ctl, CREDIT, c, ia ? 16 : 100);
    }
    koOn = Atomics.load(ctl, KO); koFull = false; sprOn = ctl.length > SPR && Atomics.load(ctl, SPR); sprFull = false; skipOn = skipAt && Atomics.load(ctl, SKIP) === 1; // 허가를 받은 뒤에 읽는다: 정지(P) 중에 한글 층을 켜고 한 프레임을 허가하면 바로 그 프레임부터 관측한다
  };
  const wire = en => { // 엔진 한 개에 입출력 갈고리를 건다(롤백 복원 때 새 엔진에도 같은 순서로)
    en.extPads = ctl.length > PAD34 + 1; // 3P·4P 칸이 있는 공유 메모리일 때만 확장 패드를 연결한다
    en.getPad = RBM ? getPadRb : (f, port) => Atomics.load(ctl, PAD_AT[port]); // 스트로브 시점의 최신 키 상태
    en.onLoop = RBM ? onLoopRb : onLoop; en.onFrameEnd = RBM ? onEndRb : onEnd;
  };
  if (RBM) rollbackSetup(RBM, e);
  wire(e);
  return e;
  // ---- 롤백 모드(RBM 이 있을 때만 쓰인다) ----
  function getPadRb(f, port) { // 프레임 k 의 패드 = H[k]. 읽은 값을 기록해 두었다가 프레임 끝마다 H 와 비교한다
    const R = RBM, k = R.k, i = ((k & RMASK) << 2) + port, v = Atomics.load(rbq, Q_PAD + i);
    if (R.usedK[i] !== k) { R.usedK[i] = k; R.usedV[i] = v; } else if (R.usedV[i] !== v) { R.mixed[k & RMASK] = 1; R.usedV[i] = v; } // 한 프레임 안에서 값이 바뀌어 읽히면(정지 중 폴링 도중 정정) 그 프레임은 불일치로 친다
    return v;
  }
  function rbCap() { const cap = Atomics.load(rbq, Q_SNAPCAP) || 64, mc = Atomics.load(rbq, Q_MEMCAP) || 2097152; return Math.max(2, Math.min(cap, RBM.snapBytes ? Math.floor(mc / RBM.snapBytes) : cap)); }
  function rbPrune() { // 검증이 끝난 프레임 수(R.ver)보다 앞선 스냅샷은 가장 새로운 1개(되감기 대상 k_s < ver)만 남기고 버린다
    const R = RBM, sn = R.snaps; let i = -1;
    for (let j = sn.length - 1; j >= 0; j--) if (sn[j].k < R.ver) { i = j; break; }
    if (i > 0) sn.splice(0, i);
  }
  function rbCapture(en) { // snapshot.js capture 와 같은 필드. APU 는 뜨지 않는다(소리는 롤백 대상이 아님, 그림자 모드에서는 en.apu 가 비어 있기도 하다)
    const R = RBM, st = en.code.st, p = en.ppu;
    const s = { ram: en.m.slice(), wram: en.wram.slice(), vram: en.vram.slice(), pal: en.pal.slice(), oam: en.ppuOam.slice(), reg: en.reg.slice(), padsh: en.padsh.slice(), extsh: en.extsh.slice(), strobe: en.strobe, dispOam: en.dispOam ? en.dispOam.slice() : null, // dispOam = 승리 글자를 뺀 표시용 OAM(표시 전용, 다음 DMA 까지 렌더러가 읽는다)
      bsel: en.bsel, v: p.v, t: p.t, fx: p.fx, w: p.w, rbuf: p.rbuf, oamaddr: p.oamaddr, mirrorV: p.mirrorV, k: R.k, first, loops, cyc: en.code.cyc + R.off, mk: clock.rollback.mark() };
    for (const n of ['A', 'X', 'Y', 'S', 'P', 'bud', 'line', 'frameNo', 'nmiP', 'irqLine', 'ctrl', 'mask', 'stat', 'irqLatch', 'irqCnt', 'irqEn', 'irqReload']) s[n] = st[n];
    s.bud += 6; // onLoop 은 $C178 JSR 직후에 불린다. JSR 명령 직전 상태로 되돌려 둔다(snapshot.js 와 같은 보정)
    return s;
  }
  function onLoopRb(en) {
    loops++; const R = RBM;
    if (R.k <= R.lastCap) return;
    rbPrune();
    if (R.snaps.length >= rbCap()) { Atomics.add(rbq, Q_OVF, 1); return; }
    const t = now(), s = rbCapture(en); R.snaps.push(s); R.lastCap = R.k;
    if (!R.snapBytes) R.snapBytes = s.ram.length + s.wram.length + s.vram.length + s.pal.length + s.oam.length + s.reg.length + 512;
    en.padReads.length = 0; en.sounds.length = 0; // 롤백 모드에서는 누적 기록을 비워 메모리 증가를 막는다(검증용 기록이라 로직과 무관)
    const us = Math.round((now() - t) * 1000); Atomics.add(rbq, Q_SNAPN, 1); Atomics.add(rbq, Q_SNAP_US, us); if (us > Atomics.load(rbq, Q_SNAPMAX_US)) Atomics.store(rbq, Q_SNAPMAX_US, us);
    Atomics.store(rbq, Q_MEM, R.snaps.length * R.snapBytes);
  }
  function rbCheck() { // 되감기 대상 프레임(가장 이른 불일치) 또는 NONE
    const R = RBM, k = R.k; const rq = Atomics.exchange(rbq, Q_REQ, 0); let m = rq ? rq - 1 : NONE; if (m >= k) m = NONE; // 아직 안 돈 프레임의 요청은 H 만 바뀌면 되므로 무시
    const conf = Atomics.load(rbq, Q_CONF), lo = Math.max(R.ver, k - (RING >> 1), 0); // 확정값을 먼저 읽고 그 뒤에 H 를 대조한다(메인은 H 를 쓴 뒤 확정을 올린다)
    for (let f = lo; f < k && f < m; f++) {
      const i = (f & RMASK) << 2;
      if (R.mixed[f & RMASK]) { m = f; break; }
      for (let p = 0; p < 4; p++) if (R.usedK[i + p] === f && R.usedV[i + p] !== Atomics.load(rbq, Q_PAD + i + p)) { m = f; break; }
    }
    if (m === NONE) { R.ver = Math.max(R.ver, Math.min(conf, k)); Atomics.store(rbq, Q_VER, R.ver); }
    return m;
  }
  function rollbackSetup(R, en) {
    clock.rollback.enable(120, { force: true }); // 소리는 늘 그림자 경로(되감기 뒤 새 시간선의 소리를 낼 수 있는 곳)
    if (Atomics.load(rbq, Q_DBG) === 1) { R.tap = []; clock.rollback.tap = (ev, f, rs) => { if (ev.t === 0) R.tap.push(f, ev.id, rs ? 1 : 0); }; }
    Atomics.store(rbq, Q_FRONT, 0); Atomics.store(rbq, Q_STOP, 0); Atomics.store(rbq, Q_VER, 0);
    en.rbRebuild = rbRebuild;
  }
  function rbBuild(s) { // 스냅샷 -> 새 엔진(APU 없음). 팀전이면 TeamEngine
    const np = rom[4] * 16384, init = Object.assign({}, s, { prg: rom.subarray(16, 16 + np), chr: rom.subarray(16 + np, 16 + np + rom[5] * 8192) });
    const en = mkEng(init); en.extsh = s.extsh.slice(); if (s.dispOam) en.dispOam = s.dispOam.slice();
    return en;
  }
  function rbRebuild(x) { // run() 이 롤백 신호(x.rbFrom = 불일치 프레임)를 받으면 부른다. 호출 시점 = e.loop() 밖(호출 스택이 풀린 뒤)
    const R = RBM, t0 = now(), m = x.rbFrom, front = R.k; let si = -1;
    for (let j = R.snaps.length - 1; j >= 0; j--) if (R.snaps[j].k < m || R.snaps[j].first) { si = j; break; } // 엄격 k_s < m. 단 시작 스냅샷(아직 패드를 한 번도 안 읽음)은 m = 0 에도 쓸 수 있다
    if (si < 0) { Atomics.add(rbq, Q_OVF, 1); throw new Error('롤백 불가: 프레임 ' + m + ' 이전 스냅샷 없음(보관 ' + R.snaps.length + '개)'); }
    const s = R.snaps[si]; R.snaps.length = si + 1;
    const en = rbBuild(s);
    R.off = s.cyc - (en.code.cyc + 6); // 새 엔진의 사이클은 0 부근에서 다시 시작한다. 복원 직후 code.cyc 는 JSR 직전(bud + 6)이라 6 이 모자란다
    if (R.off) { const o = en.env.ioWr, off = R.off; en.env.ioWr = (a, v, c) => o(a, v, c === undefined ? c : c + off); } // APU 쓰기 시각을 연속 시간축으로(모드 0 합성기 직접 쓰기)
    en.renderer = renderer; clock.rollback.rebind(en, R.off); clock.rollback.beginResim(s.mk);
    R.k = s.k; first = s.first; loops = s.loops; R.lastCap = s.k; R.front = front; R.sk = s.k; R.resim = true; R.hs = null; rsk = s.k < front - 2; R.t0 = t0;
    for (let f = s.k; f < front; f++) { const i = (f & RMASK) << 2; R.usedK[i] = R.usedK[i + 1] = R.usedK[i + 2] = R.usedK[i + 3] = -1; R.mixed[f & RMASK] = 0; } // 되감은 구간의 "읽은 값" 기록을 버린다
    const d = front - s.k, rus = Math.round((now() - t0) * 1000);
    Atomics.add(rbq, Q_NRB, 1); Atomics.store(rbq, Q_DEPTH, d); if (d > Atomics.load(rbq, Q_MAXD)) Atomics.store(rbq, Q_MAXD, d); Atomics.add(rbq, Q_RESIMF, d); Atomics.add(rbq, Q_REST_US, rus); if (rus > Atomics.load(rbq, Q_RESTMAX_US)) Atomics.store(rbq, Q_RESTMAX_US, rus);
    en.rbRebuild = rbRebuild; wire(en);
    return en;
  }
  function postRb(en, audio, redo) {
    const R = RBM, fb = skipOn ? null : renderer.fb.slice(), ram = en.m.slice();
    const out = { fb, audio, ram, frame: en.frame, loops, rb: { f: R.k - 1, n: Atomics.load(rbq, Q_NRB), d: Atomics.load(rbq, Q_DEPTH) } };
    if (redo) out.redo = true;
    if (R.hs) { out.rb.h = R.hs; R.hs = null; }
    if (koOn && koFull) out.ko = { vram: koVram.slice(), pal: koPal.slice(), lt: lt.slice() };
    if (sprOn && sprFull) out.spr = { oam: sprOam.slice(), reg: sprReg.slice() };
    self.postMessage(out, fb ? [fb.buffer, audio.buffer, ram.buffer] : [audio.buffer, ram.buffer]);
    R.posts++; Atomics.store(rbq, Q_POSTS, R.posts);
  }
  function rbRecord(en, c) { // 끝난 프레임 수 c 의 지문·결과 비트(메인 game.js 가 검증이 끝난 뒤 읽는다)
    const m = en.m; let h = 0x811c9dc5; for (let i = 0; i < m.length; i++) { h ^= m[i]; h = Math.imul(h, 16777619); }
    let s = m[0x641] === 1 && (m[0x642] & 0x7F) === 5 ? 1 : 0; if (m[0x611] & 8) s |= 2; if (m[0x612] & 8) s |= 4;
    for (let p = 0; p < 4; p++) { if (!(m[0x4A2 + p] & 4)) s |= 8 << p; if (m[0x4C2 + p] > 0) s |= 128 << p; }
    Atomics.store(rbq, HB + (c & RMASK), h | 0); Atomics.store(rbq, SB + (c & RMASK), s);
  }
  function onEndRb(en) {
    if (first) { first = false; return; }
    const R = RBM; R.k++; if (rbq.length >= SB + RING) rbRecord(en, R.k);
    const sv = ctl.length > SPD ? Atomics.load(ctl, SPD) : 0, spdR = sv > 1000 ? sv / 1000 : 1, C1 = en.code.cyc - 114 + R.off; // 연속 시간축
    if (R.resim) { // 재시뮬 프레임: 메시지·소리·허가 대기 없음
      clock.frameEnd(C1, spdR);
      if (R.k >= R.front - 4) (R.hs || (R.hs = [])).push({ f: en.frame, m: en.m.slice() }); // 되감은 구간의 마지막 5프레임 RAM: 다음 메시지(rb.h)에 실어 표시 층(이름표 = 4프레임 전 RAM)이 옛 시간선 좌표를 쓰지 않게 한다
      if (Atomics.load(ctl, RESET) !== gen) throw RESET_SIGNAL;
      if (R.k < R.front) { rsk = R.k < R.front - 2; return; }
      rsk = false; clock.rollback.endResim(); R.resim = false;
      const us = Math.round((now() - R.t0) * 1000); Atomics.add(rbq, Q_RESIM_US, us); if (us > Atomics.load(rbq, Q_RESIMMAX_US)) Atomics.store(rbq, Q_RESIMMAX_US, us);
      if (R.k - 1 > R.sk && produced >= Atomics.load(ctl, CREDIT)) postRb(en, new Float32Array(0), true); // 정정된 최신 프레임(다음 허가가 이미 있으면 곧 새 프레임이 덮으므로 생략)
      Atomics.add(rbq, Q_SEQ, 1);
    } else {
      const rate = Atomics.load(ctl, AUDIO);
      if (rate && !synth.enabled) { synth.sampleRate = rate; synth.enabled = true; }
      postRb(en, clock.frameEnd(C1, spdR), false); produced++; Atomics.store(rbq, Q_FRONT, R.k); audioMark(spdR);
    }
    for (;;) { // 다음 프레임 허가 대기(리셋·정정·정지 한도 확인)
      if (Atomics.load(ctl, RESET) !== gen) throw RESET_SIGNAL;
      const dq = R.tap && Atomics.load(rbq, Q_DBGREQ) === 1; // 점검 요청은 정정 확인(rbCheck)보다 먼저 읽는다: 메인이 H 를 쓴 뒤 요청을 걸므로, 요청이 보이면 그 H 도 rbCheck 에 보인다
      const m = rbCheck(); if (m !== NONE) throw { rbFrom: m };
      if (dq) { Atomics.store(rbq, Q_DBGREQ, 0); self.postMessage({ rbdbg: { tap: R.tap.slice(), snd: Object.assign({}, clock.rollback.stats), k: R.k, ram: en.m.slice() } }); }
      const lim = Atomics.load(rbq, Q_LIMIT), stalled = lim > 0 && R.k - Atomics.load(rbq, Q_CONF) >= lim;
      if (stalled !== R.stalled) { R.stalled = stalled; Atomics.store(rbq, Q_STOP, stalled ? 1 : 0); if (stalled) Atomics.add(rbq, Q_STALLS, 1); }
      const c = Atomics.load(ctl, CREDIT);
      if (!stalled && produced < c) break;
      audioIdle(clock);
      Atomics.wait(ctl, CREDIT, c, 16);
    }
    koOn = Atomics.load(ctl, KO); koFull = false; sprOn = ctl.length > SPR && Atomics.load(ctl, SPR); sprFull = false; skipOn = skipAt && Atomics.load(ctl, SKIP) === 1;
  }
}
async function run() {
  for (;;) {
    const gen = Atomics.load(ctl, RESET);
    try { const team = teamOf(); if (team && !mods.team) { await fetchCjs(['/engine/core_team.js', '/engine/gen/code_team.js']); mods.team = req('/')('/engine/core_team.js'); } let e = makeEngine(gen, team); const rebuild = e.rbRebuild; for (;;) { try { e.loop(); } catch (x) { if (x && x.rbFrom !== undefined && rebuild) { e = rebuild(x); continue; } throw x; } } }
    catch (x) {
      if (x === RESET_SIGNAL) continue;
      self.postMessage({ fatal: String(x && x.message || x) });
      while (Atomics.load(ctl, RESET) === gen) Atomics.wait(ctl, RESET, gen, 250); // 리셋(R)까지 정지
    }
  }
}
self.onmessage = ev => {
  const d = ev.data; if (!d || !d.ctl || ctl) return;
  ctl = new Int32Array(d.ctl); rom = d.rom; boot = d.boot; rbq = d.rb ? new Int32Array(d.rb) : null; if (rbq && rbq.length < Q_PAD + RING * 4) rbq = null;
  loadCjs(['/engine/core.js', '/engine/atk_step.js', '/engine/guard_as.js', '/engine/no_winner.js', '/engine/gen/code.js', '/engine/render.js', '/engine/apu.js', '/sound_clock.js', '/apu_skip.js'])
    .then(m => { mods = m; self.postMessage({ ready: true, pal32: m.render.PAL32 }); run(); })
    .catch(e => self.postMessage({ fatal: String(e && e.message || e) }));
};
