'use strict';
// 결정론 엔진 코어(원작 모드). 로직은 gen/code.js(6502 루틴 1:1 직역 + 명령별 사이클 계수, tools/rom/gen_port.py 생성)이고
// 이 파일은 하드웨어 경계만 담당한다: RAM 2KB, MMC3 PRG 매핑, 패드 시프트 레지스터, OAM DMA, APU/PPU 쓰기 기록.
// 출력 계층: this.renderer(render.js Renderer)를 달면 스캔라인마다 프레임버퍼를 그리고, this.apu(apu.js Apu)를 달면 APU 쓰기를 합성기로 넘긴다.
// 둘 다 선택 사항이며 달든 안 달든 게임 로직 상태는 같다(렌더용 스크롤 v 갱신은 항상 수행 — 오라클과 동일).
// 타이밍 모델(스캔라인당 113.6667 사이클, 241 라인 NMI, MMC3 IRQ)은 오라클 에뮬과 같은 규칙이라 NMI 가 로직 도중에
// 들어오는 지연 프레임까지 같은 명령 경계에서 재현한다. 번역되지 않은 코드에 도달하면 예외(미해결)로 멈춘다.
const make = require('./gen/code.js');
const { atkStepInstall, atkStepEnvDefault, atkStepResolve } = require('./atk_step.js'); // 기본 공격 전진 이동(옵션 atkStep, 기본 꺼짐)
const { noWinnerEnvDefault, noWinnerDisp } = require('./no_winner.js'); // 승리 글자(WIN!!) 숨기기(표시 전용 옵션 noWinner, 기본 켬)

const MAIN_LOOP = 0x1C178;

class Engine {
  // init(오라클의 메인 루프 진입 $C178 시점 상태):
  //  { prg, chr, ram, wram, vram, pal, oam, reg(8), bsel, v,t,fx,w,rbuf,oamaddr,mirrorV, A,X,Y,S,P, bud, line, frameNo, nmiP, irqLine, ctrl, mask, stat, irqLatch, irqCnt, irqEn, irqReload, padsh:[a,b], strobe }
  //  (padsh 는 1P·2P 표준 패드 시프트 레지스터 2칸. 확장 단자 패드(3P·4P)는 시작 상태에 없고 extPads 를 켠 뒤 첫 스트로브부터 채워진다)
  constructor(init) {
    this.m = new Uint8Array(0x800); this.m.set(init.ram);
    this.wram = new Uint8Array(0x2000); if (init.wram) this.wram.set(init.wram);
    this.prg = init.prg;
    this.pb = new Int32Array(2); this.reg = new Uint8Array(8); this.bsel = init.bsel | 0;
    if (init.reg) this.reg.set(init.reg); else { this.reg[6] = init.reg6; this.reg[7] = init.reg7; }
    this._banks();
    // PPU 레지스터·메모리 모델(렌더링 제외). 원작에 PPU 주소 공간을 데이터로 읽는 코드가 있어(11_ai.md 의 $A368 경유점 버그:
    // 패드 값이 인덱스가 되어 $2007 읽기 버퍼를 읽음) 로직 재현에도 필요하다. 네임테이블/팔레트 상태는 렌더러(M2) 입력이기도 하다.
    this.chr = init.chr || new Uint8Array(0x20000);
    this.vram = new Uint8Array(0x800); if (init.vram) this.vram.set(init.vram);
    this.pal = new Uint8Array(32); if (init.pal) this.pal.set(init.pal);
    this.ppuOam = new Uint8Array(256); if (init.oam) this.ppuOam.set(init.oam);
    this.ppu = { ctrl: init.ctrl | 0, mask: init.mask | 0, v: init.v | 0, t: init.t | 0, fx: init.fx | 0, w: init.w | 0, rbuf: init.rbuf | 0, oamaddr: init.oamaddr | 0, mirrorV: !!init.mirrorV };
    this.padsh = init.padsh ? init.padsh.slice() : [0, 0]; this.strobe = init.strobe | 0;
    this.getPad = null;      // (frameNo, port) -> 에뮬 규약 패드 비트(A=1 B=2 SEL=4 START=8 U=16 D=32 L=64 R=128). port 0 = 1P, 1 = 2P, (extPads 일 때만) 2 = 3P, 3 = 4P
    // 확장 단자 패드(패미컴 3P·4P). 원작 패드 루틴 $F99F 는 $4016·$4017 을 8번 읽으며 bit0 을 $04(1P)·$05(2P)에, bit1 을 $08(3P)·$09(4P)에 ROL 로 모은다(analysis/17_online_4p.md 1절).
    //   extPads = false(기본): 종전과 완전히 같다 — bit1 은 항상 0, getPad 를 포트 2·3 으로 부르지 않는다, padReads 형식도 그대로.
    //   extPads = true: 스트로브 때 getPad(f, 2)·getPad(f, 3) 을 읽어 $4016 bit1 = 3P, $4017 bit1 = 4P 로 1P·2P 와 같은 직렬 순서(A B SEL START U D L R)로 내보낸다.
    //   확장 패드 시프트 레지스터는 0 을 밀어 넣는다(값이 0 인 패드 = 연결 안 한 것과 비트 단위로 같다. 원작은 스트로브마다 8번만 읽는다).
    this.extPads = false; this.extsh = [0, 0];
    this.hp0Down = !(typeof process !== 'undefined' && process.env && process.env.NK_HP0_DOWN === '0'); // HP 0 즉시 다운 규칙(아래 hp0Install 주석). 기본 켬, false 또는 환경변수 NK_HP0_DOWN=0(Node 한정) = 원작과 비트 동일. 사용자 결정 2026-11-22
    this._atk = atkStepEnvDefault(); // 기본 false = 원작과 비트 동일. 온라인 락스텝 대전만 engine.atkStep = 'auto'|'dir' (server/engine/atk_step.js)
    this.noWinner = noWinnerEnvDefault(); this.dispOam = null; // 표시 전용: true 면 DMA 때 승리 글자 조각을 뺀 OAM 사본(dispOam)을 만든다. false 또는 환경변수 NK_NO_WINNER=0 = 원작과 비트 동일(server/engine/no_winner.js)
    this.onFrameEnd = null;  // (engine, frameNo) : 프레임(262 라인) 경계
    this.onNmi = null;       // (engine) : NMI 핸들러 첫 명령 직전(그 프레임에 표시될 상태)
    this.onLoop = null;      // (engine) : 메인 루프 진입($C178) 직전
    this.sounds = [];        // {frame, id} 사운드 요청($FBFF 진입 시 A)
    this.padReads = [];      // {frame, v} 패드 스트로브 시점 값(검증용)
    this.apuLog = null;      // 배열을 넣으면 {frame, line, cyc, a, v} APU 레지스터 쓰기 기록(cyc = 쓰기 명령 시작 시점의 누적 CPU 사이클)
    this.renderer = null;    // render.js Renderer (선택). 프레임 경계(onFrameEnd)에서 renderer.fb 가 완성된 프레임
    this.apu = null;         // apu.js Apu (선택). attachApu() 로 연결
    this.oam = new Uint8Array(256); this.oamFrames = 0;
    const self = this;
    this.env = {
      m: this.m, prg: this.prg, pb: this.pb, bc: 0,
      ioRd(a) {
        if (a === 0x4016 || a === 0x4017) {
          const i = a & 1; const v = self.padsh[i] & 1; self.padsh[i] = (self.padsh[i] >> 1) | 0x80;
          if (!self.extPads) return 0x40 | v;
          const x = self.extsh[i] & 1; self.extsh[i] >>= 1; return 0x40 | (x << 1) | v; // bit1 = 확장 단자 패드(3P = $4016, 4P = $4017)
        }
        if (a >= 0x6000 && a < 0x8000) return self.wram[a - 0x6000];
        if (a < 0x4000) return self._ppuRd(a & 7);
        if (a === 0x4015) throw new Error('미해결: APU 상태 읽기 $4015');
        return 0;
      },
      ioWr(a, v, cyc) {
        if (a >= 0x8000) { // $8000~$BFFF (MMC3 뱅크 선택/데이터, 미러링)
          if (a < 0xA000) { if (!(a & 1)) self.bsel = v; else { self.reg[self.bsel & 7] = v; self._banks(); } }
          else if (!(a & 1)) self.ppu.mirrorV = (v & 1) === 0;
          return;
        }
        if (a === 0x4016) {
          self.strobe = v & 1;
          if (self.strobe) {
            const f = self.code.frameNo, p0 = self.getPad ? self.getPad(f, 0) : 0, p1 = self.getPad ? self.getPad(f, 1) : 0;
            self.padsh[0] = p0; self.padsh[1] = p1;
            if (!self.extPads) self.padReads.push({ frame: f, v: p0, v2: p1 });
            else { const p2 = (self.getPad ? self.getPad(f, 2) : 0) & 255, p3 = (self.getPad ? self.getPad(f, 3) : 0) & 255; self.extsh[0] = p2; self.extsh[1] = p3; self.padReads.push({ frame: f, v: p0, v2: p1, v3: p2, v4: p3 }); }
          }
          return;
        }
        if (a < 0x4000) { self._ppuWr(a & 7, v); return; }
        if (a === 0x4014) {
          const b = (v << 8) & 0x7FF; self.oam.set(self.m.subarray(b, b + 256)); self.oamFrames++;
          for (let i = 0; i < 256; i++) self.ppuOam[(self.ppu.oamaddr + i) & 255] = self.m[b + i];
          if (self.noWinner) noWinnerDisp(self, b);
          return;
        }
        if (a >= 0x4000 && a <= 0x4017) {
          if (self.apuLog) self.apuLog.push({ frame: self.code.frameNo, line: self.code.line, cyc, a, v });
          if (self.apu) self.apu.write(cyc, a, v);
          return;
        }
        if (a >= 0x6000) { self.wram[a - 0x6000] = v; return; }
      },
      frameEnd(f) { if (self.onFrameEnd) self.onFrameEnd(self, f); },
      scan(line, mask) { self._scan(line, mask); },
      onNmi() { if (self.onNmi) self.onNmi(self); },
      onLoop() { if (self.onLoop) self.onLoop(self); },
      onSound(A) { self.sounds.push({ frame: self.code.frameNo, id: A }); },
      tr() {},
    };
    this.code = make(this.env);
    this.code.st = init;
  }
  _banks() {
    if (this.bsel & 0x40) throw new Error('MMC3 PRG 모드 1 미지원');
    this.pb[0] = (this.reg[6] & 15) << 13; this.pb[1] = (this.reg[7] & 15) << 13;
  }
  // --- PPU 레지스터 모델(오라클 ppuRd/ppuWr 와 동일 규칙; $2000 bit7/$2001/$2002 의 타이밍 효과는 생성 코드 런타임이 처리)
  _chrOff(a) { // MMC3 CHR 매핑(1KB 단위)
    const r = this.reg, inv = (this.bsel >> 7) & 1, s = (a >> 10) & 7, k = inv ? s ^ 4 : s; let b;
    if (k < 4) b = (r[k >> 1] & 0xFE) + (k & 1); else b = r[k - 2];
    return ((b % (this.chr.length >> 10)) << 10) + (a & 0x3FF);
  }
  _nt(a) { const t = (a >> 10) & 3; return (this.ppu.mirrorV ? (t & 1) : (t >> 1)) * 0x400 + (a & 0x3FF); }
  _palIdx(a) { let i = a & 0x1F; if ((i & 0x13) === 0x10) i &= 0x0F; return i; }
  _ppuRd(r) {
    const p = this.ppu;
    if (r === 2) { p.w = 0; return 0; }
    if (r === 4) return this.ppuOam[p.oamaddr];
    if (r === 7) {
      const a = p.v & 0x3FFF; let v;
      if (a >= 0x3F00) { v = this.pal[this._palIdx(a)]; p.rbuf = this.vram[this._nt(a)]; }
      else { v = p.rbuf; p.rbuf = a < 0x2000 ? this.chr[this._chrOff(a)] : this.vram[this._nt(a)]; }
      p.v = (p.v + ((p.ctrl & 4) ? 32 : 1)) & 0x7FFF; return v;
    }
    return 0;
  }
  _ppuWr(r, v) {
    const p = this.ppu;
    if (r === 0) { p.ctrl = v; p.t = (p.t & 0xF3FF) | ((v & 3) << 10); }
    else if (r === 1) p.mask = v;
    else if (r === 3) p.oamaddr = v;
    else if (r === 4) { this.ppuOam[p.oamaddr] = v; p.oamaddr = (p.oamaddr + 1) & 255; }
    else if (r === 5) {
      if (!p.w) { p.fx = v & 7; p.t = (p.t & 0xFFE0) | (v >> 3); p.w = 1; }
      else { p.t = (p.t & 0x8C1F) | ((v & 7) << 12) | ((v & 0xF8) << 2); p.w = 0; }
    } else if (r === 6) {
      if (!p.w) { p.t = (p.t & 0x00FF) | ((v & 0x3F) << 8); p.w = 1; }
      else { p.t = (p.t & 0xFF00) | v; p.v = p.t; p.w = 0; }
    } else if (r === 7) {
      const a = p.v & 0x3FFF;
      if (a >= 0x3F00) this.pal[this._palIdx(a)] = v & 0x3F;
      else if (a >= 0x2000) this.vram[this._nt(a)] = v;
      p.v = (p.v + ((p.ctrl & 4) ? 32 : 1)) & 0x7FFF;
    }
  }
  // 스캔라인 시작 훅(생성 코드 런타임 nextLine 에서 호출). 오라클 runFrame 과 같은 순서:
  //  라인 261: 렌더링 켜져 있으면 v=t. 라인 0~239: 그 라인을 그린 뒤(렌더러가 있을 때) v 의 수직 증가 + 수평 비트 복사.
  _scan(line, mask) {
    const p = this.ppu, rend = mask & 0x18;
    if (line === 261) { if (rend) p.v = p.t; return; }
    if (line >= 240) return;
    if (this.renderer) this.renderer.line(this, line, mask);
    if (rend) {
      let v = p.v;
      if ((v & 0x7000) !== 0x7000) v += 0x1000;
      else {
        v &= ~0x7000; let cy = (v & 0x3E0) >> 5;
        if (cy === 29) { cy = 0; v ^= 0x800; } else if (cy === 31) cy = 0; else cy++;
        v = (v & ~0x3E0) | (cy << 5);
      }
      p.v = (v & ~0x41F) | (p.t & 0x41F);
    }
  }
  // APU 합성기 연결. state = 오라클에서 캡처한 APU 상태(없으면 전원 켠 상태), 기준 사이클은 현재 엔진 시각.
  attachApu(apu, state) { if (state) apu.loadState(state, this.code.cyc); else apu.cyc = this.code.cyc; this.apu = apu; return apu; }
  // 현재 엔진 시각까지 소리를 합성하고 샘플을 꺼낸다(프레임 경계에서 호출)
  drainAudio() { if (!this.apu) return new Float32Array(0); this.apu.runTo(this.code.cyc); return this.apu.drain(); }
  oamView() { return this.noWinner && this.dispOam ? this.dispOam : this.ppuOam; } // 화면에 그릴 OAM(렌더러·워커 스프라이트 사본이 읽는다. 로직·스냅샷은 ppuOam)
  get atkStep() { return this._atk; } set atkStep(v) { this._atk = atkStepResolve(v); }
  get frame() { return this.code.frameNo; }
  // 메인 루프 1회전(전투 중 = 로직 틱 1회, 보통 4프레임)
  // 생성 코드는 메인 루프 재진입($C178 로의 JMP·폴스루)을 3 으로 돌려준다(tools/rom/port_runtime.js unw 주석). 그 밖의 값 = 비정상.
  loop() { if (this._hp0c !== this.code) { this._hp0c = this.code; hp0Install(this); atkStepInstall(this); } if (this.code.F[MAIN_LOOP](this.code.S) !== 3) throw new Error('메인 루프가 비정상 복귀(스택 되감기 실패)'); }
  // 프레임 번호가 target 이상이 될 때까지 진행(루프 경계에서 멈춤)
  runUntilFrame(target) { while (this.code.frameNo < target) this.loop(); }
}
// ---- HP 0 즉시 다운(사용자 결정 2026-11-22 「그냥 체력 0이면 즉시 다운」, 옵션 engine.hp0Down 기본 true, false 면 아래 훅이 아무것도 안 해 원작과 비트 동일) ----
// 원작은 HP 가 0 이어도 다운 상태(행동 1B/1C, B089)에 들어가야 탈락($04A2 bit6, 행동 66)이 확정된다 — 올라타기·잡기 중이면 최대 6.5초 더 움직인다.
// 요청 게이트 f12_956D(파일 0x1956D, 틱마다 슬롯 0~3 이 부름: 명중 판정·피격 처리 뒤, 핸들러 앞) 앞에서 HP 0·미탈락 슬롯에게 피격 날아감 요청(0x1E, $0570 bit7 고정 궤적·뒤로)을 넣는다.
// 착지하면 기존 경로로 1B → B089 가 66 으로 확정. 게이트가 1E 를 막는 행동(다운·날아감·들림 등)은 이미 다운 경로라 건드리지 않고, 작은 경직(13·1A)만 게이트를 건너 직접 1E 로 바꾼다.
// 하는 일은 RAM 읽기·쓰기뿐(내부 상태 없음)이라 스냅샷·락스텝 결정성에 영향 없음. 팀전 엔진(core_team.js)이 code 를 갈아 끼워도 loop() 가 새 code 에 다시 건다.
const HP0_GATE = 0x1956D;
function hp0Install(eng) {
  const F = eng.code.F, orig = F[HP0_GATE]; if (!orig) return;
  const m = eng.m, prg = eng.prg, blk = new Uint8Array(0x80), tb = 12 * 0x2000 - 0x8000, rdp = a => prg[tb + a];
  const tp = rdp(0x95C3 + 0x3C) | (rdp(0x95C3 + 0x3D) << 8); // 요청 0x1E 가 못 넘어가는 현재 행동 비트맵(게이트 표 $95C3[req])
  for (let c = 0; c < 0x80; c++) blk[c] = (rdp(tp + (c >> 3)) & (0x80 >> (c & 7))) ? 1 : 0;
  F[HP0_GATE] = function (s0) {
    if (eng.hp0Down && m[0x641] === 1 && (m[0x642] & 0x7F) === 2 && !(m[0x643] & 2)) {
      for (let x = 0; x < 4; x++) {
        if (m[0x4C2 + x] !== 0 || (m[0x4A2 + x] & 0x40)) continue;
        const cur = m[0x49E + x] & 0x7F;
        if (cur === 0x13 || cur === 0x1A) { m[0x49E + x] = 0x1E; m[0x4AE + x] = 0x9E; }
        else if (!blk[cur]) m[0x4AE + x] = 0x1E; else continue;
        m[0x570 + x] = (m[0x570 + x] | 0x80) & ~0x40; m[0x482 + x] = (m[0x5B + x] & 0x80) ? 0x40 : 0xC0;
      }
    }
    return orig(s0);
  };
}
module.exports = { Engine, MAIN_LOOP };
