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
(function (root) {
  function create(o) {
    const cfg = o.cfg, lead = cfg.lead | 0, delay = Math.max(1, cfg.delay | 0), every = cfg.hashEvery | 0, W = cfg.humans >= 2 && cfg.humans <= 4 ? cfg.humans | 0 : 2;
    const conf = [];          // conf[k*W + 자리]
    const mine = [];          // 내가 보낸 입력(재접속 때 다시 보내기용)
    let exec = lead, have = 0, sent = 0;
    const L = {
      width: W,
      get exec() { return exec; }, get have() { return have; }, get sent() { return sent; },
      pump() {
        if (sent > exec + delay) return 0;
        const f0 = sent, p = [];
        while (sent <= exec + delay && p.length < 120) { const v = sent < lead ? 0 : (o.sample(sent) & 255); mine[sent] = v; p.push(v); sent++; }
        o.send({ t: 'in', f: f0, p }); return p.length;
      },
      onMessage(m) {
        if (m.t === 'f' && Number.isInteger(m.f) && Array.isArray(m.p)) {
          for (let i = 0; i + W <= m.p.length; i += W) { const k = m.f + i / W; if (conf[k * W] === undefined) for (let j = 0; j < W; j++) conf[k * W + j] = m.p[i + j]; }
          while (conf[have * W] !== undefined) have++;
        } else if (m.t === 'start' && m.resume) { // 재접속: 서버가 못 받은 내 입력부터 다시 보낸다
          for (let f = m.next | 0; f < sent; f += 120) o.send({ t: 'in', f, p: mine.slice(f, Math.min(sent, f + 120)) });
        }
      },
      peek() { return exec < have ? conf.slice(exec * W, exec * W + W) : null; },
      take(hash) {
        if (exec >= have) throw new Error('확정되지 않은 프레임 실행');
        if (every && hash && exec % every === 0) o.send({ t: 'hash', f: exec, h: hash(exec) });
        exec++;
      },
    };
    return L;
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NKLockstep = api;
})(typeof self !== 'undefined' ? self : this);
