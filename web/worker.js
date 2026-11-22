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
const CREDIT = 0, PAD = 1, RESET = 3, AUDIO = 4, KO = 5, PAD34 = 6, SPR = 8, SPD = 10, SKIP = 11, TEAM = 12;
const PAD_AT = [PAD, PAD + 1, PAD34, PAD34 + 1]; // 패드 포트(0 = 1P … 3 = 4P) → ctl 칸
const RESET_SIGNAL = { reset: true };
let ctl = null, mods = null, rom = null, boot = null, produced = 0;

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
function atkOf() { const v = ctl.length > 13 ? Atomics.load(ctl, 13) : 0; return v === 1 ? 'dir' : v === 2 ? 'auto' : false; }
function makeEngine(gen, team) {
  const b = boot, np = rom[4] * 16384, prg = rom.subarray(16, 16 + np), chr = rom.subarray(16 + np, 16 + np + rom[5] * 8192);
  const mkInit = () => Object.assign({}, b, { prg, chr, ram: Uint8Array.from(b.ram), wram: Uint8Array.from(b.wram), vram: Uint8Array.from(b.vram), pal: Uint8Array.from(b.pal), oam: Uint8Array.from(b.oam), reg: Uint8Array.from(b.reg) });
  const atk = atkOf(); // 기본 공격 전진 이동(server/engine/atk_step.js): ctl[13] 0 = 끔(싱글·오프라인, 원작 비트 동일), 1 = 'dir', 2 = 'auto'. 엔진을 새로 만들 때만 읽는다(온라인 대전 호스트가 리셋 전에 쓰고 끝나면 0)
  const mkEng = () => { const en = team ? new mods.team.TeamEngine(mkInit(), team) : new mods.core.Engine(mkInit()); en.atkStep = atk; return en; }; // 팀전 = 하위 클래스(core_team.js), 그림자 엔진도 같은 종류·같은 규칙
  const e = mkEng();
  e.renderer = new mods.render.Renderer();
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
    if (skipOn) return; // 화면 생략 프레임(ctl[11]): 픽셀만 안 그린다(렌더러는 엔진 상태를 바꾸지 않는다)
    return rline.call(this, en, y, mask);
  };
  const sr = Atomics.load(ctl, AUDIO);
  const synth = e.attachApu(new mods.apu.Apu(prg, sr || 44100), b.apu); // 배속 중에는 e.apu 가 비고 그림자가 synth 에 쓴다(sound_clock)
  synth.enabled = !!sr;
  const runTo = synth.runTo, skipTo = mods.skip.skip; synth.runTo = function (t) { return skipOn ? skipTo(this, t) : runTo.call(this, t); }; // 소리 생략 프레임: 샘플 없이 같은 채널 상태로(apu_skip.js). 쓰기·그림자(sound_clock)도 이 경로를 탄다
  const clock = mods.clock.create(e, mkEng); // 그림자 엔진은 처음 배속에 들어갈 때만 만든다
  e.extPads = ctl.length > PAD34 + 1; // 3P·4P 칸이 있는 공유 메모리일 때만 확장 패드를 연결한다
  e.getPad = (f, port) => Atomics.load(ctl, PAD_AT[port]); // 스트로브 시점의 최신 키 상태
  let first = true, loops = 0;
  e.onLoop = () => { loops++; };
  e.onFrameEnd = en => {
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
    produced++;
    for (;;) { // 다음 프레임 허가 대기(리셋 요청이면 엔진을 버리고 새로 만든다)
      if (Atomics.load(ctl, RESET) !== gen) throw RESET_SIGNAL;
      const c = Atomics.load(ctl, CREDIT);
      if (produced < c) break;
      Atomics.wait(ctl, CREDIT, c, 100);
    }
    koOn = Atomics.load(ctl, KO); koFull = false; sprOn = ctl.length > SPR && Atomics.load(ctl, SPR); sprFull = false; skipOn = skipAt && Atomics.load(ctl, SKIP) === 1; // 허가를 받은 뒤에 읽는다: 정지(P) 중에 한글 층을 켜고 한 프레임을 허가하면 바로 그 프레임부터 관측한다
  };
  return e;
}
async function run() {
  for (;;) {
    const gen = Atomics.load(ctl, RESET);
    try { const team = teamOf(); if (team && !mods.team) { await fetchCjs(['/engine/core_team.js', '/engine/gen/code_team.js']); mods.team = req('/')('/engine/core_team.js'); } const e = makeEngine(gen, team); for (;;) e.loop(); }
    catch (x) {
      if (x === RESET_SIGNAL) continue;
      self.postMessage({ fatal: String(x && x.message || x) });
      while (Atomics.load(ctl, RESET) === gen) Atomics.wait(ctl, RESET, gen, 250); // 리셋(R)까지 정지
    }
  }
}
self.onmessage = ev => {
  const d = ev.data; if (!d || !d.ctl || ctl) return;
  ctl = new Int32Array(d.ctl); rom = d.rom; boot = d.boot;
  loadCjs(['/engine/core.js', '/engine/atk_step.js', '/engine/no_winner.js', '/engine/gen/code.js', '/engine/render.js', '/engine/apu.js', '/sound_clock.js', '/apu_skip.js'])
    .then(m => { mods = m; self.postMessage({ ready: true, pal32: m.render.PAL32 }); run(); })
    .catch(e => self.postMessage({ fatal: String(e && e.message || e) }));
};
