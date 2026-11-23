'use strict';
// 온라인 대전 DataChannel(비신뢰·비순서) 이진 패킷 코덱. 설계: analysis/webrtc_transport_plan.md 1.2절·9절. 브라우저(web/online_rtc.js)·서버(server_online.js)·Node 시험 공용.
// 모든 패킷은 프레임 번호가 키라 중복·순서 뒤바뀜·누락에 안전하다(받는 쪽이 이미 아는 프레임은 버린다). seq 는 손실 추정 전용(판정에 쓰지 않는다). 리틀엔디안.
//   I (클→서)  : 1 | seq u16 | f u32 | n u8 | x u32 | a i16 | ack u32 | p[n]          내 입력 f..f+n-1(서버가 아직 못 받았다고 한 곳부터 = 중복 창), x = 실행 프레임, a = 앞섬, ack = 내가 끊김 없이 아는 프레임 수(have)
//   S (서→클)  : 2 | seq u16 | ack u32 | f u32 | n u8 | w u8 | p[n*w] | k u8 | k × ( s u8 | fl u8 | f u32 | n u8 | [x u32 | a i16] | p[n] )
//                ack = 서버가 이 사람 입력을 끊김 없이 받은 다음 프레임, 앞 구간 = 확정 프레임(기존 f 메시지와 같은 배치), 뒤 k 개 = 자리 s 의 아직 확정 전 입력(기존 r 메시지), fl bit0 = x·a 있음
//   P / Q      : 3|4 | id u32                                                          DC 왕복 시간(진단)
(function (root) {
  const T_I = 1, T_S = 2, T_P = 3, T_Q = 4, NWIN = 24, NMAX = 96, MTU = 1100;
  const view = b => b instanceof DataView ? b : ArrayBuffer.isView(b) ? new DataView(b.buffer, b.byteOffset, b.byteLength) : new DataView(b);
  function encI(o) {
    const n = Math.min(255, o.p.length), b = new Uint8Array(18 + n), d = new DataView(b.buffer);
    d.setUint8(0, T_I); d.setUint16(1, o.seq & 65535, true); d.setUint32(3, o.f >>> 0, true); d.setUint8(7, n); d.setUint32(8, o.x >>> 0, true); d.setInt16(12, Math.max(-32768, Math.min(32767, o.a | 0)), true); d.setUint32(14, o.ack >>> 0, true);
    for (let i = 0; i < n; i++) b[18 + i] = o.p[i] & 255;
    return b;
  }
  function encS(o) { // o = { seq, ack, f, w, p[], rs: [{ s, f, p[], x?, a? }] }. MTU 를 넘기면 뒤 구간부터 줄인다(다음 패킷이 이어 보낸다)
    const w = o.w | 0 || 1; let nf = Math.min(255, Math.floor(o.p.length / w)); const rs = o.rs || [];
    let len = 14 + nf * w; const keep = [];
    for (const r of rs) { const hx = Number.isInteger(r.x), base = 7 + (hx ? 6 : 0); let n = Math.min(255, r.p.length); if (len + base + n > MTU) n = Math.max(0, MTU - len - base); if (len + base > MTU || (!n && !hx)) continue; keep.push([r, n, hx]); len += base + n; }
    const b = new Uint8Array(len), d = new DataView(b.buffer); let q = 0;
    d.setUint8(q, T_S); d.setUint16(1, o.seq & 65535, true); d.setUint32(3, o.ack >>> 0, true); d.setUint32(7, o.f >>> 0, true); d.setUint8(11, nf); d.setUint8(12, w); q = 13;
    for (let i = 0; i < nf * w; i++) b[q++] = o.p[i] & 255;
    b[q++] = keep.length;
    for (const [r, n, hx] of keep) { b[q++] = r.s & 255; b[q++] = hx ? 1 : 0; d.setUint32(q, r.f >>> 0, true); q += 4; b[q++] = n; if (hx) { d.setUint32(q, r.x >>> 0, true); q += 4; d.setInt16(q, Math.max(-32768, Math.min(32767, r.a | 0)), true); q += 2; } for (let i = 0; i < n; i++) b[q++] = r.p[i] & 255; }
    return b;
  }
  const encP = (id, pong) => { const b = new Uint8Array(5); b[0] = pong ? T_Q : T_P; new DataView(b.buffer).setUint32(1, id >>> 0, true); return b; };
  function dec(buf) { // 형식이 틀리면 null(버린다)
    let d; try { d = view(buf); } catch (e) { return null; }
    const L = d.byteLength; if (L < 5) return null; const t = d.getUint8(0);
    if (t === T_P || t === T_Q) return { t: t === T_P ? 'P' : 'Q', id: d.getUint32(1, true) };
    if (t === T_I) {
      if (L < 18) return null; const n = d.getUint8(7); if (L !== 18 + n) return null;
      const p = new Array(n); for (let i = 0; i < n; i++) p[i] = d.getUint8(18 + i);
      return { t: 'I', seq: d.getUint16(1, true), f: d.getUint32(3, true), x: d.getUint32(8, true), a: d.getInt16(12, true), ack: d.getUint32(14, true), p };
    }
    if (t === T_S) {
      if (L < 14) return null; const nf = d.getUint8(11), w = d.getUint8(12); let q = 13; if (w < 1 || w > 4 || L < q + nf * w + 1) return null;
      const p = new Array(nf * w); for (let i = 0; i < p.length; i++) p[i] = d.getUint8(q++);
      const k = d.getUint8(q++), rs = [];
      for (let j = 0; j < k; j++) {
        if (L < q + 7) return null; const s = d.getUint8(q), fl = d.getUint8(q + 1), f = d.getUint32(q + 2, true), n = d.getUint8(q + 6); q += 7; const r = { s, f, p: null };
        if (fl & 1) { if (L < q + 6) return null; r.x = d.getUint32(q, true); r.a = d.getInt16(q + 4, true); q += 6; }
        if (L < q + n) return null; r.p = new Array(n); for (let i = 0; i < n; i++) r.p[i] = d.getUint8(q++);
        rs.push(r);
      }
      return { t: 'S', seq: d.getUint16(1, true), ack: d.getUint32(3, true), f: d.getUint32(7, true), w, p, rs };
    }
    return null;
  }
  // 손실 추정(받는 쪽): seq 가 앞으로 나간 폭 대비 받은 수. 뒤바뀜·중복은 받은 것으로만 센다. 1초 창마다 take() 로 읽고 비운다
  function lossMeter() {
    let hi = -1, got = 0, span = 0, tGot = 0, tSpan = 0;
    return {
      on(seq) { got++; tGot++; if (hi < 0) { hi = seq; span++; tSpan++; return; } const dlt = (seq - hi + 65536) & 65535; if (dlt && dlt < 32768) { hi = seq; span += dlt; tSpan += dlt; } },
      take() { const r = { got, span, loss: span > 0 ? Math.max(0, 1 - got / span) : 0 }; got = 0; span = 0; return r; },
      total() { return { got: tGot, span: tSpan, loss: tSpan > 0 ? Math.max(0, 1 - tGot / tSpan) : 0 }; },
    };
  }
  const api = { encI, encS, encP, dec, lossMeter, NWIN, NMAX, MTU };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NKDcCodec = api;
})(typeof self !== 'undefined' ? self : this);
