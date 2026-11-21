'use strict';
// 소리 출력 AudioWorklet(web/game.js 가 actx.audioWorklet.addModule 로 불러온다. 지원하지 않거나 불러오기가 실패하면 game.js 의 종전 ScriptProcessor 경로).
// 종전 ScriptProcessor(버퍼 1024) 콜백과 같은 처리를 1024 샘플 블록 단위로 그대로 한다: 렌더 양자(128)마다 부르지만 블록이 비었을 때만 링 버퍼에서
//   새 1024 샘플 블록을 만든다(선버퍼 50ms·바닥남 판정·0.15초 초과 시 0.06초 지점으로 256 샘플 교차 페이드·DC 제거 + 게인 1.6·대기열 바닥값 43 블록 창).
//   같은 링 입력·같은 블록 경계면 출력 샘플과 통계가 종전 콜백과 비트 단위로 같다(검증: analysis/07_status.md 9절).
// 공유 메모리(game.js 가 만든다): ring = Float32Array(65536) 링 버퍼, st = Int32Array: [0] wpos(메인이 쓴 누계, 32비트 순환) [1] rpos(여기서 읽은 누계)
//   [2] 플래그(bit0 = 무음: 음소거·구동 중 등, bit1 = 정지 P) [3] 언더런 누계 [4] 건너뛰기 누계. 음량·허가율 보정은 port 메시지.
const RING = 65536, XF = 256, PREBUF = 2205, LOW_TGT = 1024, ADJ_MAX = 0.001, ADJ_GAIN = 0.1, LOW_WIN = 43, BLK = 1024;
class NKOut extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = o.processorOptions; this.ring = new Float32Array(p.ring); this.st = new Int32Array(p.st); this.vol = p.vol;
    this.blk = new Float32Array(BLK); this.bi = BLK; this.hp1 = 0; this.primed = false; this.rateAdj = 0; this.lowWin = Infinity; this.lowN = 0;
    this.port.onmessage = e => { if (typeof e.data.vol === 'number') this.vol = e.data.vol; };
  }
  block() { // 종전 onaudioprocess 한 번과 같다(out = 1024 샘플)
    const out = this.blk, ring = this.ring, st = this.st, sr = sampleRate, f = Atomics.load(st, 2), silent = !!(f & 1), paused = !!(f & 2), vol = this.vol;
    const wpos = Atomics.load(st, 0); let rpos = Atomics.load(st, 1), i = 0;
    if (((wpos - rpos) | 0) > RING) rpos = wpos - RING; // 재생이 멈춰 있는 동안 덮어쓴 구간은 버림(종전 pushAudio 의 처리를 읽는 쪽으로 옮김)
    const emit = s => { this.hp1 += (s - this.hp1) * 0.0005; out[i++] = silent ? 0 : (s - this.hp1) * 1.6 * vol; };
    if (((wpos - rpos) | 0) > sr * 0.15) {
      const to = wpos - Math.floor(sr * 0.06); Atomics.add(st, 4, 1);
      for (let k = 0; k < XF && i < out.length; k++) { const g = k / XF; emit(ring[(rpos + k) & (RING - 1)] * (1 - g) + ring[(to + k) & (RING - 1)] * g); }
      rpos = to + XF;
    }
    if (!this.primed && ((wpos - rpos) | 0) >= PREBUF) this.primed = true;
    if (this.primed) {
      const n = Math.min(out.length - i, (wpos - rpos) | 0);
      for (let k = 0; k < n; k++) emit(ring[(rpos + k) & (RING - 1)]);
      rpos += n;
      if (i < out.length) { this.primed = false; if (!paused) Atomics.add(st, 3, 1); } // 바닥남: 다시 모일 때까지 무음
    }
    for (; i < out.length; i++) out[i] = 0;
    Atomics.store(st, 1, rpos);
    if (paused) { this.lowWin = Infinity; this.lowN = 0; if (this.rateAdj !== 0) { this.rateAdj = 0; this.port.postMessage({ adj: 0 }); } } else { // 바닥값 창 → 허가율 보정(바닥났으면 0 으로 본다)
      const low = this.primed ? (wpos - rpos) | 0 : 0; if (low < this.lowWin) this.lowWin = low;
      if (++this.lowN >= LOW_WIN) { this.rateAdj = Math.max(-ADJ_MAX, Math.min(ADJ_MAX, (LOW_TGT - this.lowWin) / sr * ADJ_GAIN)); this.port.postMessage({ adj: this.rateAdj, low: this.lowWin }); this.lowWin = Infinity; this.lowN = 0; }
    }
  }
  process(inputs, outputs) {
    const out = outputs[0][0]; if (!out) return true;
    for (let i = 0; i < out.length;) {
      if (this.bi >= BLK) { this.block(); this.bi = 0; }
      const n = Math.min(out.length - i, BLK - this.bi);
      out.set(this.blk.subarray(this.bi, this.bi + n), i); i += n; this.bi += n;
    }
    return true;
  }
}
registerProcessor('nk-out', NKOut);
