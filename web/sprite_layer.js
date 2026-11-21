'use strict';
// 표시층 스프라이트 합성기(시범, analysis/18_interpolation.md 7절). 기본 꺼짐: 주소에 ?mid=1 이 있을 때만 game.js 가 부른다.
// 하는 일(화면에 그릴 256x240 픽셀만 바꾼다. 엔진·RAM·입력·락스텝·소리와 무관):
//   1) 위치 보간: 전투 로직은 4프레임 = 1틱이라 캐릭터가 4프레임마다 뛰어 움직인다. 프레임 끝 RAM 은 화면보다 한 틱 앞서 있으므로
//      「지금 화면에 뜬 상태 → RAM 의 다음 상태」 사이를 4등분해 그 슬롯의 스프라이트 조각만 옮겨 그린다(지연·예측 없음).
//      그 틱에 화면(카메라)도 가로로 움직이면($03CF = 다음 가로 스크롤) 경기장 배경과 나머지 스프라이트도 같은 비율로 같이 옮긴다(안 그러면 캐릭터만 바닥에서 미끄러진다). 원작 HUD 띠(분할선 아래)는 그대로다.
//   2) 중간 그림: 다음 상태의 그림 번호가 다르고 그 전환(A↔B)의 중간 그림 M 이 자료에 있으면, 한 틱의 뒤쪽 2프레임 동안 그 슬롯 조각을 M 으로 바꿔 그린다.
//      단 M 의 세로 범위 때문에 라인당 8개 제한에 걸려 그 슬롯 밖 스프라이트의 보임이 한 줄이라도 달라지면 그 프레임은 M 을 쓰지 않고 위치만 옮긴다(lineGuard, 18 문서 10.8).
// 입력: 워커 메시지 d = { fb, ram, frame, ko: { vram, pal, lt }, spr: { oam, reg } }(spr = web/worker.js ctl[8], ko = 한글 층 ctl[5]).
// 안전장치: 원작 렌더러(server/engine/render.js)를 그대로 불러 ko·spr 사본으로 프레임을 다시 그리고, 손대지 않은 재합성이 코어 화면(d.fb)과 픽셀 단위로 같을 때만 바꾼 화면을 낸다.
//   다르거나, 자료에 없는 그림이거나, 화면의 조각이 RAM 에서 계산한 조각과 맞지 않으면 그 프레임은 코어 화면 그대로다.
// 대상: 자료(web/mid_frames.json, tools/mid_build.js 산출)에 있는 것만. 위치 보간 = interp[동작 id] 의 슬롯(기본 = 1P 걷기), 중간 그림 = midSlots 슬롯에서 mids 에 그 전환이 있을 때(18 문서 10절).
//   v1 자료(interp·midSlots 없음)는 시범과 같이 slots × acts 로 읽는다. 자료에 없는 동작·클래스·전환은 원작 화면 그대로다.
(function (root) {
  const hex2 = s => { const a = new Uint8Array(s.length >> 1); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; };
  const sd = (a, b) => (((b - a + 128) & 255) - 128); // 8비트 화면 좌표 차(부호 있음)
  // opt: { chr(Uint8Array, ROM CHR), Renderer(render.js), data(mid_frames.json), testMid(자료에 M 이 없는 걷기 전환에 임시 합성 그림을 쓴다 — 동작 확인용, 그림 아님), checkAll(전투 프레임마다 자기 점검 통계) }
  function create(opt) {
    const chr = opt.chr, N = chr.length >> 10, data = opt.data || {}, acts = data.acts || [3], poses = data.poses || {};
    const interp = {}; if (data.interp) { for (const k in data.interp) interp[k] = data.interp[k]; } else for (const a of acts) interp[a] = data.slots || [0]; // 동작 id → 위치 보간 슬롯
    const midSlots = data.midSlots || data.slots || [0], from = data.interpFrom || null; // from[동작][클래스] = 위치 보간을 시작할 수 있는 화면 그림(없으면 제한 없음 — v1 자료는 poses 표가 곧 제한)
    const slots = [...new Set([].concat(data.slots || [0], midSlots, ...Object.keys(interp).map(k => interp[k])))].sort((a, b) => a - b);
    const R = new opt.Renderer(), ext = new Uint8Array(chr.length + 4096); ext.set(chr); // 끝 4KB = 슬롯별 M 전용 뱅크(슬롯 s = 뱅크 N + s)
    const mids = {}; (data.mids || []).forEach(m => { mids[m.cls + ':' + Math.min(m.a, m.b) + ':' + Math.max(m.a, m.b)] = { pieces: m.pieces, tiles: (m.tiles || []).map(hex2), acts: m.acts || acts, mq: m.mq || {} }; });
    const fake = { pal: null, vram: null, chr, ppu: { v: 0, fx: 0, ctrl: 0, mirrorV: false }, reg: new Uint8Array(8), bsel: 0, ppuOam: null };
    // lineGuard(기본 켬): M 을 넣으면 라인당 8개 제한 때문에 그 슬롯 밖 스프라이트의 보임이 바뀌는 프레임은 M 을 쓰지 않고 위치만 옮긴다(원작 프레임 보존). 자료 lineGuard: 0 또는 opt.lineGuard = false 면 3단계 동작(검사 없음)
    const lineGuard = opt.lineGuard !== undefined ? !!opt.lineGuard : data.lineGuard !== undefined ? !!data.lineGuard : true;
    const st = { frames: 0, battle: 0, checked: 0, checkOk: 0, checkFail: 0, ident: 0, noIdent: 0, moved: 0, mid: 0, lineGuard: 0, modified: 0, skipScroll: 0, predOk: 0, predBad: 0, last: null, lastAll: null, bySlot: {}, byAct: {} }; // predOk·predBad = 보간 목표로 삼은 다음 상태가 실제로 다음 화면이 되었는지. lineGuard = 라인당 8개 제한으로 M 을 되돌린 수. bySlot·byAct = 슬롯별·동작별 나눔
    for (const s of slots) st.bySlot[s] = { ident: 0, noIdent: 0, moved: 0, mid: 0, lineGuard: 0, predOk: 0, predBad: 0 };
    const actSt = a => st.byAct[a] || (st.byAct[a] = { moved: 0, mid: 0, lineGuard: 0, predOk: 0, predBad: 0 });
    const pk = new Int8Array(16);
    function picked(o, y, h, mine) { // 원작 렌더러와 같은 규칙(OAM 앞 순번부터 그 줄에 걸친 8개)으로 줄 y 에 그려지는 스프라이트 중 mine(바꾸는 슬롯) 밖의 순번. 끝 = -1
      let n = 0, k = 0; for (let i = 0; i < 64 && n < 8; i++) { const sy = o[i * 4] + 1; if (y >= sy && y < sy + h) { n++; if (!mine[i]) pk[k++] = i; } } pk[k] = -1; return k;
    }
    function samePicked(a, b, mine, lt) { // 모든 줄에서 mine 밖 스프라이트의 보임이 같은가
      const t = new Int8Array(9);
      for (let y = 0; y < 240; y++) { const o = y * 4; if (!(lt[o + 3] & 0x10)) continue; const h = ((lt[o + 1] >> 8) & 0x20) ? 16 : 8;
        const k = picked(a, y, h, mine); t.set(pk.subarray(0, k + 1)); if (picked(b, y, h, mine) !== k) return false; for (let j = 0; j < k; j++) if (pk[j] !== t[j]) return false; }
      return true;
    }
    const hs = slots.map(() => []), shown = slots.map(() => ({ S: null, since: 0, pred: null })), wlt = new Uint16Array(960); let lastFrame = -2, scrollAt = -99, pvy = -1;
    function render(ko, oam, sreg, extMask, lt) { // 원작 렌더러로 한 프레임(256x240). 스프라이트 뱅크는 프레임 안에서 바뀌지 않는다(18 문서 1.2 측정). extMask bit s = 슬롯 s 는 M 전용 뱅크
      fake.pal = ko.pal; fake.vram = ko.vram; fake.ppuOam = oam; fake.chr = extMask ? ext : chr;
      for (let i = 0; i < 4; i++) fake.reg[2 + i] = (extMask >> i) & 1 ? N + i : sreg[i] % N;
      for (let y = 0; y < 240; y++) {
        const o = y * 4; fake.ppu.v = lt[o]; fake.ppu.fx = lt[o + 1] & 7; fake.ppu.ctrl = lt[o + 1] >> 8; fake.reg[0] = (lt[o + 2] & 255) % N; fake.reg[1] = (lt[o + 2] >> 8) % N;
        fake.bsel = (lt[o + 3] & 0x100) ? 0x80 : 0; fake.ppu.mirrorV = !!(lt[o + 3] & 0x200); R.line(fake, y, lt[o + 3] & 255);
      }
      return R.fb;
    }
    const same = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
    const state = (m, s, f) => ({ x: m[0x411 + s], y: m[0x421 + s], p: m[0x5B + s], cls: m[0x401 + s], mem: m[0x409 + s], act: m[0x49E + s] & 0x7F, sc: m[0x3CF], since: f }); // sc = 다음에 표시될 가로 스크롤(하위 8비트. 표시 쪽 사본은 $03CB)
    const eq = (a, b) => a.x === b.x && a.y === b.y && a.p === b.p && a.cls === b.cls && a.mem === b.mem; // sc 는 상태가 처음 보인 프레임의 값만 쓴다(비교에는 넣지 않는다: $03CF 는 위치보다 먼저 바뀐다)
    // OAM 변환 규칙(08 문서 1절): 머리 타일 (t & 0x3C) == 0 은 3 × 변형을 더하고, 슬롯 영역(상위 2비트)을 붙인다. $5B bit7 == 0 이면 좌우 반전. 슬롯 2·3 은 팔레트 번호를 바꾼다
    function place(S, s, pc) { // 조각 [x, y, 타일, 속성] → 화면의 [X, Y, 타일, 속성]
      const flip = !(S.p & 0x80); let t = pc[2], a = pc[3];
      if (!(t & 0x3C)) t = (t + 3 * S.mem) & 255; t = (t & 0x3F) | (s << 6);
      if (s >= 2) a = (a & 0xE0) | ((a & 3) === 3 ? 3 : (a & 3) << 1);
      if (flip) a ^= 0x40;
      return [flip ? S.x - (pc[0] + 8) : S.x + pc[0], S.y + pc[1], t, a];
    }
    function find(oam, S, s) { // 상태 S 의 조각이 지금 화면 OAM 에 전부 있으면 그 OAM 순번 목록(조각 순서), 아니면 null
      const ps = (poses[S.cls] || {})[S.p & 0x7F]; if (!ps) return null;
      const idx = [], used = new Uint8Array(64);
      for (const pc of ps) {
        const w = place(S, s, pc); let f = -1; if (w[0] < 0 || w[0] > 255) return null;
        for (let i = 0; i < 64; i++) if (!used[i] && oam[i * 4 + 1] === w[2] && oam[i * 4 + 3] === w[0] && oam[i * 4] === (w[1] & 255)) { f = i; break; }
        if (f < 0) return null; used[f] = 1; idx.push(f);
      }
      return idx;
    }
    function testMid(S, Nx, bank) { // 임시 합성 그림(동작 확인용): A 의 조각 배치에서 B 와 타일이 다른 자리만 「위 4줄 = A 타일, 아래 4줄 = B 타일」로 만든다. A·B 가 같은 뱅크일 때만 뜻이 있다
      const A = poses[S.cls][S.p & 0x7F], B = (poses[Nx.cls] || {})[Nx.p & 0x7F]; if (!B || A.length !== B.length) return null;
      const pieces = [], tiles = [];
      for (let i = 0; i < A.length; i++) {
        const a = A[i], b = B[i]; if (a[0] !== b[0] || Math.abs(a[1] - b[1]) > 1) return null;
        if (a[2] === b[2]) { pieces.push([a[0], a[1], a[2], a[3], 0]); continue; }
        const t = new Uint8Array(16), oa = bank + (a[2] & 0x3F) * 16, ob = bank + (b[2] & 0x3F) * 16;
        for (let r = 0; r < 8; r++) { const o = r < 4 ? oa : ob; t[r] = chr[o + r]; t[r + 8] = chr[o + r + 8]; }
        pieces.push([a[0], a[1], tiles.length, a[3], 1]); tiles.push(t);
      }
      return tiles.length ? { pieces, tiles } : null;
    }
    function frame(d, out) { // out = 화면에 그릴 256x240(Uint32Array, 이미 d.fb 가 들어 있다). 바꿔 썼으면 true
      st.frames++;
      const m = d.ram, spr = d.spr, ko = d.ko;
      if (!spr || !ko || m[0x641] !== 1 || (m[0x642] & 0x7F) !== 2) { for (const h of hs) h.length = 0; lastFrame = -2; return false; } // 전투(1:2) 밖·사본 없음: 코어 화면 그대로
      if (d.frame !== lastFrame + 1) for (const h of hs) h.length = 0; // 프레임이 이어지지 않음(리셋·건너뜀)
      lastFrame = d.frame; st.battle++;
      const lt = ko.lt, dispSx = (((lt[0] & 31) << 3) | (lt[1] & 7)) & 255;
      if ((lt[0] & 0x7BE0) !== pvy) { pvy = lt[0] & 0x7BE0; scrollAt = d.frame; } // 세로 스크롤이 움직인 직후(흔들림 등)에는 손대지 않는다
      const oam = spr.oam, sreg = spr.reg; let work = null, extMask = 0, useLt = lt; const plans = [], infos = [];
      // 1단계: 슬롯마다 식별·계획만 한다(화면 이동분은 슬롯 사이에 하나여야 하므로 적용은 2단계에서)
      for (let k = 0; k < slots.length; k++) {
        const s = slots[k], H = hs[k], cur = state(m, s, d.frame), bs = st.bySlot[s];
        if (!H.length || !eq(H[H.length - 1], cur)) { H.push(cur); if (H.length > 6) H.shift(); }
        let si = -1, idx = null; for (let i = H.length - 1; i >= 0 && !idx; i--) { idx = find(oam, H[i], s); if (idx) si = i; }
        if (!idx) { st.noIdent++; bs.noIdent++; continue; } st.ident++; bs.ident++;
        const S = H[si], Nx = si < H.length - 1 ? H[H.length - 1] : null, sh = shown[k]; // 다음 상태 = 가장 새 RAM 상태(한 틱 안에서 그림 번호가 위치보다 한 프레임 먼저 바뀌므로 중간 상태는 건너뛴다)
        if (sh.S !== S) { if (sh.pred) { const ok = sh.pred === S && S.sc === dispSx, as = actSt(sh.pred.act); if (ok) { st.predOk++; bs.predOk++; as.predOk++; } else { st.predBad++; bs.predBad++; as.predBad++; } sh.pred = null; } sh.S = S; sh.since = d.frame; }
        if (!Nx) continue; // 화면 = 최신 상태(서 있음 등)
        if (Nx.cls !== S.cls || Nx.mem !== S.mem) continue;
        const doI = (interp[Nx.act] || []).indexOf(s) >= 0 && (!from || !from[Nx.act] || (from[Nx.act][S.cls] || []).indexOf(S.p & 0x7F) >= 0), turn = ((S.p ^ Nx.p) & 0x7F) && !((S.p ^ Nx.p) & 0x80), a = S.p & 0x7F, b = Nx.p & 0x7F;
        let cand = null; if (turn && midSlots.indexOf(s) >= 0) { cand = mids[S.cls + ':' + Math.min(a, b) + ':' + Math.max(a, b)] || null; if (cand && cand.acts.indexOf(Nx.act) < 0) cand = null; }
        if (!doI && !cand) continue; // 이 슬롯·동작은 자료에 없다: 원작 그대로
        const ds = sd(S.sc, Nx.sc), wx = sd(S.x, Nx.x) + ds, ddy = sd(S.y, Nx.y); if (Math.abs(wx) > 12 || Math.abs(ddy) > 12 || Math.abs(ds) > 12) continue; // wx = 캐릭터 자신의 가로 이동(화면 이동분 제외). 큰 이동(순간 이동·화면 전환)은 제외
        if (S.sc !== dispSx || d.frame - scrollAt < 8) { st.skipScroll++; continue; } // 화면의 가로 스크롤이 그 상태의 값과 다르면(가정이 안 맞는 장면) 손대지 않는다
        // q = 화면이 이 상태로 바뀐 뒤 지난 프레임(0~3). 화면은 4프레임마다 바뀌고 RAM 의 다음 상태는 그보다 3~4프레임 먼저 온다
        const q = Math.min(3, d.frame - sh.since, d.frame - Nx.since + 1);
        let M = null;
        if (cand && q >= (cand.mq[a + '>' + b] || 2)) M = cand; // mq = M 시작 프레임(A 가 2틱 이상 = 2 → 2프레임, 1틱 = 3 → 1프레임)
        if (!M && doI && opt.testMid && turn && q >= 2) M = testMid(S, Nx, (sreg[s] % N) << 10);
        if (M && M.pieces.length > idx.length) M = null; // 조각 수는 A 를 넘지 못한다(빈 OAM 자리를 새로 쓰지 않는다)
        plans.push({ s, k, idx, S, Nx, q, doI, M, dsq: doI ? Math.round(ds * q / 4) : null, wx, ddy });
      }
      // 화면 이동분(gdsq): 위치 보간을 하는 첫 슬롯이 정한다. 다른 값이 필요한 보간 슬롯은 이 프레임 건너뛴다. 보간 없는 슬롯(중간 그림만)은 경기장과 같이 움직인다
      let gdsq = null;
      for (const P of plans) { if (!P.doI) continue; const dx = Math.round(P.wx * P.q / 4) - P.dsq, dy = Math.round(P.ddy * P.q / 4); if (!dx && !dy && !P.dsq && !P.M) { P.skip = true; continue; } if (gdsq === null) gdsq = P.dsq; if (P.dsq !== gdsq) { P.skip = true; continue; } P.dx = dx; P.dy = dy; }
      for (const P of plans) { if (P.doI) continue; if (!P.M) { P.skip = true; continue; } P.dsq = gdsq || 0; P.dx = -P.dsq; P.dy = 0; }
      for (const P of plans) {
        if (P.skip) continue;
        const { s, idx, S, Nx, q, dx, dy } = P, sh = shown[P.k], bs = st.bySlot[s], as = actSt(Nx.act); let M = P.M;
        sh.pred = Nx;
        if (!work) {
          work = oam.slice(); const dsq = gdsq || 0;
          if (dsq) { // 화면 이동분: 경기장 줄(맨 윗줄과 가로 스크롤이 같은 줄)의 배경과 모든 스프라이트를 같이 옮긴다
            wlt.set(lt); useLt = wlt; const h0 = lt[0] & 0x41F, f0 = lt[1] & 7;
            for (let y = 0; y < 240; y++) { const o = y * 4; if ((lt[o] & 0x41F) !== h0 || (lt[o + 1] & 7) !== f0) break; const X = ((((lt[o] & 31) << 3) | f0) + ((lt[o] >> 10) & 1) * 256 + dsq) & 511; wlt[o] = (lt[o] & ~0x41F) | ((X >> 3) & 31) | ((X >> 8) << 10); wlt[o + 1] = (lt[o + 1] & ~7) | (X & 7); }
            for (let i = 0; i < 64; i++) { if (oam[i * 4] >= 0xEF) continue; const x = oam[i * 4 + 3] - dsq; if (x < 0 || x > 255) work[i * 4] = 0xF8; else work[i * 4 + 3] = x; }
          }
        }
        const moveTo = w => { for (const i of idx) { const x = oam[i * 4 + 3] + dx; if (x < 0 || x > 255) w[i * 4] = 0xF8; else { w[i * 4 + 3] = x; w[i * 4] = (oam[i * 4] + dy) & 255; } } };
        const moveOnly = () => { moveTo(work); if (P.doI) { st.moved++; bs.moved++; as.moved++; } }; // 화면 밖으로 나가는 조각은 숨긴다. 보간 없는 슬롯(M 만)은 경기장과 같이 움직일 뿐이라 「위치 이동」으로 세지 않는다
        let lg = false; // 라인당 8개 제한 때문에 M 을 되돌렸나
        if (!M) moveOnly();
        else {
          // M 전용 뱅크(슬롯마다 하나): 지금 그 슬롯 뱅크의 사본에, 다른 조각이 안 쓰는 타일 번호를 골라 새 타일을 넣는다(머리·그림자 등 원작 타일은 그대로 남는다)
          const src = (sreg[s] % N) << 10, dst = (N + s) << 10, usedT = new Uint8Array(64), mine = new Uint8Array(64); for (const i of idx) mine[i] = 1;
          ext.set(chr.subarray(src, src + 1024), dst);
          for (let i = 0; i < 64; i++) if (!mine[i] && oam[i * 4] < 0xEF && (oam[i * 4 + 1] >> 6) === s) usedT[oam[i * 4 + 1] & 0x3F] = 1;
          for (const pc of M.pieces) if (!pc[4]) { let t = pc[2]; if (!(t & 0x3C)) t = (t + 3 * S.mem) & 255; usedT[t & 0x3F] = 1; }
          const map = []; let free = 0x3E, ok = true;
          for (let n = 0; n < M.tiles.length; n++) { while (free >= 0 && usedT[free]) free--; if (free < 0) { ok = false; break; } ext.set(M.tiles[n], dst + free * 16); map[n] = free--; }
          const A = { x: (S.x + dx) & 255, y: (S.y + dy) & 255, p: S.p, mem: S.mem }, ws = [];
          for (const pc of M.pieces) { const w = place(A, s, pc[4] ? [pc[0], pc[1], 0x3F, pc[3]] : pc); if (pc[4]) w[2] = map[pc[2]] | (s << 6); if (w[0] < 0 || w[0] > 255) ok = false; ws.push(w); }
          for (const w of ws) if (w[1] < 0 || w[1] >= 0xEF) ok = false; // 세로: 화면 밖(0xEF 이상 = 숨김 값)·8비트 순환 자리는 쓰지 않는다
          if (ok) { // M 을 넣은 OAM 후보. 라인당 8개 제한: 이 슬롯 밖 스프라이트의 줄별 표시 여부가 「위치만 옮긴 경우」와 하나라도 다르면 M 을 쓰지 않는다
            const cand = work.slice(); for (const i of idx) cand[i * 4] = 0xF8;
            ws.forEach((w, j) => { const i = idx[j] * 4; cand[i] = w[1] & 255; cand[i + 1] = w[2]; cand[i + 2] = w[3]; cand[i + 3] = w[0]; }); // 같은 OAM 자리에 넣어 겹침 순서를 지킨다
            if (lineGuard) { const alt = work.slice(); moveTo(alt); if (!samePicked(alt, cand, mine, useLt)) { ok = false; lg = true; } }
            if (ok) work.set(cand);
          }
          if (!ok) { moveOnly(); M = null; if (lg) { st.lineGuard++; bs.lineGuard++; as.lineGuard++; } } // M 을 못 넣는 자리(가장자리·빈 타일 없음·다른 스프라이트 보임이 바뀜): 위치만 옮긴다(원작 그림 그대로)
          else { extMask |= 1 << s; st.mid++; bs.mid++; as.mid++; }
        }
        infos.push({ frame: d.frame, slot: s, act: Nx.act, q, dx, dy, dsq: P.dsq || 0, mid: !!M, lg, from: [S.x, S.y, S.p & 0x7F, S.sc], to: [Nx.x, Nx.y, Nx.p & 0x7F, Nx.sc] });
      }
      if (!infos.length) { if (opt.checkAll) { st.checked++; if (same(render(ko, oam, sreg, 0, lt), d.fb)) st.checkOk++; else st.checkFail++; } return false; }
      st.checked++; if (!same(render(ko, oam, sreg, 0, lt), d.fb)) { st.checkFail++; return false; } st.checkOk++; // 자기 점검: 재합성이 코어 화면과 다르면 손대지 않는다
      out.set(render(ko, work, sreg, extMask, useLt)); st.modified++; st.last = infos[0]; st.lastAll = infos; return true;
    }
    return { frame, stats: st };
  }
  // 브라우저 연결(game.js): init 은 원작 렌더러(/engine/render.js 원문)와 자료를 받아 온 뒤에 준비된다. 준비 전·실패 시 frame 은 아무것도 하지 않는다
  let inst = null, err = null;
  const api = { create, get ready() { return !!inst; }, get error() { return err; }, get stats() { return inst ? inst.stats : null; },
    init(o) {
      const q = typeof location !== 'undefined' ? location.search : '';
      return Promise.all([fetch('/engine/render.js').then(r => { if (!r.ok) throw new Error('render.js ' + r.status); return r.text(); }), fetch('mid_frames.json').then(r => { if (!r.ok) throw new Error('mid_frames.json ' + r.status); return r.json(); })])
        .then(([src, data]) => { const mod = { exports: {} }; new Function('module', 'exports', src + '\n//# sourceURL=/engine/render.js#layer')(mod, mod.exports);
          inst = create({ chr: o.chr, Renderer: mod.exports.Renderer, data, testMid: /[?&]midtest=1(&|$)/.test(q), checkAll: /[?&]midcheck=1(&|$)/.test(q) }); })
        .catch(e => { err = String(e && e.message || e); console.warn('스프라이트 층 준비 실패(원작 화면 그대로): ' + err); });
    },
    frame(d, out) { if (!inst) return false; try { return inst.frame(d, out); } catch (e) { err = String(e && e.message || e); inst = null; console.error('스프라이트 층 오류(끔): ' + err); out.set(d.fb); return false; } } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NKSprite = api;
})(typeof self !== 'undefined' ? self : this);
