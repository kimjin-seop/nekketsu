'use strict';
// 비경제 보상·프로필 저장(analysis/27 P1·P2, 스키마 v4). 판정은 서버에서만: 래더·랭크 반영 판(rank_games.counted = 1) · 스토리 완주(story_saved done) · 로그인 일자 · 시즌 종료.
// 모든 지급은 INSERT OR IGNORE(멱등): 같은 판을 다시 처리하거나 서버가 며칠 꺼져 있다 여러 시즌을 넘겨도 중복·누락 없이 다시 돌릴 수 있다.
// 통산 승·연승은 별도 집계 표 없이 rank_games 에서 계산한다. 키는 계정 key(닉네임 아님). 손님(guest:)은 기록하지 않는다(호출하지 않는다).
const { RULES, ITEMS, KINDS, KIND_KEY, EQUIP_KEY, DEFAULT_EQUIP, find } = require('../profile/catalog');
const { RANK } = require('../ranking/elo');

const TIER_IDX = { bronze: 0, silver: 1, gold: 2, platinum: 3, diamond: 4, master: 5 };
const tIdx = t => (t && TIER_IDX[t] !== undefined ? TIER_IDX[t] : -1);
const KST = 9 * 3600 * 1000;
const dayOf = ms => { const d = new Date(ms + KST); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); }; // 한국 시각 날짜 YYYYMMDD(서버 시각)

// rule 판정(facts 에 없는 값은 false). at = 'event' 규칙은 판·로그인·스토리 뒤, 'season' 규칙은 시즌 종료 일괄(settleSeasons)에서만 본다
const PRED = {
  tutorial: () => false, // 클라이언트 보고(tutorial_done)로만
  registered: f => !!f.registered,
  login_7: f => f.loginDays >= 7, login_30: f => f.loginDays >= 30,
  first_win: f => f.w >= 1, wins_10: f => f.w >= 10, wins_100: f => f.w >= 100, games_50: f => f.games >= 50,
  resilient: f => !!f.resilient, streak_3: f => f.maxStreak >= 3, streak_5: f => f.maxStreak >= 5, streak_10: f => f.maxStreak >= 10,
  flawless_start: f => !!f.flawless, phoenix: f => !!f.phoenix,
  placed: f => !!f.placed,
  tier_silver: f => f.tierIdx >= 1, tier_gold: f => f.tierIdx >= 2, tier_platinum: f => f.tierIdx >= 3, tier_diamond: f => f.tierIdx >= 4, tier_master: f => f.tierIdx >= 5,
  story_first_win: f => !!f.storyWin, story_clear_1: f => f.storyClears >= 1, story_clear_3: f => f.storyClears >= 3,
  season_done: f => f.seasonsDone >= 1, season_done_3: f => f.seasonsDone >= 3,
  season_silver: f => f.seasonTier >= 1, season_gold: f => f.seasonTier >= 2, season_platinum: f => f.seasonTier >= 3, season_master: f => f.seasonTier >= 5,
};
for (const k of Object.keys(RULES)) if (k !== 'always' && !PRED[k]) throw new Error('PRED 없음: ' + k);

/** 승패 열(앞이 오래된 판, true = 승)에서 통산 값 계산 */
function analyze(seq) {
  let w = 0, cw = 0, cl = 0, maxStreak = 0, resilient = false, armed = false, phoenix = false;
  for (const win of seq) {
    if (win) { if (cl >= 3) resilient = true; w++; cw++; cl = 0; if (cw > maxStreak) maxStreak = cw; if (armed && cw >= 3) phoenix = true; }
    else { cw = 0; cl++; if (cl >= 5) armed = true; }
  }
  return { w, l: seq.length - w, games: seq.length, maxStreak, resilient, phoenix, flawless: seq.length >= 5 && seq.slice(0, 5).every(Boolean) };
}

class ProfileStore {
  /** o = { ranks: RankingStore, now?() } */
  constructor(db, o) { this.db = db; o = o || {}; this.ranks = o.ranks || null; this.now = o.now || Date.now; }
  // ---------- 계산 ----------
  _seq(key) { return this.db.all('SELECT winner_key FROM rank_games WHERE counted = 1 AND (a_key = ? OR b_key = ?) ORDER BY at, id', key, key).map(r => r.winner_key === key); }
  loginDays(key) { return this.db.get('SELECT COUNT(*) AS n FROM login_days WHERE key = ?', key).n; }
  storyClears(key) { return this.db.get('SELECT COUNT(*) AS n FROM story_clears WHERE key = ?', key).n; }
  /** 지금 표시 티어·배치 상태(+지난 시즌 보관 줄의 최고 티어). ranks 가 없으면 보관 줄만 */
  _tierFacts(key) {
    let tierIdx = -1, placed = false, view = null;
    for (const r of this.db.all('SELECT tier, games FROM ratings_archive WHERE key = ?', key)) { tierIdx = Math.max(tierIdx, tIdx(r.tier)); if (r.games >= RANK.boardMinGames) placed = true; }
    if (this.ranks) { view = this.ranks.view(this.ranks.get(key)); if (!view.placement) placed = true; tierIdx = Math.max(tierIdx, tIdx(view.tier)); }
    return { tierIdx, placed, view };
  }
  _eventFacts(key, extra) {
    const a = analyze(this._seq(key)), t = this._tierFacts(key);
    return Object.assign(a, { registered: true, loginDays: this.loginDays(key), storyClears: this.storyClears(key), tierIdx: t.tierIdx, placed: t.placed }, extra);
  }
  // facts 를 만족하는 server 항목을 지급. at = 규칙 시점('event'|'season'). 새로 들어간 것만 반환 [{ kind, id, name }]
  _grant(key, facts, at, when) {
    const out = [], now = when || this.now();
    for (const it of ITEMS) {
      if (it.src !== 'server' || RULES[it.rule].at !== at || !PRED[it.rule](facts)) continue;
      if (this.db.run('INSERT OR IGNORE INTO unlocks (key, kind, item_id, at, src) VALUES (?, ?, ?, ?, ?)', key, it.kind, it.id, now, 'server').changes) out.push({ kind: it.kind, id: it.id, name: it.name });
    }
    return out;
  }
  // ---------- 획득 지점(서버 판정) ----------
  /** 로그인(bindAcct) 때: 오늘(한국 시각) 로그인 일자 기록. 새 날이거나 「첫 걸음」이 없을 때만 판정. 반환 새 획득 [] */
  onLogin(key, now) {
    now = now || this.now();
    return this.db.tx(() => {
      const ins = this.db.run('INSERT OR IGNORE INTO login_days (key, day) VALUES (?, ?)', key, dayOf(now)).changes;
      if (!ins && this.db.get("SELECT 1 AS x FROM unlocks WHERE key = ? AND kind = 'title' AND item_id = 'first_step'", key)) return [];
      return this._grant(key, this._eventFacts(key), 'event', now);
    });
  }
  /** 랭크·래더 판이 반영(counted)된 직후, 계정 자리마다. 같은 판을 다시 불러도 새 획득은 [] */
  onGame(key, now) { now = now || this.now(); return this.db.tx(() => this._grant(key, this._eventFacts(key), 'event', now)); }
  /** 스토리 저장(story_saved{saved:true}) 직후. done = 우승(완주), wins = 서버 재현 메타의 승수, snapHash = 그 저장 지점(우승 기록 중복 방지 키) */
  onStory(key, o, now) {
    now = now || this.now();
    return this.db.tx(() => {
      if (o.done && o.snapHash) this.db.run('INSERT OR IGNORE INTO story_clears (key, snap_hash, at) VALUES (?, ?, ?)', key, String(o.snapHash), now);
      return this._grant(key, this._eventFacts(key, { storyWin: o.wins >= 1 || !!o.done }), 'event', now);
    });
  }
  /** 튜토리얼 완료(클라이언트 보고, src = self). 계정당 한 번 */
  tutorialDone(key, now) {
    now = now || this.now();
    return this.db.run("INSERT OR IGNORE INTO unlocks (key, kind, item_id, at, src) VALUES (?, 'title', 'rookie', ?, 'self')", key, now).changes ? [{ kind: 'title', id: 'rookie', name: find('title', 'rookie').name }] : [];
  }
  /**
   * 시즌 종료 일괄 지급(티어 프레임·시즌 완주). ratings_archive 와 ladder_seasons.final(마스터)을 읽는 멱등 처리 — 시즌을 몇 개 건너뛰어도, 다시 돌려도 같은 결과.
   * 서버 기동 때·rollSeason 이 시즌을 넘길 때마다 호출. 반환 새로 지급한 수
   */
  settleSeasons() {
    return this.db.tx(() => {
      const per = new Map(), get = k => { let p = per.get(k); if (!p) { p = { seasonsDone: 0, seasonTier: -1, at: 0 }; per.set(k, p); } return p; };
      const closed = new Map(this.db.all('SELECT season, closed_at, final FROM ladder_seasons WHERE closed_at IS NOT NULL').map(r => [r.season, r]));
      for (const r of this.db.all('SELECT season, key, games, tier FROM ratings_archive')) {
        const c = closed.get(r.season); if (!c) continue; // 닫힌 시즌의 보관 줄만
        const p = get(r.key); if (r.games >= RANK.placementGames) p.seasonsDone++; p.seasonTier = Math.max(p.seasonTier, tIdx(r.tier)); p.at = Math.max(p.at, c.closed_at);
      }
      for (const c of closed.values()) {
        let fin = null; try { fin = JSON.parse(c.final); } catch (e) { /* 값 없음 */ }
        for (const m of (fin && fin.masters) || []) if (m && typeof m.key === 'string') { const p = get(m.key); p.seasonTier = Math.max(p.seasonTier, TIER_IDX.master); p.at = Math.max(p.at, c.closed_at); }
      }
      let n = 0;
      for (const [key, p] of per) n += this._grant(key, p, 'season', p.at || this.now()).length;
      return n;
    });
  }
  // ---------- 조회·장착 ----------
  _owned(key) {
    const m = new Map();
    for (const r of this.db.all('SELECT kind, item_id, at, src FROM unlocks WHERE key = ?', key)) m.set(r.kind + ':' + r.item_id, r);
    return m;
  }
  _equippedRow(key) { return this.db.get('SELECT title_id, frame_id, portrait_bg, portrait_stamp FROM account_profile WHERE key = ?', key); }
  /** 장착 상태(미획득·사라진 id 는 기본값으로 걸러 돌려준다) */
  equipped(key, owned) {
    owned = owned || this._owned(key); const r = this._equippedRow(key) || {};
    const ok = (kind, id) => (id && find(kind, id) && (find(kind, id).src === 'always' || owned.has(kind + ':' + id)) ? id : null);
    return {
      title: ok('title', r.title_id), frame: ok('frame', r.frame_id) || DEFAULT_EQUIP.frame,
      portrait_bg: ok('bg', r.portrait_bg) || DEFAULT_EQUIP.portrait_bg, portrait_stamp: ok('stamp', r.portrait_stamp),
    };
  }
  stats(key) {
    const a = analyze(this._seq(key)), t = this._tierFacts(key), v = t.view;
    const cur = this.ranks ? this.ranks.get(key) : null;
    const seasons = this.db.get('SELECT COUNT(*) AS n FROM ratings_archive WHERE key = ? AND games > 0', key).n + (cur && cur.games > 0 ? 1 : 0);
    return { w: a.w, l: a.l, games: a.games, winRate: a.games ? Math.round((a.w * 1000) / a.games) / 10 : null, maxStreak: a.maxStreak, seasons,
      rating: v ? v.rating : null, tier: v ? v.tier : null, placement: v ? v.placement : null, loginDays: this.loginDays(key), storyClears: this.storyClears(key) };
  }
  nickOf(key) { const r = this.db.get('SELECT nick FROM accounts WHERE key = ?', key); return r ? r.nick : null; }
  /** profile 메시지 본문. key = 계정 키 | null(손님: 전 항목 잠금·기록 없음) */
  view(key) {
    const owned = key ? this._owned(key) : new Map(), out = {};
    for (const kind of KINDS) {
      out[KIND_KEY[kind]] = ITEMS.filter(i => i.kind === kind).map(i => {
        const o = i.src === 'always' ? { at: 0 } : owned.get(kind + ':' + i.id);
        return Object.assign({ id: i.id, name: i.name, rule: i.rule, desc: RULES[i.rule].text, src: i.src, got: !!o }, o ? { at: o.at } : null);
      });
    }
    return Object.assign({ stats: key ? this.stats(key) : null }, out, { equipped: key ? this.equipped(key, owned) : Object.assign({}, DEFAULT_EQUIP) });
  }
  /**
   * 장착 변경. fields = { title?, frame?, portrait_bg?, portrait_stamp? }(값 = 항목 id | null 이면 해제 = 기본). 하나라도 알 수 없는 id·미획득이면 아무것도 바꾸지 않고 { bad: 'unknown'|'locked'|'empty', field }.
   * 성공 { equipped }
   */
  setEquipped(key, fields, now) {
    now = now || this.now();
    return this.db.tx(() => {
      const owned = this._owned(key), cur = this._equippedRow(key) || { title_id: null, frame_id: null, portrait_bg: null, portrait_stamp: null };
      const next = { title: cur.title_id, frame: cur.frame_id, bg: cur.portrait_bg, stamp: cur.portrait_stamp }; let any = false;
      for (const kind of KINDS) {
        const f = EQUIP_KEY[kind]; if (!Object.prototype.hasOwnProperty.call(fields, f)) continue;
        const v = fields[f]; any = true;
        if (v === null || v === '') { next[kind] = null; continue; }
        if (typeof v !== 'string' || v.length > 32) return { bad: 'unknown', field: f };
        const it = find(kind, v); if (!it) return { bad: 'unknown', field: f };
        if (it.src !== 'always' && !owned.has(kind + ':' + v)) return { bad: 'locked', field: f };
        next[kind] = v;
      }
      if (!any) return { bad: 'empty', field: null };
      this.db.run(`INSERT INTO account_profile (key, title_id, frame_id, portrait_bg, portrait_stamp, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET title_id = excluded.title_id, frame_id = excluded.frame_id, portrait_bg = excluded.portrait_bg, portrait_stamp = excluded.portrait_stamp, updated_at = excluded.updated_at`,
        key, next.title, next.frame, next.bg, next.stamp, now);
      return { equipped: this.equipped(key, owned) };
    });
  }
}
module.exports = { ProfileStore, analyze, dayOf };
