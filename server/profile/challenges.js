'use strict';
// 일일·주간 도전 정의(analysis/27 P4b). 서버가 이미 아는 값만 쓴다: 래더·랭크 반영 판(rank_games.counted=1)의 판수·승수, 로그인 일자(login_days), 스토리 우승(story_clears).
// metric: login(기간 안 로그인한 날 수) | games(반영 판수) | wins(반영 승수) | story(스토리 우승 수). reward = 카탈로그 칭호 id(rule = 'ch_' + id). 경제 보상 없음.
// 기간 경계 = 한국 시각(KST) 일 0시 / 주(월요일 0시). period 라벨 = 'd' | 'w' + 시작일 YYYYMMDD.
const KST = 9 * 3600 * 1000, DAY = 86400000;

const DEFS = [
  { id: 'd_login', kind: 'daily', slot: 0, name: '출석', desc: '오늘 접속하기', metric: 'login', goal: 1, reward: { kind: 'title', id: 'ch_d_login' } },
  { id: 'd_games', kind: 'daily', slot: 1, name: '세 판', desc: '래더·랭크 3판 치르기', metric: 'games', goal: 3, reward: { kind: 'title', id: 'ch_d_games' } },
  { id: 'd_win', kind: 'daily', slot: 2, name: '오늘의 승리', desc: '래더·랭크 1승', metric: 'wins', goal: 1, reward: { kind: 'title', id: 'ch_d_win' } },
  { id: 'w_login', kind: 'weekly', slot: 0, name: '사흘 출석', desc: '이번 주 3일 접속하기', metric: 'login', goal: 3, reward: { kind: 'title', id: 'ch_w_login' } },
  { id: 'w_wins', kind: 'weekly', slot: 1, name: '다섯 승', desc: '래더·랭크 5승', metric: 'wins', goal: 5, reward: { kind: 'title', id: 'ch_w_wins' } },
  { id: 'w_story', kind: 'weekly', slot: 2, name: '스토리 우승', desc: '스토리 모드 우승 1회', metric: 'story', goal: 1, reward: { kind: 'title', id: 'ch_w_story' } },
];
const byId = new Map(DEFS.map(d => [d.id, d]));

const dayStart = ms => Math.floor((ms + KST) / DAY) * DAY - KST; // 그 시각이 속한 KST 날 0시(ms)
const ymd = ms => { const d = new Date(ms + KST); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); };
/** 지금 시각의 일일·주간 기간 { daily: { period, start, end }, weekly: {...} } (end 는 다음 기간 시작 = 미포함) */
function periods(now) {
  const ds = dayStart(now), dow = (Math.floor((ds + KST) / DAY) + 3) % 7; // 1970-01-01 = 목요일 → 월요일 = 0
  const ws = ds - dow * DAY;
  return { daily: { period: 'd' + ymd(ds), start: ds, end: ds + DAY }, weekly: { period: 'w' + ymd(ws), start: ws, end: ws + 7 * DAY } };
}
module.exports = { DEFS, byId, periods, ymd };
