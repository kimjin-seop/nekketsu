'use strict';
// 선수 표시 층(표시 전용): 전투(1:2) 중 선수 머리 위에 작은 팀·자리 표식과 (설정에 따라) 이름을 얹는다. 엔진·워커·RAM·입력·락스텝·소리와 무관하고 코어 캔버스 픽셀은 손대지 않는다.
// 위치(RAM 읽기만): 발 기준점 화면 X $0411+s · 화면 Y $0421+s(높이 포함), 그림 $5B+s(bit7 = 0 이면 좌우 반전), 몸통 시트 $0401+s(08 문서 1절).
//   머리 위 = 그 그림의 메타스프라이트 조각 중 가장 위(ROM bank4 $800F 표를 여기서 읽는다), 가로 = 조각 폭의 가운데.
//   화면은 RAM 보다 4프레임 늦다(측정: 표시 OAM 과 RAM 으로 계산한 조각 일치 — 4프레임 전 RAM 95~97%, 지금 RAM 57~72%) → game.js 가 넘긴 프레임별 RAM 중 4프레임 전 것을 쓴다.
// 편: 스토리($0645 < 2) = 2대2 팀전, 팀 = 슬롯 >> 1(왼쪽 팀 빨강 ▲ · 오른쪽 팀 파랑 ●). 배틀($0645 ≥ 2) = 원작이 개인전(팀 값 없음) → 기준 자리(온라인 내 자리 · 로컬 1P) 빨강 ▲, 나머지 파랑 ●.
// 사람: 배틀 = 앞 $0645 − 1 슬롯, 스토리 = $04A2+s bit7 이 꺼진 슬롯(ui_manga.js HUD 와 같은 식). 온라인은 내 자리(room.you)만 크게.
// 설정(NKManga.tagInfo.mode): 0 끔 · 1 팀 표식만 · 2 팀 표식 + 이름(기본). 자리 번호(1P 등)는 쓰지 않는다. 쓰러진 선수(HP 0)·전투 밖·메뉴 덮개 중에는 그리지 않는다.
(function (root) {
  const OX = 88, FIELD = 188, LAG = 4;
  const NCAT = [110, 108, 104, 110, 122]; // 시트 0~4 의 그림 수(08 문서 1절)
  // ROM → 시트별 그림별 [왼쪽 x, 오른쪽 x(조각 끝), 위 y] (반전 전, 발 기준점 기준). 없는 그림 = null
  function parseBoxes(rom) {
    const u8 = rom instanceof Uint8Array ? rom : new Uint8Array(rom), base = 16 + 4 * 0x2000; // PRG 뱅크 4·5 가 $8000~$BFFF
    const rd = a => (a >= 0x8000 && a < 0xC000) ? u8[base + a - 0x8000] : -1, w = a => rd(a) | (rd(a + 1) << 8), sb = v => v > 127 ? v - 256 : v;
    const out = [];
    for (let c = 0; c < NCAT.length; c++) {
      const tab = w(0x800F + 2 * c), fr = [];
      for (let i = 0; i < NCAT[c]; i++) {
        const a = w(tab + 2 * i); if (a < 0x8000 || a >= 0xC000) { fr.push(null); continue; }
        const n = rd(a), px = w(a + 5), py = w(a + 7); if (!(n > 0 && n < 40)) { fr.push(null); continue; }
        let x0 = 999, x1 = -999, y0 = 999;
        for (let k = 0; k < n; k++) { const x = sb(rd(px + k)), y = sb(rd(py + k)); if (x < x0) x0 = x; if (x + 8 > x1) x1 = x + 8; if (y < y0) y0 = y; }
        fr.push([x0, x1, y0]);
      }
      out.push(fr);
    }
    return out;
  }
  // RAM 한 장 → 슬롯별 표식 자리(코어 화면 좌표). DOM 없음(Node 검증용). 반환 [{ s, x, top, hp }] (그릴 수 없는 슬롯은 빠진다)
  function locate(boxes, m) {
    const out = [];
    for (let s = 0; s < 4; s++) {
      const hp = m[0x4C2 + s], cat = m[0x401 + s], f = m[0x5B + s]; if (!hp || cat >= boxes.length) continue;
      const b = boxes[cat][f & 0x7F]; if (!b) continue;
      const flip = !(f & 0x80), cx = flip ? -(b[0] + b[1]) / 2 : (b[0] + b[1]) / 2, y = m[0x421 + s];
      out.push({ s, x: m[0x411 + s] + cx, top: (y > 200 ? y - 256 : y) + b[2] + 1, hp });
    }
    return out;
  }
  const COL = { red: '#e5484d', blue: '#3b82f6', gray: '#AAAABE' };
  // → { c, shape, human, mine }. 스토리 = 팀(슬롯 >> 1). 배틀 = 원작이 개인전이라 팀 값이 없다 → 「내 편/상대」로 가른다:
  //   기준 자리 = 온라인 내 자리(room.you), 로컬은 1P(슬롯 0). 기준 자리 = 빨강 ▲, 나머지(상대 사람·CPU) = 파랑 ●. $0645 가 알 수 없는 값이면 중립(회색 ●)
  function style(m, s, info) {
    const v = m[0x645]; if (v > 5) return { c: 'gray', shape: 'dot', human: false, mine: false };
    const ffa = v >= 2, humans = Math.min(4, v - 1), human = ffa ? s < humans : !(m[0x4A2 + s] & 0x80);
    const mine = human && (info.you >= 0 ? s === info.you : true);
    const red = ffa ? s === (info.you >= 0 ? info.you : 0) : !(s >> 1);
    return { c: red ? 'red' : 'blue', shape: red ? 'tri' : 'dot', human, mine };
  }
  // 이름: 온라인 사람 = 대기실 닉네임. 로컬 = 1P 사람은 로그인한 계정 닉네임 → 없으면(그 외 모두) 캐릭터 이름(에디트 = 음역 이름). 6자 넘으면 5자 + …
  const clip = t => { const a = Array.from(String(t || '').trim()); return a.length > 6 ? a.slice(0, 5).join('') + '…' : a.join(''); };
  const nameOf = (s, sy, info) => clip((info.seats && info.seats[s]) || (info.you < 0 && sy.human && s === 0 && info.nick) || (info.names && info.names[s]) || '');

  let cv = null, ov = null, ctx = null, boxes = null, err = null, shown = false, raf = 0;
  const hist = []; // [{ f, m }] 최근 8프레임
  const st = { frames: 0, draws: 0, ms: [], msMax: 0, last: null, lag: 0 };
  function hide() { if (shown && ov) { ov.style.display = 'none'; shown = false; } st.last = null; }
  function place(fh) { // 덮개 = 코어 필드 자리(hd_layer.js 와 같은 식, 디바이스 픽셀 정렬). 반환: 코어 1픽셀의 디바이스 픽셀 수
    const r = root.NKCam ? root.NKCam.rect(cv) : cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, s = r.width / 432; // 변환 전 배치 rect(카메라 줌 web/cam_fx.js: 덮개는 같은 래퍼 안이라 transform 을 같이 받는다)
    const L = Math.round((r.left + OX * s) * dpr), T = Math.round(r.top * dpr), W = Math.round(256 * s * dpr), H = Math.round(fh * s * dpr);
    if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; } else ctx.clearRect(0, 0, W, H);
    const os = ov.style, sl = L / dpr + 'px', stp = T / dpr + 'px', sw = W / dpr + 'px', sh = H / dpr + 'px';
    if (os.left !== sl) os.left = sl; if (os.top !== stp) os.top = stp; if (os.width !== sw) os.width = sw; if (os.height !== sh) os.height = sh;
    return W / 256;
  }
  function mark(x, y, r, shape, c, mine) { // (x, y) = 표식 아래 끝 가운데(디바이스 픽셀)
    ctx.beginPath();
    if (shape === 'tri') { ctx.moveTo(x, y - 1.9 * r); ctx.lineTo(x + r, y); ctx.lineTo(x - r, y); ctx.closePath(); } // ▲ 빨강
    else if (shape === 'dia') { ctx.moveTo(x, y - 2 * r); ctx.lineTo(x + r, y - r); ctx.lineTo(x, y); ctx.lineTo(x - r, y - r); ctx.closePath(); }
    else if (shape === 'sq') ctx.rect(x - 0.85 * r, y - 1.7 * r, 1.7 * r, 1.7 * r);
    else ctx.arc(x, y - r, r, 0, Math.PI * 2);
    ctx.fillStyle = COL[c]; ctx.fill(); ctx.lineWidth = Math.max(1, r * 0.35); ctx.strokeStyle = mine ? '#fff' : 'rgba(0,0,0,.85)'; ctx.stroke();
  }
  function tick() {
    raf = requestAnimationFrame(tick);
    try { draw(); } catch (e) { err = String(e && e.message || e); cancelAnimationFrame(raf); hide(); console.error('선수 표시 층 오류(끔): ' + err); }
  }
  function draw() {
    const M = root.NKManga, cur = hist[hist.length - 1];
    if (!cur || !boxes || !M) return hide();
    const m = cur.m, fight = m[0x641] === 1 && (m[0x642] & 0x7F) === 2;
    if (!fight) return hide();
    const info = M.tagInfo; if (!info || !info.mode || (info.active && !info.overlay)) return hide();
    st.frames++; const t0 = performance.now();
    let R = null; for (let i = hist.length - 1; i >= 0; i--) { R = hist[i]; if (hist[i].f <= cur.f - LAG) break; } // 4프레임 전(없으면 가장 오래된 것)
    st.lag = cur.f - R.f;
    const S = place(FIELD), pts = locate(boxes, R.m), withName = info.mode === 2;
    const fpx = 10 * Math.max(1, Math.round(S / 3)); ctx.font = fpx + 'px NKM9,monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const out = [], boxesL = []; // boxesL = 이미 그린 이름 띠(겹치면 위로 한 줄씩 비킨다)
    for (const p of pts) {
      const sy = style(m, p.s, info), r = (sy.mine ? 1.3 : 1) * 1.1 * S; // 반지름(코어 1.1픽셀, 내 선수 1.3배)
      const x = Math.max(4, Math.min(252, p.x)) * S, bh = Math.round(fpx * 1.2), top = Math.max(2 * r + 2 + (withName ? bh + 1 : 0), Math.min(FIELD, p.top - 2) * S); // 머리 위 2픽셀(이름 띠까지 화면 안), 옆 끝은 안쪽으로
      ctx.globalAlpha = 0.92; mark(x, top, r, sy.shape, sy.c, sy.mine);
      const lab = withName ? nameOf(p.s, sy, info) : '';
      if (lab) { // 표식 위 한 줄: 반투명 검은 띠 + 흰 글씨(아래 끝 = 팀색 줄)
        const tw = Math.ceil(ctx.measureText(lab).width), pw = Math.round(fpx * 0.35), bw = tw + 2 * pw, bx = Math.round(Math.max(0, Math.min(ov.width - bw, x - bw / 2)));
        let by = Math.round(top - 2 * r - 1 - bh);
        const hit = y => boxesL.some(b => bx < b[0] + b[2] && b[0] < bx + bw && y < b[1] + bh + 1 && b[1] < y + bh + 1);
        for (let k = 0; k < 3 && hit(by); k++) by = by - bh - 1 >= 0 ? by - bh - 1 : by + bh + 1; // 겹침 = 한 줄 위(화면 위 끝이면 아래)
        boxesL.push([bx, by, bw]);
        ctx.globalAlpha = 0.55; ctx.fillStyle = '#000'; ctx.fillRect(bx, by, bw, bh);
        ctx.globalAlpha = 0.95; ctx.fillStyle = COL[sy.c]; ctx.fillRect(bx, by + bh - Math.max(1, Math.round(S / 3)), bw, Math.max(1, Math.round(S / 3)));
        ctx.fillStyle = '#fff'; ctx.fillText(lab, bx + bw / 2, by + bh / 2);
      }
      out.push({ s: p.s, x: p.x, top: p.top, c: sy.c, shape: sy.shape, mine: sy.mine, label: lab, box: lab ? boxesL[boxesL.length - 1].concat(Math.round(fpx * 1.2)) : null, hp: p.hp }); // box = 이름 띠 [x, y, 폭, 높이](디바이스 픽셀)
    }
    ctx.globalAlpha = 1;
    if (!shown) { ov.style.display = ''; shown = true; }
    const dt = performance.now() - t0; st.draws++; if (dt > st.msMax) st.msMax = dt; st.ms.push(dt); if (st.ms.length > 600) st.ms.shift();
    st.last = { f: cur.f, rf: R.f, S, fpx, mode: info.mode, m645: m[0x645], tags: out };
  }
  const api = {
    parseBoxes, locate, style, get stats() { return st; }, get error() { return err; }, get shown() { return shown; }, get ready() { return !!boxes; },
    init(o) { // o = { canvas(#c), rom(ROM 전체) }. 실패하면 층만 끈다(게임은 그대로)
      try {
        cv = o.canvas; boxes = parseBoxes(o.rom);
        ov = document.createElement('canvas'); ov.id = 'nk-tags'; ov.style.cssText = 'position:absolute;display:none;pointer-events:none';
        cv.parentNode.appendChild(ov); ctx = ov.getContext('2d');
        if (document.fonts && document.fonts.load) document.fonts.load('10px NKM9').catch(() => { /* 글꼴 없음 = 기본 글꼴 */ });
        raf = requestAnimationFrame(tick);
      } catch (e) { err = String(e && e.message || e); boxes = null; console.warn('선수 표시 층 준비 실패(끔): ' + err); }
    },
    frame(f, m) { if (!boxes) return; hist.push({ f, m }); if (hist.length > 8) hist.shift(); }, // game.js: 워커 프레임마다(로컬·온라인 공통). m 은 그 프레임 RAM 사본(읽기만, 보관만)
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NKTags = api;
})(typeof self !== 'undefined' ? self : this);
