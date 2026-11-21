'use strict';
// 스토리 저장 구간 서버 재현(analysis/21_story_continue_plan.md 5.4·5.5절) — 1단계 골격. 아직 server_online.js 에 연결하지 않는다(2단계).
// 클라이언트는 스냅샷·승패를 보내지 않는다. 직전 저장 상태(base)와 그 뒤 프레임별 패드 입력만 받아, 서버가 같은 엔진으로 재현해
//  (1) 클라이언트가 본 끝 프레임 RAM 지문(FNV, web/game.js fnv)과 대조하고 (2) 구간 안 마지막 저장 지점($C178 진입, snapshot.checkpointKind)의
//  스냅샷·메타(시합·승패·레벨·이름)를 스스로 만든다.
//
// 프레임 번호는 모두 엔진 절대 프레임(= 워커 프레임 메시지 d.frame, code.frameNo):
//   from  = base 상태의 frameNo(스냅샷이 잡힌 프레임. 그 프레임의 남은 부분부터 재현)
//   pads[i] = 절대 프레임 from + i 동안의 1P 패드(그 프레임의 모든 스트로브가 같은 값을 읽는다 = 21 문서 5.3 기록 모드 규약). pads2 = 2P(협력 스토리), 없으면 0
//   end.f = 절대 프레임 번호. 엔진이 프레임 end.f 로 넘어가는 경계(onFrameEnd, frameNo === end.f)의 RAM 2KB 지문이 end.h 여야 한다.
//           = 워커가 프레임 end.f 메시지로 보내는 RAM(d.ram). 그래서 pads.length === end.f - from (from ~ end.f-1 프레임 입력).
//   클라이언트가 같은 워커에서 이어 갈 때도, 저장 스냅샷으로 워커를 새로 만들었을 때도 같은 규칙이다
//   (새 워커는 첫 2프레임 패드를 0 으로 두므로 클라이언트 기록에도 0 이 들어간다).
// 결과 코드(22 문서 err 방식): save_bad(형식) · save_build(eng 불일치) · save_too_long(상한) · save_desync(지문 불일치·엔진 예외·끝 미도달) · replay_timeout(스레드 시간 초과)
// 사용: const R = require('./replay_save.js'); await R.runInWorker({ base:{ gz } | { boot:true }, from, pads, pads2?, end:{ f, h } })
//       (동기 함수 replaySegment 는 같은 인자로 현재 스레드에서 돈다 — 시험·도구용. 서버 이벤트 루프에서는 runInWorker 만 쓸 것)
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const SN = require('./snapshot.js');

const REC = 1;                    // 입력 기록 규약 버전(21 문서 1.4 rec)
const MAX_FRAMES = 72000;         // 구간 상한(20분, 21 문서 5.4)
const R = path.join(__dirname, '..', '..');
const ROM_PATH = path.join(R, 'analysis', 'rom', 'nekketsu.nes');
const BOOT_PATH = path.join(R, 'data', 'rom_derived', 'states', 'boot_title.json');
const STOP = { stop: true };

let romCache = null, idsCache = null, bootCache = null;
function rom() { if (!romCache) romCache = new Uint8Array(fs.readFileSync(ROM_PATH)); return romCache; }
function ids() { if (!idsCache) idsCache = { rom: SN.romHash(rom()), eng: SN.engineHash(), rec: REC }; return idsCache; }
function bootState() { if (!bootCache) bootCache = JSON.parse(fs.readFileSync(BOOT_PATH, 'utf8')); return bootCache; }
const fail = (code, why, extra) => Object.assign({ ok: false, code, why }, extra || {});

// rec 1 전송 형식: (값 u8, 길이 LEB128) 런 → gzip → base64. 사람 입력 한 경기 구간 1~2KB [추정]
function encodePads(p) {
  const out = []; let i = 0;
  while (i < p.length) { const v = p[i] & 255; let j = i + 1; while (j < p.length && (p[j] & 255) === v) j++; out.push(v); let n = j - i; do { let b = n & 127; n >>>= 7; if (n) b |= 128; out.push(b); } while (n); i = j; }
  return zlib.gzipSync(Buffer.from(out)).toString('base64');
}
function decodePads(b64, maxFrames) {
  maxFrames = maxFrames || MAX_FRAMES;
  if (typeof b64 !== 'string' || b64.length > 4 * maxFrames) throw Object.assign(new Error('pads 형식'), { code: 'save_bad' });
  let raw; try { raw = zlib.gunzipSync(Buffer.from(b64, 'base64'), { maxOutputLength: 6 * maxFrames + 64 }); } catch (x) { throw Object.assign(new Error('pads 압축'), { code: 'save_bad' }); }
  const out = []; let i = 0;
  while (i < raw.length) {
    const v = raw[i++]; let n = 0, sh = 0, b;
    do { if (i >= raw.length || sh > 21) throw Object.assign(new Error('pads 런'), { code: 'save_bad' }); b = raw[i++]; n |= (b & 127) << sh; sh += 7; } while (b & 128);
    if (n < 1 || out.length + n > maxFrames) throw Object.assign(new Error('pads 길이'), { code: n < 1 ? 'save_bad' : 'save_too_long' });
    for (let k = 0; k < n; k++) out.push(v);
  }
  return Uint8Array.from(out);
}
const asPads = p => (p instanceof Uint8Array ? p : Array.isArray(p) && p.every(x => Number.isInteger(x) && x >= 0 && x <= 255) ? Uint8Array.from(p) : null);

// 동기 재현. job = { base:{ gz:Uint8Array } | { boot:true }, from, pads, pads2?, end:{ f, h }, eng?, rec?, maxFrames? }
function replaySegment(job) {
  const t0 = Date.now(), I = ids();
  if (!job || typeof job !== 'object' || !job.base || !job.end) return fail('save_bad', 'job');
  if (job.eng !== undefined && job.eng !== I.eng) return fail('save_build', 'eng');
  if (job.rec !== undefined && job.rec !== REC) return fail('save_build', 'rec');
  const maxFrames = Math.min(job.maxFrames || MAX_FRAMES, MAX_FRAMES);
  const pads = asPads(job.pads), pads2 = job.pads2 == null ? null : asPads(job.pads2);
  if (!pads || (job.pads2 != null && !pads2)) return fail('save_bad', 'pads');
  if (pads.length > maxFrames) return fail('save_too_long', 'frames ' + pads.length);
  if (pads2 && pads2.length !== pads.length) return fail('save_bad', 'pads2 길이');
  let st;
  if (job.base.boot === true) st = bootState();
  else {
    if (!(job.base.gz instanceof Uint8Array)) return fail('save_bad', 'base');
    let d; try { d = SN.decode(Buffer.from(job.base.gz.buffer, job.base.gz.byteOffset, job.base.gz.byteLength), I); } catch (x) { return fail(x.code || 'save_bad', x.message); }
    if (!d.engMatch) return fail('save_build', 'base eng'); // 재현 결과는 엔진 코드에 달려 있다(21 문서 1.4)
    st = d.state;
  }
  const F0 = st.frameNo, endF = job.end.f, endH = job.end.h;
  if (job.from !== F0) return fail('save_bad', 'from ' + job.from + ' ≠ base ' + F0);
  if (!Number.isInteger(endF) || endF - F0 !== pads.length || pads.length < 2) return fail('save_bad', 'end.f');
  if (typeof endH !== 'string' || !/^[0-9a-f]{8}$/.test(endH)) return fail('save_bad', 'end.h');

  const e = SN.restore(st, rom(), { audio: false });
  e.getPad = (f, port) => { const i = f - F0; if (i < 0 || i >= pads.length) return 0; return port === 0 ? pads[i] : port === 1 && pads2 ? pads2[i] : 0; };
  let prevKey = null, cp = null, loops = 0, hash = null, endRam = null;
  e.onLoop = en => {
    loops++;
    const kind = SN.checkpointKind(en.m, prevKey); prevKey = SN.screenKey(en.m);
    if (kind) cp = { kind, frame: en.frame, line: en.code.line, state: SN.capture(en), meta: SN.metaOf(en.m) };
  };
  e.onFrameEnd = en => { if (en.frame === endF) { hash = SN.fnv(en.m); endRam = en.m.slice(); throw STOP; } };
  e.padReads = { push() {} }; // 재현은 스트로브 기록이 필요 없다(장시간 구간 메모리 증가 방지, core.js 무수정)
  try { for (;;) e.loop(); }
  catch (x) { if (x !== STOP) return fail('save_desync', 'engine: ' + String(x && x.message || x), { frames: e.frame - F0, ms: Date.now() - t0 }); }
  if (hash !== endH) return fail('save_desync', 'hash', { frames: pads.length, ms: Date.now() - t0 });
  const res = { ok: true, hash, frames: pads.length, loops, ms: Date.now() - t0, story: SN.isStory(endRam), last: SN.metaOf(endRam), checkpoint: null, ids: I };
  if (cp) {
    const gz = SN.encode(cp.state, I);
    res.checkpoint = { kind: cp.kind, frame: cp.frame, line: cp.line, meta: cp.meta, done: cp.kind === 'done', gz: new Uint8Array(gz.buffer, gz.byteOffset, gz.byteLength), snapHash: SN.sha1(gz) };
  }
  return res;
}

// worker_threads 로 한 구간 재현(서버 이벤트 루프를 막지 않음). 동시 실행 수·대기열 상한은 호출자(2단계 server_online.js)가 관리한다.
function runInWorker(job, opt) {
  const { Worker } = require('worker_threads');
  const timeoutMs = (opt && opt.timeoutMs) || 60000;
  return new Promise(resolve => {
    let done = false;
    const w = new Worker(__filename, { workerData: { nkReplayJob: job }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    const fin = r => { if (done) return; done = true; clearTimeout(tm); w.terminate().catch(() => {}); resolve(r); };
    const tm = setTimeout(() => fin(fail('replay_timeout', timeoutMs + 'ms')), timeoutMs);
    w.on('message', fin);
    w.on('error', x => fin(fail('save_desync', 'worker: ' + String(x && x.message || x))));
    w.on('exit', c => fin(fail('save_desync', 'worker exit ' + c)));
  });
}

const wt = require('worker_threads');
if (!wt.isMainThread && wt.workerData && wt.workerData.nkReplayJob && wt.parentPort) {
  let r; try { r = replaySegment(wt.workerData.nkReplayJob); } catch (x) { r = fail('save_desync', 'worker: ' + String(x && x.message || x)); }
  wt.parentPort.postMessage(r);
}

module.exports = { REC, MAX_FRAMES, replaySegment, runInWorker, encodePads, decodePads, ids, bootState };
