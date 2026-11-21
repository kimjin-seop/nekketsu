'use strict';
// 소리 합성 생략용 빨리 감기(덮개 아래 빨리 감기 구동 전용, web/worker.js ctl[11]). 엔진 파일(server/engine/apu.js)은 한 줄도 바꾸지 않는다.
// 문제: 덮개 아래 구동(story_team·battle_full 등) 동안 소리는 버리는데(web/game.js fastOn), 합성기 runTo 가 CPU 사이클마다 4채널 + 믹서를 돌아
//   프레임당 시간의 큰 몫을 쓴다. 그렇다고 합성기를 떼거나 runTo 를 건너뛰면 길이 카운터·엔벌로프·DMC 가 멈춰 구동 뒤 첫 음이 어긋난다.
// 방식: skip(a, target) = apu.js Apu.runTo(target) 와 같은 채널 상태로 도착하되 샘플을 만들지 않는다.
//   프레임 카운터 사건(1/4·1/2 클록)은 원래 메서드(clockQuarter·clockHalf)를 같은 사이클에 부르고, 그 사이는 사건 단위로 건너뛴다:
//   펄스·노이즈 타이머(홀수 사이클)·삼각파 타이머(매 사이클)는 주기 나눗셈으로, 노이즈 LFSR 은 재장전 횟수만큼, DMC 는 rate 사건마다 원래 식 그대로.
//   apuOdd·apuAcc(샘플 경계 누산)도 사이클 수만큼 같은 식으로 진행한다. 다른 것은 만들지 않은 샘플(buf)과 마지막 미완 샘플의 합(apuSum·apuN = 0 으로 비움)뿐이다.
//   검증: 같은 쓰기열에서 runTo 와 skip 의 saveState(apuSum·apuN 제외)가 프레임마다 같아야 한다(스크래치 검증 스크립트, 보고서 참조).
// Node(검증)·워커 공용(CommonJS).
function tick(c, N, per) { // 타이머 N 클록: 0 이면 per 로 재장전(이때 1회 증가), 아니면 1 감소. 증가 횟수를 돌려준다
  if (N <= c.tcnt) { c.tcnt -= N; return 0; }
  N -= c.tcnt + 1; const P = per + 1, q = Math.floor(N / P); c.tcnt = per - (N - q * P); return q + 1;
}
function dmcFetch(a, d) {
  if (!d.sbufFull && d.rem > 0) {
    d.sbuf = a.rdMem(d.curAddr); d.sbufFull = true; d.curAddr = d.curAddr === 0xFFFF ? 0x8000 : d.curAddr + 1; d.rem--;
    if (d.rem === 0) { if (d.loop) { d.curAddr = d.addr; d.rem = d.len; } }
  }
}
function advance(a, m) { // 프레임 카운터 사건이 없는 m 사이클(각 사이클의 프레임 카운터 이후 부분)
  if (m <= 0) return;
  const p = a.p, t = a.tri, n = a.noi, d = a.dmc;
  const odd = (m + (a.apuOdd ? 0 : 1)) >> 1; a.apuOdd = a.apuOdd !== !!(m & 1); // 홀수 클록 수(토글 뒤 참인 사이클)
  for (let i = 0; i < 2; i++) { const c = p[i]; c.seq = (c.seq + tick(c, odd, c.timer)) & 7; }
  { let k = tick(n, odd, (n.period >> 1) - 1 < 0 ? 0 : (n.period >> 1) - 1), s = n.shift; const b = n.mode ? 6 : 1;
    while (k-- > 0) s = (s >> 1) | (((s & 1) ^ ((s >> b) & 1)) << 14); n.shift = s; }
  { const inc = tick(t, m, t.timer); if (inc && t.len > 0 && t.linCnt > 0 && t.timer >= 2) t.seq = (t.seq + inc) & 31; }
  let k = m; // DMC: rate 사건마다 원래 식(사이클 순서: 타이머 → 사건 → 읽기)
  while (k > 0) {
    const j = d.tcnt <= 1 ? 1 : d.tcnt;
    if (j > k) { d.tcnt -= k; dmcFetch(a, d); break; }
    if (j > 1) dmcFetch(a, d);
    d.tcnt = d.rate;
    if (!d.silent) { if (d.shift & 1) { if (d.out <= 125) d.out += 2; } else if (d.out >= 2) d.out -= 2; d.shift >>= 1; }
    if (--d.bits <= 0) { d.bits = 8; if (d.sbufFull) { d.shift = d.sbuf; d.sbufFull = false; d.silent = false; } else d.silent = true; }
    dmcFetch(a, d); k -= j;
  }
  const cps = 1789773 / a.sampleRate; let acc = a.apuAcc; // 샘플 경계 누산(runTo 와 같은 식·같은 순서의 부동소수 연산)
  for (let i = 0; i < m; i++) { acc += 1; if (acc >= cps) acc -= cps; }
  a.apuAcc = acc;
}
function skip(a, target) {
  const cycles = target - a.cyc; if (cycles <= 0) return; a.cyc = target;
  const E4 = a.fc5 ? 37281 : 29829, END = a.fc5 ? 37282 : 29830;
  let k = cycles;
  while (k > 0) {
    const fc = a.fcCycles, nx = fc < 7457 ? 7457 : fc < 14913 ? 14913 : fc < 22371 ? 22371 : fc < E4 ? E4 : fc < END ? END : fc + 1, L = nx - fc;
    if (L > k) { a.fcCycles = fc + k; advance(a, k); break; }
    advance(a, L - 1); a.fcCycles = nx;
    if (nx === 7457 || nx === 22371) a.clockQuarter(); else if (nx === 14913 || nx === E4) { a.clockQuarter(); a.clockHalf(); }
    if (nx >= END) a.fcCycles = 0;
    advance(a, 1); k -= L;
  }
  a.apuSum = 0; a.apuN = 0; // 만들지 않은 미완 샘플(다음 샘플은 재개 뒤 사이클만의 평균)
}
module.exports = { skip };
