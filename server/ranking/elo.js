'use strict';
// 2인 랭크(Elo) 규칙 상수·계산. 순수 함수만(저장은 server/store/ranking.js). 참조: 통키 server/ranking/elo.js 와 같은 값(손님·분쟁·실시간 규칙은 열혈 추가, analysis/22 4절).
const RANK = {
  init: 1000, k: 32, kPlacement: 48, placementGames: 10, floor: 100, // 시작 1000, K 32(자기 첫 10판 48), 하한 100
  boardMinGames: 5, boardTop: 50,                                      // 순위표: 5판 미만 = 배치 중(목록 제외), 상위 50
  pairLimit: 3, pairWindowMs: 24 * 3600 * 1000,                        // 같은 상대 24시간 3판까지만 반영
  forfeitWindow: 10, forfeitMax: 3, lockMs: 30 * 60000,                // 최근 10판 중 기권 3회 -> 30분 랭크 잠금
  disputeMax: 3,                                                       // 최근 10판(forfeitWindow) 중 분쟁(one_sided·desync·mismatch) 상대(계정) 서로 다른 3명 -> 30분 랭크 잠금(손님 상대 분쟁은 안 셈)
  guestDailyMax: 3, guestWindowMs: 24 * 3600 * 1000, kGuest: 16,       // 손님 상대 판: 계정당 24시간 3판까지만 반영, 계정 쪽 K 16, 손님 레이팅 1000 고정
  minRealMs: 30000, realFrac: 0.9,                                     // 반영 최소 실시간: max(30초, 전투 확정 프레임 실시간 × 0.9). 미만 = TOO_FAST
  season: 1,                                                           // 시즌 1(첫 시즌 번호). 지금 시즌은 RankingStore.season() — ladder_seasons 표(analysis/22 10절)
  rules: { humans: 2, stage: 0, rule: 1 },                             // 랭크 방 규칙 고정(사람 2 + CPU 자동 2, 스테이지 커서 0, 룰 1 = 룰2)
  // 래더·티어·시즌(analysis/22 10절). 구조 = 통키 PROTOCOL 11절(LADDER), 값은 열혈에 맞춤(시작 1000·K 32/48 이 같아 티어 구간도 같은 값)
  tierBounds: { silver: 950, gold: 1050, platinum: 1150, diamond: 1250 }, // 하한. 950 미만 bronze
  tierDemoteBuffer: 25,                                                // 강등만 완충: 지금 티어 하한 - 25 아래로 내려가야 강등
  master: { topN: 5, pct: 0.05, minPlayers: 20, minRating: 1250, minGames: 20 }, // 정원 = min(5, max(1, floor(인원 × 0.05))), 인원 < 20 이면 없음
  inactiveDays: 14,                                                    // 마지막 반영 판 14일 지나면 순위표·마스터 자격 제외(레이팅 그대로)
  seasonDays: 28, seasonResetFactor: 0.5,                              // 시즌 28일, 넘김 = round(1000 + (r - 1000) × 0.5), 판수·승·패 0(배치·K 48 다시)
  queue: { expandStep: 100, expandSec: 15, maxWaitSec: 60, windowRule: 'max', tickMs: 1000 }, // 허용 차 = 100 × (1 + floor(대기초/15)), 60초 이상 무제한
  ladderStartSec: 120,                                                 // 매칭 뒤 이 안에 시작하지 않으면 래더 방 해산(벌점 없음)
  ladderCancel: { windowMs: 10 * 60000, max: 3, lockMs: 5 * 60000 },  // 래더 방 시작 전 이탈 10분 안 3회 -> 5분 ladder_join 거절(ranked_locked, 메모리)
};
const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
const DAY = 86400000;
/** 레이팅만으로 정한 티어(완충 없음) */
function tierOf(r) { let t = 'bronze'; for (const x of TIERS) if (x !== 'bronze' && r >= RANK.tierBounds[x]) t = x; return t; }
const tierLower = t => (t === 'bronze' ? -Infinity : RANK.tierBounds[t]);
/** 표시 티어 갱신: 승급 = 위 티어 하한에 닿으면 바로, 강등 = 지금 티어 하한 - 25 아래로 내려가면 한 칸씩(내려간 칸에도 같은 완충). cur 없음 = 레이팅으로 */
function nextTier(cur, r) {
  if (!TIERS.includes(cur)) return tierOf(r);
  const raw = tierOf(r); let i = TIERS.indexOf(cur);
  if (TIERS.indexOf(raw) > i) return raw;
  while (i > 0 && r < tierLower(TIERS[i]) - RANK.tierDemoteBuffer) i--;
  return TIERS[i];
}
const seasonReset = r => Math.max(RANK.floor, Math.round(RANK.init + (r - RANK.init) * RANK.seasonResetFactor));
function masterQuota(players) { const M = RANK.master; return players < M.minPlayers ? 0 : Math.min(M.topN, Math.max(1, Math.floor(players * M.pct))); }
/** 대기 waitMs 인 사람의 허용 레이팅 차(maxWaitSec 이상 = Infinity) */
function queueWindow(waitMs) { const Q = RANK.queue, w = Math.max(0, waitMs) / 1000; return w >= Q.maxWaitSec ? Infinity : Q.expandStep * (1 + Math.floor(w / Q.expandSec)); }
const kOf = games => (games < RANK.placementGames ? RANK.kPlacement : RANK.k);
const expected = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));
/** 한 판 뒤 두 사람의 새 레이팅. 각자 자기 K(kA·kB 를 주면 그 값), 하한 100. 반환 [a 뒤, b 뒤] */
function eloAfter(a, b, aWon, kA, kB) {
  const ea = expected(a.rating, b.rating);
  const da = Math.round((kA || kOf(a.games)) * ((aWon ? 1 : 0) - ea)), db = Math.round((kB || kOf(b.games)) * ((aWon ? 0 : 1) - (1 - ea)));
  return [Math.max(RANK.floor, a.rating + da), Math.max(RANK.floor, b.rating + db)];
}
module.exports = { RANK, TIERS, DAY, kOf, expected, eloAfter, tierOf, nextTier, seasonReset, masterQuota, queueWindow };
