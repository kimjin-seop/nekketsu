'use strict';
// 기본 공격 전진 이동(사용자 결정 2026-11-22: 「주먹·발차기 연타 중 제자리에 서 있지 말고 조금씩 앞으로 / 대각선 입력이면 대각선으로」,
// 동기 = 두 선수가 거리를 둔 채 제자리 연타만 해서 서로 안 맞는 교착). 원작에 없는 규칙이라 옵션으로 끌 수 있다.
// 옵션 engine.atkStep(기본 false = 원작과 비트 동일. 싱글·오프라인은 항상 이 상태. 온라인 락스텝 대전만 start.cfg.atkStep 으로 켠다):
//   false(또는 환경변수 NK_ATK_STEP=0) = 훅이 아무것도 안 함
//   'dir'  = 방향키(AI 는 방향 바이트)를 누른 방향으로만 전진. 방향 없음 = 제자리(종전과 동일)
//   'auto' = 'dir' + 방향 없음이면 바라보는 쪽으로 전진. 방향 있으면 그 방향(대각선 포함)
//   true   = ATK_STEP_DEFAULT. 환경변수 NK_ATK_STEP=dir|auto(Node 한정)면 엔진 생성 시 그 값으로 켠다(도구·서버 설정용)
// 대상 행동 = 지상 A(0x0F)·지상 B(0x10)(연타 콤보 포함) + 마하 펀치(0x4A)·마하 킥(0x4B). 마하 계열은 보유 캐릭터($0605 bit7/bit6)에서 A/B 가 보통 펀치·킥을 대신하는 지상 연타 기술이라 같이 전진한다(2026-11-22 사용자 보고: 발차기가 안 나감 = B 가 0x4B 로 바뀐 캐릭터).
// 그 밖의 필살기·점프·잡기·던지기·달리기 공격·다운 등은 건드리지 않는다.
// 구현: 위치 적분 f12_9D6D(파일 0x19D6D, 슬롯마다 핸들러 끝에서 호출)의 직전에 x·깊이 속도 RAM($045A/$045F, $0464/$0469)에만 값을 넣는다.
// 핸들러가 직전에 D0B4 로 속도를 0 으로 만든 뒤라 속도 = 우리 값만이고, 실제 이동·벽·경계·지형 처리는 원작 적분/지형 루틴이 그대로 한다.
// 하는 일은 RAM 읽기·쓰기뿐(내부 상태 없음, 시간·난수 없음)이라 스냅샷·락스텝 결정성에 영향 없음. 속도는 1/256 px 단위(틱당).
const INTEGRATE = 0x19D6D;
const ATK_STEP_DEFAULT = 'auto';
const ATK_STEP_SPEED = { x: 128, y: 80 }; // 틱당 1/256 px. x 128 = 0.5px/틱(지상 A 한 방 5틱 ≈ 2.5px), 깊이는 걷기 속도 비(576/1024)에 맞춤. 여기 한 곳에서 조절
function atkStepResolve(v) { return v === true ? ATK_STEP_DEFAULT : v; }
function atkStepEnvDefault() { // 엔진 생성 기본값: 환경변수 NK_ATK_STEP=dir|auto 일 때만 켬(Node 한정), 그 밖에는 false
  const e = typeof process !== 'undefined' && process.env && process.env.NK_ATK_STEP;
  return e === 'dir' || e === 'auto' ? e : false;
}
function atkStepInstall(eng) {
  const F = eng.code.F, orig = F[INTEGRATE]; if (!orig) return;
  const m = eng.m, code = eng.code;
  F[INTEGRATE] = function (s0) {
    const mode = eng.atkStep;
    if (mode && m[0x641] === 1) {
      const X = code.st.X;
      if (X < 4) {
        const a = m[0x49E + X] & 0x7F;
        if ((a === 0x0F || a === 0x10 || a === 0x4A || a === 0x4B) && m[0x644] !== 4) {
          const d = m[0x482 + X], left = (m[0x5B + X] & 0x80) !== 0; // 바라보는 쪽(핸들러가 방향키로 이미 갱신, AI 는 상대 쪽)
          let sx = 0, sy = 0;
          switch (d) {
            case 0x40: sx = 1; break; case 0xC0: sx = -1; break; case 0x00: sy = 1; break; case 0x80: sy = -1; break; // 깊이 + = 위
            case 0x20: sx = 1; sy = 1; break; case 0x60: sx = 1; sy = -1; break; case 0xA0: sx = -1; sy = -1; break; case 0xE0: sx = -1; sy = 1; break;
            default: if (mode === 'auto') sx = left ? -1 : 1; // 방향 없음(0xFF 등)
          }
          if (sx && (sx < 0) !== left) sx = 0; // 바라보는 반대쪽(뒤)으로는 가지 않는다(사람은 방향키로 돌아서므로 사실상 AI 쪽 보호)
          if (sx || sy) {
            const vx = sx * ATK_STEP_SPEED.x, vy = sy * ATK_STEP_SPEED.y;
            m[0x45A + X] = vx & 0xFF; m[0x45F + X] = (vx >> 8) & 0xFF; m[0x464 + X] = vy & 0xFF; m[0x469 + X] = (vy >> 8) & 0xFF;
          }
        }
      }
    }
    return orig(s0);
  };
}
module.exports = { atkStepInstall, atkStepEnvDefault, atkStepResolve, ATK_STEP_SPEED, ATK_STEP_DEFAULT };
