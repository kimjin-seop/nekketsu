'use strict';
// 랭킹 저장(SQLite, db.js 래퍼). ratings = 계정별 지금 시즌 레이팅·전적·티어·잠금, rank_games = 반영 판정용 판 기록(같은 상대 제한·손님 상한·기권/분쟁 잠금),
//   ladder_seasons = 시즌(28일), ratings_archive = 지난 시즌 줄(analysis/22 10절, 스키마 v3).
// 참조: 통키 server/store/ranking.js(같은 규칙을 CommonJS 로 옮김). 손님 상한·무효 사유·분쟁은 열혈 추가(analysis/22 4절).
const { RANK, DAY, eloAfter, nextTier, seasonReset, masterQuota } = require('../ranking/elo');

const GUEST = 'guest:'; // rank_games 의 손님 키 접두(계정 이름에는 ':' 이 올 수 없다)
const FRESH = (key, nick) => ({ key, nick, rating: RANK.init, w: 0, l: 0, games: 0, lockUntil: 0, tier: null, lastGameAt: 0 });

class RankingStore {
  /** o = { seasonMs?(시험용 시즌 길이), now?() } */
  constructor(db, o) {
    this.db = db; o = o || {};
    this.seasonMs = o.seasonMs || RANK.seasonDays * DAY; this.now = o.now || Date.now;
    this._cur = null; this._masters = null;
    this.rollSeason(this.now());
  }
  // ---------- 시즌 ----------
  /** 지금 시즌 { n, startedAt, endsAt }. 끝난 시즌이 있으면 먼저 넘긴다(서버 기동·주기 검사·판 기록 때) */
  season(now) { now = now || this.now(); if (!this._cur || now >= this._cur.endsAt) this.rollSeason(now); return this._cur; }
  /**
   * 시즌 넘김(서버 시각 기준). 표가 비어 있으면 시즌 1 을 now 부터 연다. 끝난 시즌마다(서버가 꺼져 있던 동안 여러 시즌이면 그 수만큼):
   * 마스터 확정 → final 저장·closed_at → ratings 를 ratings_archive 로 복사 → 레이팅 압축·판수/승/패 0·티어 비움(배치 다시)·season+1, 잠금 유지.
   * 다음 시즌 시작 = 지난 시즌 종료 시각(28일 단위 고정). 한 시즌 넘김 = 트랜잭션 하나. 반환 넘긴 시즌 수
   */
  rollSeason(now) {
    now = now || this.now(); let n = 0;
    for (;;) {
      const done = this.db.tx(() => {
        let cur = this.db.get('SELECT season, started_at, ends_at FROM ladder_seasons WHERE closed_at IS NULL ORDER BY season DESC LIMIT 1');
        if (!cur) {
          const last = this.db.get('SELECT MAX(season) AS s FROM ladder_seasons').s;
          const s = last ? last + 1 : RANK.season, start = last ? this.db.get('SELECT ends_at FROM ladder_seasons WHERE season = ?', last).ends_at : now;
          this.db.run('INSERT INTO ladder_seasons (season, started_at, ends_at) VALUES (?, ?, ?)', s, start, start + this.seasonMs);
          cur = { season: s, started_at: start, ends_at: start + this.seasonMs };
        }
        if (now < cur.ends_at) { this._cur = { n: cur.season, startedAt: cur.started_at, endsAt: cur.ends_at }; return true; }
        const s = cur.season, b = this._boardBase(s, cur.ends_at), masters = this._masterRows(s, cur.ends_at, b.total);
        this.db.run('UPDATE ladder_seasons SET closed_at = ?, final = ? WHERE season = ?', now, JSON.stringify({ players: b.total, masters: masters.map(r => ({ key: r.key, nick: r.nick, rating: r.rating })) }), s);
        this.db.run(`INSERT OR REPLACE INTO ratings_archive (season, key, nick, rating, w, l, games, tier, last_game_at)
          SELECT season, key, nick, rating, w, l, games, tier, last_game_at FROM ratings WHERE season = ?`, s);
        for (const r of this.db.all('SELECT key, rating FROM ratings WHERE season = ?', s)) this.db.run('UPDATE ratings SET rating = ?, w = 0, l = 0, games = 0, tier = NULL, season = ?, updated_at = ? WHERE key = ?', seasonReset(r.rating), s + 1, now, r.key);
        this.db.run('INSERT INTO ladder_seasons (season, started_at, ends_at) VALUES (?, ?, ?)', s + 1, cur.ends_at, cur.ends_at + this.seasonMs);
        return false;
      });
      if (done) break;
      n++; this._masters = null;
    }
    if (n && this.onRoll) { try { this.onRoll(n); } catch (e) { /* 보상 지급 실패가 시즌 넘김을 막지 않는다(settleSeasons 는 멱등이라 다음에 다시 돈다) */ } } // 시즌 종료 일괄 지급(profile.settleSeasons) 연결
    return n;
  }
  // 순위표 대상(배치 완료·비활동 아님) 인원
  _boardBase(s, now) {
    const since = now - RANK.inactiveDays * DAY;
    return { since, total: this.db.get('SELECT COUNT(*) AS n FROM ratings WHERE season = ? AND games >= ? AND last_game_at > ?', s, RANK.boardMinGames, since).n };
  }
  _masterRows(s, now, total) {
    const q = masterQuota(total), M = RANK.master; if (!q) return [];
    return this.db.all(`SELECT key, nick, rating FROM ratings WHERE season = ? AND games >= ? AND last_game_at > ? AND rating >= ?
      ORDER BY rating DESC, w DESC, key ASC LIMIT ?`, s, Math.max(M.minGames, RANK.boardMinGames), now - RANK.inactiveDays * DAY, M.minRating, q);
  }
  /** 지금 마스터 키 집합(실시간 순위 조건, 30초 캐시·판 기록 때 무효화) */
  masters(now) {
    now = now || this.now(); const s = this.season(now).n;
    if (this._masters && this._masters.s === s && now - this._masters.at < 30000) return this._masters;
    const b = this._boardBase(s, now), rows = this._masterRows(s, now, b.total);
    this._masters = { s, at: now, total: b.total, quota: masterQuota(b.total), keys: new Set(rows.map(r => r.key)) };
    return this._masters;
  }
  /** 화면용 요약(좌석·매칭·내 줄 공통). tier = 표시 티어(배치 중 null, 'master' 가능) */
  view(p, now) {
    now = now || this.now();
    const placement = p.games < RANK.boardMinGames, inactive = !placement && p.lastGameAt <= now - RANK.inactiveDays * DAY, master = !placement && !inactive && this.masters(now).keys.has(p.key);
    return { rating: p.rating, w: p.w, l: p.l, games: p.games, placement, placementLeft: placement ? RANK.boardMinGames - p.games : 0, tier: placement ? null : master ? 'master' : (p.tier || null), inactive, master };
  }
  // ---------- 줄 ----------
  get(key, nick) {
    const r = this.db.get('SELECT key, nick, rating, w, l, games, lock_until, tier, last_game_at FROM ratings WHERE key = ? AND season = ?', key, this.season().n);
    if (r) return { key: r.key, nick: r.nick, rating: r.rating, w: r.w, l: r.l, games: r.games, lockUntil: r.lock_until, tier: r.tier, lastGameAt: r.last_game_at };
    const o = this.db.get('SELECT lock_until FROM ratings WHERE key = ?', key); // 다른 시즌 줄(넘김 전 경합 등)이 남아 있으면 잠금만 이어받는다
    return Object.assign(FRESH(key, nick || key), o ? { lockUntil: o.lock_until } : null);
  }
  lockedUntil(key, now) { now = now || this.now(); const u = this.get(key).lockUntil; return u > now ? u : 0; }
  _save(p, now) {
    this.db.run(`INSERT INTO ratings (key, nick, rating, w, l, games, season, lock_until, updated_at, tier, last_game_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET nick = excluded.nick, rating = excluded.rating, w = excluded.w, l = excluded.l, games = excluded.games, season = excluded.season,
        lock_until = excluded.lock_until, updated_at = excluded.updated_at, tier = excluded.tier, last_game_at = excluded.last_game_at`,
    p.key, p.nick, p.rating, p.w, p.l, p.games, this.season(now).n, p.lockUntil, now, p.tier || null, p.lastGameAt || 0);
  }
  /** 같은 두 키가 24시간 안에 반영된 판 수(래더 짝 찾기 미리 보기·PAIR_LIMIT) */
  pairCount(ak, bk, now) {
    now = now || this.now();
    return this.db.get(`SELECT COUNT(*) AS n FROM rank_games WHERE counted = 1 AND at > ?
      AND ((a_key = ? AND b_key = ?) OR (a_key = ? AND b_key = ?))`, now - RANK.pairWindowMs, ak, bk, bk, ak).n;
  }
  // 최근 10판(반영 여부 무관, 기록된 랭크 판) 중 자기 기권 3회 또는 분쟁 상대(계정) 서로 다른 3명 -> 30분 잠금. p = get() 결과(계정만). 잠금이 걸리면 p.lockUntil 을 바꾼다
  //   분쟁은 판 수가 아니라 서로 다른 상대 수로 센다(같은 상대와 몇 번 분쟁이 나도 1회 = 한 사람이 일부러 분쟁을 반복해 정직한 상대를 잠그지 못하게, analysis/22 4절).
  //   손님 상대 분쟁은 세지 않는다(손님은 결과를 안 내는 것만으로 비용 없이 반복할 수 있다. 예전 기록에 dispute 1 이 남아 있어도 상대 키 'guest:' 로 거른다)
  _lock(p, now) {
    const recent = this.db.all('SELECT a_key, b_key, forfeit_key, dispute_a, dispute_b FROM rank_games WHERE a_key = ? OR b_key = ? ORDER BY at DESC, id DESC LIMIT ?', p.key, p.key, RANK.forfeitWindow);
    const ff = recent.filter(r => r.forfeit_key === p.key).length, opp = new Set();
    for (const r of recent) {
      const o = r.a_key === p.key ? (r.dispute_a ? r.b_key : null) : (r.dispute_b ? r.a_key : null);
      if (o && o !== p.key && !o.startsWith(GUEST)) opp.add(o);
    }
    if (ff >= RANK.forfeitMax || opp.size >= RANK.disputeMax) p.lockUntil = Math.max(p.lockUntil || 0, now + RANK.lockMs);
  }
  _keys(players) {
    const acct = players.map(p => p.account !== false);
    return { acct, keys: players.map((p, i) => (acct[i] ? p.key : GUEST + p.key)) };
  }
  /**
   * 랭크 판 1판 기록. players = [{key, nick, account}](자리 0·1), winner = 0|1, forfeit = 기권한 자리|null, voidWhy = 서버가 정한 미반영 사유(SAME_IP | TOO_FAST)|없음, ladder = 래더 판 여부.
   * 손님(account:false)은 레이팅 1000 고정·저장 없음으로 상대 노릇만 한다(계정 쪽만 바뀐다, 계정 쪽 K = kGuest, 계정당 24시간 guestDailyMax 판까지). rank_games 의 손님 키 = 'guest:<키>'.
   * 반영되면 배치(5판) 이상인 계정의 저장 티어를 nextTier 로 갱신(배치를 마치는 판 = 레이팅으로 바로 정함), last_game_at = now.
   * 반환 { counted, why?, season, before, after, delta, seatCounted, lockUntil[], tierBefore[], tier[], placement[], placementLeft[] }
   */
  record(o) {
    const { matchId, players, winner } = o, forfeit = o.forfeit === undefined ? null : o.forfeit, now = o.now || this.now();
    const season = this.season(now).n;
    const res = this.db.tx(() => {
      const { acct, keys: [ak, bk] } = this._keys(players);
      const [a, b] = players.map((p, i) => (acct[i] ? this.get(p.key, p.nick) : FRESH(p.key, p.nick)));
      a.nick = players[0].nick; b.nick = players[1].nick;
      const before = [a.rating, b.rating], vb = [a, b].map((p, i) => (acct[i] ? this.view(p, now) : null));
      const none = why => ({ counted: false, why, before, after: before, delta: [0, 0], seatCounted: [false, false], lockUntil: [0, 0], rows: [a, b], acct, vb });
      if (ak === bk) return none('SAME_KEY');
      if (!acct[0] && !acct[1]) return none('NO_ACCOUNT');
      const guest = !acct[0] || !acct[1];
      let why = o.voidWhy || null;
      if (!why && guest) { // 손님 상대 판: 계정 쪽의 24시간 반영 수(손님 이름을 바꿔도 같은 계정으로 센다)
        const k = acct[0] ? ak : bk;
        const n = this.db.get(`SELECT COUNT(*) AS n FROM rank_games WHERE counted = 1 AND at > ?
          AND ((a_key = ? AND b_key LIKE 'guest:%') OR (b_key = ? AND a_key LIKE 'guest:%'))`, now - RANK.guestWindowMs, k, k).n;
        if (n >= RANK.guestDailyMax) why = 'GUEST';
      }
      if (!why && this.pairCount(ak, bk, now) >= RANK.pairLimit) why = 'PAIR_LIMIT';
      const counted = !why;
      this.db.run('INSERT INTO rank_games (match_id, a_key, b_key, winner_key, forfeit_key, counted, at, why, season, ladder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        String(matchId), ak, bk, winner === 0 ? ak : bk, forfeit === null ? null : (forfeit === 0 ? ak : bk), counted ? 1 : 0, now, why, season, o.ladder ? 1 : 0);
      if (counted) {
        const [ra, rb] = guest ? eloAfter(a, b, winner === 0, acct[0] ? RANK.kGuest : 0, acct[1] ? RANK.kGuest : 0) : eloAfter(a, b, winner === 0);
        a.rating = ra; b.rating = rb; a.games++; b.games++;
        if (winner === 0) { a.w++; b.l++; } else { b.w++; a.l++; }
        for (const p of [a, b]) { p.lastGameAt = now; if (p.games >= RANK.boardMinGames) p.tier = nextTier(p.tier, p.rating); }
      }
      if (forfeit !== null && acct[forfeit]) this._lock(forfeit === 0 ? a : b, now); // 최근 10판 중 자기 기권 3회 -> 30분 잠금(계정만)
      if (acct[0]) this._save(a, now);
      if (acct[1]) this._save(b, now);
      if (!acct[0]) a.rating = before[0]; // 손님 쪽은 저장하지 않으므로 변동 0
      if (!acct[1]) b.rating = before[1];
      const after = [a.rating, b.rating];
      return Object.assign({ counted }, why ? { why } : {}, { before, after, delta: [after[0] - before[0], after[1] - before[1]], seatCounted: acct.map(x => counted && x), lockUntil: [acct[0] ? a.lockUntil : 0, acct[1] ? b.lockUntil : 0], rows: [a, b], acct, vb });
    });
    if (res.counted) this._masters = null;
    return finish(this, res, season, now);
  }
  /**
   * 분쟁 판 기록(결과 one_sided·desync·mismatch). 서버는 엔진을 돌리지 않아 어느 쪽이 거짓인지 가리지 못하므로(결과를 낸 쪽이 거짓일 수도 있다)
   * 「결과를 안 낸 쪽 탓」으로 정하지 않고, 계정 대 계정이면 두 자리 모두에 분쟁 1회(dispute_a·dispute_b = 1)를 남긴다(레이팅 변동 없음).
   * 상대가 손님이면 기록만 남기고(dispute 0·0) 잠금 계산에서 뺀다. 잠금 = _lock(최근 10판 중 분쟁 상대 서로 다른 3명).
   * 반환 { counted:false, why:'DISPUTE', kind, season, before, after, delta, lockUntil[], tierBefore[], tier[], … }
   */
  dispute(o) {
    const { matchId, players, kind } = o, now = o.now || this.now(), season = this.season(now).n;
    const res = this.db.tx(() => {
      const { acct, keys: [ak, bk] } = this._keys(players);
      const ps = players.map((p, i) => (acct[i] ? this.get(p.key, p.nick) : FRESH(p.key, p.nick)));
      const before = [ps[0].rating, ps[1].rating], vb = ps.map((p, i) => (acct[i] ? this.view(p, now) : null));
      const both = acct[0] && acct[1] && ak !== bk, d = both ? 1 : 0; // 손님 상대·같은 키 = 기록만
      this.db.run('INSERT INTO rank_games (match_id, a_key, b_key, winner_key, forfeit_key, counted, at, why, dispute_a, dispute_b, season, ladder) VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?)',
        String(matchId), ak, bk, '', now, 'DISPUTE:' + String(kind), d, d, season, o.ladder ? 1 : 0);
      if (both) ps.forEach((p, i) => { p.nick = players[i].nick; this._lock(p, now); this._save(p, now); });
      return { counted: false, why: 'DISPUTE', kind, before, after: before, delta: [0, 0], seatCounted: [false, false], lockUntil: ps.map((p, i) => (acct[i] ? p.lockUntil : 0)), rows: ps, acct, vb };
    });
    return finish(this, res, season, now);
  }
  /**
   * 순위표(지금 시즌): 배치 완료(5판 이상)·활동 중(마지막 반영 판 14일 안)만, 레이팅 내림차순(같으면 같은 순위, 그다음 승 많은 순).
   * me = 내 줄(배치 중·비활동이면 rank:null). 반환 { season, total, masterQuota, top[], me }
   */
  board(top, meKey, meNick, now) {
    top = top || RANK.boardTop; now = now || this.now();
    this._masters = null; // 순위표는 언제나 새로 센다(인원·마스터. 좌석 표시용 캐시는 30초)
    const s = this.season(now), M = this.masters(now), since = now - RANK.inactiveDays * DAY;
    const rows = this.db.all(`SELECT key, nick, rating, w, l, games, tier FROM ratings WHERE season = ? AND games >= ? AND last_game_at > ?
      ORDER BY rating DESC, w DESC, key ASC LIMIT ?`, s.n, RANK.boardMinGames, since, top);
    let prev = null, rank = 0;
    const list = rows.map((r, i) => { if (r.rating !== prev) { rank = i + 1; prev = r.rating; } return { rank, nick: r.nick, rating: r.rating, w: r.w, l: r.l, games: r.games, tier: M.keys.has(r.key) ? 'master' : r.tier }; });
    let me = null;
    if (meKey) {
      const m = this.get(meKey, meNick), v = this.view(m, now);
      const above = v.placement || v.inactive ? 0 : this.db.get('SELECT COUNT(*) AS n FROM ratings WHERE season = ? AND games >= ? AND last_game_at > ? AND rating > ?', s.n, RANK.boardMinGames, since, m.rating).n;
      me = Object.assign({ rank: v.placement || v.inactive ? null : above + 1, nick: m.nick }, v, { lockUntil: m.lockUntil > now ? m.lockUntil : 0 });
    }
    return { season: s, total: M.total, masterQuota: M.quota, top: list, me };
  }
}
// 기록 결과에 자리별 티어·배치 값을 붙인다(tierBefore = 판 전 표시 티어, tier = 판 뒤 표시 티어. 손님 자리 null)
function finish(st, res, season, now) {
  const va = res.rows.map((p, i) => (res.acct[i] ? st.view(p, now) : null));
  const pick = (vs, k) => vs.map(v => (v ? v[k] : null));
  const out = Object.assign({}, res, { season, tierBefore: pick(res.vb, 'tier'), tier: pick(va, 'tier'), placement: pick(va, 'placement'), placementLeft: pick(va, 'placementLeft') });
  delete out.rows; delete out.acct; delete out.vb;
  return out;
}
module.exports = { RankingStore };
