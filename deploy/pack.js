'use strict';
// 배포 폴더 생성(로컬 전용 — 업로드·서버 접속 없음). 사용: node deploy/pack.js [출력폴더, 기본 deploy/dist]
// 화이트리스트 방식: 아래 목록에 있는 것만 복사한다(새 파일이 생겨도 자동으로 올라가지 않는다).
// 끝에 검증: 제외 폴더 부재, 시크릿 패턴 grep, 크기·파일 수, MANIFEST.txt(경로·크기·sha256) 생성.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const SRC = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'dist'));
if (OUT === SRC || SRC.startsWith(OUT + path.sep) || OUT.length < 10) { console.error('출력 폴더가 이상합니다(원본 폴더·상위 폴더 불가): ' + OUT); process.exit(2); }

// [원본 상대경로, 구분] 구분: code = 서버·클라이언트 코드, rom = 원작 ROM 또는 ROM 파생물, font = 폰트(OFL), asset = 자체 제작 자산
const ITEMS = [
  ['server_online.js', 'code'], ['package.json', 'code'], ['package-lock.json', 'code'],
  ['server/asset_gate.js', 'code'], ['server/static_compress.js', 'code'], ['server/story_pace.js', 'code'],
  ['server/store', 'code'], ['server/ranking', 'code'], ['server/profile', 'code'],
  ['server/engine/core.js', 'code'], ['server/engine/core_team.js', 'code'], ['server/engine/atk_step.js', 'code'], ['server/engine/guard_as.js', 'code'], ['server/engine/no_winner.js', 'code'], ['server/engine/apu.js', 'code'], ['server/engine/render.js', 'code'],
  ['server/engine/replay_save.js', 'code'], ['server/engine/snapshot.js', 'code'],
  ['server/engine/gen', 'rom'],                       // ROM 직역 생성 코드(원격 제공은 세션 게이트)
  ['node_modules/ws', 'code'],                        // 순수 JS(네이티브 모듈 없음). 서버에서 npm ci --omit=dev 로 대체 가능
  ['web', 'asset'],                                   // 클라이언트(web/ko_table.json = ROM 일본어 원문, web/hd, web/img 안 ROM 파생 그림 포함 — 아래 별도 표기)
  ['art/fonts/galmuri/Galmuri7.ttf', 'font'], ['art/fonts/galmuri/Galmuri14.ttf', 'font'], ['art/fonts/galmuri/Galmuri9.ttf', 'font'], ['art/fonts/galmuri/Galmuri11.ttf', 'font'], ['art/fonts/galmuri/Galmuri11-Bold.ttf', 'font'],
  ['art/fonts/galmuri/LICENSE.txt', 'font'], ['art/fonts/galmuri/ofl.md', 'font'],
  ['art/logo/logo_ko_1x.png', 'asset'],
  ['analysis/rom/nekketsu.nes', 'rom'],               // 원작 ROM 본체(서버 /rom/ 서빙 + 스토리 이어하기 재현 워커가 읽는다)
  ['analysis/ui_rework/characters.json', 'rom'],      // /ui/characters.json
  ['art/ui_manga/portraits_orig/hud', 'rom'], ['art/ui_manga/portraits_orig/body', 'rom'], ['art/ui_manga/portraits_orig/cutin', 'rom'], // 원작 초상
  ['data/rom_derived/states', 'rom'],                 // ROM 실행 파생 시작 상태 JSON
  ['deploy/ecosystem.config.js', 'code'],
];
// analysis/hd_survey/out 에서는 스테이지 프레임만(/ui/stage_<id>.png)
const GLOBS = [['analysis/hd_survey/out', /^stage_\d{1,2}_frame_bg\.png$/, 'rom']];
// 항목이 폴더여도 복사하지 않을 이름(어디에 있든)
const SKIP_NAME = /(^\.env|\.log$|\.pkl$|\.bak$|~$|^Thumbs\.db$|^\.DS_Store$|\.nes\.sav$)/i;

const kind = new Map(); // dist 상대경로 → 구분
let n = 0, bytes = 0;
function copyFile(rel, k) {
  const s = path.join(SRC, rel), d = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d);
  kind.set(rel.replace(/\\/g, '/'), k); n++; bytes += fs.statSync(d).size;
}
function walk(rel, k) {
  const s = path.join(SRC, rel);
  if (!fs.existsSync(s)) throw new Error('원본 없음: ' + rel);
  const st = fs.statSync(s);
  if (st.isFile()) return SKIP_NAME.test(path.basename(rel)) ? 0 : copyFile(rel, k);
  for (const e of fs.readdirSync(s)) if (!SKIP_NAME.test(e)) walk(path.join(rel, e), k);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const [rel, k] of ITEMS) walk(rel, k);
for (const [dir, re, k] of GLOBS) for (const e of fs.readdirSync(path.join(SRC, dir))) if (re.test(e)) copyFile(path.join(dir, e), k);
// web 안 ROM 파생 표기(별도 목록)
for (const r of ['web/ko_table.json', 'web/mid_frames.json', 'web/img/title_bg_A.png', 'web/img/title_bg_A_tile.png']) if (kind.has(r)) kind.set(r, 'rom');
for (const r of kind.keys()) if (/^web\/hd\//.test(r)) kind.set(r, 'rom'); // 스테이지 HD 그림(원작 화면 기반 재작화)
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true }); // 데이터 폴더(빈 채로). DB 는 서버에서 새로 만든다

// ---------- 검증 ----------
const problems = [];
const all = []; (function ls(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? ls(p) : all.push(p); } })(OUT);
const rels = all.map(p => path.relative(OUT, p).replace(/\\/g, '/'));
// 1) 제외 확인
const FORBID = [/^_backup\//, /^_verify\//, /^test\//, /^tools\//, /^docs\//, /^public\//, /^art\/(sprites|sheets|bg|ui)\//, /^analysis\/(?!rom\/nekketsu\.nes$|ui_rework\/characters\.json$|hd_survey\/out\/stage_\d+_frame_bg\.png$)/,
  /^data\/(nekketsu\.db|backup|rom_derived\/(?!states\/))/, /\.(db|db-wal|db-shm|log|pkl)$/, /(^|\/)\.env/, /^server_game\.js$/, /^server\.js$/, /^deploy\/(?!ecosystem\.config\.js$)/];
for (const r of rels) for (const f of FORBID) if (f.test(r)) { problems.push('제외 대상이 들어감: ' + r); break; }
// 2) 시크릿 grep(텍스트 파일만)
const SECRET = [/BEGIN [A-Z ]*PRIVATE KEY/, /AKIA[0-9A-Z]{16}/, /\bsk-[A-Za-z0-9]{20,}/, /ghp_[A-Za-z0-9]{30,}/, /ADMIN_ACCOUNTS\s*[=:]\s*['"]?\S/, /(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"\s]{6,}['"]/i];
const TEXT = /\.(js|json|html|css|md|txt|webmanifest|svg|cjs)$/i; let secHits = 0, scanned = 0;
for (const p of all) { if (!TEXT.test(p) || fs.statSync(p).size > 5e6) continue; scanned++; const t = fs.readFileSync(p, 'utf8');
  for (const re of SECRET) { const m = re.exec(t); if (m) { secHits++; problems.push('시크릿 의심: ' + path.relative(OUT, p) + ' → ' + m[0].slice(0, 60)); } } }
// 3) MANIFEST
const lines = ['# nekketsu 배포 폴더 MANIFEST — ' + new Date().toISOString(), '# 구분\t바이트\tsha256\t경로'];
for (const p of all.slice().sort()) { const r = path.relative(OUT, p).replace(/\\/g, '/'), b = fs.readFileSync(p);
  lines.push((kind.get(r) || '?') + '\t' + b.length + '\t' + crypto.createHash('sha256').update(b).digest('hex') + '\t' + r); }
fs.writeFileSync(path.join(OUT, 'MANIFEST.txt'), lines.join('\n') + '\n');
const sum = {}; for (const r of rels) { const k = kind.get(r) || '?'; sum[k] = sum[k] || { files: 0, bytes: 0 }; sum[k].files++; sum[k].bytes += fs.statSync(path.join(OUT, r)).size; }
console.log('출력: ' + OUT);
console.log('파일 ' + rels.length + '개, 합계 ' + (bytes / 1048576).toFixed(1) + ' MB (복사 ' + n + '개)');
for (const [k, v] of Object.entries(sum)) console.log('  ' + k + ': ' + v.files + '개 ' + (v.bytes / 1048576).toFixed(2) + ' MB');
console.log('시크릿 grep: 텍스트 ' + scanned + '개 검사, 의심 ' + secHits + '건');
console.log(problems.length ? '문제 ' + problems.length + '건:\n  ' + problems.join('\n  ') : '검증 통과(제외 대상 0건, 시크릿 0건)');
process.exit(problems.length ? 1 : 0);
