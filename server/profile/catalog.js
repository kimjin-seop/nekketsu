'use strict';
// 비경제 보상 카탈로그(analysis/27 P1). 칭호·프레임·초상 배경·초상 스탬프의 id·이름·잠금 조건(rule).
// 능력치·재화·유료 없음. 서버가 아는 값(래더 반영 판·티어·시즌·스토리 완주·로그인 일자)만 조건에 쓴다. 이름은 짧은 일반어.
// 같은 rule 은 칭호·프레임·배경·스탬프가 공유한다(조건 재사용). rule 의 판정 함수는 profile.js.
// kind: title | frame | bg | stamp. src: 'server'(서버 판정) | 'self'(클라이언트 보고, tutorial_done 만) | 'always'(항상 가짐).
// 티어 이름·임계값은 server/ranking/elo.js(RANK.tierBounds: silver 950 · gold 1050 · platinum 1150 · diamond 1250, master = 순위 정원)를 따른다.

// rule -> { at: 'event'(판·로그인·스토리 직후) | 'season'(시즌 종료 일괄), text: 잠금 조건 설명 }
const RULES = {
  always: { at: 'event', text: '기본' },
  tutorial: { at: 'event', text: '튜토리얼을 끝까지 마치기' },
  registered: { at: 'event', text: '계정 가입' },
  login_7: { at: 'event', text: '로그인한 날 7일(누적)' },
  login_30: { at: 'event', text: '로그인한 날 30일(누적)' },
  first_win: { at: 'event', text: '래더·랭크 1승' },
  wins_10: { at: 'event', text: '래더·랭크 10승' },
  wins_100: { at: 'event', text: '래더·랭크 100승' },
  games_50: { at: 'event', text: '래더·랭크 50판' },
  resilient: { at: 'event', text: '3연패 뒤 승리' },
  streak_3: { at: 'event', text: '3연승' },
  streak_5: { at: 'event', text: '5연승' },
  streak_10: { at: 'event', text: '10연승' },
  flawless_start: { at: 'event', text: '첫 5판 전승' },
  phoenix: { at: 'event', text: '5연패 뒤 3연승' },
  placed: { at: 'event', text: '시즌 배치(5판) 완료' },
  tier_silver: { at: 'event', text: '실버 티어 도달' },
  tier_gold: { at: 'event', text: '골드 티어 도달' },
  tier_platinum: { at: 'event', text: '플래티넘 티어 도달' },
  tier_diamond: { at: 'event', text: '다이아 티어 도달' },
  tier_master: { at: 'event', text: '마스터 도달' },
  story_first_win: { at: 'event', text: '스토리에서 첫 승리' },
  story_clear_1: { at: 'event', text: '스토리 우승 1회' },
  story_clear_3: { at: 'event', text: '스토리 우승 3회' },
  season_done: { at: 'season', text: '시즌 10판 이상 치르고 마무리' },
  season_done_3: { at: 'season', text: '시즌 완주 3회' },
  season_silver: { at: 'season', text: '시즌 종료 때 실버 이상' },
  season_gold: { at: 'season', text: '시즌 종료 때 골드 이상' },
  season_platinum: { at: 'season', text: '시즌 종료 때 플래티넘 이상' },
  season_master: { at: 'season', text: '시즌 종료 때 마스터' },
};

const T = (id, name, rule, src) => ({ kind: 'title', id, name, rule, src: src || 'server' });
const F = (id, name, rule) => ({ kind: 'frame', id, name, rule, src: rule === 'always' ? 'always' : 'server' });
const B = (id, name, rule) => ({ kind: 'bg', id, name, rule, src: rule === 'always' ? 'always' : 'server' });
const S = (id, name, rule) => ({ kind: 'stamp', id, name, rule, src: 'server' });

const ITEMS = [
  // 입문·접속
  T('rookie', '신입 열혈', 'tutorial', 'self'), T('first_step', '첫 걸음', 'registered'), T('regular', '단골', 'login_7'), T('attendance', '개근', 'login_30'),
  // 래더
  T('first_win', '첫 승리', 'first_win'), T('ten_wins', '열 승', 'wins_10'), T('veteran', '백전노장', 'wins_100'), T('fighter', '싸움꾼', 'games_50'), T('resilient', '불굴', 'resilient'),
  // 연승
  T('streak_3', '삼연승', 'streak_3'), T('streak_5', '파죽지세', 'streak_5'), T('streak_10', '무적 행진', 'streak_10'), T('flawless_start', '무패 시작', 'flawless_start'), T('phoenix', '불사조', 'phoenix'),
  // 티어
  T('placed', '첫 평가', 'placed'), T('tier_silver', '실버 입성', 'tier_silver'), T('tier_gold', '골드 입성', 'tier_gold'), T('tier_platinum', '플래티넘 입성', 'tier_platinum'),
  T('tier_diamond', '다이아 입성', 'tier_diamond'), T('tier_master', '마스터', 'tier_master'),
  // 시즌
  T('season_done', '시즌 완주', 'season_done'), T('season_done_3', '시즌 단골', 'season_done_3'),
  // 스토리
  T('story_first_win', '스토리 첫 승', 'story_first_win'), T('story_clear_1', '스토리 우승', 'story_clear_1'), T('story_clear_3', '스토리 3관왕', 'story_clear_3'),

  // 프레임 8
  F('default', '기본', 'always'), F('champion', '우승', 'story_clear_1'), F('season_done', '시즌 완주', 'season_done'),
  F('tier_silver', '실버', 'season_silver'), F('tier_gold', '골드', 'season_gold'), F('tier_platinum', '플래티넘', 'season_platinum'),
  F('master', '마스터', 'season_master'), F('veteran', '백전노장', 'wins_100'),

  // 초상 배경 6
  B('default', '기본', 'always'), B('win10', '열 승', 'wins_10'), B('streak', '연승', 'streak_3'), B('tier_gold', '골드', 'season_gold'), B('season_done', '시즌 완주', 'season_done'), B('champion', '우승', 'story_clear_1'),
  // 초상 스탬프 6
  S('star', '별', 'first_win'), S('fist', '주먹', 'games_50'), S('flame', '불꽃', 'streak_5'), S('crown', '왕관', 'tier_master'), S('shield', '방패', 'resilient'), S('laurel', '월계수', 'story_clear_3'),
];

const KINDS = ['title', 'frame', 'bg', 'stamp'];
const KIND_KEY = { title: 'titles', frame: 'frames', bg: 'bgs', stamp: 'stamps' }; // 응답 필드 이름
const EQUIP_KEY = { title: 'title', frame: 'frame', bg: 'portrait_bg', stamp: 'portrait_stamp' }; // profile_set 필드 이름
const DEFAULT_EQUIP = { title: null, frame: 'default', portrait_bg: 'default', portrait_stamp: null };

const byKey = new Map();
for (const it of ITEMS) {
  if (!RULES[it.rule]) throw new Error('카탈로그 rule 없음: ' + it.rule);
  const k = it.kind + ':' + it.id; if (byKey.has(k)) throw new Error('카탈로그 id 중복: ' + k);
  byKey.set(k, it);
}
const find = (kind, id) => byKey.get(kind + ':' + id) || null;
const list = kind => ITEMS.filter(i => i.kind === kind);

module.exports = { RULES, ITEMS, KINDS, KIND_KEY, EQUIP_KEY, DEFAULT_EQUIP, find, list };
