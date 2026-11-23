'use strict';
// 온라인 대전 WebRTC DataChannel 전송(클라이언트). 설계: analysis/webrtc_transport_plan.md 9절. 코덱 = web/online_dc_codec.js(먼저 읽혀 있어야 한다).
// 서버(NK_RTC=1)가 room{rtc:1} 을 주면 web/ui_manga.js 가 start() 를 부른다. 시그널링은 웹소켓(rtc 메시지), 채널 1개(비신뢰·비순서).
// 웹소켓 in·r·f 는 종전대로 함께 오간다(이중 송신). 이 모듈은 같은 내용을 UDP 로 한 번 더(잃어도 다음 패킷이 다시 싣는 창 중복) 보내고 받을 뿐이라, 꺼지거나 막혀도 종전 경로 그대로 돈다.
//   create({ sig(m), onMsg(m) }) : sig = 웹소켓으로 보내기, onMsg = 받은 패킷을 기존 메시지 모양(f·r)으로 넘길 곳
//   .start() / .stop()          : PeerConnection 만들기(이미 열려 있으면 그대로) / 닫기
//   .onSig(m)                   : 서버 rtc 메시지(answer·후보)
//   .bind(ls) / .unbind()       : 대전 시작·끝(ls = NKLockstep). 묶여 있는 동안 16ms 마다 하트비트(보낸 지 15ms 넘었으면 창을 다시 보낸다 = 마지막 패킷이 사라져도 한 틱 뒤 복구)
//   .sent()                     : 락스텝이 입력을 보낸 직후(같은 틱에 DC 로도)
//   .stat()                     : 진단 { st: off|conn|open|bad|ws, why, loss(최근 1초 %), lossAll, rx(초당), rtt, bad(불량 전환 수), tries }
// 폴백: 5초 안에 안 열리면 1회 다시, 또 실패하면 ws(이 소켓에서는 다시 안 한다). 대전 중 0.5초 무음 = bad(3초 연속 정상이면 open), 한 판 3회 = ws. bad 가 2초 넘거나 ICE failed = 새 PeerConnection 으로 다시(판당 3회, 망 전환 대응)
(function (root) {
  const T_OPEN = 5000, T_SILENT = 500, T_GOOD = 3000, MAX_BAD = 3, MAX_RE = 3, HB_MS = 16;
  function create(o) {
    const C = root.NKDcCodec, now = () => performance.now();
    let pc = null, dc = null, id = 0, st = 'off', why = '', tries = 0, tmOpen = null, ls = null, hb = null;
    let ackI = -1, seq = 0, lastTx = 0, lastRx = 0, badN = 0, badAt = 0, goodAt = 0, re = 0, rtt = 0, pingAt = 0, rxN = 0, rxps = 0, lossPct = 0, statAt = 0, txN = 0;
    let loss = C ? C.lossMeter() : null;
    function drop() { clearTimeout(tmOpen); tmOpen = null; const p = pc, d = dc; pc = null; dc = null; if (d) { d.onopen = d.onmessage = d.onclose = null; try { d.close(); } catch (e) { /* 무시 */ } } if (p) { p.onicecandidate = p.onconnectionstatechange = null; try { p.close(); } catch (e) { /* 무시 */ } } }
    function fallback(w) { drop(); st = 'ws'; why = w; try { o.sig({ t: 'rtc', close: true }); } catch (e) { /* 무시 */ } }
    function connect() {
      drop(); if (!C || typeof RTCPeerConnection === 'undefined') { st = 'ws'; why = 'nortc'; return; }
      const my = ++id; st = 'conn'; why = ''; tries++;
      try {
        pc = new RTCPeerConnection({ iceServers: [] }); dc = pc.createDataChannel('nk', { ordered: false, maxRetransmits: 0 }); dc.binaryType = 'arraybuffer';
        const p = pc, d = dc;
        d.onopen = () => { if (id !== my) return; clearTimeout(tmOpen); tmOpen = null; st = 'open'; lastRx = now(); goodAt = 0; if (loss) loss = C.lossMeter(); };
        d.onmessage = ev => { if (id === my) rx(ev.data); };
        d.onclose = () => { if (id === my && (st === 'open' || st === 'bad')) retry('closed'); };
        p.onicecandidate = ev => { if (id === my && ev.candidate && ev.candidate.candidate) o.sig({ t: 'rtc', id: my, cand: ev.candidate.candidate, mid: ev.candidate.sdpMid || '0' }); };
        p.onconnectionstatechange = () => { if (id === my && p.connectionState === 'failed') retry('ice'); };
        p.createOffer().then(of => p.setLocalDescription(of).then(() => { if (id === my) o.sig({ t: 'rtc', id: my, type: 'offer', sdp: of.sdp }); })).catch(() => { if (id === my) fallback('offer'); });
        tmOpen = setTimeout(() => { if (id === my && st === 'conn') { if (tries < 2) connect(); else fallback('timeout'); } }, T_OPEN);
      } catch (e) { fallback('error'); }
    }
    function retry(w) { if (ls && re < MAX_RE) { re++; tries = 1; connect(); why = w; } else if (!ls && tries < 2) connect(); else fallback(w); } // 대전 중 = 새 PeerConnection 으로 다시 수립(망 전환·ICE 실패)
    function rx(buf) {
      const m = C.dec(buf); if (!m) return; const t = now();
      if (m.t === 'Q') { const r = t - pingAt; if (m.id === (pingAt >>> 0) && r >= 0 && r < 10000) rtt = r; return; }
      if (m.t !== 'S') return;
      loss.on(m.seq); rxN++; lastRx = t; if (st === 'bad') { if (!goodAt) goodAt = t; else if (t - goodAt >= T_GOOD) { st = 'open'; goodAt = 0; } }
      if (!ls) return;
      if (m.ack > ackI) ackI = m.ack;
      const n = m.p.length / m.w; if (n >= 1 && m.w === ls.width && m.f + n > ls.have) o.onMsg({ t: 'f', f: m.f, p: m.p });
      for (const r of m.rs) { // 이미 아는 프레임은 잘라 낸다(새 내용이 없으면 넘기지 않는다 → 락스텝·롤백 쪽 일은 웹소켓 경로와 같은 횟수)
        if (r.s >= ls.width) continue; let i = 0; while (i < r.p.length && ls.known(r.f + i, r.s)) i++;
        const hx = r.x !== undefined; if (i >= r.p.length && !hx) continue;
        const q = { t: 'r', s: r.s, f: r.f + i, p: i ? r.p.slice(i) : r.p }; if (hx) { q.x = r.x; q.a = r.a; } o.onMsg(q);
      }
    }
    function tx() {
      if (!ls || !dc || dc.readyState !== 'open') return;
      const sent = ls.sent, lo = ackI < 0 ? Math.max(0, sent - C.NWIN) : Math.min(ackI, sent);
      try { dc.send(C.encI({ seq: seq = (seq + 1) & 65535, f: lo, p: ls.mineFrom(lo, C.NMAX), x: ls.exec, a: ls.rollback ? ls.myAdv() : 0, ack: ls.have })); lastTx = now(); txN++; } catch (e) { /* 닫히는 중 */ }
    }
    function beat() {
      const t = now();
      if (st === 'open' || st === 'bad') {
        if (t - lastTx >= HB_MS - 1) tx();
        if (t - pingAt >= 1000 && dc && dc.readyState === 'open') { pingAt = t; try { dc.send(C.encP(pingAt >>> 0)); } catch (e) { /* 무시 */ } }
        if (st === 'open' && t - lastRx > T_SILENT) { st = 'bad'; badAt = t; goodAt = 0; if (++badN >= MAX_BAD) return fallback('flap'); }
        else if (st === 'bad') { if (t - lastRx > T_SILENT) goodAt = 0; if (t - badAt > 2000 && t - lastRx > 2000) retry('silent'); }
      }
      if (t - statAt >= 1000) { const dt = t - statAt; statAt = t; rxps = rxN * 1000 / dt; rxN = 0; if (loss) lossPct = loss.take().loss * 100; }
    }
    return {
      start() { if (st === 'open' || st === 'bad' || st === 'conn') return; if (st === 'ws' && why !== '' && tries >= 2 && !ls) return; tries = 0; connect(); },
      restart() { tries = 0; connect(); }, // 재접속(새 웹소켓): 서버 쪽 PeerConnection 은 소켓과 함께 사라졌다
      stop() { drop(); st = 'off'; why = ''; tries = 0; },
      onSig(m) {
        if (!pc || (m.id | 0) !== id) return;
        if (typeof m.sdp === 'string') pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => { if ((m.id | 0) === id) fallback('answer'); });
        else if (typeof m.cand === 'string') pc.addIceCandidate({ candidate: m.cand, sdpMid: m.mid || '0' }).catch(() => { /* 못 쓰는 후보 */ });
      },
      bind(l) { ls = l; ackI = -1; badN = 0; re = 0; lastRx = now(); statAt = now(); rxN = 0; if (C) loss = C.lossMeter(); clearInterval(hb); hb = setInterval(beat, HB_MS); },
      unbind() { ls = null; clearInterval(hb); hb = null; },
      sent() { if (st === 'open' || st === 'bad') tx(); },
      stat() { const a = loss ? loss.total() : { loss: 0, got: 0, span: 0 }; return { st, why, loss: +lossPct.toFixed(1), lossAll: +(a.loss * 100).toFixed(2), got: a.got, span: a.span, rx: Math.round(rxps), tx: txN, rtt: Math.round(rtt), bad: badN, tries, re }; },
    };
  }
  root.NKRtc = { create };
})(typeof self !== 'undefined' ? self : this);
