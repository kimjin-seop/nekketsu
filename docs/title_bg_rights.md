# 메인 메뉴 배경(A안) 권리 메모 — 2026-11-21

- 대상: `web/img/title_bg_A.png`(428x240), `web/img/title_bg_A_tile.png`(256x240). 원본 시안 `art/ui_manga/mockups_title/bg_A_1280x720.png`.
- 출처: 원작 ROM 타이틀 화면 캡처 파생(정적 판·두 사람 스프라이트). 생성 스크립트 `art/ui_manga/scripts/title_mock_compose.py` → `title_bg_runtime.py`. AI 생성 없음.
- 상태: 로컬 전용. 공개 배포 전에 권리 판단이 필요하다(진행을 막지 않는 메모). 공개 시 대안 = 시안 C(원작 5색 단순화) 또는 자체 제작 판으로 교체(`web/ui_manga.js` buildTbg 의 두 경로만 바꾸면 됨).
- 2026-11-21 추가: 메인 메뉴 배경은 원작 엔진의 타이틀 화면을 실시간으로 그린다(시작 상태 `data/rom_derived/states/title_fight.json`, ROM 실행 파생물 — 저장소 제외). 화면 하단에 원작 저작권 줄 원문 「©1992 TECHNOS JAPAN CORP.」 과 「Remake by 흑칠랑」 을 표기한다(web/ui_manga.js crEl).

## 원격 ROM 파생물 제공(모바일 M0) 권리 메모 — 2026-11-21
- 대상: `/rom/nekketsu.nes`(원작 ROM)·`/state/*.json`(ROM 실행 파생 시작 상태)·`/engine/gen/code.js`(ROM 에서 뽑은 코드)·`/ui/`(원작 초상·스테이지 프레임·캐릭터 자료).
- 정책: `NK_REMOTE_ASSETS=session` 일 때만 HTTPS + 로그인 세션(손님 sid 또는 계정 토큰) 요청에 원격 제공(`server/asset_gate.js`, analysis/27 「M0 접근 정책」). 기본 off = 루프백 전용(종전).
- 상태: 개발용 스위치. 실제 운영 배포·터널·인프라 설정은 하지 않았다. 원격 제공을 켠 채 외부에 공개하면 원작 ROM 과 파생물의 배포가 되므로 공개 전에 권리 판단이 필요하다(진행을 막지 않는 메모).
