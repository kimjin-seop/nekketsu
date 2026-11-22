'use strict';
// 출력 계층(M2 렌더러): 엔진의 PPU 상태(네임테이블·팔레트·OAM·CHR 뱅크 레지스터·스크롤 v/t/fx·PPUCTRL/PPUMASK)를
// 스캔라인 단위로 256x240 프레임버퍼(ABGR Uint32, canvas ImageData 와 같은 배치)에 그린다. Node/브라우저 공용.
// 규칙은 오라클(public/nes.js renderLine)과 동일하다: 라인 단위 렌더, 라인당 스프라이트 8개 제한(OAM 순서 우선),
// 좌측 8px 마스크(PPUMASK bit1/bit2), 스프라이트 우선순위 비트, 8x16 스프라이트, MMC3 CHR 뱅크(라인 시점 값).
// 엔진이 라인마다 호출하므로(core.js _scan) 화면 중간의 스크롤·CHR 뱅크 전환(MMC3 IRQ 분할)이 그 라인부터 반영된다.
// 색상표는 오라클과 같은 값(NES 2C02 근사 RGB 64색). 게임 로직에는 관여하지 않는다(sprite 0 hit 미반영: 원작 코드가 쓰지 않음).
const PALRGB = [84,84,84,0,30,116,8,16,144,48,0,136,68,0,100,92,0,48,84,4,0,60,24,0,32,42,0,8,58,0,0,64,0,0,60,0,0,50,60,0,0,0,0,0,0,0,0,0,
152,150,152,8,76,196,48,50,236,92,30,228,136,20,176,160,20,100,152,34,32,120,60,0,84,90,0,40,114,0,8,124,0,0,118,40,0,102,120,0,0,0,0,0,0,0,0,0,
236,238,236,76,154,236,120,124,236,176,98,236,228,84,236,236,88,180,236,106,100,212,136,32,160,170,0,116,196,0,76,208,32,56,204,108,56,180,204,60,60,60,0,0,0,0,0,0,
236,238,236,168,204,236,188,188,236,212,178,236,236,174,236,236,174,212,236,180,176,228,196,144,204,210,120,180,222,120,168,226,144,152,226,180,160,214,228,160,162,160,0,0,0,0,0,0];
// 깜박임 제거(표시 전용 옵션, analysis/24_flicker_removal.md): noFlicker 가 참이면 라인당 스프라이트 8개 제한을 풀고, 원작이 깜박임 구간에서
//   프레임마다 뒤집는 OAM(NMI 가 DMA 뒤 항목 i <-> 63-i 로 뒤집음)을 직전 프레임과 비교해 정방향 순서로 되돌려 그린다(겹친 조각의 앞뒤가 프레임마다 바뀌지 않게).
//   거짓(기본)이면 종전 코드 경로 그대로다(출력 바이트 동일). 게임 로직·RAM·소리에는 관여하지 않는다(sprite 0 hit·overflow 플래그는 원래 미반영).
//   웹: 워커(web/worker.js) 전역의 공유 메모리 ctl 칸 NF_SLOT 을 프레임마다(라인 0) 읽는다. render.js 는 워커 전역에서 실행되므로 워커 최상위 ctl 이 보인다(워커 무수정).
//   Node 도구(차분·오라클)에는 ctl 이 없으므로 늘 꺼짐(renderer.noFlicker = true 를 직접 줄 때만 켜짐).
const NF_SLOT = 9;
const NF_CTL = (() => { try { return (typeof ctl !== 'undefined' && ctl instanceof Int32Array && ctl.length > NF_SLOT) ? ctl : null; } catch (x) { return null; } })(); // eslint-disable-line no-undef
const PAL32 = new Uint32Array(64);
for (let i = 0; i < 64; i++) PAL32[i] = ((255 << 24) | (PALRGB[i * 3 + 2] << 16) | (PALRGB[i * 3 + 1] << 8) | PALRGB[i * 3]) >>> 0;

class Renderer {
  constructor() {
    this.fb = new Uint32Array(256 * 240);
    this.row = new Uint8Array(256); this.bgz = new Uint8Array(256 + 16); this.sprBuf = new Int16Array(256);
    this.cb = new Int32Array(8);
    this.noFlicker = false; this.nfPrev = null; this.nfRev = false; this.nfStat = { frames: 0, rev: 0 }; // 깜박임 제거 상태(위 주석)
  }
  // 라인 0 에서 한 번: 이번 프레임 OAM 이 직전 프레임 OAM 의 뒤집힌 꼴이면 방향을 바꾸고, 같으면 유지, 새로 만든 OAM 이면 정방향
  _nfFrame(oam) {
    const p = this.nfPrev || (this.nfPrev = new Uint8Array(256));
    let same = true, rev = true;
    for (let i = 0; i < 256 && (same || rev); i++) { if (oam[i] !== p[i]) same = false; if (oam[i] !== p[252 - (i & ~3) + (i & 3)]) rev = false; }
    this.nfRev = same ? this.nfRev : rev ? !this.nfRev : false;
    p.set(oam); this.nfStat.frames++; if (this.nfRev) this.nfStat.rev++;
  }
  // e = Engine(core.js), y = 0~239, mask = PPUMASK. e.ppu.v 는 이 라인의 시작 스크롤(수직 증가는 엔진이 렌더 뒤에 수행).
  line(e, y, mask) {
    if (y === 0) { if (NF_CTL) this.noFlicker = Atomics.load(NF_CTL, NF_SLOT) === 1; if (this.noFlicker) this._nfFrame(e.oamView ? e.oamView() : e.ppuOam); }
    const fb = this.fb, o = y * 256, pal = e.pal;
    const grey = (mask & 1) ? 0x30 : 0x3F;
    if (!(mask & 0x18)) { fb.fill(PAL32[pal[0] & grey], o, o + 256); return; } // 렌더링 꺼짐: 배경색
    const row = this.row, bgz = this.bgz, vram = e.vram, chr = e.chr, cb = this.cb, p = e.ppu, ctrl = p.ctrl;
    { // MMC3 CHR 매핑(1KB x 8), 오라클 updateBanks 와 동일
      const r = e.reg, inv = (e.bsel >> 7) & 1, N = chr.length >> 10, lo = inv ? 4 : 0, hi = inv ? 0 : 4;
      cb[lo] = ((r[0] & 0xFE) % N) << 10; cb[lo + 1] = (((r[0] & 0xFE) + 1) % N) << 10;
      cb[lo + 2] = ((r[1] & 0xFE) % N) << 10; cb[lo + 3] = (((r[1] & 0xFE) + 1) % N) << 10;
      cb[hi] = (r[2] % N) << 10; cb[hi + 1] = (r[3] % N) << 10; cb[hi + 2] = (r[4] % N) << 10; cb[hi + 3] = (r[5] % N) << 10;
    }
    const bd = pal[0];
    row.fill(bd); bgz.fill(0);
    const bg = mask & 8;
    if (bg) {
      const v = p.v, fx = p.fx;
      let cx = v & 31; const cy = (v >> 5) & 31, nty = (v >> 11) & 1, fy = (v >> 12) & 7;
      let ntx = (v >> 10) & 1;
      const patbase = (ctrl & 0x10) ? 0x1000 : 0, mv = p.mirrorV;
      for (let x = 0; x < 264; x += 8) {
        const phys = (mv ? ntx : nty) * 0x400;
        const tile = vram[phys + ((cy << 5) | cx)];
        const at = vram[phys + 0x3C0 + ((cy >> 2) << 3) + (cx >> 2)];
        const pa = (at >> (((cy & 2) << 1) | (cx & 2))) & 3;
        const ca = patbase + tile * 16 + fy;
        const base = cb[(ca >> 10) & 7] + (ca & 0x3FF);
        const lo = chr[base], hi = chr[base + 8];
        for (let b = 0; b < 8; b++) {
          const px = x + b - fx;
          if (px >= 0 && px < 256) {
            const c = ((lo >> (7 - b)) & 1) | (((hi >> (7 - b)) & 1) << 1);
            if (c) { bgz[px] = 1; row[px] = pal[pa * 4 + c]; }
          }
        }
        cx++; if (cx === 32) { cx = 0; ntx ^= 1; }
      }
      if (!(mask & 2)) for (let i = 0; i < 8; i++) { row[i] = bd; bgz[i] = 0; }
    }
    if (mask & 0x10) {
      const h = (ctrl & 0x20) ? 16 : 8, spb = (ctrl & 8) ? 0x1000 : 0, oam = e.oamView ? e.oamView() : e.ppuOam, sb = this.sprBuf;
      sb.fill(-1);
      let cnt = 0; const picked = [];
      if (this.noFlicker) { // 깜박임 제거: 이 라인에 걸친 항목 전부를 정방향 순서로(뒤집힌 프레임이면 63 -> 0)
        const rv = this.nfRev;
        for (let n = 0; n < 64; n++) { const i = rv ? 63 - n : n, sy = oam[i * 4] + 1; if (y >= sy && y < sy + h) picked.push(i); }
      } else
      for (let i = 0; i < 64; i++) {
        const sy = oam[i * 4] + 1;
        if (y >= sy && y < sy + h) { if (cnt < 8) picked.push(i); cnt++; if (cnt >= 8 && picked.length === 8) break; }
      }
      for (let k = 0; k < picked.length; k++) {
        const i = picked[k], sy = oam[i * 4] + 1, tile = oam[i * 4 + 1], at = oam[i * 4 + 2], sx = oam[i * 4 + 3];
        let yy = y - sy; if (at & 0x80) yy = h - 1 - yy;
        let ca;
        if (h === 16) ca = (tile & 1) * 0x1000 + (tile & 0xFE) * 16 + (yy & 7) + (yy > 7 ? 16 : 0);
        else ca = spb + tile * 16 + yy;
        const base = cb[(ca >> 10) & 7] + (ca & 0x3FF);
        const lo = chr[base], hi = chr[base + 8];
        for (let b = 0; b < 8; b++) {
          const px = sx + b; if (px > 255) break;
          const bb = (at & 0x40) ? 7 - b : b;
          const c = ((lo >> (7 - bb)) & 1) | (((hi >> (7 - bb)) & 1) << 1);
          if (!c) continue;
          if (sb[px] < 0) sb[px] = 0x10 | ((at & 3) << 2) | c | ((at & 0x20) ? 0x100 : 0);
        }
      }
      const lm = (mask & 4) ? 0 : 8;
      for (let px = lm; px < 256; px++) {
        const s = sb[px];
        if (s >= 0 && !((s & 0x100) && bgz[px])) row[px] = pal[s & 0x1F];
      }
    }
    for (let x = 0; x < 256; x++) fb[o + x] = PAL32[row[x] & grey];
  }
}
const api = { Renderer, PAL32 };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
