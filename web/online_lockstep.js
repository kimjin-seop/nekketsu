'use strict';
// 온라인 대전 락스텝 버퍼(1단계). 설계: analysis/online_sync.md. 화면·소켓·엔진을 모른다(Node 검증 도구 tools/online_sync_test.js 와 브라우저 공용).
// 프레임 번호 k = 엔진 프레임 번호 - 시작 상태의 프레임 번호. 서버가 확정해 준 프레임(k 의 [1P, 2P] 패드)만 엔진에 넣는다.
// 한 프레임 폭 W = 사람 수(cfg.humans 2·3·4, 없거나 범위 밖이면 2 = 종전과 같다. analysis/17_online_4p.md): 자리 i = 패드 포트 i, 빠진 자리(peer gone)는 서버가 0 으로 확정해 준다.
//   create({ cfg, send, sample }) : cfg = 서버 start 의 cfg(delay, lead, hashEvery), send(msg) = 서버로 보내기, sample(k) = 프레임 k 에 넣을 내 패드 값(0~255)
//   .pump()        : 내 입력을 실행 위치 + delay 프레임까지 보낸다(실행이 멈추면 더 보내지 않는다 = 앞서 보내는 양이 delay 로 제한)
//   .onMessage(m)  : 서버 메시지 'f'(확정 프레임. 순서가 뒤섞여 와도 프레임 번호로 정렬, 중복 무시), 재접속 'start'(resume) 처리
//   .peek()        : 다음에 실행할 프레임의 [1P, 2P](사람 3·4명이면 길이 W: [자리 0 … 자리 W-1]) (아직 확정 전이면 null)
//   .take(hash)    : 그 프레임을 실행했다고 표시. hash(k) = 프레임 k 를 실행하기 직전 상태의 RAM 지문 → hashEvery 프레임마다 서버로 보낸다
//   .exec / .have / .sent / .width : 다음 실행 프레임 / 끊김 없이 확정된 프레임 수 / 보낸 내 입력 수 / 한 프레임 폭 W
// 롤백 모드(PROTO 6, cfg.rollback 이 있을 때만. 설계: analysis/online_sync.md 9절): 서버가 확정 전에 중계하는 r{s,f,p[],x,a}(상대 자리 s 의 입력)를 받아 conf 에 채운다. 확정 방송 f 와 값이 같다(다르면 f 가 이긴다 = diff).
//   .have = 내 입력까지 포함해 모든 자리의 실제 값을 안 프레임 수(최종값이라 다시 안 바뀐다). .predict(k) = 프레임 k 의 자리별 값(모르는 자리 = 그 자리의 마지막으로 안 값 반복). .take() 는 확정을 기다리지 않는다(실행 허가는 game.js 가 정한다).
//   빠진 자리(peer gone)의 확정 값 = 그 사람이 나가기 전에 보내 이미 중계된 프레임은 그 값, 나머지는 0(server_online.js confirm). onMessage(peer gone) 을 넘기면 그 자리의 모르는 프레임을 0 으로 예측한다.
//   .mineFrom(lo, n) = 내가 보낸 입력 lo 부터 최대 n 개(web/online_rtc.js 가 서버 미확인 구간을 DataChannel 로 다시 싣는다). r 의 x·a 는 새 값(x 가 커졌거나 같은 x 에 새 프레임)일 때만 반영한다.
//   .setDelay(d) = 입력 지연 변경(자동 후퇴·방 단위 조정 rbd). .adv() = 내가 상대보다 앞선 프레임 수 추정(GGPO 방식: 서로 잰 값 a 를 주고받아 (내 값 - 상대 값) / 2). o.me = 내 자리(사람 j 번째), o.now = 시계(ms, 기본 Date.now)
(function (root) {
  function create(o) {
    const cfg = o.cfg, lead = cfg.lead | 0, every = cfg.hashEvery | 0, W = cfg.humans >= 1 && cfg.humans <= 4 ? cfg.humans | 0 : 2;
    let delay = Math.max(1, cfg.delay | 0);
    const rb = !!cfg.rollback, me = o.me | 0, now = o.now || Date.now;
    const lastV = new Array(W).fill(0), lastF = new Array(W).fill(-1), pD = new Array(W).fill(null), pA = new Array(W).fill(0), pT = new Array(W).fill(0), pX = new Array(W).fill(-1); // pX = 자리별 마지막으로 받은 x(같은 r 이 두 경로(DC·웹소켓)로 겹쳐 오거나 뒤늦게 와도 앞섬 측정을 낡은 값으로 덮지 않게) // 롤백: 자리별 마지막으로 안 값·그 프레임, 상대가 알린 앞섬 측정(pD = 내 실행 - 상대 실행(보낸 때) , pA = 상대가 잰 값, pT = 받은 시각)
    const conf = [];          // conf[k*W + 자리]
    const mine = [];          // 내가 보낸 입력(재접속 때 다시 보내기용)
    let exec = lead, have = 0, sent = 0;
    const L = {
      width: W,
      rollback: rb, get delay() { return delay; }, setDelay(d) { delay = Math.max(1, Math.min(60, d | 0)); },
      get exec() { return exec; }, get have() { return have; }, get sent() { return sent; },
      pump() {
        if (sent > exec + delay) return 0;
        const f0 = sent, p = [];
        while (sent <= exec + delay && p.length < 120) { const v = sent < lead ? 0 : (o.sample(sent) & 255); mine[sent] = v; if (rb) conf[sent * W + me] = v; p.push(v); sent++; }
        o.send(rb ? { t: 'in', f: f0, p, x: exec, a: L.myAdv() } : { t: 'in', f: f0, p }); if (rb) fillHave(); return p.length;
      },
      myAdv() { let a = -Infinity, t = now(); for (let j = 0; j < W; j++) if (j !== me && pD[j] !== null && t - pT[j] < 1500 && pD[j] > a) a = pD[j]; return a === -Infinity ? 0 : Math.max(-1000, Math.min(1000, a | 0)); }, // 내가 보낼 값 = 상대들 중 가장 큰 (내 실행 - 상대 실행 + 전달 시간)
      predict(k) { const out = []; for (let j = 0; j < W; j++) { const v = conf[k * W + j]; out.push(v !== undefined ? v : j === me && mine[k] !== undefined ? mine[k] : lastV[j]); } return out; },
      known(k, j) { return conf[k * W + j] !== undefined; },
      mineFrom(lo, n) { lo = Math.max(0, lo | 0); return mine.slice(lo, Math.min(sent, lo + (n | 0))); }, // DC 중복 창용: 내가 보낸 입력 lo.. (최대 n 개)
      adv() { let a = -Infinity, t = now(); for (let j = 0; j < W; j++) if (j !== me && pD[j] !== null && t - pT[j] < 1500) a = Math.max(a, (pD[j] - pA[j]) / 2); return a === -Infinity ? 0 : a; },
      diff: 0, diffLo: Infinity, // diff = 확정 방송이 이미 안 값(중계·내 값)과 달랐던 횟수(서버 계약상 0 이어야 한다), diffLo = 그중 가장 이른 프레임(game.js rbSync 가 읽고 Infinity 로 되돌린다: 그 프레임부터 이력을 다시 맞춘다)
      onMessage(m) {
        if (rb && m.t === 'r' && Number.isInteger(m.s) && m.s >= 0 && m.s < W && m.s !== me && Number.isInteger(m.f) && Array.isArray(m.p)) {
          let nw = false; for (let i = 0; i < m.p.length; i++) { const k = m.f + i; if (conf[k * W + m.s] === undefined) { conf[k * W + m.s] = m.p[i] & 255; nw = true; } if (k >= lastF[m.s]) { lastF[m.s] = k; lastV[m.s] = conf[k * W + m.s]; } }
          if (Number.isInteger(m.x) && (m.x > pX[m.s] || (m.x === pX[m.s] && nw))) { pX[m.s] = m.x; pD[m.s] = exec - m.x; pA[m.s] = Number.isInteger(m.a) ? m.a : 0; pT[m.s] = now(); }
          fillHave();
        } else if (m.t === 'f' && Number.isInteger(m.f) && Array.isArray(m.p)) {
          if (rb) { // 확정 방송: 모든 자리의 최종 값(중계·내 값과 다르면 이쪽이 이긴다)
            for (let i = 0; i + W <= m.p.length; i += W) { const k = m.f + i / W; for (let j = 0; j < W; j++) { const x = k * W + j, v = m.p[i + j]; if (conf[x] !== undefined && conf[x] !== v) { L.diff++; if (k < L.diffLo) L.diffLo = k; } conf[x] = v; if (k >= lastF[j]) { lastF[j] = k; lastV[j] = v; } } }
            fillHave();
          } else {
          for (let i = 0; i + W <= m.p.length; i += W) { const k = m.f + i / W; if (conf[k * W] === undefined) for (let j = 0; j < W; j++) conf[k * W + j] = m.p[i + j]; }
          while (conf[have * W] !== undefined) have++;
          }
        } else if (rb && m.t === 'peer' && m.ev === 'gone' && Number.isInteger(m.slot) && m.slot >= 0 && m.slot < W && m.slot !== me) { // 빠진 자리: 서버가 못 받은 프레임은 0 으로 확정한다 → 모르는 프레임의 예측도 0(마지막 값 반복이 아니라)
          lastV[m.slot] = 0; lastF[m.slot] = Infinity;
        } else if (m.t === 'start' && m.resume) { // 재접속: 서버가 못 받은 내 입력부터 다시 보낸다
          for (let f = m.next | 0; f < sent; f += 120) o.send({ t: 'in', f, p: mine.slice(f, Math.min(sent, f + 120)) });
        }
      },
      peek() { return exec < have ? conf.slice(exec * W, exec * W + W) : null; },
      take(hash) {
        if (!rb && exec >= have) throw new Error('확정되지 않은 프레임 실행');
        if (!rb && every && hash && exec % every === 0) o.send({ t: 'hash', f: exec, h: hash(exec) });
        exec++;
      },
    };
    function fillHave() { for (;;) { let ok = true; for (let j = 0; j < W; j++) if (conf[have * W + j] === undefined) { ok = false; break; } if (!ok) break; have++; } } // 롤백: 모든 자리의 값이 찬 프레임까지
    return L;
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NKLockstep = api;
})(typeof self !== 'undefined' ? self : this);
