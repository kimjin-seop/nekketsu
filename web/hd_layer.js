'use strict';
// 전투 배경 HD 층(analysis/16_wide_hd_online_plan.md 4.2절 차분 마스크 합성, 단계 1). 기본 꺼짐: 주소에 ?hd=1 이 있을 때만 game.js 가 불러온다.
// 표시 전용: 코어 캔버스(432x240, 원작 픽셀) 위 필드 자리(라인 0~187)에 디바이스 해상도 덮개 캔버스를 하나 더 얹는다. 엔진·워커·RAM·입력·락스텝·소리와 무관하고
//   코어 캔버스 픽셀은 손대지 않는다(덮개를 숨기면 원작 화면 그대로).
// 합성(프레임마다): 한글 층 PPU 사본(ko: 네임테이블·팔레트·라인별 스크롤·뱅크)과 ROM CHR 로 원작 렌더러(/engine/render.js 원문)를 스프라이트를 끈 채 돌려 「배경만」 프레임을 만들고,
//   실제 프레임(fb)과 다른 픽셀(선수·그림자·효과 등 스프라이트) = 원작 도트(최근접 확대), 같은 픽셀 = HD 그림(web/hd/stage<id>_hd_<k>x.webp, 월드 (x,y) → (kx,ky))으로 바꾼다.
//   화면 x = 월드 x − 카메라(라인별 가로 스크롤 v·fx). 원작 HUD 띠(라인 188~239)는 덮지 않는다.
// 원작 그대로 두는 경우(안전 폴백): 전투(1:2) 밖, 스테이지 id($0644)가 표에 없음, 네임테이블(경기장 24행 + 속성) 해시·배경 뱅크·팔레트가 그 스테이지 기준과 다름(페이드 등),
//   PPU 사본 없음, HD 그림 로드 실패·로드 전. 라인 단위로는 렌더링 꺼짐·흑백·뱅크 다름·그림 밖 줄, 픽셀 단위로는 왼쪽 8px 가림·그림 폭 밖·팔레트 애니 칸(스파크·컨베이어·물길)·기준과 바뀐 네임테이블 칸(맨홀)이 원작 그대로다.
// 그림 배율 k: 덮개 디바이스 배율 S(= 필드 폭 디바이스 px / 256)가 3.5 미만이면 3배판, 아니면 4배판을 고품질 보간으로 S 에 맞춘다(16 문서 4.4절 3번).
(function (root) {
  // 스테이지 기준(analysis/hd_survey/out/stage_<id>.json + data/rom_derived/states/hd_s<id>.json 에서 잰 값. tools/make_hd_fight_states.js):
  //   tm = 네임테이블 2장의 경기장 24행 + 속성 48바이트 FNV-1a(sha1 은 survey tilemap_sha1 과 같음 확인), bank = 라인의 R0 | R1<<8, pal = 배경 팔레트 16바이트(기준), anim = 팔레트 애니 칸(그 칸 색을 쓰는 픽셀은 원작), w = 그림의 월드 폭
  //   2차(art/ui_manga/stage_hd/manifest.json round2.handoff.hd_layer_STAGES): 변형 id 는 tm·bank 가 같고 pal 만 다르다. id 14 = round3.
  //   nt = 전투 중 바뀌는 네임테이블 칸 [표, 행, 열0, 열1](맨홀·통나무), tmx = 그 칸을 뺀 tm, base = 그 칸의 기준 타일(zones/nt/s<id>.json vram). 기준과 다른 칸(8x8)만 원작 도트로 그린다.
  const MH = { nt: [[0, 16, 10, 13], [0, 18, 22, 25], [0, 20, 10, 13], [1, 16, 2, 5], [1, 20, 2, 5]], tmx: 0xcf7ff456, base: '8c8d8e8f9c9d9e9f8c8d8e8f8c8d8e8f8c8d8e8f' };
  const STAGES = {
    0: { tm: 0x0287f7ce, bank: 0x4240, pal: '0f3710000f3727170f2616070f302326', anim: [], w: 512, h: 192 },
    1: { tm: 0x2d820a8b, bank: 0x4a48, pal: '0f2010000f312c1c0f0f2c280f302326', anim: [9, 10], w: 384, h: 192 },
    2: { tm: 0x4fdd2737, bank: 0x5250, pal: '0f3c23130f3828180f0b10000f302326', anim: [9, 10, 11], w: 512, h: 192 },
    3: { tm: 0x63831c1e, bank: 0x4a48, pal: '0f2010000f3121110f3727170f302326', anim: [], w: 384, h: 192, ...MH },
    4: { tm: 0xad192331, bank: 0x4644, pal: '0f3038280f3021110f30322b0f302326', anim: [], w: 480, h: 192 },
    5: { tm: 0x0287f7ce, bank: 0x4240, pal: '0f3b10000f3828180f291a0b0f302326', anim: [], w: 512, h: 192 },
    6: { tm: 0x2d820a8b, bank: 0x4a48, pal: '0f3727170f3121000f0f2c280f302326', anim: [9, 10], w: 384, h: 192 },
    7: { tm: 0x4fdd2737, bank: 0x5250, pal: '0f3421110f3827170f0b10000f302326', anim: [9, 10, 11], w: 512, h: 192 },
    8: { tm: 0x63831c1e, bank: 0x4a48, pal: '0f2027170f3121110f3929180f302326', anim: [], w: 384, h: 192, ...MH },
    9: { tm: 0xe2f49bfd, bank: 0x4e4c, pal: '0f1131210f3727170f392b1c0f302326', anim: [1, 2, 3], w: 496, h: 192 },
    10: { tm: 0x0287f7ce, bank: 0x4240, pal: '0f3810000f322b1b0f38270b0f302326', anim: [], w: 512, h: 192 },
    11: { tm: 0x2d820a8b, bank: 0x4a48, pal: '0f31211c0f312b000f0f2c280f302326', anim: [9, 10], w: 384, h: 192 },
    12: { tm: 0x4fdd2737, bank: 0x5250, pal: '0f3c1c0c0f3827170f0b10000f302326', anim: [9, 10, 11], w: 512, h: 192 },
    13: { tm: 0x63831c1e, bank: 0x4a48, pal: '0f3028180f3626150f3827170f302326', anim: [], w: 384, h: 192, ...MH },
    14: { tm: 0x1b26520f, bank: 0x5654, pal: '0f3929190f3037260f3027170f302326', anim: [], w: 448, h: 192, nt: [[0, 16, 16, 31], [0, 17, 16, 31], [0, 18, 16, 31]], tmx: 0xb38b66cf, base: '80808080d0d0d0d0d0d0d0d0d0d0d0d080808080e0e0e0e0e0e0e0e0e0e0e0e080808080f0f0f0f0f0f0f0f0f0f0f0f0' },
    15: { tm: 0x0287f7ce, bank: 0x4240, pal: '0f3310000f3424140f2717070f302326', anim: [], w: 512, h: 192 },
    16: { tm: 0x2d820a8b, bank: 0x4a48, pal: '0f3710170f3626160f0f2c280f302326', anim: [9, 10], w: 384, h: 192 },
    17: { tm: 0x4fdd2737, bank: 0x5250, pal: '0f391b0b0f3810000f0b10000f302326', anim: [9, 10, 11], w: 512, h: 192 },
    18: { tm: 0x63831c1e, bank: 0x4a48, pal: '0f2717070f3626160f3b1c0c0f302326', anim: [], w: 384, h: 192, ...MH },
    19: { tm: 0xd5d6906b, bank: 0x5e5c, pal: '0f2b1b0b0f3727170f3036260f302326', anim: [], w: 384, h: 192 },
  };
  const FIELD = 188, OX = 88;
  const hexb = s => { const a = new Uint8Array(s.length >> 1); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; };
  for (const k in STAGES) { const S = STAGES[k]; S.palB = hexb(S.pal); S.animM = new Uint8Array(16); for (const i of S.anim) S.animM[i] = 1;
    if (S.nt) { S.skip = new Uint8Array(0x800); S.ci = []; S.baseB = hexb(S.base); for (const [n, r, c0, c1] of S.nt) for (let c = c0; c <= c1; c++) { S.skip[n * 0x400 + r * 32 + c] = 1; S.ci.push(n * 0x400 + r * 32 + c); } }
  }
  const dc = new Uint8Array(64 * 24); // 바뀐 칸(월드 8x8, 64열 x 24행)
  function tmHash(v, skip) { let h = 0x811c9dc5; for (let n = 0; n < 2; n++) { const b = n * 0x400; for (let i = 0; i < 768; i++) { if (skip && skip[b + i]) continue; h ^= v[b + i]; h = Math.imul(h, 16777619); } for (let i = 0x3C0; i < 0x3F0; i++) { h ^= v[b + i]; h = Math.imul(h, 16777619); } } return h >>> 0; }
  // 합성 핵심(DOM 없음, Node 검증용으로도 쓴다). opt: { chr(ROM CHR), Renderer(render.js) }
  function create(opt) {
    const R = new opt.Renderer(), chr = opt.chr, fpal = new Uint8Array(32);
    const fake = { pal: fpal, vram: null, chr, ppu: { v: 0, fx: 0, ctrl: 0, mirrorV: true }, reg: new Uint8Array(8), bsel: 0, ppuOam: new Uint8Array(256) };
    const mask = new Uint32Array(256 * FIELD), bands = [];
    // 반환: null(원작 그대로, why 에 사유) 또는 { sid, bands: [[y0, y1, 월드 x, 월드 y0]], mask(256x188 ABGR, 0 = HD 자리), hd(HD 픽셀 수), spr(스프라이트 픽셀 수), mis(재합성과 다른 그 밖 픽셀 수) }
    // sp = 그 프레임의 스프라이트 사본(web/worker.js ctl[8]: { oam 256, reg 4 }), nf = 깜박임 제거 켬. sp 가 있으면 스프라이트까지 다시 그리되 스프라이트 팔레트 칸에 표시(bit7)를 달아
    //   「보이는 스프라이트 픽셀」을 정확히 가른다(스프라이트 색이 그 자리 배경색과 같아도 원작 도트로 남는다 — 4.2절 한계 보완). sp 가 없으면 배경만 그려 fb 와 다른 픽셀만 스프라이트로 본다.
    const res = { sid: -1, bands, mask, hd: 0, spr: 0, mis: 0, why: '' };
    function compose(fb, ko, m, sp, nf) {
      res.why = '';
      if (!ko || !ko.lt || !ko.vram || !ko.pal) { res.why = 'noKo'; return null; }
      if (m[0x641] !== 1 || (m[0x642] & 0x7F) !== 2) { res.why = 'notFight'; return null; }
      const sid = m[0x644], S = STAGES[sid]; if (!S) { res.why = 'stage'; return null; }
      const pal = ko.pal, lt = ko.lt;
      for (let i = 0; i < 16; i++) if ((i === 0 || (i & 3)) && !S.animM[i] && (pal[i] & 0x3F) !== S.palB[i]) { res.why = 'pal'; return null; } // 페이드·번쩍임 등: 원작 그대로
      let nd = 0;
      if (S.nt) { // 맨홀 칸: 나머지 칸은 해시로, 바뀌는 칸은 기준 타일과 칸 단위로 비교
        if (tmHash(ko.vram, S.skip) !== S.tmx) { res.why = 'tilemap'; return null; }
        dc.fill(0); for (let k = 0; k < S.ci.length; k++) { const i = S.ci[k]; if (ko.vram[i] !== S.baseB[k]) { dc[((i & 0x3FF) >> 5) * 64 + (i >> 10) * 32 + (i & 31)] = 1; nd++; } }
      } else if (tmHash(ko.vram) !== S.tm) { res.why = 'tilemap'; return null; }
      fpal.set(pal); for (const i of S.anim) fpal[i] = (pal[i] & 0x3F) | 0x40; // 팔레트 애니 칸 표시(렌더러의 row 값에 bit6 가 남는다. 화면 색은 & 0x3F 로 같다)
      if (sp) { for (let i = 16; i < 32; i++) fpal[i] = (pal[i] & 0x3F) | 0x80; fake.ppuOam = sp.oam; for (let i = 0; i < 4; i++) fake.reg[2 + i] = sp.reg[i]; R.noFlicker = !!nf; }
      const sm = sp ? 0xFF : ~0x10; // 렌더 마스크: 스프라이트 사본이 있으면 원작 그대로, 없으면 스프라이트 끔
      fake.vram = ko.vram; bands.length = 0; let hd = 0, spr = 0, mis = 0, band = null;
      for (let y = 0; y < FIELD; y++) {
        const o = y * 4, v = lt[o], fx = lt[o + 1] & 7, ctrl = lt[o + 1] >> 8, bk = lt[o + 2], mk = lt[o + 3] & 255, mo = y * 256, fo = y * 256;
        const wx = ((v >> 10) & 1) * 256 + (v & 31) * 8 + fx, wy = ((v >> 5) & 31) * 8 + ((v >> 12) & 7);
        const ok = (mk & 8) && !(mk & 1) && bk === S.bank && !(ctrl & 0x10) && !(lt[o + 3] & 0x100) && (lt[o + 3] & 0x200) && wy < S.h;
        if (!ok) { for (let x = 0; x < 256; x++) mask[mo + x] = fb[fo + x]; band = null; if (y === 0 && sp && nf) R._nfFrame(sp.oam); continue; } // 깜박임 제거의 OAM 방향 추적은 라인 0 에서 한다
        fake.ppu.v = v; fake.ppu.fx = fx; fake.ppu.ctrl = ctrl; fake.reg[0] = bk & 255; fake.reg[1] = bk >> 8;
        R.line(fake, y, mk & sm);
        const bf = R.fb, row = R.row, x0 = (mk & 2) ? 0 : 8, xw = Math.min(256, S.w - wx), dr = nd ? (wy >> 3) * 64 : -1;
        for (let x = 0; x < 256; x++) {
          const c = fb[fo + x];
          if (x < x0 || x >= xw) mask[mo + x] = c;
          else if (row[x] & 0x80) { mask[mo + x] = c; spr++; } // 보이는 스프라이트 픽셀
          else if (c !== bf[fo + x]) { mask[mo + x] = c; if (sp) mis++; else spr++; } // 재합성과 다름(사본 없음 = 스프라이트로 본다)
          else if (row[x] & 0x40) mask[mo + x] = c; // 팔레트 애니 칸
          else if (dr >= 0 && dc[dr + (((wx + x) & 511) >> 3)]) mask[mo + x] = c; // 기준과 바뀐 네임테이블 칸
          else { mask[mo + x] = 0; hd++; }
        }
        if (band && band[2] === wx && band[3] + (y - band[0]) === wy) band[1] = y + 1; else { band = [y, y + 1, wx, wy]; bands.push(band); }
      }
      if (!hd) { res.why = 'noHd'; return null; }
      res.sid = sid; res.hd = hd; res.spr = spr; res.mis = mis; res.nd = nd; return res;
    }
    return { compose, get why() { return res.why; } };
  }
  // ---- 브라우저 연결(game.js): init 뒤 draw(코어 256x240 ABGR, ko 사본, RAM, 숨김) 를 paint 마다 부른다 ----
  let core = null, err = null, cv = null, ov = null, octx = null, off = null, offCtx = null, offImg = null, shown = false, lastWhy = '';
  const imgs = {}; // 'sid:k' → { img, ok, fail }
  const st = { frames: 0, hd: 0, fall: {}, ms: [], msMax: 0, k: 0, S: 0, last: null };
  function loadImg(sid, k) {
    const key = sid + ':' + k; if (imgs[key]) return imgs[key];
    const e = imgs[key] = { img: new Image(), ok: false, fail: false };
    e.img.src = 'hd/stage' + sid + '_hd_' + k + 'x.webp'; // 무손실 WebP(마스터 PNG = art/ui_manga/stage_hd, 픽셀 동일. tools/hd_webp.py 로 만든다)
    e.img.decode().then(() => { e.ok = true; }).catch(() => { e.fail = true; console.warn('HD 배경 불러오기 실패(원작 그대로): ' + e.img.src); });
    return e;
  }
  function hide(why) { if (why) { st.fall[why] = (st.fall[why] || 0) + 1; lastWhy = why; } if (shown && ov) { ov.style.display = 'none'; shown = false; } }
  function place() { // 덮개 = 코어 필드 자리(디바이스 픽셀 정렬). 반환: 디바이스 배율 S
    const r = root.NKCam ? root.NKCam.rect(cv) : cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, s = r.width / 432; // 변환 전 배치 rect(카메라 줌 web/cam_fx.js)
    const L = Math.round((r.left + OX * s) * dpr), T = Math.round(r.top * dpr), W = Math.round(256 * s * dpr), H = Math.round(FIELD * s * dpr);
    if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; }
    const sl = L / dpr + 'px', stp = T / dpr + 'px', sw = W / dpr + 'px', sh = H / dpr + 'px', os = ov.style;
    if (os.left !== sl) os.left = sl; if (os.top !== stp) os.top = stp; if (os.width !== sw) os.width = sw; if (os.height !== sh) os.height = sh;
    return W / 256;
  }
  function draw(fb, ko, m, hidden) {
    if (!core || !ov) return;
    st.frames++;
    if (hidden) return hide('cover');
    if (!m || m[0x641] !== 1) return hide('notFight');
    if (STAGES[m[0x644]]) loadImg(m[0x644], place() < 3.5 ? 3 : 4); // 전투 입장(1:4)부터 쓸 배율판만 미리 읽는다
    if ((m[0x642] & 0x7F) !== 2) return hide('notFight');
    const t0 = performance.now();
    const g = root.__game, r = core.compose(fb, ko, m, api.spr || null, !!(g && g.noFlicker)); if (!r) return hide(core.why || 'x');
    const S = place(), k = S < 3.5 ? 3 : 4, e = loadImg(r.sid, k);
    if (!e.ok) return hide(e.fail ? 'imgFail' : 'imgLoad');
    const W = ov.width, H = ov.height;
    octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = 'high';
    for (const b of r.bands) { const n = Math.min(256, STAGES[r.sid].w - b[2]); octx.drawImage(e.img, b[2] * k, b[3] * k, n * k, (b[1] - b[0]) * k, 0, b[0] * S, n * S, (b[1] - b[0]) * S); }
    new Uint32Array(offImg.data.buffer).set(r.mask); offCtx.putImageData(offImg, 0, 0);
    octx.imageSmoothingEnabled = false; octx.drawImage(off, 0, 0, 256, FIELD, 0, 0, W, H);
    if (!shown) { ov.style.display = ''; shown = true; }
    const dt = performance.now() - t0; st.hd++; st.k = k; st.S = S; if (dt > st.msMax) st.msMax = dt; st.ms.push(dt); if (st.ms.length > 600) st.ms.shift();
    st.last = { sid: r.sid, nd: r.nd, hd: r.hd, spr: r.spr, mis: r.mis, sp: !!api.spr, bands: r.bands.length, b0: r.bands[0].slice() }; if (r.mis) st.misFrames = (st.misFrames || 0) + 1;
  }
  const api = { spr: null /* game.js 가 프레임마다 넣는 스프라이트 사본(d.spr) */, create, STAGES, get ready() { return !!core; }, get error() { return err; }, get stats() { return st; }, get shown() { return shown; }, get why() { return lastWhy; },
    init(o) { // o = { chr, canvas }
      cv = o.canvas;
      return fetch('/engine/render.js').then(r => { if (!r.ok) throw new Error('render.js ' + r.status); return r.text(); }).then(src => {
        const mod = { exports: {} }; new Function('module', 'exports', src + '\n//# sourceURL=/engine/render.js#hd')(mod, mod.exports);
        core = create({ chr: o.chr, Renderer: mod.exports.Renderer });
        ov = document.createElement('canvas'); ov.id = 'nk-hd'; ov.style.cssText = 'position:absolute;display:none;pointer-events:none;image-rendering:auto;background:#000';
        cv.insertAdjacentElement('afterend', ov); octx = ov.getContext('2d');
        off = document.createElement('canvas'); off.width = 256; off.height = FIELD; offCtx = off.getContext('2d'); offImg = offCtx.createImageData(256, FIELD);
      }).catch(e => { err = String(e && e.message || e); core = null; console.warn('HD 층 준비 실패(원작 그대로): ' + err); });
    },
    draw(fb, ko, m, hidden) { if (!core) return; try { draw(fb, ko, m, hidden); } catch (e) { err = String(e && e.message || e); core = null; if (ov) ov.style.display = 'none'; shown = false; console.error('HD 층 오류(끔): ' + err); } } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NKHd = api;
})(typeof self !== 'undefined' ? self : this);
