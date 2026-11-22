'use strict';
// 온라인 대전 전용 가드(사용자 결정 2026-11-22: 「새 가드를 만든다. 전용 키 = 스페이스바, 엔진에는 Select 비트(패드 비트 4)로 전달」, 옵션 engine.guardAS).
// 원작 막기(행동 0x47, 스톤 가드 보유자 0x48)는 「정면 상대가 공격하는 순간 A/B」일 때만 나가고 약 28프레임 뒤 스스로 풀린다. 이 훅은 같은 행동·그림·피격 분류(5)를
// 그대로 쓰되, 사람 슬롯이 Select 를 누르면 상대 공격과 무관하게 막기 자세로 들어가고 최대 GUARD_FRAMES 프레임 유지한 뒤 강제로 풀며, 풀린 뒤 쿨다운 동안은 다시 못 쓴다.
// 옵션 engine.guardAS(0/1, 기본 0 = 훅이 아무것도 안 해 원작과 비트 동일. 싱글·스토리·오프라인·로컬 2P·튜토리얼은 항상 이 상태. 온라인 락스텝 대전만 start.cfg.guardAS 로 켠다):
//   환경변수 NK_GUARD_AS=1(Node 한정)이면 엔진 생성 시 켠다(도구용).
// 규칙(모두 RAM 읽기·쓰기):
//  - 대상 = 사람 슬롯($04A2 bit7·bit6 없음, HP 0 아님). COM 슬롯은 Select 가 와도 아무 일 없음. 전투 중(hp0 훅과 같은 조건: $0641=1, $0642&0x7F=2, $0643 bit1 없음)에서만 동작.
//  - 시작: Select 를 새로 누른 틱 + 쿨다운 0 + 현재 행동이 서기·걷기·달리기(0~4)일 때. 같은 틱에 A·B 를 새로 눌렀으면(Select+A 동시) 시작하지 않아 일반 주먹·발차기가 그대로 나간다. 같은 틱의 명중 판정 전에 행동을 막기로 바꿔 그 틱 공격부터 막는다(틱 = 4프레임).
//  - 유지: 키를 누르고 있는 동안 GUARD_FRAMES 까지. 막기 핸들러($A9C6)가 스스로 풀리지 않게 종료 타이머($0523)를 되감고, 누른 채 새 입력(이동·공격)은 요청을 막아 무시한다.
//    막고 밀려난 속도가 0 이 되어 핸들러가 서기로 돌린 경우(틈 4프레임)는 같은 틱에 막기로 되돌려 틈을 없앤다.
//  - 해제: 시간 초과 → 쿨다운 GUARD_COOLDOWN 프레임. 키를 일찍 떼거나 맞고 날아가는 등 막기가 끊김 → 쿨다운 = max(GUARD_COOLDOWN/2, GUARD_COOLDOWN * 쓴 비율). 쿨다운 중에는 시작 못 함.
//    시작은 새로 누른 틱만 인정(누르고 있다고 계속 다시 시작하지 않음).
//  - 방어 효과·뚫림은 원작 피격 분류 5(행동 0x47/0x48) 그대로: 정면 공격만 막고(등 뒤는 못 막음) 큰 공격(위력 0x50)·합체기·돌진은 원작 규칙대로 날아간다. 데미지 식도 원작 그대로.
// 상태는 JS 변수가 아니라 엔진 RAM 의 미사용 칸에 둔다(락스텝 RAM 지문·스냅샷에 포함되어 어긋나지 않는다). 정적 분석(gen/code.js·code_team.js 가 읽고 쓰지 않는 칸) + 모든 시작 상태 x 난수 입력 동적 확인:
//   $06BD+슬롯 = 막기 남은 틱(bit0~6) | 직전 틱 Select 눌림(bit7),  $06C1+슬롯 = 쿨다운 남은 틱.
// 팀전 엔진(core_team.js)이 code 를 갈아 끼워도 core.js loop() 가 새 code 에 다시 건다.
const TICK_ENTRY = 0x19515; // 전투 틱 한 번(슬롯별 입력 처리가 끝난 뒤, 명중 판정 $8546 이전). 틱마다 한 번 불린다
const GUARD_FRAMES = 60, GUARD_COOLDOWN = 60, TICK_FRAMES = 4;
const GUARD_TICKS = Math.ceil(GUARD_FRAMES / TICK_FRAMES), COOLDOWN_TICKS = Math.ceil(GUARD_COOLDOWN / TICK_FRAMES), COOLDOWN_MIN_TICKS = Math.ceil(COOLDOWN_TICKS / 2);
const A_GUARD = 0x47, A_STONE = 0x48, A_STAND = 0x01, SEL_BIT = 0x20; // SEL_BIT = 게임 내부 패드 비트(A=0x80 B=0x40 Select=0x20 Start=0x10 상=8 하=4 좌=2 우=1)
const RAM_G = 0x6BD, RAM_CD = 0x6C1;
const START_FROM = [1, 1, 1, 1, 1, 0, 0, 0]; // 현재 행동 0~4(서기·동작 후 대기·달리기 정지·걷기·달리기)에서만 시작
function guardAsEnvDefault() { const e = typeof process !== 'undefined' && process.env && process.env.NK_GUARD_AS; return e === '1' ? 1 : 0; }
function guardAsResolve(v) { return v ? 1 : 0; }
function guardAsStep(eng) {
  const m = eng.m;
  const live = m[0x641] === 1 && (m[0x642] & 0x7F) === 2 && !(m[0x643] & 2);
  for (let x = 0; x < 4; x++) {
    const gi = RAM_G + x, ci = RAM_CD + x;
    if (!live || (m[0x4A2 + x] & 0xC0) || m[0x4C2 + x] === 0) { if (m[gi]) m[gi] = 0; if (m[ci]) m[ci] = 0; continue; } // 전투 밖·COM·탈락·HP 0: 상태 지움
    const sel = (m[m[0x4AA + x]] & SEL_BIT) !== 0, was = (m[gi] & 0x80) !== 0;
    let n = m[gi] & 0x7F, cd = m[ci];
    const cur = m[0x49E + x] & 0x7F, inG = cur === A_GUARD || cur === A_STONE;
    const act = (m[0x605 + x] & 8) ? A_STONE : A_GUARD;
    if (cd) cd--;
    if (n) {
      if (sel && (inG || cur === A_STAND)) { // 유지(막기 속도가 0 이 되어 서기로 돌아간 틱도 이어 간다)
        n--;
        if (n === 0) { cd = COOLDOWN_TICKS; if (inG) m[0x49E + x] = A_STAND; }
        else { if (!inG) m[0x49E + x] = act; m[0x523 + x] = 8; m[0x4AE + x] = act | 0x80; }
      } else { // 일찍 뗌 또는 피격·잡힘 등으로 막기가 끊김
        cd = Math.max(COOLDOWN_MIN_TICKS, Math.ceil(COOLDOWN_TICKS * (GUARD_TICKS - n) / GUARD_TICKS)); n = 0;
        if (inG) m[0x49E + x] = A_STAND;
      }
    } else if (sel && !was && cd === 0 && cur < 8 && START_FROM[cur] && !(m[4 + m[0x4AA + x]] & 0xC0)) { // 새로 누른 틱 + 쿨다운 끝 + 서기·걷기·달리기
      n = GUARD_TICKS; m[0x49E + x] = act; m[0x4AE + x] = act | 0x80;
    }
    m[gi] = n | (sel ? 0x80 : 0); m[ci] = cd;
  }
}
function guardAsInstall(eng) {
  const F = eng.code.F, orig = F[TICK_ENTRY]; if (!orig) return;
  F[TICK_ENTRY] = function (s0) { if (eng.guardAS) guardAsStep(eng); return orig(s0); };
}
module.exports = { guardAsInstall, guardAsEnvDefault, guardAsResolve, guardAsStep, GUARD_FRAMES, GUARD_COOLDOWN, TICK_FRAMES, RAM_G, RAM_CD };
