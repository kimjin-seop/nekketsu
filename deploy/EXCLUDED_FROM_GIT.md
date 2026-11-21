# 저장소에서 빠진 파일 (서버 실행에는 필요)

사용자 결정(2026-11-21)으로 실행에 필요한 ROM 파생 런타임 파일(시작 상태, 직역 엔진 `server/engine/gen/`, 원작 초상, 스테이지 프레임, `web/hd/`, `web/ko_table.json`, `web/mid_frames.json`, `web/img/title_bg_A*.png`, `analysis/ui_rework/characters.json`)은 저장소에 포함했다.
원작 ROM 본체는 저장소에 올리지 않는다. `git clone` 후 아래 한 가지만 서버의 같은 경로에 별도로 채우면 게임이 뜬다.

## A. 실행에 필수 (별도 준비물)
| 경로 | 내용 | 확보 방법 |
|------|------|-----------|
| `analysis/rom/nekketsu.nes` | 원작 ROM 본체(262,160 B). 서버 `/rom/nekketsu.nes`(루프백 또는 세션 요청)와 스토리 이어하기 재현 워커가 읽는다 | 사용자가 직접 서버에 업로드(저장소 금지, `.gitignore` 의 `*.nes`) |

## B. 개발·제작용 (배포 불필요, 저장소 제외)
`tools/`, `test/`, `analysis/` 조사 메모·스크립트·캡처, `art/` 제작물(폰트·로고 1개 제외), `public/`·`server.js`·`server_game.js`(오라클·로컬 서버), `art/ui_manga/` 의 원본·목업·실험물. 로컬 디스크에는 그대로 있다.

## C. 시크릿·런타임·로컬 상태 (항상 제외)
`data/nekketsu.db*`, `data/backup/`, `node_modules/`(서버에서 `npm ci`), `_backup/`, `_verify/`, `_serve*.log|err`, `.env*`, `deploy/dist/`.
운영 DB 는 빈 상태로 시작(스키마 자동 생성).

정확한 필수 목록은 `deploy/pack.js` 의 포함 목록과 대조할 것.
