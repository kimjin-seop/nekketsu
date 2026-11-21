'use strict';
// 계정(이름 + 비밀번호)과 로그인 토큰. 저장은 db.js 래퍼만 쓴다. 참조: 통키 server/store/accounts.js(같은 규칙을 CommonJS 로 옮김).
// 비밀번호: crypto.scrypt(비동기) + 계정별 랜덤 솔트 16바이트, 비교는 timingSafeEqual. 평문·해시·토큰은 로그에 남기지 않는다.
// 로그인 토큰: 랜덤 32바이트(base64url, 30일). DB 에는 sha256 해시만 저장한다.
const crypto = require('crypto');

const PW_MIN = 6, PW_MAX = 64, TOKEN_TTL_MS = 30 * 24 * 3600 * 1000, KEYLEN = 64, SCRYPT = { N: 16384, r: 8, p: 1 };
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, KEYLEN, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

/** 비밀번호 형식: 문자열, 6~64자(코드 포인트 기준) */
const passwordOk = pw => typeof pw === 'string' && [...pw].length >= PW_MIN && [...pw].length <= PW_MAX;
async function hashPassword(pw, saltB64) {
  saltB64 = saltB64 || crypto.randomBytes(16).toString('base64');
  const k = await scrypt(pw.normalize('NFC'), Buffer.from(saltB64, 'base64'));
  return { hash: k.toString('base64'), salt: saltB64 };
}
async function checkPassword(pw, hashB64, saltB64) {
  const k = await scrypt(pw.normalize('NFC'), Buffer.from(saltB64, 'base64')), want = Buffer.from(hashB64, 'base64');
  return want.length === k.length && crypto.timingSafeEqual(k, want);
}
const DUMMY = { hash: crypto.randomBytes(KEYLEN).toString('base64'), salt: crypto.randomBytes(16).toString('base64') };

class AccountStore {
  constructor(db, o) { this.db = db; this.tokenTtlMs = (o && o.tokenTtlMs) || TOKEN_TTL_MS; }
  has(key) { return !!this.db.get('SELECT 1 AS x FROM accounts WHERE key = ?', key); }
  /** 가입. 이미 있으면 null. 해시 계산 중 같은 키 동시 가입은 PRIMARY KEY 로 하나만 성공 */
  async create(key, nick, pw) {
    if (this.has(key)) return null;
    const h = await hashPassword(pw);
    const r = this.db.run('INSERT OR IGNORE INTO accounts (key, nick, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?)', key, nick, h.hash, h.salt, Date.now());
    return r.changes ? { key, nick } : null;
  }
  /** 로그인 확인. 없는 이름도 같은 비용의 해시를 계산한다(존재 여부를 시간으로 드러내지 않게) */
  async verify(key, pw) {
    const row = this.db.get('SELECT key, nick, pw_hash, pw_salt FROM accounts WHERE key = ?', key);
    const ok = await checkPassword(pw, row ? row.pw_hash : DUMMY.hash, row ? row.pw_salt : DUMMY.salt);
    if (!row || !ok) return null;
    this.db.run('UPDATE accounts SET last_login_at = ? WHERE key = ?', Date.now(), key);
    return { key: row.key, nick: row.nick };
  }
  /** 로그인 토큰 발급(원문 반환, DB 에는 해시만). 그 계정의 만료 토큰은 이때 정리 */
  issueToken(key) {
    const token = crypto.randomBytes(32).toString('base64url'), now = Date.now();
    this.db.tx(() => {
      this.db.run('DELETE FROM auth_tokens WHERE key = ? AND expires_at <= ?', key, now);
      this.db.run('INSERT INTO auth_tokens (token_hash, key, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(token), key, now, now + this.tokenTtlMs);
    });
    return token;
  }
  /** 토큰 -> 계정(만료·없음 null) */
  tokenAccount(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const r = this.db.get('SELECT a.key, a.nick, t.expires_at FROM auth_tokens t JOIN accounts a ON a.key = t.key WHERE t.token_hash = ?', sha256(token));
    if (!r || r.expires_at <= Date.now()) return null;
    return { key: r.key, nick: r.nick };
  }
  revokeToken(token) { if (typeof token === 'string') this.db.run('DELETE FROM auth_tokens WHERE token_hash = ?', sha256(token)); }
}

/**
 * 로그인 실패 제한(메모리, windowMs 안의 실패 수). 통키 규칙에서 IP 단독 기준만 올렸다(20 -> 60, analysis/22 2절).
 * - 잠금(lockMs 동안 맞는 비밀번호도 거절): (이름, IP) 쌍 failNick 회(먼저 걸리는 잠금), IP 단독 failIp 회(같은 IP·공유기 뒤 여러 사람이 한꺼번에 막히는 일을 줄이려 높게 둔다).
 * - 이름 단독(여러 IP 합계)은 잠그지 않고 failNick 회째 실패부터 다음 시도마다 slowStepMs 씩 늦춘다(최대 slowMaxMs).
 * 성공하면 그 이름 단독 기록과 그 (이름, IP) 쌍 기록을 지운다(IP 기록은 유지).
 */
class LoginGuard {
  constructor(o) {
    o = o || {};
    this.failNick = o.failNick || 5; this.failIp = o.failIp || 60; this.windowMs = o.windowMs || 15 * 60000; this.lockMs = o.lockMs || 15 * 60000;
    this.slowStepMs = o.slowStepMs !== undefined ? o.slowStepMs : 1000; this.slowMaxMs = o.slowMaxMs !== undefined ? o.slowMaxMs : 10000; this.now = o.now || Date.now;
    this.pair = new Map(); this.nick = new Map(); this.ip = new Map();
  }
  _rec(map, k) {
    const t = this.now(); let r = map.get(k);
    if (!r || (t - r.start >= this.windowMs && r.until <= t)) { r = { start: t, count: 0, until: 0 }; map.set(k, r); }
    if (map.size > 10000) for (const [kk, v] of map) if (t - v.start >= this.windowMs && v.until <= t) map.delete(kk);
    return r;
  }
  _live(map, k) { const r = map.get(k); return r && this.now() - r.start < this.windowMs ? r : null; }
  locked(key, ip) {
    const t = this.now(), p = this.pair.get(key + '\n' + (ip || '')), q = ip ? this.ip.get(ip) : null;
    return (p ? p.until : 0) > t || (q ? q.until : 0) > t;
  }
  delayMs(key) { const r = this._live(this.nick, key), n = r ? r.count : 0; return n < this.failNick ? 0 : Math.min(this.slowStepMs * (n - this.failNick + 1), this.slowMaxMs); }
  fail(key, ip) {
    const t = this.now(), p = this._rec(this.pair, key + '\n' + (ip || ''));
    if (++p.count >= this.failNick) p.until = t + this.lockMs;
    this._rec(this.nick, key).count++;
    if (ip) { const r = this._rec(this.ip, ip); if (++r.count >= this.failIp) r.until = t + this.lockMs; }
  }
  success(key, ip) { this.nick.delete(key); this.pair.delete(key + '\n' + (ip || '')); }
}

module.exports = { AccountStore, LoginGuard, passwordOk, hashPassword, checkPassword, PW_MIN, PW_MAX, TOKEN_TTL_MS };
