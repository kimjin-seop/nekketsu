'use strict';
// 스토리 이어하기용 엔진 전체 상태 스냅샷(analysis/21_story_continue_plan.md 1.3·1.4·2.1절). Node·브라우저 공용(압축·해시만 Node 전용).
// 시점: 메인 루프 진입($C178) = engine.onLoop 안에서만 capture() 를 부른다(다른 시점은 JS 호출 스택 위라 복원할 수 없다).
//   onLoop 은 생성 코드 f14_C178 첫 줄 `bud-=6; env.onLoop(...)` 에서 불리므로 bud 에 6 을 되돌려 "JSR 명령 직전" 상태로 만든다(21 문서 3.2절:
//   이 보정을 빼면 RAM 2프레임·소리 대부분이 어긋난다). APU 도 같은 시각(code.cyc - 6)까지 합성한 뒤 상태를 뜬다.
// 결과 객체 = data/rom_derived/states/boot_title.json 과 같은 형식(그대로 new Engine(...)·web/worker.js 의 boot 로 쓸 수 있다).
// 직렬화: [u32 머리말 길이][머리말 JSON(fmt·rom·eng·스칼라·APU)][RAM 2KB][VRAM 2KB][팔레트 32][OAM 256][MMC3 reg 8][WRAM 8KB(0 이 아닐 때만)] → gzip.
//   WRAM 은 원작이 쓰지 않아(21 문서 1.3) 보통 빼고, 복원 때 0 으로 채운다.
// 무효화(1.4): fmt 다르면 불러오기 불가(save_old), rom 다르면 불가(save_rom), eng 다르면 불러오기는 허용하되 engMatch=false 로 알린다(구간 재현은 호출자가 거절).
// 이 모듈은 core.js·gen/code.js·apu.js 를 읽기만 한다(공개 필드·code.st getter/setter·apu.saveState/loadState).

const FMT = 1;
const MAGIC = 0x4E4B5331; // 'NKS1'
const BLOBS = [['ram', 0x800], ['vram', 0x800], ['pal', 32], ['oam', 256], ['reg', 8]];
const SCALARS = ['bsel', 'v', 't', 'fx', 'w', 'rbuf', 'oamaddr', 'mirrorV', 'A', 'X', 'Y', 'S', 'P', 'bud', 'line', 'frameNo', 'nmiP', 'irqLine',
  'ctrl', 'mask', 'stat', 'irqLatch', 'irqCnt', 'irqEn', 'irqReload', 'padsh', 'strobe'];
const ONLOOP_JSR_CYC = 6; // $C178 JSR 사이클(onLoop 직전에 이미 뺀 값)

// RAM 2KB 지문 — web/game.js fnv 와 같은 함수(FNV-1a 32bit, 소문자 16진 8자)
function fnv(a) { let h = 0x811c9dc5; for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, '0'); }
// 화면 키 "모드:단계"(15 문서) — $0641 : $0642 & 0x7F
function screenKey(m) { return m[0x641] + ':' + (m[0x642] & 0x7F); }
// 스토리 여부($0645 0 = 1P 스토리, 1 = 2P 협력 스토리)
function isStory(m) { return m[0x645] === 0 || m[0x645] === 1; }

// 저장 지점 판정(21 문서 2.1절, 권고안): 스토리에서 (가) 대진표 9:4 로 들어온 첫 루프, (나) 시합 18 뒤 대기실 10:1 로 들어온 첫 루프(대회 종료).
//  prevKey = 바로 앞 루프의 화면 키(없으면 null → 들어온 것으로 본다). 돌려주는 값: null | 'bracket' | 'done'
function checkpointKind(m, prevKey) {
  if (!isStory(m)) return null;
  const k = screenKey(m); if (k === prevKey) return null;
  if (k === '9:4') return 'bracket';
  if (k === '10:1' && m[0x644] >= 18) return 'done';
  return null;
}
// 슬롯 메타(21 문서 5.2절 열). 모두 RAM 에서 뽑는다(클라이언트 값 불신)
function metaOf(m) {
  return { players: m[0x645] === 1 ? 2 : 1, match: m[0x644], wins: m[0x65A], losses: m[0x664], rule: m[0x647], level: m[0x5B2],
    nameKana: Array.from(m.subarray ? m.subarray(0x5AD, 0x5B2) : m.slice(0x5AD, 0x5B2)) };
}

// 엔진 → 상태 객체(boot_title 형식). onLoop 안에서만 부를 것. APU 가 붙어 있어야 한다(소리 상태까지 같아야 이어서 비트 동일).
//  주의: 엔진의 APU 를 code.cyc - 6 까지 진행시킨다(합성은 누적 사이클 기준이라 끊지 않은 진행 결과에는 영향 없음).
function capture(e) {
  if (!e || !e.code) throw new Error('snapshot: 엔진 없음');
  if (!e.apu) throw new Error('snapshot: APU 가 붙지 않은 엔진(attachApu 필요)');
  const st = e.code.st; // getter = 사본
  st.bud += ONLOOP_JSR_CYC;
  e.apu.runTo(e.code.cyc - ONLOOP_JSR_CYC);
  const p = e.ppu;
  const s = { ram: Array.from(e.m), wram: Array.from(e.wram), vram: Array.from(e.vram), pal: Array.from(e.pal), oam: Array.from(e.ppuOam), reg: Array.from(e.reg),
    apu: e.apu.saveState(), bsel: e.bsel, v: p.v, t: p.t, fx: p.fx, w: p.w, rbuf: p.rbuf, oamaddr: p.oamaddr, mirrorV: p.mirrorV,
    padsh: e.padsh.slice(), strobe: e.strobe };
  for (const k of ['A', 'X', 'Y', 'S', 'P', 'bud', 'line', 'frameNo', 'nmiP', 'irqLine', 'ctrl', 'mask', 'stat', 'irqLatch', 'irqCnt', 'irqEn', 'irqReload']) s[k] = st[k];
  return s;
}

// 상태 객체 → 엔진 init(new Engine 인자). rom = .nes 파일 바이트(Uint8Array)
function romParts(rom) {
  const np = rom[4] * 16384, prg = rom.subarray(16, 16 + np), chr = rom.subarray(16 + np, 16 + np + rom[5] * 8192);
  return { prg, chr };
}
function toInit(s, rom) {
  const { prg, chr } = romParts(rom);
  return Object.assign({}, s, { prg, chr, ram: Uint8Array.from(s.ram), wram: s.wram ? Uint8Array.from(s.wram) : new Uint8Array(0x2000),
    vram: Uint8Array.from(s.vram), pal: Uint8Array.from(s.pal), oam: Uint8Array.from(s.oam), reg: Uint8Array.from(s.reg) });
}
// 상태 객체 → 엔진(APU 연결 포함). opt: { Engine, Apu, Renderer?, sampleRate=44100, audio=false }
//  Node 에서는 Engine·Apu 를 생략하면 같은 폴더의 core.js·apu.js 를 쓴다.
function restore(s, rom, opt) {
  opt = opt || {};
  const Engine = opt.Engine || require('./core.js').Engine, Apu = opt.Apu || require('./apu.js').Apu;
  const e = new Engine(toInit(s, rom));
  if (opt.Renderer) e.renderer = new opt.Renderer();
  const { prg } = romParts(rom);
  e.attachApu(new Apu(prg, opt.sampleRate || 44100), s.apu); e.apu.enabled = !!opt.audio;
  return e;
}

// ---- 직렬화(Node 전용: zlib·crypto) ----
function nodeReq(n) { if (typeof require !== 'function') throw new Error('snapshot: ' + n + ' 는 Node 전용'); return require(n); }
function sha1(buf) { return nodeReq('crypto').createHash('sha1').update(buf).digest('hex'); }
function romHash(rom) { return sha1(Buffer.from(rom.buffer, rom.byteOffset, rom.byteLength)); }
// eng = SHA-1(core.js + gen/code.js + apu.js) 바이트 이어 붙임(21 문서 1.4)
function engineHash(dir) {
  const fs = nodeReq('fs'), path = nodeReq('path'); dir = dir || __dirname;
  return sha1(Buffer.concat(['core.js', 'gen/code.js', 'apu.js'].map(f => fs.readFileSync(path.join(dir, f)))));
}
function encode(s, ids) {
  if (!ids || !ids.rom || !ids.eng) throw new Error('snapshot: rom·eng 해시 필요');
  const wramUsed = !!(s.wram && s.wram.some(x => x));
  const head = { fmt: FMT, rom: ids.rom, eng: ids.eng, apu: s.apu, wram: wramUsed };
  for (const k of SCALARS) head[k] = s[k];
  const hb = Buffer.from(JSON.stringify(head), 'utf8');
  const parts = [Buffer.alloc(8), hb];
  parts[0].writeUInt32BE(MAGIC, 0); parts[0].writeUInt32BE(hb.length, 4);
  for (const [k, n] of BLOBS) { if (!s[k] || s[k].length !== n) throw new Error('snapshot: ' + k + ' 길이 ' + (s[k] && s[k].length)); parts.push(Buffer.from(s[k])); }
  if (wramUsed) parts.push(Buffer.from(s.wram));
  return nodeReq('zlib').gzipSync(Buffer.concat(parts), { level: 9 });
}
// gzip 버퍼 → { state(boot_title 형식, wram 포함), fmt, rom, eng, engMatch }. ids = { rom, eng }(현재 서버 값). 형식 오류는 code 붙은 Error
function decode(gz, ids, maxBytes) {
  const err = (code, msg) => Object.assign(new Error(msg), { code });
  let b; try { b = nodeReq('zlib').gunzipSync(gz, { maxOutputLength: maxBytes || 64 * 1024 }); } catch (x) { throw err('save_bad', 'snapshot: 압축 해제 실패'); }
  if (b.length < 8 || b.readUInt32BE(0) !== MAGIC) throw err('save_bad', 'snapshot: 머리 표식 없음');
  const hl = b.readUInt32BE(4); if (8 + hl > b.length) throw err('save_bad', 'snapshot: 머리말 길이');
  let head; try { head = JSON.parse(b.subarray(8, 8 + hl).toString('utf8')); } catch (x) { throw err('save_bad', 'snapshot: 머리말 JSON'); }
  if (head.fmt !== FMT) throw err('save_old', 'snapshot: 형식 버전 ' + head.fmt + ' ≠ ' + FMT);
  if (ids && ids.rom && head.rom !== ids.rom) throw err('save_rom', 'snapshot: ROM 해시 불일치');
  let o = 8 + hl; const s = {};
  for (const [k, n] of BLOBS) { if (o + n > b.length) throw err('save_bad', 'snapshot: ' + k + ' 잘림'); s[k] = Array.from(b.subarray(o, o + n)); o += n; }
  if (head.wram) { if (o + 0x2000 > b.length) throw err('save_bad', 'snapshot: wram 잘림'); s.wram = Array.from(b.subarray(o, o + 0x2000)); o += 0x2000; }
  else s.wram = new Array(0x2000).fill(0);
  if (o !== b.length) throw err('save_bad', 'snapshot: 남는 바이트');
  for (const k of SCALARS) { if (!(k in head)) throw err('save_bad', 'snapshot: ' + k + ' 없음'); s[k] = head[k]; }
  if (!head.apu || !Array.isArray(head.apu.p)) throw err('save_bad', 'snapshot: APU 상태 없음');
  s.apu = head.apu;
  return { state: s, fmt: head.fmt, rom: head.rom, eng: head.eng, engMatch: !ids || !ids.eng || head.eng === ids.eng };
}

const api = { FMT, fnv, screenKey, isStory, checkpointKind, metaOf, capture, toInit, restore, romParts, romHash, engineHash, sha1, encode, decode };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
