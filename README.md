# 열혈 (nekketsu)

온라인 대전 중계 서버 + 웹 클라이언트. 실행에 필요한 ROM 파생 런타임 파일은 포함하지만 원작 ROM 본체(`analysis/rom/nekketsu.nes`)는 포함하지 않는다(별도 준비).

- 서버: `node server_online.js [포트]` (Node 22.13 이상, `npm ci --omit=dev` 로 ws 설치). 환경변수는 `deploy/ecosystem.config.js` 참조.
- 클라이언트: `web/` (서버가 정적 서빙. 엔진은 `web/worker.js` 워커에서 실행, SharedArrayBuffer 때문에 서버가 COOP/COEP 헤더를 붙인다).
- 엔진·렌더러·사운드: `server/engine/` (직역 생성 코드 `server/engine/gen/` 포함).
- 배포: `deploy/DEPLOY.md`, 배포 폴더 생성 `node deploy/pack.js`, 스모크 `node deploy/smoke.js`.
- 저장소에서 빠진 실행 필수 준비물(ROM 본체): `deploy/EXCLUDED_FROM_GIT.md`.
- 권리 메모: `docs/title_bg_rights.md`. 원작 저작권·상표는 공개 전 별도 확인 필요.
