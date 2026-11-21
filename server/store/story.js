'use strict';
// 스토리 이어하기 슬롯 저장(analysis/21 13절). 저장은 db.js 래퍼만 쓴다. 스냅샷·메타는 서버 재현(server/engine/replay_save.js) 결과만 넣는다(클라이언트 값 불신).
// 슬롯 = 계정당 0~2(3칸). 덮어쓰기·갱신은 비교 후 교체(put 의 expect = 그 슬롯의 지금 snap_hash, 빈 칸이면 null) — 다른 연결이 그 사이에 바꿨으면 null(save_stale).
const SLOTS = 3;
const slotOk = v => Number.isInteger(v) && v >= 0 && v < SLOTS;

class StoryStore {
  constructor(db) { this.db = db; }
  /** 계정의 슬롯 목록(스냅샷 본문 제외). slot 순 */
  list(key) {
    return this.db.all(`SELECT slot, fmt, rom, eng, snap_hash, frame, kind, seq, players, match, wins, losses, rule, level, name_kana, name_ko, done, updated_at
      FROM story_saves WHERE key = ? ORDER BY slot`, key);
  }
  /** 한 슬롯(스냅샷 포함) | null */
  get(key, slot) { return this.db.get('SELECT * FROM story_saves WHERE key = ? AND slot = ?', key, slot); }
  hashOf(key, slot) { const r = this.db.get('SELECT snap_hash FROM story_saves WHERE key = ? AND slot = ?', key, slot); return r ? r.snap_hash : null; }
  /**
   * 저장(새로 쓰기·덮어쓰기·갱신 공통). expect = 기대하는 지금 snap_hash(빈 칸 기대면 null). 다르면 null. 성공하면 새 seq
   * s = { fmt, rom, eng, snap(Uint8Array gzip), snapHash, frame, kind, meta:{ players, match, wins, losses, rule, level, nameKana[] }, nameKo, done }
   */
  put(key, slot, expect, s) {
    return this.db.tx(() => {
      const cur = this.db.get('SELECT snap_hash, seq, created_at FROM story_saves WHERE key = ? AND slot = ?', key, slot);
      if ((cur ? cur.snap_hash : null) !== expect) return null;
      const now = Date.now(), seq = cur ? cur.seq + 1 : 1, m = s.meta;
      this.db.run(`INSERT INTO story_saves (key, slot, fmt, rom, eng, snap, snap_hash, frame, kind, seq, players, match, wins, losses, rule, level, name_kana, name_ko, done, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key, slot) DO UPDATE SET fmt = excluded.fmt, rom = excluded.rom, eng = excluded.eng, snap = excluded.snap, snap_hash = excluded.snap_hash,
          frame = excluded.frame, kind = excluded.kind, seq = excluded.seq, players = excluded.players, match = excluded.match, wins = excluded.wins, losses = excluded.losses,
          rule = excluded.rule, level = excluded.level, name_kana = excluded.name_kana, name_ko = excluded.name_ko, done = excluded.done, updated_at = excluded.updated_at`,
        key, slot, s.fmt, s.rom, s.eng, s.snap, s.snapHash, s.frame, s.kind, seq, m.players, m.match, m.wins, m.losses, m.rule, m.level,
        JSON.stringify(m.nameKana || []), s.nameKo || '', s.done ? 1 : 0, cur ? cur.created_at : now, now);
      return seq;
    });
  }
  /** 삭제. 지운 행 수(0|1) */
  del(key, slot) { return this.db.run('DELETE FROM story_saves WHERE key = ? AND slot = ?', key, slot).changes | 0; }
}

module.exports = { StoryStore, SLOTS, slotOk };
