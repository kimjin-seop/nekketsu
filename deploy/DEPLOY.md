# 열혈 nekketsu.oddplay.kr 배포 절차서 (초안, 2026-11-21)

상태: **준비물과 절차만 작성. 서버 접속·DNS·nginx·certbot·pm2·업로드는 아무것도 실행하지 않았다.** 실제 서버 정보는 아직 없다(6절 목록).
같은 방식으로 서비스 중인 사례: tank(`tank/deploy/`, tank.oddplay.kr 포트 3200)·liero(포트 3000) = pm2 fork 1개 + nginx 80 서버 블록 + `certbot --nginx`.

## 0. 먼저 알아야 할 것 (차단·결정 사항)

1. **차단: 현재 클라이언트는 원격 접속에서 게임이 뜨지 않는다.** 서버는 원작 ROM·시작 상태·초상 등(`/rom/ /state/ /ui/ /engine/gen/`)을 루프백 요청에만 주거나(NK_REMOTE_ASSETS=off, 원격 403),
   `session` 모드에서 **HTTPS + 쿠키 `nk_sess`(손님 sid 또는 계정 토큰) 또는 헤더 `X-NK-Session`** 이 있는 요청에만 준다(analysis/27 「M0 접근 정책」). 그런데 `web/` 에는 `nk_sess` 쿠키를 세우는 코드가 아직 없고
   (grep 0건), `game.js`·`opening_scene.js`·`worker.js` 는 페이지 로드 즉시 `/rom/nekketsu.nes`·`/state/boot_title.json`·`/engine/gen/code.js` 를 받는다 → 원격에서는 403 으로 「ROM 불러오기 실패」가 난다.
   M0 문서의 「필요한 클라이언트 변경(윤프론)」 ①②③(로그인·손님 welcome 뒤 쿠키 설정, 세션 확보 뒤로 ROM 로드 지연, 403 시 로그인 안내)이 구현돼야 「현재 버전 배포」가 실제로 플레이된다.
   `smoke.js` 가 이를 확인한다(원격 흉내 요청 + 세션 쿠키 → 200, 쿠키 없음 → 403). 브라우저 실화면 원격 검증은 하지 못했다.
2. **결정: ROM·ROM 파생물을 공개 서버에 올린다**(아래 5절 목록). 사용자 결정 「현재 버전으로 배포」에 포함된 사실이며 법무는 개발을 막지 않는다. 다만 `oddplay_portal/docs/RIGHTS_NOTES.md` 가 열혈을 「여섯 중 위험 최대」로 적어 두었다.
3. **결정: 계정·랭킹 데이터 이전 여부** → 7절. 권고 = 이전하지 않고 빈 DB 로 시작.
4. 포털(`oddplay_portal`)의 열혈 카드는 `soon` 이다. 배포 후 `play` 로 바꾸려면 포털 쪽 별도 작업(이 폴더 밖).

## 1. 사전 요건

| 항목 | 요건 | 근거 |
|---|---|---|
| 서버 Node | **22.13 이상**(22.5~22.12 는 `node_args: '--experimental-sqlite'`). 로컬은 v25.7.0 | `server/store/db.js` 가 내장 `node:sqlite` 사용 |
| 네이티브 빌드 | **불필요**. better-sqlite3 없음. 의존성은 순수 JS `ws@^8.23.0` 하나(`package-lock.json` 동봉) | `package.json` |
| OS·아키텍처 | 제한 없음(Windows 에서 만든 배포 폴더를 그대로 Linux 에 복사해도 된다) | 위 |
| pm2 | 서버에 있음(tank·liero 가 사용 중이라고 전제 — 미확인) | 사례 |
| nginx·certbot | 서버에 있음(전제 — 미확인) | 사례 |
| 포트 | 앱 3600(초안). 서버에서 이미 쓰는 포트(liero 3000, tank 3200, 그 밖에 통키·레전드 등) 확인 후 확정 | 6절 |
| DNS 권한 | oddplay.kr 의 DNS 편집 권한(또는 요청 상대) | 4절 |
| 디스크 | 배포 폴더 약 52 MB + DB 성장분 + 마이그레이션 백업 | 3절 |
| 프로세스 수 | **1개 고정**(방·락스텝 상태 메모리 보관, 재시작하면 진행 중 대전 소실) | server_online.js |

## 2. 패키징 (로컬, 업로드 안 함)

```
cd C:\Users\김진섭\Works\nekketsu
node deploy/pack.js          # → deploy/dist/ 생성(기존 dist 는 지우고 다시 만든다)
node deploy/smoke.js 8861    # dist 만으로 임시 포트 기동 → 36개 확인 → 서버 종료
```
- 화이트리스트 방식(목록에 있는 것만 복사). 끝에 제외 폴더 검사·시크릿 grep 을 하고 `MANIFEST.txt`(구분·크기·sha256·경로)를 만든다. 문제가 있으면 종료 코드 1.
- 2026-11-21 실행 결과: **파일 399개(+MANIFEST.txt), 51.4 MB** (rom 279개 38.2 MB · font 5개 12.1 MB · asset 76개 0.7 MB · code 39개 0.4 MB). 시크릿 의심 0건, 제외 대상 0건, 스모크 PASS 36 / FAIL 0.
- 폰트는 Galmuri 3종(9·11·11-Bold, 12 MB)만 쓴다(웹이 요청하는 것만). 용량이 문제면 서버에서 압축본이 캐시되므로 그대로 둬도 된다.
- 업로드 방법(rsync·scp·git 등)은 서버 접속 방식 확정 후 결정(6절). 이 폴더는 git 저장소가 아니다.

### 제외한 것 (배포 폴더에 없음)
`_backup/`(41 MB) `_verify/`(1.1 GB) `analysis/`(ROM 1개·characters.json·스테이지 프레임 20개 외 전부) `art/`(폰트 3종·logo_ko_1x.png·portraits_orig 외 전부: sprites·sheets·bg·ui 등) `docs/` `test/` `tools/` `public/` `server.js`·`server_game.js`(오라클·로컬 8770 서버)
`data/nekketsu.db*`·`data/backup/`(개발 DB·마이그레이션 백업) `data/rom_derived/` 중 `states/` 밖(디스어셈블·gfx 등 분석물) `*.log` `.env*`(없음) `_serve*.log` `deploy/` 중 ecosystem 외. 서버 로그가 아닌 개발 로그 `_serve3500.log` 등은 포함하지 않았다.

## 3. 서버 준비 (tank 사례와 같은 순서, 경로는 확정 필요)

```
# 1) 디렉터리(예: /data/www/nekketsu — tank 가 /data/www/tank 를 쓴 관례. 확정 필요) — 실행 유저는 tank·liero 와 같은 유저
sudo mkdir -p /data/www/nekketsu && sudo chown <유저>: /data/www/nekketsu
# 2) 배포 폴더 내용을 /data/www/nekketsu/ 로 복사(예: rsync -a --delete --exclude data/ deploy/dist/ <서버>:/data/www/nekketsu/)
#    주의: --delete 를 쓸 때 data/ 를 반드시 제외(DB 보호). 최초에는 data/ 가 빈 폴더.
# 3) 의존성 확인: node_modules/ws 가 이미 들어 있다. 다르게 하려면  cd /data/www/nekketsu && npm ci --omit=dev
# 4) 권한: DB 폴더(data/)는 실행 유저만 쓰기(앱이 data/ 를 0700, DB 파일을 0600 으로 만든다. POSIX 한정). 코드 폴더는 읽기 전용이면 충분
# 5) pm2
cd /data/www/nekketsu && pm2 start deploy/ecosystem.config.js && pm2 save
# 6) nginx
sudo cp deploy/nginx-nekketsu.oddplay.kr.conf /etc/nginx/sites-available/nekketsu.oddplay.kr   # ← 이 파일은 배포 폴더에 포함되지 않으므로 저장소의 deploy/ 에서 따로 올린다
sudo ln -s /etc/nginx/sites-available/nekketsu.oddplay.kr /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```
- `deploy/nginx-…conf`·`DEPLOY.md`·`pack.js`·`smoke.js` 는 배포 폴더(dist)에 넣지 않는다(dist 에는 `deploy/ecosystem.config.js` 만). nginx 파일은 따로 올려라.
- 마이그레이션 백업: 새 DB 는 `user_version 0` 이라 백업이 안 생긴다. 이후 업데이트에서 스키마가 바뀌면 `data/backup/` 에 `VACUUM INTO` 사본이 자동 생성되고, 만들 수 없으면 기동이 멈춘다(디스크·권한 확인).

## 4. DNS · HTTPS

- DNS: `nekketsu.oddplay.kr` **A 레코드 → 서버 IPv4**(tank·liero 와 같은 서버라면 같은 IP). 서버가 IPv6 를 받는다면 AAAA 도(nginx 에 `listen [::]:80` 이 있다). TTL 은 기본값. 전파 확인: `nslookup nekketsu.oddplay.kr`.
- 인증서: DNS 가 전파된 뒤 `sudo certbot --nginx -d nekketsu.oddplay.kr` (nginx 파일에 443 server 블록과 80→443 리디렉트가 자동 부착된다. tank 와 같은 방식이라 직접 443 을 쓰지 않았다). 갱신은 서버의 certbot 타이머에 따른다(기존 사이트와 동일).
- certbot 이 만든 443 블록에도 `/ws` location 과 위 헤더가 그대로 따라오는지 `sudo nginx -T | grep -A12 nekketsu` 로 확인.
- HTTPS 는 선택이 아니다: `crossOriginIsolated`(SharedArrayBuffer)가 HTTPS 에서만 켜지고, 원격 ROM 제공 게이트도 HTTPS 만 허용한다. LAN `http://` 접근은 지원하지 않는다.

## 5. 서버에 올라가는 ROM·ROM 파생물 (사용자에게 알리는 사실)

구분은 `deploy/dist/MANIFEST.txt` 첫 칸(`rom`)과 같다. 서빙 정책: 원격에는 `NK_REMOTE_ASSETS=session` 이라 세션 없는 요청은 403, 세션 있으면 HTTPS 에서 **그대로 내려간다(= 사용자 브라우저에 ROM 이 전달된다).**

| 경로(배포 폴더 기준) | 내용 | 크기 | 원격 서빙 | 서버가 읽는 용도 |
|---|---|---|---|---|
| `analysis/rom/nekketsu.nes` | **원작 FC ROM 본체**(262,160 B) | 0.25 MB | `/rom/nekketsu.nes`(세션) | 스토리 이어하기 서버 재현 워커 |
| `data/rom_derived/states/*.json` (36개) | ROM 실행 파생 시작 상태 | 1.1 MB | `/state/`(세션) | `boot_title.json` 은 서버 재현에도 사용 |
| `server/engine/gen/*` (3개) | ROM 직역 생성 코드(`code.js` 3.2 MB 등) | 6.6 MB | `/engine/gen/`(세션) | 서버 재현·엔진 지문 |
| `art/ui_manga/portraits_orig/{hud,body,cutin}` (174개) | 원작 초상 추출물 | 0.12 MB(이미지 목록 크기는 MANIFEST 참조) | `/ui/portraits_orig/`(세션) | 없음 |
| `analysis/hd_survey/out/stage_*_frame_bg.png` (20개) | 원작 스테이지 프레임 | 0.1 MB | `/ui/stage_N.png`(세션) | 없음 |
| `analysis/ui_rework/characters.json` | 원작 캐릭터 수치·필살기 이름 자료 | 26 KB | `/ui/characters.json`(세션) | 없음 |
| `web/hd/*.webp` (40개) | 원작 스테이지 배경 HD 재작화(원작 화면 기반) | 31.8 MB | **`/hd/` — 게이트 없음, 누구나 받음** | 없음 |
| `web/ko_table.json` | **ROM 일본어 원문 + 한글 덧그리기 표** | 29 KB | **게이트 없음** | 없음 |
| `web/mid_frames.json` | 보간 프레임 자료(ROM 파생) | 34 KB | 게이트 없음 | 없음 |
| `web/img/title_bg_A*.png` | 원작 타이틀 화면 캡처 파생 배경 | 5.6 KB | 게이트 없음 | 없음 |
| 그 밖의 `web/` | 클라이언트(JS·CSS), 자체 제작 UI 그림 | — | 게이트 없음 | 없음 |

- 주의: `web/` 아래 ROM 파생물(위 표 `web/…`)은 **세션 게이트 밖**이라 NK_REMOTE_ASSETS=session 이어도 인터넷에 그대로 공개된다. 게이트를 확장하려면 코드 수정이 필요(이 담당 범위 밖, 결정 필요).
- 화면 하단 표기 「©1992 TECHNOS JAPAN CORP.」·「Remake by 흑칠랑」은 클라이언트가 이미 표시한다(docs/title_bg_rights.md).
- 폰트 Galmuri 3종은 SIL OFL 1.1(`art/fonts/galmuri/LICENSE.txt`·`ofl.md` 동봉).

## 6. 환경변수 표 (ecosystem.config.js 초안에 반영됨)

| 변수 | 값(초안) | 필수 | 설명·근거 |
|---|---|---|---|
| `PORT` (또는 argv[2]) | 3600 | 예 | 기본 3500(개발). 서버 포트 현황 확인 후 확정. nginx `proxy_pass` 와 일치 |
| `HOST` | 127.0.0.1 | 예 | nginx 뒤. 직접 외부에 열지 않는다 |
| `ALLOWED_HOSTS` | nekketsu.oddplay.kr | 예 | 없으면 Host 가 localhost 가 아닌 요청은 403 |
| `STATIC` | 1 | 예 | HOST 가 루프백이라도 ALLOWED_HOSTS 가 있으면 명시해야 정적 서빙이 켜진다(없으면 모든 경로 404) |
| `NK_REMOTE_ASSETS` | session | 예 | off(기본)이면 원격에 ROM 이 나가지 않아 게임이 안 뜬다. 0절 1번 참조 |
| `NK_TRUST_PROXY` | 1 | **예(통키 사고 재발 방지)** | 없으면 모든 접속이 127.0.0.1 하나로 보여 `MAX_CONNS_PER_IP`(8)로 대량 차단, 랭크 SAME_IP 오판, HTTPS 판정 실패(원격 ROM 403). 통키 HANDOFF 의 TRUST_PROXY 사고와 같은 종류 |
| `NK_TRUST_PROXY_HOPS` | 1 | 예 | nginx 1단. 앞에 프록시/CDN 이 더 있으면 올린다 |
| `NK_DB_PATH` | `<배포폴더>/data/nekketsu.db` | 예 | 없으면 계정·랭킹·이어하기·프로필 기능이 모두 꺼진다(`err acct_off`). 통키 DB 와 별개 파일 |
| `NK_DB_BACKUP_DIR` | (기본 DB 옆 backup/) | 아니오 | 스키마 마이그레이션 전 사본 위치 |
| `NK_STORY_WORKERS` / `NK_STORY_QUEUE` / `NK_STORY_TIMEOUT_MS` | 2 / 8 / 180000(기본) | 아니오 | 이어하기 재현 스레드(CPU 사용). 서버 코어 수 확인 후 조정 |
| `MAX_CONNS` `MAX_CONNS_PER_IP` `MAX_ROOMS_PER_IP` | 400 / 8 / 4(기본) | 아니오 | 모바일 데이터망 공유 IP(CGNAT)를 감안해 운영 중 조정 가능 |
| `GRACE_MS` | 20000(기본) | 아니오 | 끊김 뒤 재접속 대기 = 손님 sid 유효 시간(원격 ROM 세션도 이 시간 안에서만 유효) |
| `NK_ROOM_HOST_START` | (미설정 = 켜짐) | 아니오 | 설정 `0` = 방장 시작 규칙 해제(기본 사용) |
| `NK_RANK_ALLOW_SAME_IP` | **넣지 않는다** | — | 로컬 시험용(같은 IP 대전 반영). 운영에서 켜면 다중 접속 랭크 조작 가능 |
| `LEGACY_ROOMS` `PROVISIONAL` `PREFILL` `COUNT_MS` 등 | 기본값 | — | 검증 도구·시험용. 건드리지 않는다 |
| `ADMIN_ACCOUNTS` | **해당 없음** | — | 열혈에는 관리자 계정·공지 기능이 없다(통키 전용). 시크릿성 환경변수 없음 |

## 7. 데이터·DB (결정 필요)

- 구조: SQLite 파일 하나(`data/nekketsu.db`, WAL 이므로 `-wal`·`-shm` 포함 3파일이 한 세트). 첫 기동에 스키마(v1~현재 버전)를 자동 생성한다(`openDb` → `migrate`). 표: accounts(닉·scrypt 해시·솔트), auth_tokens(토큰 해시, 30일), ratings·rank_games·ladder 시즌·ratings_archive, story_saves(이어하기 스냅샷), 프로필·보상 표(v4). (근거: `server/store/db.js` 마이그레이션 주석. 개발 DB 는 읽지 않았다.)
- **권고: 개발 DB 를 이전하지 않고 빈 DB 로 시작.** 이유: 개발 중 만든 테스트 계정·테스트 랭킹·시험 대전 기록이 공개 랭킹과 시즌 정산(프로필 칭호 등)에 섞인다. 개발 DB 는 마이그레이션 백업 3개(v2→v3→v4→v5)를 거친 시험 데이터다.
- **결정 필요(사용자)**: ① 개발 계정·랭킹을 옮길지(권고: 아니오) ② 옮긴다면 어떤 계정만(옮기려면 서버 정지 → `-wal`·`-shm` 포함 3파일을 같이 복사 또는 `VACUUM INTO` 사본, 별도 최디비 검토 필요) ③ 첫 공개 시즌 시작 시점(새 DB 의 시즌 시작 시점은 코드로 확인하지 않음).
- 비밀번호 해시는 DB 안에만 있고 환경변수·코드에 시크릿은 없다. DB 파일 권한 0600(POSIX).
- 백업 권장: 일 1회 `sqlite3 data/nekketsu.db ".backup '<경로>'"` 또는 pm2 중지 없이 `VACUUM INTO`(서버에 sqlite3 CLI 가 있을 때). 방법은 서버 환경 확정 후.

## 8. 기동 후 확인 (순서대로)

서버 안에서:
```
pm2 status                                   # nekketsu online, 재시작 횟수 0
pm2 logs nekketsu --lines 30                 # "http://127.0.0.1:3600/ (웹소켓 /ws, 정적 서빙 켬, 계정·랭킹 DB …)"
curl -s http://127.0.0.1:3600/online/status -H 'Host: nekketsu.oddplay.kr'   # {"proto":3,"rooms":0,...}
```
밖에서(DNS·인증서 뒤):
| URL | 기대 |
|---|---|
| `http://nekketsu.oddplay.kr/` | 301 → https |
| `https://nekketsu.oddplay.kr/` | 200 + 응답 헤더 `Cross-Origin-Opener-Policy: same-origin`·`Cross-Origin-Embedder-Policy: require-corp`(`curl -sI`) |
| `https://nekketsu.oddplay.kr/online/status` | 200 JSON(`proto`·`rooms`) |
| `https://nekketsu.oddplay.kr/rom/nekketsu.nes` (세션 없이) | **403**(200 이면 게이트 오작동 → 즉시 중지) |
| `https://nekketsu.oddplay.kr/state/boot_title.json`·`/ui/characters.json`·`/engine/gen/code.js` (세션 없이) | 403 |
| `https://nekketsu.oddplay.kr/hd/stage0_hd_3x.webp` | 200(게이트 없음) |
| `https://nekketsu.oddplay.kr/fonts/Galmuri11.ttf`, `/logo/logo_ko_1x.png` | 200 |
| `wss://nekketsu.oddplay.kr/ws` | 101 업그레이드(브라우저 콘솔 또는 `wscat -c wss://nekketsu.oddplay.kr/ws` 로 `{"t":"hello","name":"점검"}` → `welcome`) |
| 브라우저 실제 플레이 | 0절 1번 클라이언트 변경 후에만 의미가 있다: 타이틀 → 온라인 → 방 만들기 → 두 번째 브라우저로 참가 → 대전 시작 |

## 9. 로그·모니터링

- 앱 로그: `pm2 logs nekketsu`(시간 접두 포함). 대전 방 생성·종료·desync 등이 찍힌다. 로그 회전: `pm2 install pm2-logrotate`(서버에 이미 있으면 공통 적용).
- 운영 확인: `/online/status`(방 수·이름 수·누계, 개인정보 없음). `desync` 숫자가 늘면 클라이언트·엔진 지문 불일치(배포 중 새로고침 안 한 사용자 등).
- nginx: `/var/log/nginx/access.log`·`error.log`. 의심 IP 집계는 통키 HANDOFF 의 `limit_req` 예시를 같은 방식으로 적용 가능(`/ws` 에 `limit_req`/`limit_conn`). 앱 자체 제한이 이미 있다(접속·방·실패 횟수).
- 메모리: `max_memory_restart: 600M`(초안). 재시작하면 대전 중인 방이 사라지므로 운영 중 실측 후 조정.

## 10. 업데이트·롤백

- 업데이트: 로컬에서 `node deploy/pack.js` → 새 dist 를 **이전 버전과 별도 폴더**로 업로드(`/data/www/nekketsu_releases/<날짜>/`) → `data/` 는 심볼릭 링크 또는 공통 폴더로 공유 → 전환 시점에 `pm2 restart nekketsu`. 클라이언트는 `ETag`/`no-cache` 로 즉시 새 파일을 받는다. 엔진 지문이 바뀌면 열려 있던 방은 「엔진·ROM·시작 상태 지문이 다릅니다」 로 시작이 거절되므로 사용자가 새로고침해야 한다.
- **롤백(코드)**: 직전 릴리스 폴더로 `current` 링크(또는 pm2 `cwd`)를 되돌리고 `pm2 restart nekketsu`. DB 는 코드와 무관하게 `data/` 에 남는다.
- **롤백(스키마가 바뀐 릴리스였다면)**: 기동 전에 자동 생성된 `data/backup/nekketsu_v<이전>_before_v<새>_*.db` 를 pm2 정지 상태에서 `data/nekketsu.db` 로 복사(`-wal`·`-shm` 은 지운다)한 뒤 이전 코드로 기동. 사본이 있는 시점 이후의 계정·랭킹 변동은 사라진다.
- **긴급 비공개(ROM 노출 즉시 차단)**: `pm2 stop nekketsu`(nginx 는 502). 또는 `sudo rm /etc/nginx/sites-enabled/nekketsu.oddplay.kr && sudo nginx -t && sudo systemctl reload nginx`. 완전 철수는 `pm2 delete nekketsu` + 배포 폴더 삭제 + DNS 레코드 제거.
- 최초 배포 롤백 = 위 긴급 비공개와 같다(원래 아무것도 없던 서브도메인이므로 되돌리기 쉽다).

## 11. 알려진 위험

1. **원격 세션 클라이언트 미구현(0절 1번)** — 이대로 배포하면 접속자는 「ROM 불러오기 실패」 화면을 본다. 서버 쪽 게이트는 시험 통과(`node --test test/asset_gate.test.js` 3/3 은 별도 기록, 이번 작업에서 재실행하지 않음).
2. **세션 게이트 밖 ROM 파생물**: `web/hd/`(31.8 MB)·`ko_table.json`(ROM 일본어 원문)·`mid_frames.json`·`title_bg_A*.png` 는 누구나 받을 수 있다(5절).
3. **원작 ROM 이 세션 있는 모든 방문자에게 전달된다**(손님 sid 만으로 충분 — 로그인 불필요). 권리 문제는 개발 비차단이지만 포털 RIGHTS_NOTES 의 최고 위험 항목이다.
4. `NK_TRUST_PROXY` 누락 시 전원 동일 IP 로 계산(통키 사고 재현) → 6절. nginx 가 XFF 를 안 넘기면 같은 효과(nginx 파일은 넘기도록 썼다).
5. 프로세스 1개·메모리 상태: 재시작·크래시 시 진행 중 대전·대기방 소실(이어하기·계정은 DB 라 유지). 락스텝 서버라 동시 대전 규모에 따른 CPU 는 실측 없음(서버 사양 미확인).
6. 이어하기 서버 재현 워커(2 스레드)는 CPU 를 쓴다 — 서버가 다른 게임과 코어를 공유하면 영향 가능. 사양 확인 필요.
7. Node 22.x 에서 `node:sqlite` 가 ExperimentalWarning 을 낸다(동작에는 영향 없음). 서버 Node 가 22.13 미만이면 기동 실패(메시지로 안내됨).
8. 서버 OS 에서의 실제 기동은 확인하지 못했다(로컬 Windows·Node v25.7.0 에서만 스모크). Linux 에서 `fs.chmod` 0700/0600 경로는 로컬에서 실행되지 않았다.
9. 모바일(터치 패드 M1·레이아웃 M2)은 개발 중이라 「현재 버전」 배포 시 PC 중심이다(포털도 `soon`).
10. 3500 개발 서버·개발 DB 는 이 작업에서 접근하지 않았다(ecosystem 의 포트 3600 은 개발 3500 과 겹치지 않게 잡은 초안).

## 12. 사용자에게 받아야 할 정보

1. 서버 접속 방법(ssh 호스트·유저·키 방식, 업로드 경로 허용 여부) — **실행은 팀장/사용자 승인 후**
2. 배포 경로(`/data/www/nekketsu` 관례를 따를지), 실행 유저, 기존 앱들과 같은 서버인지
3. 프로세스 관리: pm2(ecosystem 초안) 맞는지, systemd 인지, pm2 실행 유저·`pm2 save`/startup 상태
4. 서버 Node 버전(22.13 이상 필요), CPU 코어·메모리
5. 사용 중인 포트 목록(3600 가능 여부), nginx 가 다른 앞단(CDN·Cloudflare) 뒤인지(HOPS 값)
6. DNS 권한: 누가 `nekketsu.oddplay.kr` A(/AAAA) 레코드를 추가하는지, 서버 공인 IP
7. certbot 이메일·기존 사이트와 같은 방식 사용 가능 여부(sudo 권한)
8. 결정: 빈 DB 로 시작할지(권고) / 개발 계정·랭킹 이전 여부
9. 결정: 원격 클라이언트 세션 구현(0절 1번)을 먼저 할지, ROM 파생물 중 게이트 밖(`web/hd` 등) 처리 방침
10. 포털 카드를 `soon` → `play` 로 바꾸는 시점
