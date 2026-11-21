'use strict';
// 래더 대기열(메모리, 순수 — 저장·소켓 없음). 짝 찾기 규칙(analysis/22 10.3절, 구조 = 통키 server/ranking/queue.js):
//  - 허용 차 = queueWindow(대기 시간), 두 사람 중 넓은 창(windowRule 'max').
//  - 같은 키·hard(a,b)(같은 IP 등)인 짝은 절대 짓지 않는다.
//  - 오래 기다린 사람부터, 허용 범위 안에서 레이팅 차가 가장 작은 상대.
//  - soft(a,b)(같은 상대 24시간 제한·직전 상대)인 짝은 다른 후보가 있으면 고르지 않고, 먼저 기다린 쪽 대기가 maxWaitSec 를 넘었을 때만 허용.
const { RANK, queueWindow } = require('./elo');

class LadderQueue {
  constructor() { this.map = new Map(); this.seq = 0; } // key -> entry
  /** e = { key, nick, rating, at(ms), ...(호출한 쪽 값) }. 이미 있으면 그대로 두고 false */
  join(e) { if (this.map.has(e.key)) return false; this.map.set(e.key, Object.assign({}, e, { seq: ++this.seq })); return true; }
  leave(key) { return this.map.delete(key); }
  get(key) { return this.map.get(key) || null; }
  get size() { return this.map.size; }
  values() { return [...this.map.values()]; }
  window(e, now) { return queueWindow(now - e.at); }
  /** 한 번 짝 찾기. 짝지은 사람은 대기열에서 뺀다. 반환 [{ a, b, soft }](a = 먼저 기다린 사람) */
  match(now, hard, soft) {
    hard = hard || (() => false); soft = soft || (() => false);
    const es = this.values().sort((x, y) => x.at - y.at || x.seq - y.seq), used = new Set(), out = [];
    for (const a of es) {
      if (used.has(a.key)) continue;
      const wa = this.window(a, now);
      let best = null, lim = null;
      for (const b of es) {
        if (b === a || used.has(b.key) || a.key === b.key || hard(a, b)) continue;
        const d = Math.abs(a.rating - b.rating), wb = this.window(b, now);
        if (!(d <= (RANK.queue.windowRule === 'min' ? Math.min(wa, wb) : Math.max(wa, wb)))) continue;
        if (soft(a, b)) { if (!lim || d < lim.d) lim = { b, d }; continue; }
        if (!best || d < best.d) best = { b, d };
      }
      const pick = best || (lim && now - a.at >= RANK.queue.maxWaitSec * 1000 ? lim : null);
      if (!pick) continue;
      used.add(a.key); used.add(pick.b.key); this.map.delete(a.key); this.map.delete(pick.b.key);
      out.push({ a, b: pick.b, soft: !best });
    }
    return out;
  }
}
module.exports = { LadderQueue };
