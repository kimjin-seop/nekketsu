'use strict';
// 스토리 저장 실시간 검사(analysis/21 13.4·13.8). 서버 저장 = 재현이라 입력 열은 위조할 수 있다 → 실시간보다 지나치게 빠르게 만든 기록을 거절한다.
//  ① 구간 검사: 잠금 기준(anchorF/anchorAt) 뒤 진행 > 경과 × realFrac + slackF → 'seg'. 기준은 story_begin 과 저장 성공(저장 지점) 때마다 다시 잡는다
//     (기본 전투 속도 1.3배·덮개 아래 fast 구동 몫이 세션 내내 쌓여 몇 경기 뒤 여유를 다 쓰던 문제 수정, 저장 구간마다 여유 slackF).
//  ② 계정 누적 검사(새는 양동이): 저장 구간 쪼개기·story_begin 되풀이로 구간 여유를 거듭 얻는 것 방지. 계정마다 빚 d(프레임) = 실시간 × paceFrac 보다 앞선 양.
//     저장 성공 때 d = max(0, d + 구간 프레임 − 경과 × paceFrac). 구간 검사 때 그 값(아직 반영 전) > slackF → 'pace'. 빚은 0 아래로 안 내려간다(쉬는 시간을 모아 두었다 쓰지 못함).
//     잠금이 바뀌어도(다시 begin·다른 기기) 계정 키로 남는다. 결과 = 장기 평균 paceFrac 배 + slackF 를 넘을 수 없다.
const FRAME_MS = 1000 / 60.0988;
// 경과 프레임 시간: 마지막 반영(pace.t)과 잠금 기준 중 늦은 쪽부터(잠금 전 쉬는 시간은 셈하지 않음)
const paceDebt = (lock, pace, endF, now, paceFrac) => Math.max(0, pace.d + (endF - lock.anchorF) - (now - Math.max(pace.t, lock.anchorAt)) / FRAME_MS * paceFrac);
// null = 통과, 'seg' = 구간 검사, 'pace' = 계정 누적 검사. realFrac 0 = 둘 다 끔(종전 시험 훅 NK_STORY_REAL_FRAC=0 그대로), paceFrac 0 = ②만 끔
const paceOn = cfg => cfg.realFrac > 0 && cfg.paceFrac > 0;
function paceCheck(lock, pace, endF, now, cfg) {
  if (cfg.realFrac > 0 && endF - lock.anchorF > (now - lock.anchorAt) / FRAME_MS * cfg.realFrac + cfg.slackF) return 'seg';
  if (paceOn(cfg) && pace && paceDebt(lock, pace, endF, now, cfg.paceFrac) > cfg.slackF) return 'pace';
  return null;
}
// 저장 성공(잠금이 frame 으로 옮겨 감): 빚 반영 + 구간 기준 다시 잡기
function paceCommit(lock, pace, frame, now, cfg) { // now = 그 구간을 받은 시각(재현 대기 시간은 셈하지 않음)
  if (pace && paceOn(cfg)) { pace.d = paceDebt(lock, pace, frame, now, cfg.paceFrac); pace.t = now; }
  lock.anchorF = frame; lock.anchorAt = now;
}
module.exports = { paceCheck, paceCommit, FRAME_MS };
