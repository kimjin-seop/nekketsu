'use strict';
// 승리 글자(「1P WIN!!」「CPU WIN!!」, 무승부 글자) 숨기기(사용자 결정 2026-11-22: 「원작 하단 WINNER 를 깔끔하게 다 없애줘, 엔진 수정 OK」). 표시 전용 옵션 engine.noWinner.
//   기본 켬. 끄거나(false) 환경변수 NK_NO_WINNER=0(Node 한정)이면 이 훅은 아무것도 안 하고 원작과 비트 동일.
// 원작이 글자를 그리는 방식(analysis 없음, 코드 조사): 전투 종료 연출 1:5(f14_C649 $C649)가 개체(object) 슬롯 X($0401+X = 종류 8)를 하나 만들고
//   ($5B+X = 모습 번호 0x87 무승부 / 0x88~0x8B 1P~4P 승 / 0x8C CPU 승 / 0x8D 두 번째 줄, 위치 $6B+X·$0421+X) 스프라이트 합성기(f14_CAF7 $CAF7)가
//   그 모습의 조각(타일 5~8개, 한 줄)을 OAM 섀도($0200)에 쓴다. 글자는 BG 네임테이블이 아니라 스프라이트이고, 승자 슬롯에 따라 x 위치만 다르다(1P 왼쪽 … 4P 오른쪽).
// 구현: OAM DMA($4014) 때 섀도 OAM 에서 그 개체의 조각(타일·y·x 간격이 ROM 의 모습 표와 일치하는 항목)을 찾아, 표시용 사본(eng.dispOam)에서만 y 를 화면 밖(0xFF)으로 옮긴다.
//   CPU RAM(m[])·ppuOam(스냅샷/지문에 들어가는 PPU 쪽 OAM)·소리·타이밍은 전혀 건드리지 않는다. 렌더러(render.js)·워커의 스프라이트 사본이 eng.oamView() 로 이 사본을 읽는다.
//   내부 상태 없음(사본은 매 DMA 때 다시 계산) → 스냅샷·락스텝 결정성에 영향 없음. 팀전 엔진(core_team.js)도 같은 DMA 경로라 그대로 적용된다.
const WIN_TYPE = 8;          // $0401+X 종류: 승리 글자 개체
const BANK_BASE = 4 * 0x2000; // 합성기가 $8000 창에서 읽는 모습 표의 PRG 뱅크(8KB 단위 4번, 원작 고정 데이터)
const FRAME_MIN = 7, FRAME_MAX = 13; // $5B+X & 0x7F: 7 무승부, 8~11 1P~4P 승, 12 CPU 승, 13 두 번째 줄
const HIDE_Y = 0xFF;

function noWinnerEnvDefault() { const e = typeof process !== 'undefined' && process.env && process.env.NK_NO_WINNER; return e !== '0'; }

// ROM 의 모습 표 읽기(엔진마다 한 번): 종류 8 의 모습 f 조각 = [{ t: 타일, x: x 간격, y: y 간격 }]
function partsOf(prg) {
  const rdw = a => prg[BANK_BASE + a - 0x8000] | (prg[BANK_BASE + a - 0x8000 + 1] << 8), ok = a => a >= 0x8000 && a < 0xA000;
  const out = {}, tp = rdw(0x800F + 2 * WIN_TYPE); if (!ok(tp)) return out;
  for (let f = FRAME_MIN; f <= FRAME_MAX; f++) {
    const hp = rdw(tp + 2 * f); if (!ok(hp)) continue;
    const q = BANK_BASE + hp - 0x8000, n = prg[q]; if (!n || n > 16) continue;
    const ptr = i => prg[q + 1 + 2 * i] | (prg[q + 2 + 2 * i] << 8), A = ptr(0), C = ptr(2), D = ptr(3), parts = [];
    if (!ok(A) || !ok(C) || !ok(D)) continue;
    for (let i = 0; i < n; i++) parts.push({ t: prg[BANK_BASE + A - 0x8000 + i] & 0x7F, x: prg[BANK_BASE + C - 0x8000 + i], y: prg[BANK_BASE + D - 0x8000 + i] });
    out[f] = parts;
  }
  return out;
}

// DMA 한 번: 섀도 OAM(m[b..b+255])에서 승리 글자 조각을 찾아 eng.dispOam(= ppuOam 복사본)의 y 를 숨긴다. 찾은 개수를 돌려준다.
function noWinnerDisp(eng, b) {
  const d = eng.dispOam || (eng.dispOam = new Uint8Array(256)); d.set(eng.ppuOam);
  const m = eng.m; if (m[0x641] !== 1) return 0;
  const tbl = eng._nwParts || (eng._nwParts = partsOf(eng.prg)), oa = eng.ppu.oamaddr; let hid = 0;
  const claimed = new Uint8Array(64);
  for (let X = 0; X < 8; X++) {
    if (m[0x401 + X] !== WIN_TYPE) continue;
    const parts = tbl[m[0x5B + X] & 0x7F]; if (!parts) continue;
    const y0 = m[0x421 + X], hit = [];
    for (const p of parts) { // 조각마다: y·타일이 맞는 아직 안 쓴 OAM 항목
      const wy = (y0 + p.y) & 255;
      for (let i = 0; i < 64; i++) {
        if (claimed[i]) continue; const o = b + i * 4;
        if (m[o] === wy && (m[o + 1] & 0x7F) === p.t) { hit.push({ i, base: (m[o + 3] - p.x) & 255 }); break; }
      }
    }
    if (!hit.length) continue;
    const cnt = {}; let best = -1, bn = 0; for (const h of hit) { const n = cnt[h.base] = (cnt[h.base] || 0) + 1; if (n > bn) { bn = n; best = h.base; } }
    if (bn < Math.min(parts.length, 2)) continue; // 우연히 하나만 맞는 경우는 건드리지 않는다
    for (const h of hit) if (h.base === best) { claimed[h.i] = 1; d[(oa + h.i * 4) & 255] = HIDE_Y; hid++; }
  }
  return hid;
}
module.exports = { noWinnerEnvDefault, noWinnerDisp };
