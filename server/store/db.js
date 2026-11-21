'use strict';
// SQLite 얇은 래퍼(계정·랭킹). node:sqlite(Node 22.13 이상은 플래그 없이, 22.5~22.12 는 --experimental-sqlite) 는 이 파일에서만 쓴다.
// 노출: openDb(file) -> { run, get, all, exec, tx, close, file }. SQL 값은 언제나 바인드 파라미터(?)로 넘긴다(문자열 이어 붙이기 금지).
// 스키마: MIGRATIONS 배열(SQL 문자열 또는 db => {} 함수) 순서대로 한 번씩 적용하고 PRAGMA user_version 에 적용한 수를 남긴다(새 변경은 배열 끝에 추가만 한다).
// 파일: 서버가 NK_DB_PATH(또는 createServer({ dbPath }))를 받았을 때만 연다. ':memory:' = 메모리(시험용). 통키 DB 와 별개 파일.
const fs = require('fs'), path = require('path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (e) { /* openDb 에서 알린다 */ }
const SQLITE_MISSING = '이 서버의 계정·랭킹은 Node 내장 SQLite(node:sqlite)가 필요합니다(현재 ' + process.version + '). Node 22.13 이상으로 올리거나 22.5~22.12 는 --experimental-sqlite 로 실행하세요.';
const sqliteAvailable = () => !!(sqlite && sqlite.DatabaseSync);

const MIGRATIONS = [
  // v1: 계정·로그인 토큰·랭킹·메타. 이어하기(story_saves)는 v2
  `CREATE TABLE accounts (
     key TEXT PRIMARY KEY,              -- 비교 키(NFC + 영문 소문자)
     nick TEXT NOT NULL,                -- 표시 이름(가입 때 쓴 그대로)
     pw_hash TEXT NOT NULL,             -- scrypt 64바이트(base64)
     pw_salt TEXT NOT NULL,             -- 랜덤 16바이트(base64)
     created_at INTEGER NOT NULL,
     last_login_at INTEGER
   );
   CREATE TABLE auth_tokens (
     token_hash TEXT PRIMARY KEY,       -- sha256(토큰) hex. 토큰 원문은 저장하지 않는다
     key TEXT NOT NULL REFERENCES accounts(key),
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX auth_tokens_key ON auth_tokens(key);
   CREATE TABLE ratings (
     key TEXT PRIMARY KEY, nick TEXT NOT NULL,
     rating INTEGER NOT NULL, w INTEGER NOT NULL, l INTEGER NOT NULL, games INTEGER NOT NULL,
     season INTEGER NOT NULL DEFAULT 1, lock_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
   );
   CREATE INDEX ratings_board ON ratings(season, games, rating);
   CREATE TABLE rank_games (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     match_id TEXT NOT NULL, a_key TEXT NOT NULL, b_key TEXT NOT NULL,
     winner_key TEXT NOT NULL, forfeit_key TEXT, counted INTEGER NOT NULL, at INTEGER NOT NULL
   );
   CREATE INDEX rank_games_a ON rank_games(a_key, at);
   CREATE INDEX rank_games_b ON rank_games(b_key, at);
   CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`,
  // v2: 스토리 이어하기 슬롯(analysis/21 13절). 계정당 슬롯 0~2. snap = 서버 재현으로 만든 스냅샷(snapshot.encode gzip). 클라이언트 값은 name_ko(표시용)만
  //   rank_games 추가 열(why·dispute_a·dispute_b)은 여기로 옮기지 않는다(운영 DB 에 RankingStore 가 이미 더해 둠 → 무조건 ADD COLUMN 이면 실패, analysis/22 8절 6번)
  `CREATE TABLE story_saves (
     key TEXT NOT NULL REFERENCES accounts(key),
     slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 2),
     fmt INTEGER NOT NULL, rom TEXT NOT NULL, eng TEXT NOT NULL,   -- 무효화 키(21 문서 1.4)
     snap BLOB NOT NULL, snap_hash TEXT NOT NULL, frame INTEGER NOT NULL, kind TEXT NOT NULL, -- 스냅샷(gzip)·SHA-1·그 엔진 절대 프레임·'bracket'|'done'
     seq INTEGER NOT NULL, players INTEGER NOT NULL, match INTEGER NOT NULL, wins INTEGER NOT NULL, losses INTEGER NOT NULL,
     rule INTEGER NOT NULL, level INTEGER NOT NULL, name_kana TEXT NOT NULL, name_ko TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     PRIMARY KEY (key, slot)
   );`,
  // v3(2026-11-21): 래더 시즌·티어(analysis/22 10절). 함수 항목 = 열이 없을 때만 더한다(운영 DB 는 RankingStore 가 rank_games 의 why·dispute_a·dispute_b 를 이미 더해 둠, 8절 6번).
  //   ratings = 지금 시즌 줄(기본키 key 그대로, season 열 = 그 줄의 시즌). 시즌 넘김 때 지난 시즌 줄은 ratings_archive 로 복사한 뒤 압축·초기화한다.
  //   기존 줄(종전 랭크 방 전적)은 시즌 1 그대로 이어 쓴다(초기화 없음). last_game_at 은 updated_at 으로 채운다.
  db => {
    const cols = t => new Set(db.all('PRAGMA table_info(' + t + ')').map(c => c.name));
    const add = (t, c, ty) => { if (!cols(t).has(c)) db.exec('ALTER TABLE ' + t + ' ADD COLUMN ' + c + ' ' + ty); };
    add('rank_games', 'why', 'TEXT'); add('rank_games', 'dispute_a', 'INTEGER NOT NULL DEFAULT 0'); add('rank_games', 'dispute_b', 'INTEGER NOT NULL DEFAULT 0');
    add('rank_games', 'season', 'INTEGER NOT NULL DEFAULT 0'); add('rank_games', 'ladder', 'INTEGER NOT NULL DEFAULT 0');
    add('ratings', 'tier', 'TEXT'); add('ratings', 'last_game_at', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`UPDATE ratings SET last_game_at = updated_at WHERE last_game_at = 0 AND games > 0;
      CREATE TABLE IF NOT EXISTS ladder_seasons (season INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, closed_at INTEGER, final TEXT);
      CREATE TABLE IF NOT EXISTS ratings_archive (season INTEGER NOT NULL, key TEXT NOT NULL, nick TEXT NOT NULL, rating INTEGER NOT NULL, w INTEGER NOT NULL, l INTEGER NOT NULL,
        games INTEGER NOT NULL, tier TEXT, last_game_at INTEGER NOT NULL, PRIMARY KEY (season, key));`);
  },
  // v4(2026-11-21): 비경제 보상·프로필(analysis/27 P1). 새 표만 추가(기존 표 열·데이터 무변경). 통산 승·연승은 별도 집계 없이 rank_games 에서 계산.
  //   account_profile = 장착(칭호·프레임·초상 배경·스탬프, NULL = 기본), unlocks = 획득(src server = 서버 판정, self = 클라이언트 보고 tutorial_done 만),
  //   login_days = 로그인 일자(한국 시각 YYYYMMDD), challenge_claims = 일일·주간 도전 수령(화면은 P4b, 표만 먼저), story_clears = 스토리 우승 영구 기록(snap_hash = 저장 지점 = 같은 우승 중복 방지)
  `CREATE TABLE IF NOT EXISTS account_profile (
     key TEXT PRIMARY KEY, title_id TEXT, frame_id TEXT, portrait_bg TEXT, portrait_stamp TEXT, updated_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS unlocks (
     key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('title', 'frame', 'bg', 'stamp')), item_id TEXT NOT NULL,
     at INTEGER NOT NULL, src TEXT NOT NULL DEFAULT 'server' CHECK (src IN ('server', 'self')),
     PRIMARY KEY (key, kind, item_id)
   );
   CREATE TABLE IF NOT EXISTS login_days (
     key TEXT NOT NULL, day INTEGER NOT NULL, PRIMARY KEY (key, day)
   );
   CREATE TABLE IF NOT EXISTS challenge_claims (
     key TEXT NOT NULL, period TEXT NOT NULL, slot INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (key, period, slot)
   );
   CREATE TABLE IF NOT EXISTS story_clears (
     key TEXT NOT NULL, snap_hash TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (key, snap_hash)
   );`,
  // v5(2026-11-21): 프로필 닉네임 조회(통산 집계)용 ratings_archive(key) 인덱스. 추가형(IF NOT EXISTS, 기존 데이터 무변경). v4 는 이미 적용된 DB 가 있어 고치지 않는다.
  `CREATE INDEX IF NOT EXISTS idx_ratings_archive_key ON ratings_archive (key);`,
];

function openDb(file) {
  if (!sqliteAvailable()) throw new Error(SQLITE_MISSING);
  if (typeof file !== 'string' || !file) throw new Error('DB 경로가 없습니다');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  const raw = new sqlite.DatabaseSync(file);
  if (file !== ':memory:') {
    raw.exec('PRAGMA journal_mode = WAL');
    if (process.platform !== 'win32') for (const f of [file, file + '-wal', file + '-shm']) { try { if (fs.existsSync(f)) fs.chmodSync(f, 0o600); } catch (e) { /* 경고 없이 계속 */ } }
  }
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000; PRAGMA synchronous = NORMAL');
  const cache = new Map();
  const st = sql => { let s = cache.get(sql); if (!s) { s = raw.prepare(sql); cache.set(sql, s); } return s; };
  let depth = 0;
  const db = {
    file,
    run: (sql, ...p) => st(sql).run(...p),
    get: (sql, ...p) => st(sql).get(...p) || null,
    all: (sql, ...p) => st(sql).all(...p),
    exec: sql => raw.exec(sql),
    tx(fn) { // 트랜잭션(중첩 호출은 바깥에 합류)
      if (depth > 0) return fn();
      raw.exec('BEGIN IMMEDIATE'); depth++;
      try { const r = fn(); raw.exec('COMMIT'); return r; } catch (e) { try { raw.exec('ROLLBACK'); } catch (e2) { /* 무시 */ } throw e; } finally { depth--; }
    },
    close() { cache.clear(); try { raw.close(); } catch (e) { /* 무시 */ } },
  };
  if (file !== ':memory:') backupBeforeMigrate(db, file);
  migrate(db);
  return db;
}
// 기존 파일 DB(user_version >= 1)에 새 마이그레이션을 적용하기 전, 같은 폴더 backup/ 에 일관된 사본(VACUUM INTO)을 남긴다(되돌리기용, analysis/22 10.6절).
//   NK_DB_BACKUP_DIR 로 폴더를 바꿀 수 있다. 사본을 못 만들면 마이그레이션 없이 시작을 멈춘다(사본 없는 스키마 변경 방지)
function backupBeforeMigrate(db, file) {
  const v = userVersion(db); if (v < 1 || v >= MIGRATIONS.length) return;
  const dir = process.env.NK_DB_BACKUP_DIR || path.join(path.dirname(path.resolve(file)), 'backup');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (e) { /* Windows 등 실패해도 계속 */ }
  const out = path.join(dir, path.basename(file, path.extname(file)) + '_v' + v + '_before_v' + MIGRATIONS.length + '_' + new Date().toISOString().replace(/[:.]/g, '-') + '.db');
  try { db.exec("VACUUM INTO '" + out.replace(/'/g, "''") + "'"); } catch (e) { db.close(); throw new Error('마이그레이션 전 DB 사본을 만들지 못했습니다(' + out + '): ' + e.message); }
  try { fs.chmodSync(out, 0o600); } catch (e) { /* Windows 등 실패해도 계속(사본은 이미 있음) */ }
  console.log('DB 마이그레이션 전 사본: ' + out);
}

const userVersion = db => db.get('PRAGMA user_version').user_version | 0;
function migrate(db) {
  for (let v = userVersion(db) + 1; v <= MIGRATIONS.length; v++) db.tx(() => { const m = MIGRATIONS[v - 1]; if (typeof m === 'function') m(db); else db.exec(m); db.exec('PRAGMA user_version = ' + v); }); // 함수 항목 = 조건부 변경(v3)
}

module.exports = { openDb, MIGRATIONS, userVersion, sqliteAvailable, SQLITE_MISSING };
