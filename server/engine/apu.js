'use strict';
// 사운드 계층: 엔진(직역된 원작 사운드 드라이버)이 내는 APU 레지스터 쓰기열(누적 CPU 사이클 타임스탬프 포함)을 받아
// PCM 샘플을 합성한다. Node/브라우저 공용. 합성 규칙은 오라클(public/nes.js 의 apuWr/apuTick/clock*)과 같은 식을 그대로 옮긴 것이다
// (pulse x2, triangle, noise, DMC, 프레임 카운터, 비선형 믹서, 사이클 평균 다운샘플). 대체 음원·재해석 없음.
// 오라클과 동일한 한계: 프레임 카운터 타이밍 근사, 프레임/DMC IRQ·DMC 사이클 스틸 없음, 출력 필터 없음(실기 정확도는 미검증).
// 사용: const a = new Apu(prg, sampleRate); a.write(cyc, addr, val); a.runTo(cyc); a.drain() -> Float32Array
const LEN_TAB = [10,254,20,2,40,4,80,6,160,8,60,10,14,12,26,14,12,16,24,18,48,20,96,22,192,24,72,26,16,28,32,30];
const NOISE_TAB = [4,8,16,32,64,96,128,160,202,254,380,508,762,1016,2034,4068];
const DMC_TAB = [428,380,340,320,286,254,226,214,190,160,142,128,106,84,72,54];
const DUTY = [[0,1,0,0,0,0,0,0],[0,1,1,0,0,0,0,0],[0,1,1,1,1,0,0,0],[1,0,0,1,1,1,1,1]];
const TRI_SEQ = [15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15];
const STATE_KEYS = ['apuAcc', 'apuSum', 'apuN', 'fcCycles', 'fc5', 'fcIrqInhibit', 'apuOdd'];

class Apu {
  // prg = PRG ROM 전체(DMC 샘플은 고정 뱅크 $C000~$FFFF = 마지막 16KB 에서 읽는다. 원작 샘플 위치 $FE00~$FFBF)
  constructor(prg, sampleRate) {
    this.prg = prg; this.fixedBase = prg.length - 0x4000;
    this.sampleRate = sampleRate || 44100; this.apuAcc = 0; this.apuSum = 0; this.apuN = 0;
    this.chunks = []; this.buf = new Float32Array(4096); this.len = 0; this.enabled = true;
    this.p = [0, 1].map(() => ({ en: false, duty: 0, halt: false, constVol: false, vol: 0, envStart: false, envDiv: 0, envDecay: 0,
      sweepEn: false, sweepPer: 0, sweepNeg: false, sweepShift: 0, sweepReload: false, sweepDiv: 0, timer: 0, tcnt: 0, seq: 0, len: 0 }));
    this.tri = { en: false, ctrl: false, linReload: 0, linCnt: 0, linFlag: false, timer: 0, tcnt: 0, seq: 0, len: 0 };
    this.noi = { en: false, halt: false, constVol: false, vol: 0, envStart: false, envDiv: 0, envDecay: 0, mode: false, period: 4, tcnt: 0, shift: 1, len: 0 };
    this.dmc = { en: false, irq: false, loop: false, rate: 428, tcnt: 428, out: 0, addr: 0xC000, len: 0, curAddr: 0, rem: 0, sbuf: 0, sbufFull: false, shift: 0, bits: 0, silent: true };
    this.fcCycles = 0; this.fc5 = false; this.fcIrqInhibit = false; this.apuOdd = false;
    this.cyc = 0; // 여기까지 합성을 마친 누적 CPU 사이클
  }
  // 상태 저장/복원(오라클 NES 인스턴스의 APU 필드와 같은 이름). 엔진 시작 상태·세이브·롤백용.
  saveState() {
    const s = { p: this.p.map(c => ({ ...c })), tri: { ...this.tri }, noi: { ...this.noi }, dmc: { ...this.dmc } };
    for (const k of STATE_KEYS) s[k] = this[k];
    return s;
  }
  loadState(s, cyc) {
    this.p = s.p.map(c => ({ ...c })); this.tri = { ...s.tri }; this.noi = { ...s.noi }; this.dmc = { ...s.dmc };
    for (const k of STATE_KEYS) this[k] = s[k];
    this.cyc = cyc | 0;
  }
  rdMem(a) { // DMC 샘플 읽기. 원작은 고정 뱅크만 쓴다. 그 밖의 주소는 미해결(뱅크 매핑 시점 의존)로 예외.
    if (a >= 0xC000) return this.prg[this.fixedBase + a - 0xC000];
    throw new Error('미해결: DMC 가 고정 뱅크 밖($' + a.toString(16) + ')을 읽음');
  }
  write(cyc, a, v) { this.runTo(cyc); this.reg(a, v); }
  reg(a, v) {
    const p = this.p, t = this.tri, n = this.noi, d = this.dmc;
    if (a < 0x4008) {
      const c = p[(a >> 2) & 1];
      switch (a & 3) {
        case 0: c.duty = v >> 6; c.halt = !!(v & 0x20); c.constVol = !!(v & 0x10); c.vol = v & 15; break;
        case 1: c.sweepEn = !!(v & 0x80); c.sweepPer = (v >> 4) & 7; c.sweepNeg = !!(v & 8); c.sweepShift = v & 7; c.sweepReload = true; break;
        case 2: c.timer = (c.timer & 0x700) | v; break;
        case 3: c.timer = (c.timer & 0xFF) | ((v & 7) << 8); if (c.en) c.len = LEN_TAB[v >> 3]; c.seq = 0; c.envStart = true; break;
      }
    } else if (a < 0x400C) {
      switch (a & 3) {
        case 0: t.ctrl = !!(v & 0x80); t.linReload = v & 0x7F; break;
        case 2: t.timer = (t.timer & 0x700) | v; break;
        case 3: t.timer = (t.timer & 0xFF) | ((v & 7) << 8); if (t.en) t.len = LEN_TAB[v >> 3]; t.linFlag = true; break;
      }
    } else if (a < 0x4010) {
      switch (a & 3) {
        case 0: n.halt = !!(v & 0x20); n.constVol = !!(v & 0x10); n.vol = v & 15; break;
        case 2: n.mode = !!(v & 0x80); n.period = NOISE_TAB[v & 15]; break;
        case 3: if (n.en) n.len = LEN_TAB[v >> 3]; n.envStart = true; break;
      }
    } else if (a < 0x4014) {
      switch (a & 3) {
        case 0: d.irq = d.irq && !!(v & 0x80); d.loop = !!(v & 0x40); d.rate = DMC_TAB[v & 15]; break;
        case 1: d.out = v & 0x7F; break;
        case 2: d.addr = 0xC000 | (v << 6); break;
        case 3: d.len = (v << 4) | 1; break;
      }
    } else if (a === 0x4015) {
      p[0].en = !!(v & 1); p[1].en = !!(v & 2); t.en = !!(v & 4); n.en = !!(v & 8);
      if (!p[0].en) p[0].len = 0; if (!p[1].en) p[1].len = 0; if (!t.en) t.len = 0; if (!n.en) n.len = 0;
      d.irq = false;
      if (v & 0x10) { if (d.rem === 0) { d.curAddr = d.addr; d.rem = d.len; } } else d.rem = 0;
    } else if (a === 0x4017) {
      this.fc5 = !!(v & 0x80); this.fcIrqInhibit = !!(v & 0x40); this.fcCycles = 0;
      if (this.fc5) { this.clockQuarter(); this.clockHalf(); }
    }
  }
  clockEnv(c) {
    if (c.envStart) { c.envStart = false; c.envDecay = 15; c.envDiv = c.vol; }
    else if (c.envDiv === 0) { c.envDiv = c.vol; if (c.envDecay > 0) c.envDecay--; else if (c.halt) c.envDecay = 15; }
    else c.envDiv--;
  }
  clockQuarter() {
    this.clockEnv(this.p[0]); this.clockEnv(this.p[1]); this.clockEnv(this.noi);
    const t = this.tri;
    if (t.linFlag) t.linCnt = t.linReload; else if (t.linCnt > 0) t.linCnt--;
    if (!t.ctrl) t.linFlag = false;
  }
  sweepTarget(c, i) {
    const ch = c.timer >> c.sweepShift;
    return c.sweepNeg ? c.timer - ch - (i === 0 ? 1 : 0) : c.timer + ch;
  }
  clockHalf() {
    for (let i = 0; i < 2; i++) {
      const c = this.p[i];
      if (c.len > 0 && !c.halt) c.len--;
      if (c.sweepDiv === 0 && c.sweepEn && c.sweepShift > 0 && c.timer >= 8) { const tg = this.sweepTarget(c, i); if (tg <= 0x7FF) c.timer = tg; }
      if (c.sweepDiv === 0 || c.sweepReload) { c.sweepDiv = c.sweepPer; c.sweepReload = false; } else c.sweepDiv--;
    }
    if (this.tri.len > 0 && !this.tri.ctrl) this.tri.len--;
    if (this.noi.len > 0 && !this.noi.halt) this.noi.len--;
  }
  // 누적 사이클 target 까지 합성(1 CPU 사이클 단위)
  runTo(target) {
    const cycles = target - this.cyc; if (cycles <= 0) return; this.cyc = target;
    const p = this.p, t = this.tri, n = this.noi, d = this.dmc;
    const cps = 1789773 / this.sampleRate;
    for (let k = 0; k < cycles; k++) {
      this.fcCycles++;
      const fc = this.fcCycles;
      if (fc === 7457 || fc === 22371) this.clockQuarter();
      else if (fc === 14913) { this.clockQuarter(); this.clockHalf(); }
      else if (!this.fc5 && fc === 29829) { this.clockQuarter(); this.clockHalf(); }
      else if (this.fc5 && fc === 37281) { this.clockQuarter(); this.clockHalf(); }
      if (fc >= (this.fc5 ? 37282 : 29830)) this.fcCycles = 0;
      this.apuOdd = !this.apuOdd;
      if (this.apuOdd) {
        for (let i = 0; i < 2; i++) { const c = p[i]; if (c.tcnt === 0) { c.tcnt = c.timer; c.seq = (c.seq + 1) & 7; } else c.tcnt--; }
        if (n.tcnt === 0) {
          n.tcnt = (n.period >> 1) - 1 < 0 ? 0 : (n.period >> 1) - 1;
          const fb = (n.shift & 1) ^ ((n.shift >> (n.mode ? 6 : 1)) & 1);
          n.shift = (n.shift >> 1) | (fb << 14);
        } else n.tcnt--;
      }
      if (t.tcnt === 0) { t.tcnt = t.timer; if (t.len > 0 && t.linCnt > 0 && t.timer >= 2) t.seq = (t.seq + 1) & 31; } else t.tcnt--;
      if (--d.tcnt <= 0) {
        d.tcnt = d.rate;
        if (!d.silent) { if (d.shift & 1) { if (d.out <= 125) d.out += 2; } else if (d.out >= 2) d.out -= 2; d.shift >>= 1; }
        if (--d.bits <= 0) {
          d.bits = 8;
          if (d.sbufFull) { d.shift = d.sbuf; d.sbufFull = false; d.silent = false; } else d.silent = true;
        }
      }
      if (!d.sbufFull && d.rem > 0) {
        d.sbuf = this.rdMem(d.curAddr); d.sbufFull = true; d.curAddr = d.curAddr === 0xFFFF ? 0x8000 : d.curAddr + 1; d.rem--;
        if (d.rem === 0) { if (d.loop) { d.curAddr = d.addr; d.rem = d.len; } }
      }
      let p1 = 0, p2 = 0;
      for (let i = 0; i < 2; i++) {
        const c = p[i]; let o = 0;
        if (c.len > 0 && c.timer >= 8 && DUTY[c.duty][c.seq] && !(c.sweepShift > 0 && !c.sweepNeg ? this.sweepTarget(c, i) > 0x7FF : false)) o = c.constVol ? c.vol : c.envDecay;
        if (i === 0) p1 = o; else p2 = o;
      }
      const tr = (t.timer < 2) ? 0 : TRI_SEQ[t.seq];
      const no = (n.len > 0 && !(n.shift & 1)) ? (n.constVol ? n.vol : n.envDecay) : 0;
      const ps = p1 + p2;
      const po = ps ? 95.88 / (8128 / ps + 100) : 0;
      const td = tr / 8227 + no / 12241 + d.out / 22638;
      const to = td ? 159.79 / (1 / td + 100) : 0;
      this.apuSum += po + to; this.apuN++; this.apuAcc += 1;
      if (this.apuAcc >= cps) {
        this.apuAcc -= cps;
        if (this.enabled) {
          if (this.len === this.buf.length) { this.chunks.push(this.buf); this.buf = new Float32Array(4096); this.len = 0; }
          this.buf[this.len++] = this.apuSum / this.apuN;
        }
        this.apuSum = 0; this.apuN = 0;
      }
    }
  }
  // 지금까지 만든 샘플을 꺼낸다(소비자가 비움)
  drain() {
    let tot = this.len; for (const c of this.chunks) tot += c.length;
    const out = new Float32Array(tot); let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    out.set(this.buf.subarray(0, this.len), o);
    this.chunks = []; this.len = 0;
    return out;
  }
}
const api = { Apu };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
