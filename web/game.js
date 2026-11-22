'use strict';
// 자체 엔진 웹 클라이언트. 에뮬(public/nes.js)을 쓰지 않는다: 엔진(server/engine/core.js + gen/code.js) + 렌더러(render.js) + APU 합성기(apu.js).
// 화면: 16:9 아트 캔버스 432x240, 코어 256x240 은 가운데(x=88)에 원본 그대로(최근접 정수배). 좌우 88px 는 빈 영역(한글 UI 계층 자리).
//   와이드 장식(13 문서 13절·15절, ?classic=1 제외): 코어 밖(캔버스 좌우 88px + 캔버스 밖 창 여백)을 CSS 배경(index.html .nk-wide #stage: 그라데이션 + 옅은 망점)과 코어 둘레 창틀로 채운다.
//   전투 필드 확대(13 문서 15절): 신규 게이지 패널이 뜨는 전투에서는 원작 하단 HUD 띠(라인 188~239)를 화면에서만 가리고(clip-path, 캔버스 픽셀·엔진 불변) 필드(0~187)를 창 높이에 맞춰 키운다.
// 구조: 엔진은 워커(web/worker.js)에서 돌고 프레임 경계마다 멈춘다. 이 스레드는 60.0988Hz 누산기(소리 대기열 수준에 따라 ±0.1% 이내 보정)로 프레임을 허가하고, 받은 화면·소리를 내보낸다.
//   패드는 공유 메모리(ctl)에 계속 써 두고, 엔진이 원작의 패드 스트로브 시점마다 읽는다(일시정지처럼 메인 루프로 돌아오지 않는 구간도 프레임마다 반영).
//   SharedArrayBuffer 가 필요해 server_game.js 가 교차 출처 격리 헤더(COOP/COEP)를 붙인다.
(function () {
  const cv = document.getElementById('c'), ctx = cv.getContext('2d'), info = document.getElementById('info'), stage = document.getElementById('stage'), msg = document.getElementById('msg');
  const DEBUG = /[?&]debug/.test(location.search);
  const STATE = (/[?&]state=([a-z0-9_]+)/.exec(location.search) || [])[1] || 'boot_title'; // 시작 상태(data/rom_derived/states/<이름>.json)
  // 기본 주소(쿼리 없음) = 신규 타이틀·모드 선택 층(web/ui_menu.js) + 한글 덧그리기 켬. ?classic=1 = 종전의 원작 메뉴 경로(신규 층 없음, 한글 층은 ?ko=1·K 키로만).
  const CLASSIC = /[?&]classic=1(&|$)/.test(location.search);
  const MENU = !CLASSIC && !/[?&]state=/.test(location.search) && !!window.NKMenu && !!window.NKDriver; // 시작 상태를 지정한 주소(?state=)는 그 상태에서 바로 시작한다
  // 메뉴 층 고르기(analysis/15_ui_manga_impl.md): 신규 UI 층 v2(web/ui_manga.js, NKManga)가 있고 켜져 있으면 그것을, 아니면(?ko=0 · ?ui=menu · 파일 없음) 종전 층(web/ui_menu.js, NKMenu)을 쓴다. 두 층은 같은 계약(init·show·hide·state)이다
  let UI = MENU && window.NKManga && window.NKManga.enabled ? window.NKManga : window.NKMenu;
  // 신규 UI 층 2단계(15 문서 9절): 일시정지 메뉴·설정·결과 화면. MG = 신규 층이 켜진 주소에서만(?classic=1 · ?ko=0 · ?ui=menu 는 종전 그대로)
  const MG = !CLASSIC && window.NKManga && window.NKManga.enabled ? window.NKManga : null;
  // 깜박임 제거(analysis/24_flicker_removal.md): 렌더러(server/engine/render.js)가 워커에서 ctl[NF] 를 프레임마다 읽어, 켜져 있으면 라인당 스프라이트 8개 제한을 풀고 원작의 OAM 뒤집기를 되돌려 그린다(표시만, 엔진·RAM·소리 불변).
  //   기본 켬(설정 「깜박임 제거」, nk_manga_settings.nf). ?classic=1 은 늘 끔(원작 화면 그대로). ?nf=0 · ?nf=1 = 설정과 무관하게 끔·켬(비교용)
  const NF = 9, NF_Q = (/[?&]nf=([01])(&|$)/.exec(location.search) || [])[1];
  let nfSet = 1;
  const nfOn = () => !CLASSIC && (NF_Q !== undefined ? NF_Q === '1' : !!nfSet);
  function applyNf() { if (ctl) Atomics.store(ctl, NF, nfOn() ? 1 : 0); }
  // 게임 속도(로컬 전용, analysis/07_status.md): 프레임 허가 누산기(tick)에 배율을 곱한다(화면·게임만 빨라짐). 소리는 음 높이·템포 그대로: 배율을 ctl[SPD] 로 워커에 알리면 워커의 소리 시계(web/sound_clock.js)가
  //   사운드 드라이버를 실시간 60Hz 로 따로 돌려 프레임당 약 734/배율 샘플을 보낸다(pushAudio 는 리샘플 없이 그대로 낸다). 엔진(core·gen/code·apu)·워클릿 불변, 1배속이면 소리도 종전과 비트 동일.
  //   선택지 1 · 1.15 · 1.3 · 1.5. 설정 nk_manga_settings.speed(없거나 범위 밖(옛 값 1.25·2 포함) = 혼자 하기 기본 1.3), onSettings 가 오기 전은 1.0. 온라인·?classic=1 은 늘 1.0. ?speed=1|1.15|1.3|1.5 = 설정과 무관하게 고정(검증용, ?nf= 와 같은 방식)
  const SPEEDS = [1, 1.15, 1.3, 1.5], SPEED_DEF = 1.3, SPEED_Q = (/[?&]speed=(1|1\.15|1\.3|1\.5)(&|$)/.exec(location.search) || [])[1];
  //   적용 범위 = 실제 시합 진행(선수 조작 구간)만: 엔진 RAM $0641 = 1 · $0642 하위 7비트 = 2(일시정지 메뉴를 여는 canPause 와 같은 판정). 그 밖(타이틀·메뉴·대기실·대진표·스토리 대사·
  //   시합 전 「FIGHT!!」 연출 1:4·승패 연출 1:5·결과 10 등)은 늘 1.0(analysis/07_status.md 15절). RAM 은 워커가 넘긴 최근 프레임 사본(mirror.m)을 읽기만 한다
  let speedSet = 1;
  const inFight = m => m[0x641] === 1 && (m[0x642] & 0x7F) === 2;
  const spd = () => online ? (CLASSIC ? 1 : Math.min(1.5, Math.max(1, +(online.cfg && online.cfg.speed) || 1))) /* 온라인 = 서버 start.cfg.speed(server_online.js ONLINE_SPEED) 고정, 없으면 1 */ : CLASSIC || !inFight(mirror.m) ? 1 : (v => window.NKCamTrig ? window.NKCamTrig.speed(v) : v)(SPEED_Q !== undefined ? +SPEED_Q : speedSet); // NKCamTrig.speed = 판이 끝나는 KO 슬로우(web/cam_triggers.js, 로컬 전용·1배 미만 없음)
  function speedOf(v) { // 설정 값 → 배율. 설정 객체에 speed 칸이 없으면 저장소 값, 그것도 없으면 기본값
    if (v === undefined) try { const j = JSON.parse(localStorage.getItem('nk_manga_settings') || 'null'); if (j) v = j.speed; } catch (e) { /* 저장소를 못 쓰면 기본값 */ }
    return SPEEDS.indexOf(+v) >= 0 ? +v : SPEED_DEF;
  }
  let HD = null, hdLoad = false; const HD_Q = (/[?&]hd=([01])(&|$)/.exec(location.search) || [])[1]; // 2026-11-21 기본 켬(설정 nk_manga_settings.hd, web/settings.js. 모바일 폭은 기본 끔), ?hd=0 · ?hd=1 = 설정과 무관하게 끔·켬, ?classic=1 은 늘 끔. 표시 전용(워커는 PPU·스프라이트 사본만 더 보낸다).
  const hdWant = () => !CLASSIC && (HD_Q !== undefined ? HD_Q === '1' : !!(window.NKSettings && window.NKSettings.get('hd') && !(window.NKQuality && window.NKQuality.off('hd')))); // 품질 단계 보통·낮음 = HD 끔(web/quality.js)
  function loadHd() { // 처음 켤 때 한 번만 불러온다. 준비·그림 로드 실패는 hd_layer.js 가 원작 배경으로 폴백(조용히)
    if (hdLoad || !ctl) return; hdLoad = true; Atomics.store(ctl, KOF, 1); Atomics.store(ctl, 8, 1);
    const s = document.createElement('script'); s.src = 'hd_layer.js'; s.onload = () => { window.NKHd.init({ chr: romChr, canvas: cv }).then(() => { if (window.NKHd.ready) HD = window.NKHd; }); }; s.onerror = () => console.warn('hd_layer.js 불러오기 실패(원작 배경)'); document.head.appendChild(s);
  }
  // 종전 주석: 전투 배경 HD 층(web/hd_layer.js, analysis/16 4.2절): 주소에 ?hd=1 이 있을 때만 불러온다. 기본 꺼짐(파일도 안 읽는다)
  let TAGS = null; // 선수 표시 층(web/unit_tags.js, 표시 전용): 신규 UI 층 주소에서만 불러온다(?classic=1 · ?ui=menu 는 없음). 프레임마다 RAM 사본을 넘겨 받기만 한다
  let FX = null; // 타격 이펙트 층(web/hit_fx.js, 표시 전용): TAGS 와 같은 조건에서만 불러온다. 프레임마다 RAM 사본을 넘겨 받기만 한다
  let MID = null; // 표시층 스프라이트 합성기(시범, analysis/18_interpolation.md 7절. web/sprite_layer.js): 주소에 ?mid=1 이 있을 때만 불러오고 워커에 스프라이트 사본(ctl[8])을 요청한다. 기본은 꺼짐(파일도 안 읽는다)
  let vol = 1, scaleSet = 0, endRam = null, resumeAt = 0, gpStart = false, turbo = false; // vol·scaleSet = 설정(음량 0~1, 화면 배율 0 자동 · 1 꽉 채우기 · 2~4 = n배), endRam = 전투 종료(1:5) 진입 프레임의 RAM, turbo = 스모크용 빨리 감기(__game.turbo)
  const CW = 432, CH = 240, OX = (CW - 256) >> 1;
  const WIDE = !CLASSIC; // 와이드 장식: 캔버스 좌우는 투명(배경이 비친다), 배율은 코어(256x240)가 창에 들어가는 최대 정수배(세로 화면에서 좌우 여백 때문에 코어가 작아지지 않게. 넘치는 캔버스 좌우는 잘린다)
  if (WIDE) document.documentElement.classList.add('nk-wide'); // 배경 그림은 CSS(index.html)
  const FIELD = 188, PANEL_MIN = 0.6; // FIELD = 원작 전투 화면 분할선(위 188라인 = 경기장, 아래 52라인 = 원작 HUD. 16 문서 1절). PANEL_MIN = 게이지 패널을 띄우는 최소 배율(ui_manga.js placeHud 와 같은 값)
  let wantCrop = false, fightOn = false, cropNow = false; // cropNow = 지금 실제로 필드 확대 배치(패널이 뜰 자리가 있어 fit 이 가렸다) // wantCrop = 신규 게이지 패널이 켜진 전투(NKManga.fieldOnly), fightOn = 전투 화면(배경의 좌우 색 번짐)
  const img = ctx.createImageData(256, 240), img32 = new Uint32Array(img.data.buffer);
  // D = 점프 전용 키(2026-11-21 기본 Z·X·C → A·S·D, web/keymap.js 가 없을 때의 대체 표. 2P 는 T·F·G·H 방향): 원작 점프 입력(A+B 동시)과 같은 패드 값(A|B = 3)을 한 번에 세운다. 엔진에는 A+S 를 같이 누른 것과 똑같이 들어간다(입력 매핑만, 코어·판정 불변)
  const KEYS = [['KeyA', 0, 1], ['KeyS', 0, 2], ['KeyD', 0, 3], ['ShiftRight', 0, 4], ['ShiftLeft', 0, 4], ['Enter', 0, 8], ['ArrowUp', 0, 16], ['ArrowDown', 0, 32], ['ArrowLeft', 0, 64], ['ArrowRight', 0, 128],
    ['KeyU', 1, 1], ['KeyI', 1, 2], ['KeyO', 1, 3], ['KeyY', 1, 4], ['KeyL', 1, 8], ['KeyT', 1, 16], ['KeyG', 1, 32], ['KeyF', 1, 64], ['KeyH', 1, 128],
    ['Numpad8', 0, 16], ['Numpad2', 0, 32], ['Numpad4', 0, 64], ['Numpad6', 0, 128], ['Numpad7', 0, 80], ['Numpad9', 0, 144], ['Numpad1', 0, 96], ['Numpad3', 0, 160]]; // 숫자패드 = 1P 8방향(대각 키 하나)
  const kmap = {}, KM = window.NKKeymap || null; // 키 리매핑(web/keymap.js, 15 문서 21절): 사용자 표가 있으면 그 줄(같은 [코드, 플레이어, 비트] 모양)로, 없으면 KEYS. 바꾸면 다시 만들고 눌린 키를 비운다
  // 터치 패드(web/touch_pad.js, analysis/27 M1절): 1P 가상 키 코드(키보드 e.code 로는 나오지 않는 # 시작). __game.touch.key 가 키보드와 같은 keyAt(KEEP·cleanDirs·held)으로 넣는다
  const TOUCH = [['#tU', 0, 16], ['#tD', 0, 32], ['#tL', 0, 64], ['#tR', 0, 128], ['#tA', 0, 1], ['#tB', 0, 2], ['#tJ', 0, 3], ['#tS', 0, 8]];
  function mapKeys() { for (const c in kmap) delete kmap[c]; (KM ? KM.entries() : KEYS).forEach(k => kmap[k[0]] = k); TOUCH.forEach(k => kmap[k[0]] = k); }
  mapKeys(); if (KM) KM.on(() => { mapKeys(); held.clear(); writePads(); });
  // 짧은 탭 보정: 원작은 전투 중 패드를 4프레임(1틱)에 한 번만 읽는다(오라클 측정: 3프레임 이하로 누르거나 뗀 입력은 위상에 따라 빠져 더블 탭 달리기가 안 나감).
  //   키 눌림·뗌을 각각 엔진 프레임 KEEP 개 이상 유지해 틱이 반드시 보게 한다. 바뀌는 것은 사람 입력의 시점뿐(엔진·기록·락스텝 형식 불변). kq = 아직 반영 못 한 눌림·뗌, kAt = 마지막 반영 때의 granted
  const KEEP = 4, kq = new Map(), kAt = new Map();
  const held = new Set();          // 눌린 키 코드(같은 버튼에 키가 둘인 Shift 좌/우 때문에 코드 단위로 추적)
  held.clear = function () { Set.prototype.clear.call(this); kq.clear(); kAt.clear(); }; // 키 상태를 비우는 곳(메뉴·일시정지·blur)에서 밀린 탭도 함께 버린다
  const lastDir = [[0, 0], [0, 0]]; // [플레이어][0=좌우,1=상하] 마지막에 누른 방향 비트
  // 화면·소리 생략(web/worker.js ctl[11]): 덮개 아래 빨리 감기(fastOn, turbo 제외) 프레임을 허가할 때만 1. 그 프레임은 fb 가 null(화면 안 그림), 소리 샘플 없음(어차피 버림).
  //   엔진·패드·RAM 은 같다. fbStale = 마지막으로 받은 프레임이 생략 프레임 → 그리지 않고, 덮개 걷기(tryLink)는 다음 그린 프레임까지 미룬다
  const SKIP = 11; let fbStale = false;
  // 타이틀 밖 메뉴 = 효과음 끔(2026-11-22 사용자 요청: 타이틀 데모 대련 효과음은 타이틀에서만, 다른 메뉴 화면은 배경음악만). ctl[16] 1 = web/sound_clock.js 가 그림자 드라이버로 소리를 내며 효과음 요청(id 01~1F)만 넘기지 않는다(본 엔진 RAM·로직 불변).
  //   신규 층 MG.sfxQuiet(메뉴 층이 떠 있고 타이틀이 아님 · 「다른 게임」 팝업) 일 때만, 온라인(락스텝 중)은 늘 0. 타격음 층(web/audio_fx.js)도 같은 값(__game.sfxQuiet)을 본다
  const SFXQ = 16, sfxQuiet = () => !online && !!MG && UI === MG && menuOn && !!MG.sfxQuiet;
  const skipSet = v => Atomics.store(ctl, SKIP, v);
  // 승리 연출 건너뛰기(2026-11-21, 신규 층 MG 주소의 로컬 판만): 전투 종료 연출 1:5(WINNER 등, 약 172프레임) 동안 새로 누른 A·B·START(패드 비트, 키 리매핑과 무관)·Esc·클릭·터치가 오면
  //   그 뒤 프레임을 덮개 아래 빨리 감기(fastOn, 화면·소리 생략)로 허가해 다음 덮개(스토리 대기실 10:0 · 배틀 결과 0:0)까지 넘긴다. 빨리 감는 동안 엔진 패드는 0(입력 없음과 같은 경로).
  //   엔진·워커 불변, 바뀌는 것은 허가 시점뿐. 스토리 저장 기록(rec)은 프레임마다 실제 허가한 패드를 그대로 남기므로(recGrant) 재현이 같다. 온라인(락스텝)은 onWorker 에서 먼저 빠져 해당 없음.
  //   1:5 · 0:0 밖(라이벌 논평 6:x·원작 대기실 등)이나 덮개가 뜨면 끝. 1:5 첫 VSK_GRACE 프레임에 누른 버튼(전투 끝의 연타)은 뗐다 다시 눌러야 한다
  const VSK_BITS = 1 | 2 | 8, VSK_GRACE = 20, vsk = { st: 0, f: 0, base: 0, tap: false, el: null }; // st 0 = 없음, 1 = 1:5 입력 감시, 2 = 빨리 감기
  function vskHint(on) {
    if (on && !vsk.el) { const e = vsk.el = document.createElement('div'); e.textContent = '건너뛰기 ▸'; e.style.cssText = 'position:absolute;left:calc(var(--nk-l,0px) + 256px*var(--nk-s,1) - 6px);top:calc(var(--nk-t,0px) + 1px*var(--nk-h,240)*var(--nk-s,1) - 6px);transform:translate(-100%,-100%);font:clamp(10px,1.7vmin,14px) Galmuri11,sans-serif;color:#fff;opacity:.7;background:rgba(0,0,0,.45);padding:2px 6px;border-radius:3px;pointer-events:none;z-index:5'; stage.appendChild(e); }
    if (vsk.el) vsk.el.style.display = on ? '' : 'none';
  }
  function vskEnd() { if (vsk.st === 2) { acc = 0; last = 0; if (!menuOn) padBlock = true; } vsk.st = 0; vsk.tap = false; vskHint(false); } // 빨리 감기 뒤: 누산기 초기화(따라잡기 배속 방지), 덮개 없이 원작 화면이면 누른 키를 뗄 때까지 막는다
  function vskStep(m) { // 로컬 프레임마다(덮기 판정 뒤)
    const md = m[0x641], sub = m[0x642] & 0x7F, v15 = md === 1 && sub === 5;
    if (vsk.st === 2) { if (menuOn || online || !(v15 || (md === 0 && sub === 0)) || ++vsk.f > 600) vskEnd(); return; }
    if (!v15 || !MG || online || menuOn || paused || fatal || turbo || MG.active) { if (vsk.st) vskEnd(); return; }
    const p = localPads(), b = (p[0] | p[1]) & VSK_BITS;
    if (vsk.st === 0) { vsk.st = 1; vsk.f = 0; vsk.base = b; vsk.tap = false; vskHint(true); return; }
    if (++vsk.f <= VSK_GRACE) { vsk.base |= b; vsk.tap = false; return; }
    vsk.base &= b; // 뗀 버튼은 다시 누르면 건너뛰기
    if (vsk.tap || (b & ~vsk.base)) { vsk.st = 2; vsk.f = 0; vsk.tap = false; vskHint(false); held.clear(); }
  }
  window.addEventListener('pointerdown', () => { if (vsk.st === 1) vsk.tap = true; });
  window.addEventListener('keydown', e => { if (vsk.st === 1 && e.code === 'Escape') vsk.tap = true; });
  const CREDIT = 0, PAD = 1, RESET = 3, AUDIO = 4, KOF = 5, PAD3 = 6, PAD4 = 7, SPD = 10; // SPD = 전투 배율 x1000(web/worker.js ctl[10]) // PAD3·PAD4 = 3P·4P(확장 단자 패드, web/worker.js ctl[6]·[7]). 사람 3·4명 온라인 판의 사람 자리에만 쓰고 그 밖에는 반드시 0(0 이 아니면 $0645 < 4 에서 원작이 1P·2P 에 합친다. analysis/17_online_4p.md 3.2절)
  // 한글 덧그리기 층(analysis/13_korean_ui.md). 기본 켬(?ko=0 으로 끔, K 키로 원작/한글 비교). ?classic=1 에서는 기본 꺼짐: ?ko=1 또는 K 키로 켰을 때만 web/korean.js 를 불러오고 워커에 PPU 상태 사본을 요청한다.
  // 코어 256x240 출력(img)은 그대로 그린 뒤 그 위에 덧그린다.
  let ko = CLASSIC ? /[?&]ko=1(&|$)/.test(location.search) : !/[?&]ko=0(&|$)/.test(location.search), koMod = null, koLoading = false, koSnap = null, koErr = null, romChr = null, pal32 = null;
  const RATE = 60.0988, MAX_AHEAD = 3;
  let worker = null, ctl = null, ready = false, paused = false, muted = false, actx = null, node = null, fatal = null;
  let granted = 0, received = 0;
  // 신규 메뉴 층 연결. 층이 떠 있는 동안(menuOn) 엔진은 덮개 아래에서 그대로 돈다: 원작 타이틀을 START 로 넘겨(pre, 그동안 무음) 원작 모드 선택 화면(모드 5)에 세워 두고,
  // 사용자가 모드·설정을 고르면(want, wantOpt) 메뉴 구동기(web/menu_driver.js, drv)가 가상 패드 입력열(autoPad = 1P, autoPad2 = 2P)로 덮개 아래 원작 메뉴를 넘긴다:
  //   배틀 = 신규 층에서 고른 인원(1인·2인)·에디트 '안 한다'를 답해 캐릭터 선택(5:4)까지('한다'를 고르면 원작 에디트 여부 질문 5:1:4 까지), 스토리 = 원작 인원 선택(5:1:3)까지(13 문서 11·12절).
  // 그 화면이 준비되면(또는 구동기가 실패하면 그 자리에서) 층을 걷어 원작 화면(한글 덧그리기)을 보여 준다. 층이 떠 있는 동안 사용자 입력은 엔진에 넣지 않고(구동 입력만 들어간다), 구동 중에는 소리를 내지 않는다.
  // 걷은 뒤에는 누르고 있던 키·버튼을 뗄 때까지 막는다(padBlock).
  const PRE_SETTLE = 150; // 모드 5 가 된 뒤(= 타이틀 페이드아웃 시작) 화면이 바뀔 때까지 기다리는 프레임 수
  let menuOn = false, pre = false, preF = 0, autoPad = 0, autoPad2 = 0, padBlock = false, want = null, wantOpt = null, picked = null, drv = null, drvEnd = null; // drvEnd = 구동 결과('done' | 'fail', 층을 걷을 차례)
  let lay = null; // lay = 지금 떠 있는 층이 UI 가 아닐 때(스토리 대진표·대기실은 ?state= 주소에서도 신규 층 MG 가 띄운다)
  // 스토리 화면 덮기 표: [모드 $0641, 조건(RAM), NKManga 함수]. covSeen[모드] = 그 모드에 든 뒤 이미 띄우기를 시도함(모드를 벗어나면 풀린다)
  //   9 대진표 = 9:4 입력 대기($0642 = $84) 첫 프레임 / 10 대기실 = 모드 10 첫 프레임(10:0, 원작 대기실이 밝아지기 전)부터 덮고 구동 story_lobby 로 10:2 입력 대기까지 넘긴다
  const COVER = [[9, r => r[0x642] === 0x84, 'bracket'], [10, () => true, 'lobby']], covSeen = {};
  // 원작 소프트 리셋 감지(13 문서 13.8절): 층을 걷은 뒤 원작이 부팅 화면(테크노스 로고 = 화면 키 $0641 2)으로 돌아가면(스테이지 선택의 GAME EXIT 등) R 키와 같이 처음부터 다시 시작해 신규 타이틀을 연다.
  // 측정: GAME EXIT → 0:1 페이드아웃(검정) → 0:0 → 2:0 이 되고 15프레임 뒤에 로고가 밝아진다. 2 가 된 프레임(검정)에 그 프레임을 그리지 않고 바로 덮으므로 원작 부팅 화면은 보이지 않는다.
  const BOOT_MODE = 2; let exits = 0; // exits = 이렇게 신규 타이틀로 돌아온 횟수(스모크용)
  const mirror = { frame: 0, loops: 0, m: new Uint8Array(0x800) }; // 워커 엔진의 최근 프레임 상태(디버그·스모크용)
  // 소리 링 버퍼(1.49초). rpos/wpos 는 누계 샘플 수
  // 출력(T9): AudioWorklet(web/audio_worklet.js)을 쓸 수 있으면 링·위치를 공유 메모리(wk)에 두고 워클릿이 아래 ScriptProcessor 콜백과 같은 1024 블록 처리를 한다(rpos 는 워클릿 소유).
  //   쓸 수 없거나 불러오기가 실패하면 종전 ScriptProcessor 경로(아래 initAudio 의 onaudioprocess 그대로). audioStat.out = 'worklet' | 'script'
  const RING = 65536, XF = 256;
  let ring = new Float32Array(RING), wk = null;
  let wpos = 0, rpos = 0, hp1 = 0, primed = false;
  const PREBUF = 2205; // 재생 시작·바닥난 뒤에는 50ms 가 모일 때까지 기다린다(프레임 도착 흔들림으로 인한 끊김 방지)
  const audioStat = { samples: 0, peak: 0, underruns: 0, skips: 0, rateAdj: 0, low: 0, out: '' };
  // 소리 지연 제어. 엔진은 프레임당 733.856 샘플을 만들어 60.0988fps 면 초당 44,104 샘플(소비 44,100 보다 +4, 오디오 시계 오차가 더해짐)이라
  // 그대로 두면 대기열이 계속 쌓인다. 재생 콜백 직후의 대기열 바닥값을 약 1초(43 콜백) 창으로 모아, 그 최솟값이 LOW_TGT 가 되도록
  // 프레임 허가율을 ±0.1% 안에서 조절한다(엔진의 프레임 경계·샘플열은 그대로, 바뀌는 것은 허가 시점뿐).
  const LOW_TGT = 1024, ADJ_MAX = 0.001, ADJ_GAIN = 0.1, LOW_WIN = 43;
  let rateAdj = 0, lowWin = Infinity, lowN = 0;

  // 원작 패드는 좌+우·상+하가 동시에 눌릴 수 없다. 키보드·게임패드에서 겹치면 나중에 누른 쪽만 남긴다(기록이 없으면 둘 다 뗀 것으로).
  function cleanDirs(v, p) {
    if ((v & 0xC0) === 0xC0) v = (v & ~0xC0) | (lastDir[p][0] & 0xC0);
    if ((v & 0x30) === 0x30) v = (v & ~0x30) | (lastDir[p][1] & 0x30);
    return v;
  }
  const keyRipe = c => { const a = kAt.get(c); return a === undefined || received - a >= KEEP || received < a; }; // received < a = 워커를 새로 만들어 셈이 0 부터
  function keySet(c, on) {
    if (on) { held.add(c); const k = kmap[c]; if (k[2] & 0xC0) lastDir[k[1]][0] = k[2]; if (k[2] & 0x30) lastDir[k[1]][1] = k[2]; } else held.delete(c);
    kAt.set(c, granted);
  }
  function keyAt(c, on) { // 키 이벤트: 바로 반영할 수 있으면 반영(참), 직전 변화가 KEEP 프레임을 못 채웠으면 줄에 넣는다
    const q = kq.get(c) || [], cur = q.length ? q[q.length - 1] : held.has(c);
    if (cur === on) return false;
    if (!q.length && keyRipe(c)) { keySet(c, on); return true; }
    if (q.length >= 2) q.splice(0, 2); // 연타가 밀리면 가장 오래된 탭 하나를 버린다(지연이 쌓이지 않게)
    q.push(on); kq.set(c, q); return false;
  }
  function keyDrain() { // 화면 주기마다: 밀린 눌림·뗌 중 때가 된 것을 반영
    kq.forEach((q, c) => { if (keyRipe(c)) { keySet(c, q.shift()); if (!q.length) kq.delete(c); } });
  }
  function pollPads() {
    if (online) return online.pads; // 온라인: 확정 프레임(또는 구동기) 값만 엔진에 넣는다
    if (menuOn) return [autoPad, autoPad2];
    if (paused || vsk.st === 2) return [0, 0]; // 승리 연출 건너뛰기 중 = 입력 없음. 멈춘 동안은 엔진에 아무것도 넣지 않는다(일시정지를 연 게임패드 START 가 원작 START 로 새지 않게. 풀린 뒤는 padBlock 이 막는다)
    const out = localPads();
    if (padBlock) { if (out[0] | out[1]) return [0, 0]; padBlock = false; }
    return out;
  }
  let gpMute = false; const gpAny = g => g.buttons.some(x => x && x.pressed) || Math.abs(g.axes[0] || 0) > 0.5 || Math.abs(g.axes[1] || 0) > 0.5;
  function localPads() { // 키보드·게임패드의 지금 값 [1P, 2P]
    const gpSt = !(MG && mirror.m[0x641] === 1 && (mirror.m[0x642] & 0x7F) === 2); // 신규 층 주소의 전투(1:2)에서는 1P 게임패드 START = 일시정지 메뉴 전용(원작 START 로 넣지 않는다)
    const p = [0, 0];
    held.forEach(code => { const k = kmap[code]; if (k) p[k[1]] |= k[2]; });
    const gp = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < 2; i++) {
      const g = gp[i]; if (!g) continue; const b = g.buttons;
      if (!i && online && MG && (MG.forfeitOpen || gpMute)) { gpMute = gpAny(g); continue; } // 기권 확인 창이 게임패드 1 을 읽는 동안(+ 닫은 뒤 손을 뗄 때까지) 엔진에 넣지 않는다
      if (KM) p[i] |= KM.padBits(g, i || gpSt); else { if (b[0] && b[0].pressed) p[i] |= 1; if (b[2] && b[2].pressed) p[i] |= 2; if (b[8] && b[8].pressed) p[i] |= 4; if (b[9] && b[9].pressed && (i || gpSt)) p[i] |= 8; } // 버튼 = 키 리매핑 표(방향은 아래 고정)
      if ((b[12] && b[12].pressed) || g.axes[1] < -0.5) p[i] |= 16; if ((b[13] && b[13].pressed) || g.axes[1] > 0.5) p[i] |= 32;
      if ((b[14] && b[14].pressed) || g.axes[0] < -0.5) p[i] |= 64; if ((b[15] && b[15].pressed) || g.axes[0] > 0.5) p[i] |= 128;
    }
    return [cleanDirs(p[0], 0), cleanDirs(p[1], 1)];
  }
  function writePads() { // 3P·4P: 온라인 3·4인 판의 사람 자리(자리 2 = 사람 3명 이상, 자리 3 = 4명)만, 그 밖(로컬·스토리·2인 온라인·CPU 자리·리셋 대기)은 0
    if (!ctl || rec) return; // 스토리 저장 기록 중: 패드 칸은 recGrant 만 쓴다(워커가 멈춰 있을 때만)
    const p = pollPads(), H = online && online.phase === 'run' ? (online.team ? 4 : online.H) : 2; // 팀전(2:2) = $0645 5 고정이라 4칸 모두(COM 자리는 0)
    Atomics.store(ctl, PAD, p[0]); Atomics.store(ctl, PAD + 1, p[1]); Atomics.store(ctl, PAD3, H >= 3 ? p[2] & 255 : 0); Atomics.store(ctl, PAD4, H >= 4 ? p[3] & 255 : 0);
  }
  const zeroExt = () => { Atomics.store(ctl, PAD3, 0); Atomics.store(ctl, PAD4, 0); }; // 엔진을 새로 만들기 전: 3P·4P 칸을 비운다
  function fit() {
    const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
    const mob = window.NKMobile ? window.NKMobile.layout(w, h) : null; // 모바일 배치(web/mobile.js, analysis/27 M2): 세이프 에어리어 안 정수배, 필드 확대·게이지 패널 끔. null = 종전 그대로
    const dpr = window.devicePixelRatio || 1, max = mob ? Math.min(mob.aw / (WIDE ? 256 : CW), mob.ah / CH) : Math.min(w / (WIDE ? 256 : CW), h / CH);
    let s = Math.floor(max * dpr) / dpr; if (s < 1 / dpr) s = max; // 디바이스 픽셀 기준 정수배(최근접)
    if (scaleSet === 1) s = max; else if (scaleSet >= 2) s = Math.min(s, scaleSet); // 설정의 화면 배율: 꽉 채우기(정수배 아님) / n배(창에 들어가는 최대 정수배를 넘지 않는다)
    // 전투 필드 확대: 필드(256x188) + 창틀(위아래 3픽셀)이 창 높이에 들어가고 좌우 게이지 패널이 PANEL_MIN 이상으로 뜨는 가장 큰 배율. 정수배가 높이를 거의(97%) 채우면 정수배, 아니면 비정수(최근접 확대 그대로, 필드 높이는 디바이스 픽셀 정수)
    // 패널이 못 뜨는 창(세로·좁은 창)·패널을 끈 설정에서는 가리지 않는다(원작 HUD 가 유일한 정보)
    let fh = CH;
    if (wantCrop && !mob) {
      const pk = v => Math.min(FIELD * v / 640, ((w - 262 * v) / 2 - 12) / 266); // 그 배율에서의 패널 배율(placeHud 와 같은 식: 한쪽 여백 = (창 − 코어 − 창틀) / 2)
      const m = Math.min(h / (FIELD + 6), (w - 24 - 532 * (PANEL_MIN + 0.01)) / 262), si = Math.floor(m * dpr) / dpr;
      const v = scaleSet >= 2 ? Math.min(si, scaleSet) : scaleSet !== 1 && si >= m * 0.97 ? si : Math.floor(m * FIELD * dpr) / (FIELD * dpr);
      if (v > 0 && pk(v) >= PANEL_MIN) { s = v; fh = FIELD; }
    }
    cv.dataset.fh = fh; // 보이는 코어 높이(라인). ui_manga.js placeHud 가 읽는다
    cropNow = fh < CH;
    cv.style.width = CW * s + 'px'; cv.style.height = CH * s + 'px'; cv.style.clipPath = fh < CH ? 'inset(0 0 ' + (CH - fh) * s + 'px 0)' : '';
    // 가운데 정렬 위치가 디바이스 픽셀의 소수(예: 높이가 홀수면 top .5px)가 되지 않게 내림 스냅한다(반 픽셀에 걸치면 신규 메뉴 층 가장자리로 캔버스가 1px 비친다)
    const snap = v => Math.floor(v * dpr + 1e-6) / dpr - v, ox = mob ? mob.x0 + (mob.aw - CW * s) / 2 : (w - CW * s) / 2, oy = mob ? mob.y0 + mob.top(fh * s) : (h - fh * s) / 2; // oy = 보이는 부분(필드)을 세로 가운데에(모바일 세로 = 위쪽)
    cv.style.left = (mob ? ox - (w - CW * s) / 2 : 0) + snap(ox) + 'px'; cv.style.top = oy + snap(oy) - (h - CH * s) / 2 + 'px'; // #stage 가 캔버스 전체(240라인)를 가운데 두므로 그 차이만큼 옮긴다(가리지 않을 때 = 종전 값)
    if (WIDE) { // 창틀(#stage::after)은 보이는 코어 자리
      const L = ox + snap(ox), T = oy + snap(oy), st = stage.style;
      st.setProperty('--nk-s', s); st.setProperty('--nk-l', L + OX * s + 'px'); st.setProperty('--nk-t', T + 'px'); st.setProperty('--nk-h', fh);
    }
    // 조작 안내문(#msg): 필드 확대 배치에서는 필드가 창 높이를 거의 채워 창 바닥의 안내문이 아래 창틀 선과 겹친다 → 필드 안쪽 아래(창틀 선 위)로 올린다. 그 밖의 배치는 종전 자리(CSS bottom 6px)
    msg.style.bottom = cropNow ? Math.max(6, Math.ceil(h - (oy + snap(oy) + fh * s)) + 4) + 'px' : '';
    msg.classList.toggle('band', cropNow); msg.style.maxWidth = cropNow ? Math.floor(256 * s) + 'px' : ''; // 필드 위에 얹히는 배치: 글자 폭만큼의 반투명 어두운 바탕 띠(index.html #msg.band. 작은 창에서는 필드 바닥 무늬 위에 놓인다)
  }
  // 프레임마다: 전투 화면 여부(배경 색 번짐)·필드 확대 여부가 바뀌면 배치를 다시 잡는다(화면 배치만. 엔진·입력·락스텝과 무관)
  function viewMode(m) {
    const sub = m[0x642] & 0x7F, fight = WIDE && m[0x641] === 1 && (sub === 2 || sub === 4 || sub === 5);
    if (fight !== fightOn) { fightOn = fight; document.documentElement.classList.toggle('nk-fight', fight); }
    const c = !!MG && !!MG.fieldOnly; if (c !== wantCrop) { wantCrop = c; fit(); if (MG.relayout) MG.relayout(); }
  }
  fit(); window.addEventListener('resize', fit);
  if (!DEBUG) info.style.display = 'none';
  const hideMsg = () => msg.classList.add('hide'); if (MENU) hideMsg(); else setTimeout(hideMsg, 10000);
  const cover = on => document.documentElement.classList.toggle('nk-cover', on); // 신규 메뉴 층이 떠 있는 동안 조작 안내문을 아예 그리지 않는다(index.html 머리의 한 줄이 스크립트 로딩 전부터 켜 둔다)
  if (!MENU) cover(false);
  function openMenu(fn) { lay = null; menuOn = true; pre = true; preF = 0; autoPad = 0; autoPad2 = 0; padBlock = false; want = null; wantOpt = null; picked = null; drv = null; drvEnd = null; hideMsg(); cover(true); if (fn) fn(); else UI.show('title'); }
  // ── 온라인 대전 O1(analysis/16_wide_hd_online_plan.md 부록 A). 소켓·로비·대기방은 신규 층(ui_manga.js)이 맡고, 여기서는 start 뒤의 락스텝만 돈다.
  //   검증 도구 tools/online_sync_test.js 의 가상 클라이언트와 같은 순서: 엔진을 시작 상태로 새로 만들고(워커 리셋), 워커가 프레임 k 를 보내 오면
  //   확정 프레임 k(서버 f, 폭 = cfg.humans = 2·3·4. 3·4인은 17 문서: 구동 계획 battle_full4, 3P·4P 는 ctl[6]·[7])를 꺼내 구동 계획(cfg.plan)이 도는 동안은 구동기 값, 끝난 뒤는 확정 값을 패드에 쓰고 1프레임만 허가한다(MAX_AHEAD 1).
  //   구동 중(prefill 구간, 확정이 이미 와 있음)은 60Hz 를 기다리지 않고 빨리 감고(덮개 아래), 끝나면 덮개를 걷고 60Hz 로 돈다. 내 패드(1P 키·게임패드 1)는 내 자리 포트로 서버에 보낸다.
  //   결과: 전투 종료(1:5) 진입 프레임에 승자 슬롯을 result 로 보낸다(양쪽 같은 프레임·같은 값). end 를 받으면 엔진을 처음부터 다시 만들고 신규 층의 결과 화면으로.
  let online = null, bootFrame = -1;
  const fnv = a => { let h = 0x811c9dc5; for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, '0'); }; // RAM 2KB 지문(양쪽 같은 함수)
  // ── 스토리 저장 기록(analysis/21 5.3·13·14절). rec = 기록 중인 구간: 기준 상태(base)의 프레임 from 부터 프레임마다 1P·2P 패드 값(p·p2, n 칸).
  //   규약 rec 1: 워커가 프레임 F 메시지를 보내고 멈춰 있을 때만 패드 칸(ctl[1]·[2])을 쓰고 한 프레임만 허가한다(onlineAdvance 와 같은 방식) → 프레임 하나 동안 패드 값이 바뀌지 않아
  //   서버 재현(server/engine/replay_save.js getPad(f) = pads[f − from])과 같다. 새 엔진의 첫 2프레임(lead)은 패드 0. 기록 중 writePads 는 패드 칸을 건드리지 않고,
  //   허가 없이 돈 프레임(기록 시작 전에 남은 허가·lead)은 그동안 칸에 있던 값(last)으로 채운다. 저장 지점(스토리 9:4 진입 · 대회 종료 10:1)을 지나 60프레임 뒤
  //   신규 층(NKManga.storyPoint)에 알리면 층이 pick('rec_seg') 로 구간을 받아 서버에 보낸다(비동기, 게임은 그대로 진행). 엔진·워커 무수정
  let recArm = false; // 새 게임 기록을 첫 스토리 구동까지 미뤄 둠(타이틀 대기 중 rec_new, 아래 recNew·pick)
  let holdBoot = null; // 타이틀 대기 전용 시작 상태(/state/title_fight.json = 3:5 대련 진입, tools/make_title_fight_state.js). 없으면 titleBoot. 기록·온라인은 늘 titleBoot
  const holdOf = () => holdBoot && MG && UI === MG ? holdBoot : titleBoot;
  let rec = null, curBoot = null, titleBoot = null, romU8 = null, ticking = false, loadWait = 0, loadT0 = 0, loadMs = -1; // curBoot = 지금 워커의 boot, titleBoot = 주소의 시작 상태(/state/<STATE>.json)
  const keyOf = m => m[0x641] + ':' + (m[0x642] & 0x7F);
  const mkRec = (from, key) => ({ from, n: 0, p: new Uint8Array(16384), p2: new Uint8Array(16384), last: 0, last2: 0, live: false, key: key || null, point: 0, bad: '' });
  function recPush(v, v2) { const r = rec; if (r.n >= r.p.length) { const L = Math.max(16384, r.p.length * 2), a = new Uint8Array(L), b = new Uint8Array(L); a.set(r.p); b.set(r.p2); r.p = a; r.p2 = b; } r.p[r.n] = v; r.p2[r.n] = v2; r.n++; }
  function recBad(why) { if (!rec.bad) { rec.bad = why; console.warn('저장 기록 어긋남: ' + why); } }
  function recFrame(d) { // 워커 프레임 메시지마다(기록 중)
    const r = rec, F = d.frame;
    if (!r.live) { if (F !== r.from + 2) return; r.live = true; } // 새 엔진의 첫 메시지 = from + 2. 그 전 메시지는 버린 엔진의 남은 프레임
    if (r.bad) return;
    if (F - r.from < r.n) return recBad('frame ' + F + ' n ' + r.n);
    while (r.from + r.n < F) recPush(r.last, r.last2);
    const m = d.ram, k = keyOf(m);
    if (m[0x645] <= 1 && k !== r.key && (k === '9:4' || (k === '10:1' && m[0x644] >= 18))) r.point = F + 60; // 서버 저장 지점(snapshot.checkpointKind)이 구간 안에 들어가게 60프레임 뒤에 보낸다
    r.key = k;
    if (r.point && F >= r.point) { r.point = 0; if (MG && MG.storyPoint) setTimeout(() => MG.storyPoint(), 0); }
  }
  function recGrant() { // 기록 중 한 프레임 허가: 워커가 멈춰 있을 때만. 지금 패드를 칸에 쓰고 이번 프레임(F = 마지막으로 받은 프레임)의 기록으로 남긴다
    const r = rec; if (!ready || !ctl || fatal || !r.live || granted > received) return false;
    const p = pollPads(), a = p[0] & 255, b = p[1] & 255;
    if (!r.bad) { if (r.from + r.n !== mirror.frame) recBad('grant ' + mirror.frame + ' n ' + r.n); else { recPush(a, b); r.last = a; r.last2 = b; } }
    Atomics.store(ctl, PAD, a); Atomics.store(ctl, PAD + 1, b); Atomics.store(ctl, PAD3, 0); Atomics.store(ctl, PAD4, 0);
    granted = received + 1; Atomics.store(ctl, CREDIT, granted); Atomics.notify(ctl, CREDIT); return true;
  }
  function recSeg() { // 지금까지의 구간: 마지막으로 받은 프레임 F 의 RAM 지문까지(pads = 프레임 from ~ F−1). 2P 칸은 값이 있을 때만
    const r = rec; if (!r || !r.live || r.bad || online) return null;
    const F = mirror.frame, n = F - r.from; if (n < 2 || n > r.n) return null;
    const p2 = r.p2.slice(0, n); return { from: r.from, pads: r.p.slice(0, n), pads2: p2.some(x => x) ? p2 : null, end: { f: F, h: fnv(mirror.m) } };
  }
  function recTrim(f) { const r = rec; if (!r || !Number.isInteger(f) || f < r.from || f > r.from + r.n) return false; const k = f - r.from; r.p = r.p.slice(k); r.p2 = r.p2.slice(k); r.n -= k; r.from = f; return true; } // 서버가 저장한 지점(from) 앞은 버린다
  function startWorker(st) { // 워커는 boot 를 첫 메시지로 한 번만 받는다 → 다른 boot 로 시작하려면 워커를 새로 만든다. 버린 워커의 메시지는 무시
    const w = worker = new Worker('worker.js'); curBoot = st;
    w.onmessage = ev => { if (w === worker) { onWorker(ev); aSync(); } };
    w.onerror = e => { if (w === worker) showFatal(String(e.message || e)); };
    w.postMessage({ ctl: ctl.buffer, rom: romU8, boot: st });
  }
  function bootWith(st) { // 지금 워커를 끝내고 st 로 새로 만든다(허가·받은 수는 새 워커 기준 0 부터. 패드 칸 0 = lead)
    if (worker) worker.terminate(); worker = null;
    ready = false; fatal = null; Atomics.store(ctl, PAD, 0); Atomics.store(ctl, PAD + 1, 0); zeroExt(); granted = 0; received = 0; Atomics.store(ctl, CREDIT, 0);
    bootFrame = Number.isInteger(st.frameNo) ? st.frameNo : -1; startWorker(st);
  }
  function recNew(o) { // 새 게임(계정 슬롯): 엔진을 시작 상태(boot_title)로 다시 만들고 첫 프레임부터 기록. 덮개 아래 원작 타이틀 넘김(pre)부터 다시
    if (!ready || online || !titleBoot || STATE !== 'boot_title' || !o || o.from !== titleBoot.frameNo) return false;
    if (holding()) { recArm = true; return true; } // 타이틀 대기 중: 기록·리셋을 첫 스토리 구동(pick)까지 미룬다(인원·에디트·파트너 화면 동안 타이틀 배경·음악 유지, 기록 프레임도 늘지 않는다)
    rec = mkRec(titleBoot.frameNo, null); loadWait = 0; reboot(); return true;
  }
  function storyLoad(o) { // 이어하기: 서버가 준 상태(story_begun.state, boot_title 형식)로 워커를 새로 만들어 바로 이어 간다(원작 메뉴 구동 없음). 덮개는 그대로, storyLift 가 신규 화면으로 바꾼다
    const st = o && o.state; if (!ready || online || !st || !Number.isInteger(st.frameNo) || !Array.isArray(st.ram)) return false;
    if (!st.wram) st.wram = new Uint8Array(0x2000); // 서버는 WRAM 이 모두 0 이면 뺀다(worker.js 는 Uint8Array.from(b.wram))
    rec = mkRec(st.frameNo, keyOf(st.ram)); paused = false; turbo = false; endRam = null; menuOn = true; pre = false; autoPad = 0; autoPad2 = 0; padBlock = false; want = null; wantOpt = null; picked = null; drv = null; drvEnd = null; lay = null; held.clear();
    for (const k in covSeen) covSeen[k] = false; cover(true); hideMsg(); loadT0 = performance.now(); loadMs = -1; loadWait = 1; bootWith(st); return true;
  }
  function storyLift(d) { // 불러온 엔진이 덮을 화면(COVER: 대진표 9:4 입력 대기 · 대기실)에 닿으면 신규 층을 그 화면으로 바꾼다. 900프레임 안에 못 닿으면 덮개를 걷어 원작 화면으로
    if (!rec || !rec.live) return; const r = d.ram, done = () => { loadWait = 0; loadMs = Math.round(performance.now() - loadT0); MG.hide(); };
    for (const c of COVER) if (r[0x641] === c[0] && c[1](r) && r[0x645] <= 1) {
      done(); covSeen[c[0]] = true; const v = MG[c[2]] ? MG[c[2]](r) : false;
      if (!v) return liftLoad();
      lay = MG; if (v.plan) { want = v.plan; wantOpt = v.opt || null; tryDrive(); } return;
    }
    if (d.frame - rec.from > 900) { done(); liftLoad(); }
  }
  function liftLoad() { menuOn = false; held.clear(); padBlock = true; lay = null; viewMode(mirror.m); cover(false); }
  function onlineDriver(mode, opt) { // 검증 도구 autoDrive 와 같다: 타이틀 START 끊어 누르기 → 모드 5 뒤 PRE_SETTLE 프레임 → 메뉴 구동기(RAM·프레임 번호만 본다)
    let pre1 = true, n = 0, d = null, state = 'run';
    return { step(m, frame) {
      if (state !== 'run') return { pad: 0, pad2: 0, state };
      if (pre1) { if (m[0x641] !== 5) { n = 0; return { pad: (frame & 15) < 6 ? 8 : 0, pad2: 0, state }; } if (++n < PRE_SETTLE) return { pad: 0, pad2: 0, state }; pre1 = false; d = window.NKDriver.create(mode, opt); }
      const r = d.step(m, null); state = r.state; return r;
    } };
  }
  function onlineStart(o) {
    const cfg = o && o.cfg, plan = cfg && cfg.plan, D = window.NKDriver, H = cfg ? cfg.humans | 0 : 0;
    const t = cfg && cfg.team, T = t && t.mode === '2v2' && Array.isArray(t.cpu) && t.cpu.length === 4 && Array.isArray(t.seatOf) && t.seatOf.length === H && t.seatOf.every(i => Number.isInteger(i) && i >= 0 && i < 4 && !t.cpu[i]) ? t : null; // 팀전(analysis/30 10절): cpu[4]·seatOf[H](j 번째 사람의 자리)
    const mode = plan && !T && H >= 3 ? plan.mode + '4' : plan && plan.mode; // 사람 3·4명: 서버는 같은 이름(battle_full)에 opt.players 3·4·opt.humans[] 를 실어 준다 → 3·4인 단계(battle_full4)로 돈다. 2인은 종전 그대로. 팀전 = 서버가 battle_full4 그대로 준다
    if (online || !ready || !ctl || ctl.length < 14 || fatal || bootFrame < 0 || received < 1 || !window.NKLockstep || !D || !plan || !D.plans[mode] || (cfg.state && cfg.state !== STATE) || (curBoot !== titleBoot && curBoot !== holdBoot) || (cfg.team && !T) || H < (T ? 1 : 2) || H > 4 || (T ? !plan.opt || plan.opt.players !== 4 : H >= 3 && (!plan.opt || plan.opt.players !== H))) return false;
    const tSnd = T && (!T.cpu[0] || !T.cpu[1]) && (!T.cpu[2] || !T.cpu[3]) && T.seatOf[o.slot | 0] !== undefined ? 1 + (T.seatOf[o.slot | 0] >> 1) : 0; // 양 팀에 사람 = 승패 징글을 내 팀 기준으로(web/sound_clock.js jingle, ctl[14] = 1 + 내 팀)
    Atomics.store(ctl, 14, tSnd);
    Atomics.store(ctl, 12, T ? 16 | T.cpu.reduce((a, v, i) => a | ((v ? 1 : 0) << i), 0) : 0); // 엔진 선택(web/worker.js ctl[12]): 엔진을 새로 만들기 전에 쓴다(아래 bootWith·onlineReset). 판이 끝나면 onlineStop 이 0
    rec = null; loadWait = 0; // 온라인 = 엔진을 시작 상태로 다시 만든다(스토리 기록 끝)
    if (curBoot !== titleBoot) bootWith(titleBoot); // 타이틀 대기 상태(title_fight)로 돌던 워커 → 시작 상태로 새로 만든다(아래 idle → onlineReset 이 이어서 리셋. 프레임 번호 기준 bootFrame = titleBoot)
    paused = false; turbo = false; endRam = null; pre = false; drv = null; drvEnd = null; want = null; wantOpt = null; picked = null; lay = null; menuOn = true; held.clear();
    const on = online = { cfg, H, team: T, slot: o.slot | 0, names: Array.isArray(o.names) ? o.names : [], send: o.send, phase: 'idle', pads: [0, 0, 0, 0], pend: null, acc: 0, drvState: 'run', drvWhy: '', resSent: false, res: null, drv: onlineDriver(mode, plan.opt) }; // team: names = 자리순(seatOf 로 찾는다)
    on.ls = window.NKLockstep.create({ cfg, send: o.send, sample: () => localPads()[0] }); // 내 패드 = 1P 키·게임패드 1(자리와 무관), 서버가 내 자리 포트로 확정해 준다
    if ((H >= 3 || T) && on.ls.width !== H) { online = null; Atomics.store(ctl, 12, 0); Atomics.store(ctl, 14, 0); return false; } // 옛 락스텝(폭 2 고정)이 캐시에 남은 경우
    Atomics.store(ctl, 13, cfg.atkStep === 'dir' ? 1 : cfg.atkStep === 'auto' ? 2 : 0); // 기본 공격 전진 이동(web/worker.js ctl[13]): 서버 start.cfg.atkStep 을 모든 참가자가 같게. 워커가 다음 리셋(엔진 새로 만들기)에서 읽는다
    Atomics.store(ctl, 15, cfg.guardAS ? 1 : 0); // 온라인 가드(web/worker.js ctl[15], server/engine/guard_as.js): 서버 start.cfg.guardAS 를 모든 참가자가 같게. 패드 비트 4(Select) 눌림 = 가드. 워커가 다음 리셋에서 읽는다
    o.attach({ msg: onlineMsg, have: () => on.ls.have });
    writePads(); return true;
  }
  function onlineReset() { // 워커가 멈춰 있고(허가 = 받은 프레임) 보낸 프레임이 없을 때 엔진을 시작 상태로 새로 만든다. 새 엔진의 첫 2프레임(lead)은 패드 0
    online.phase = 'run'; online.pads = [0, 0, 0, 0]; writePads();
    Atomics.add(ctl, RESET, 1); Atomics.notify(ctl, RESET); Atomics.notify(ctl, CREDIT);
  }
  function onlineFrame(d) {
    const o = online; if (o.phase !== 'run') return; // 리셋 전 엔진의 프레임(허가하지 않는다)
    const k = d.frame - bootFrame, m = d.ram;
    if (o.tail) { if (!(m[0x641] === 1 && (m[0x642] & 0x7F) === 5) || ++o.tailN > 360) return onlineStop(o.tail); o.pend = d; return onlineAdvance(); } // 결과 합의 뒤 WINNER 연출 꼬리(아래 onlineMsg end): 1:5 가 끝나면(또는 360프레임) 결과 화면으로
    if (k !== o.ls.exec) { console.error('온라인 프레임 어긋남 k=' + k + ' exec=' + o.ls.exec); o.send({ t: 'leave' }); return onlineStop({ t: 'end', reason: 'error' }); }
    if (!o.resSent && m[0x641] === 1 && (m[0x642] & 0x7F) === 5) { // 승자(15 문서 8·14절): 1:5 진입 프레임에 $04A2+s bit2 가 꺼진 슬롯, 없으면 HP > 0. 하나가 아니면 -1
      let r;
      if (o.team) { const a = !!(m[0x611] & 8), b = !!(m[0x612] & 8); r = { team: a && !b ? 1 : b && !a ? 0 : -1 }; } // 팀전(analysis/30 10.2): $0611 bit3 = 팀 0 전멸 → 팀 1 승, $0612 bit3 → 팀 0 승, 그 밖 -1
      else { const w = []; for (let s = 0; s < 4; s++) if (!(m[0x4A2 + s] & 4)) w.push(s); if (!w.length) for (let s = 0; s < 4; s++) if (m[0x4C2 + s] > 0) w.push(s); r = { winner: w.length === 1 ? w[0] : -1 }; }
      o.resSent = true; o.res = { t: 'result', f: k, r }; o.send(o.res); if (MG && MG.forfeitDone) MG.forfeitDone(); // res = 보낸 결과(끊긴 사이에 보냈으면 사라진다 → 재접속 뒤 다시 보낸다)
    }
    o.pend = d; onlineAdvance();
  }
  function onlineAdvance() {
    const o = online; if (!o || o.phase !== 'run' || !o.pend || fatal) return;
    if (o.tail) { if (o.acc < 1) return; o.acc -= 1; o.pend = null; o.pads = [0, 0, 0, 0]; writePads(); granted = received + 1; Atomics.store(ctl, CREDIT, granted); Atomics.notify(ctl, CREDIT); return; } // 꼬리 = 서버 확정 없이 패드 0 으로 60Hz 진행(승부는 이미 서버가 정함, 표시 전용)
    o.ls.pump(); const conf = o.ls.peek(); if (!conf) return;
    if (o.drvState !== 'run') { if (o.acc < 1) return; o.acc -= 1; } // 구동 뒤 = 60Hz(tick 이 채운다)
    const d = o.pend; o.pend = null; let p = conf;
    if (o.drvState === 'run') {
      let r; try { r = o.drv.step(d.ram, d.frame); } catch (e) { r = { state: 'fail', why: String(e && e.message || e) }; }
      if (r.state === 'run') p = r.pads || [r.pad, r.pad2 || 0]; else { o.drvState = r.state; o.drvWhy = r.why || ''; onlineLift(); }
    }
    if (o.team && p === conf) { const q = [0, 0, 0, 0]; conf.forEach((v, j) => { q[o.team.seatOf[j]] = v; }); p = q; } // 팀전: j 번째 사람 → 자리 seatOf[j], COM 자리 0
    o.pads = [p[0] & 255, p[1] & 255, p[2] & 255, p[3] & 255]; writePads(); // 구동 중 = 구동기 4칸, 끝난 뒤 = 확정 값(폭 H, 없는 칸은 0)
    o.ls.take(() => fnv(d.ram));
    granted = received + 1; Atomics.store(ctl, CREDIT, granted); Atomics.notify(ctl, CREDIT);
  }
  function onlineLift() { // 구동 끝(전투 입장 1:4): 덮개를 걷는다. 실패해도 양쪽 같은 상태라 원작 화면으로 그대로 이어 간다
    if (online.drvState === 'fail') console.warn('온라인 구동 실패: ' + online.drvWhy);
    menuOn = false; held.clear(); online.acc = 0; last = 0; (lay || UI).hide(); lay = null; viewMode(mirror.m); cover(false);
  }
  function onlineMsg(m) {
    const o = online; if (!o) return;
    if (m.t === 'f' || m.t === 'start') { o.ls.onMessage(m); if (m.t === 'start' && m.resume && o.res) o.send(o.res); /* 재접속: 결과를 다시 보낸다(서버는 자리마다 첫 보고만 받으므로 겹쳐도 무해) */ onlineAdvance(); }
    else if (m.t === 'peer' && m.ev === 'gone') { const at = o.team ? o.team.seatOf[m.slot] | 0 : m.slot | 0; if (MG) MG.toast((o.names[at] || (at + 1) + 'P') + ' 나감', 'hp-low'); } // 3·4인·팀전: 그 자리가 판에서 빠졌다(판은 계속, 그 자리 입력은 서버가 0 으로 확정). 팀전 slot = j 번째 사람
    else if (m.t === 'peer') { const me = m.slot === o.slot, at = o.team ? o.team.seatOf[m.slot] | 0 : m.slot | 0, who = o.H >= 3 || o.team ? o.names[at] || (at + 1) + 'P' : '상대'; /* 3·4인 = 그 자리 이름, 2인 = 종전 문구 그대로 */ if (MG && !(me && m.ev === 'drop')) MG.toast(m.ev === 'drop' ? who + (m.why === 'stall' || m.why === 'slow' ? ' 화면 멈춤' : ' 연결 끊김') + ' — 기다리는 중' : me ? '재접속됨' : who + ' 복귀', m.ev === 'drop' ? 'hp-low' : 'hp', m.ev === 'drop' ? (m.grace || 20000) : 0); } // 서버는 복귀를 방 전원(돌아온 본인 포함)에게 알린다(slot = 그 자리). 본인 자리면 「재접속됨」
    else if (m.t === 'desync') { if (MG) MG.toast('동기 어긋남 감지', 'hp-low'); console.warn('온라인 지문 불일치 f=' + m.f); }
    else if (m.t === 'end') { const r = mirror.m; if (m.reason === 'result' && o.resSent && !o.tail && MG && r[0x641] === 1 && (r[0x642] & 0x7F) === 5) { o.tail = m; o.tailN = 0; onlineAdvance(); } else onlineStop(o.tail || m); } // 결과 합의(end result)가 1:5 첫 프레임에 바로 와도 WINNER 연출(1:5)을 끝까지 보여 준 뒤 닫는다. 그 밖(기권·끊김 등)은 바로
  }
  function onlineStop(m) { // 대전 끝(결과·기권·끊김): 엔진을 처음부터 다시 만들고 신규 층 결과 화면
    const o = online; if (!o) return; online = null; Atomics.store(ctl, 13, 0); Atomics.store(ctl, 15, 0); Atomics.store(ctl, 12, 0); Atomics.store(ctl, 14, 0); held.clear(); fatal = null; if (!DEBUG) info.style.display = 'none'; // ctl[12] = 일반 엔진으로(아래 리셋에서 읽는다). 엔진 정지 안내 글자도 숨긴다(reset 과 같게)
    zeroExt(); const to = holdOf(); if (curBoot !== to) bootWith(to); else { Atomics.add(ctl, RESET, 1); Atomics.notify(ctl, RESET); Atomics.notify(ctl, CREDIT); } // 신규 층 = 타이틀 대기 상태(대련부터, reset 과 같게)
    openMenu(() => { if (UI.onlineEnd) UI.onlineEnd(m, o.slot); else UI.show('title'); });
  }
  document.addEventListener('visibilitychange', () => { // 온라인 대전 중 탭이 숨겨지면 판마다 한 번만 알린다(숨은 탭은 화면이 멈춰 서버가 기권 처리). 숨은 동안 떠 있다가 돌아오면 4초 뒤 사라진다(복귀 알림은 없다)
    const o = online, T = '탭이 숨겨지면 약 30초 뒤 기권 처리됩니다'; if (!o || !MG) return;
    if (document.hidden) { if (!o.hidTold) { o.hidTold = 1; MG.toast(T, 'hp-low', 30000); } } else if (o.hidTold === 1) { o.hidTold = 2; MG.toast(T, 'hp-low', 4000); }
  });
  // 타이틀 대기(hold, 2026-11-21): 신규 층(MG)이 떠 있고 아직 아무것도 고르지 않았으면(want 없음·기록 없음) 원작 타이틀을 START 로 넘기지 않고 입력 없이 그대로 돌린다.
  //   원작 타이틀(모드 3: 로고 낙하·강변 띠 흐름·두 사람 입장 → 3:5 대련 데모)과 타이틀 음악이 원작 그대로 나오고, 그 화면을 신규 층 메인 메뉴 배경(MG.titleBg)으로 넘긴다(소리도 켬).
  //   원작은 3:5 약 2,725프레임 뒤 제작사 로고(모드 2)로 넘어가므로 모드 3 을 벗어나면 엔진을 시작 상태로 다시 만들어 타이틀을 되풀이한다(holdRst = 리셋 뒤 모드 3 프레임을 받을 때까지).
  //   고르면(pick → want) 그때 START 넘김(pre)을 덮개 아래 빨리 감기로 돌린다(fastOn). 엔진·구동 계획·PRE_SETTLE 은 그대로(받는 패드열이 같다)
  let holdRst = false;
  const holding = () => !!MG && UI === MG && menuOn && pre && want === null && !rec && !online;
  function stepPre() { // 프레임마다: 원작 타이틀에서 START 를 짧게 끊어 눌러 모드 선택으로 넘긴다
    if (holding()) {
      autoPad = 0; preF = 0;
      if (mirror.m[0x641] === 3) holdRst = false;
      else if (!holdRst && (curBoot === titleBoot || curBoot === holdBoot)) { holdRst = true; zeroExt(); Atomics.add(ctl, RESET, 1); Atomics.notify(ctl, RESET); Atomics.notify(ctl, CREDIT); }
      return;
    }
    if (mirror.m[0x641] !== 5) { autoPad = (mirror.frame & 15) < 6 ? 8 : 0; preF = 0; return; }
    autoPad = 0; if (++preF >= PRE_SETTLE) { pre = false; tryDrive(); }
  }
  function tryDrive() { // 고른 모드가 있고 원작 모드 선택 화면이 준비됐으면 구동 시작
    if (!menuOn || want === null || pre || drv) return;
    drv = window.NKDriver.create(want, wantOpt);
  }
  function stepDrv() { // 프레임마다: 구동기가 낸 패드 값을 엔진에 넣고, 끝나면(성공·실패 모두) 층을 걷는다
    if (drvEnd) return;
    const r = drv.step(mirror.m, koSnap ? koSnap.pal : null); autoPad = r.pad; autoPad2 = r.pad2 || 0;
    if (r.state === 'run') return;
    autoPad = 0; autoPad2 = 0; drvEnd = r.state; acc = 0; last = 0; // 빨리 감기 뒤 누산기 초기화
    if (r.state === 'fail') { console.warn('메뉴 구동 실패(원작 메뉴를 그대로 보여 줍니다): ' + r.why); const L = lay || UI; if (L.driveFailed) L.driveFailed(); } // 안전망: 사용자가 원작 메뉴에서 직접 진행(신규 층이 모은 선택은 버린다)
    else { const L = lay || UI; if (L.driveDone && L.driveDone(want, mirror.m)) { drv = null; drvEnd = null; want = null; wantOpt = null; return; } } // 이어 띄울 신규 화면이 있으면(스토리 팀·룰·대진표, analysis/23 1단계) 덮개를 걷지 않는다. 엔진은 원작 입력 대기에서 기다린다
    tryLink();
  }
  function tryLink() { // 구동이 끝났고 한글 층이 준비됐으면 층을 걷는다(한글 층 준비 전에는 원작 일본어가 비치므로 기다린다)
    if (!menuOn || !drvEnd || fbStale || (ko && !koMod && !koErr)) return; // fbStale: 마지막 프레임이 화면 생략 프레임이면 다음 그린 프레임까지(onWorker)
    picked = want; want = null; menuOn = false; autoPad = 0; autoPad2 = 0; held.clear(); padBlock = true; writePads(); (lay || UI).hide(); lay = null;
    viewMode(mirror.m); // 덮개를 걷는 그 자리에서 배치(필드 확대·패널)를 다시 판정한다(다음 엔진 프레임까지 종전 배치가 비치지 않게)
    cover(false); msg.classList.remove('hide'); setTimeout(hideMsg, 10000);
  }
  // 덮개 아래 빨리 감기(14 문서 5절, 워커는 그대로): 설정에 fast 가 있는 구동(신규 UI 층의 battle_full) 동안은 60Hz 누산기를 기다리지 않고, 프레임을 받는 즉시 구동기가 낸 패드를 쓰고 다음 한 프레임을 허가한다.
  // 엔진이 받는 것은 프레임별 패드뿐이라 1배속 구동과 같은 상태에 도착한다. 그동안 소리는 대기열에 넣지 않는다(구동 중 무음은 종전과 같다)
  //   타이틀 대기 뒤 고른 직후의 START 넘김(pre, 약 3.6초)도 신규 층에서는 빨리 감는다(덮개 아래, 패드열 동일)
  const fastOn = () => turbo || !!(drv && menuOn && !drvEnd && wantOpt && wantOpt.fast) || (!!MG && UI === MG && menuOn && pre && want !== null && !online) || (vsk.st === 2 && !online); // 마지막 = 승리 연출 건너뛰기(위 vsk)
  // 일시정지 메뉴(신규 층): 전투(1:2) 중 Esc·START 로 연다. 워커에는 멈춤 신호가 없으므로 P 키와 같이 프레임 허가를 멈춘다(엔진 상태는 그대로 남는다). 원작의 START 일시정지 대신 쓴다
  const canPause = () => !!MG && ready && !online && !menuOn && !paused && !fatal && !MG.active && mirror.m[0x641] === 1 && (mirror.m[0x642] & 0x7F) === 2 && performance.now() - resumeAt > 300;
  function openPause(ev) { if (!canPause() || !MG.pause(ev)) return false; paused = true; held.clear(); writePads(); hideMsg(); return true; }
  function resume() { paused = false; last = 0; acc = 0; held.clear(); padBlock = true; writePads(); resumeAt = performance.now(); }
  // 신규 층이 고른 것: 구동할 모드(battle_full · battle_again · battle · story) 또는 동작(resume = 일시정지 풀기, quit = 처음부터 다시 시작해 신규 타이틀로)
  function pick(m, o) {
    if ((m === 'online' || m === 'quit' || /^battle/.test(m)) && window.NKOpening) window.NKOpening.arm(false); // 스토리 새 게임 밖으로: 미리 만든 오프닝 워커를 버린다(web/opening_scene.js)
    if (m === 'online') { recArm = false; return onlineStart(o); } // 신규 층 대기방에서 start 를 받음 → 락스텝 구동(성공 여부를 돌려준다)
    if (m === 'rec_new') return recNew(o); if (m === 'story_load') { recArm = false; return storyLoad(o); } if (m === 'rec_seg') return recSeg(); if (m === 'rec_trim') return recTrim(o && o.from); if (m === 'rec_off') { rec = null; recArm = false; return true; } // 스토리 저장(위 rec 블록)
    let rb = false; // 미뤄 둔 새 게임 기록(recArm): 첫 스토리 구동에서 엔진을 시작 상태로 다시 만들고 첫 프레임부터 기록(종전 recNew 와 같은 순서·같은 패드열)
    if (recArm && /^story/.test(m)) { recArm = false; rec = mkRec(titleBoot.frameNo, null); loadWait = 0; reboot(); rb = true; } else if (m !== 'resume') recArm = false;
    if (rec && !/^story/.test(m) && m !== 'resume' && m !== 'reboot' && m !== 'quit') rec = null; // 스토리 밖 구동(배틀 등) = 기록 끝
    if (m === 'resume') return resume();
    if (m === 'quit') { resume(); return reset(); }
    if (m === 'reboot' || (o && o.reboot)) { if (!rb) reboot(); if (m === 'reboot') return; } // 엔진만 처음부터(신규 층은 그대로 덮은 채): 원작 타이틀 넘김(pre) 뒤 구동. 스토리 팀·룰에서 되돌아가 설정을 바꿀 때(analysis/23 1단계)
    want = m; wantOpt = o || null; tryDrive();
  }
  function reboot() { // 기록 중이면 새 엔진의 첫 프레임부터 다시 기록(lead 패드 0). 지금 워커가 다른 boot(불러온 상태)면 워커를 새로 만든다
    if (!ready) return; fatal = null; zeroExt();
    if (rec) { rec = mkRec(titleBoot.frameNo, null); Atomics.store(ctl, PAD, 0); Atomics.store(ctl, PAD + 1, 0); }
    const to = rec ? titleBoot : holdOf(); // 기록 중 = 시작 상태(boot_title)부터. 그 밖 = 타이틀 대기 상태(대련부터)
    if (curBoot !== to) bootWith(to); else { Atomics.add(ctl, RESET, 1); Atomics.notify(ctl, RESET); Atomics.notify(ctl, CREDIT); }
    openMenu(() => {});
  }
  function onSettings(s) { speedSet = speedOf(s.speed); /* 게임 중에도 다음 화면 주기부터 바로 */ nfSet = s.nf === 0 ? 0 : 1; applyNf(); vol = s.vol / 10; if (wk && wk.node) wk.node.port.postMessage({ vol }); if (scaleSet !== s.scale) { scaleSet = s.scale; fit(); } viewMode(mirror.m); /* 게이지 패널 켬·끔(정지 중에도 바로 반영) */ if (s.mute !== undefined) { muted = !!s.mute; aSync(); } /* 음소거(설정 칸 mute, 호스트 출력단만) */ if (hdWant()) loadHd(); /* HD 배경을 설정에서 처음 켬 */ }
  const showFatal = s => { fatal = s; info.style.display = ''; info.textContent = '엔진 정지: ' + s; console.error('엔진 정지: ' + s); };

  function pushAudio(a) { // 배속 중에도 리샘플하지 않는다: 워커(web/sound_clock.js)가 이미 실시간 길이만큼(프레임당 약 734/배율 샘플) 원래 음 높이·템포로 합성해 보낸다
    const n = a.length; let k = 0;
    for (; k < n; k++) { const s = a[k]; ring[(wpos + k) & (RING - 1)] = s; if (s > audioStat.peak) audioStat.peak = s; }
    wpos += k; audioStat.samples += k;
    if (wk) { Atomics.store(wk.st, 0, wpos); return; } // 워클릿: 덮어쓴 구간 버림은 읽는 쪽(워클릿)이 한다(32비트 순환, 차이는 |0)
    if (wpos - rpos > RING) rpos = wpos - RING; // 재생이 멈춰 있는 동안 덮어쓴 구간은 버림
  }
  // 워클릿에 무음·정지 상태를 알린다(종전 콜백이 읽던 muted·pre·구동 중·paused 와 같은 조건). 워커 프레임·화면 주기·키 입력마다
  const aSync = () => { if (wk) Atomics.store(wk.st, 2, (muted || (pre && !holding()) || (drv && menuOn) || (online && menuOn) ? 1 : 0) | (paused ? 2 : 0) | (window.NKImpact && window.NKImpact.stopping ? 4 : 0)); }; // 4 = 히트스톱(web/impact_fx.js, 오프라인만): 워클릿이 그동안 링을 읽지 않는다
  // 소리 컨텍스트 미리 만들기: 첫 클릭·키 처리 안에서 new AudioContext(약 100ms, 실측)가 화면을 멈추지 않게 타이틀 대기 중(입력 전)에 만들어 둔다.
  //   입력 전에는 suspended 로 남고(자동 재생 정책), 링·워클릿·워커 소리 칸 설정은 종전대로 첫 입력의 initAudio 에서 한다
  let preAc = null;
  function preAudio() { if (actx || preAc) return; const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; try { preAc = new AC({ sampleRate: 44100 }); } catch (e) { preAc = null; } }
  function initAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC || !ready) return;
    actx = preAc || new AC({ sampleRate: 44100 }); preAc = null; if (actx.state === 'suspended') actx.resume(); // 미리 만든 컨텍스트(preAudio)는 첫 사용자 입력에서 resume
    rpos = wpos; Atomics.store(ctl, AUDIO, actx.sampleRate | 0);
    if (actx.audioWorklet && typeof AudioWorkletNode === 'function') { // 링·위치를 공유 메모리로 옮기고 워클릿을 불러온다
      // 불러오는 동안 온 소리는 링에 쌓이되, 노드를 만들 때 선버퍼(PREBUF)만 남기고 앞은 버린다(종전은 출력이 곧바로 시작해 선버퍼만큼 모이면 재생했다.
      // 남겨 두면 그 분량이 그대로 지연이 되고 허가율 보정 ±0.1% 로는 초당 44 샘플밖에 줄지 않는다). audioStat.wkMs = 불러오기 시간, wkDrop = 버린 샘플
      const sab = new SharedArrayBuffer(RING * 4), st = new Int32Array(new SharedArrayBuffer(32)), A = actx, t0 = performance.now();
      ring = new Float32Array(sab); Atomics.store(st, 0, wpos); Atomics.store(st, 1, rpos);
      wk = { st, node: null }; audioStat.out = 'worklet'; aSync();
      const live = (k, i) => Object.defineProperty(audioStat, k, { get: () => Atomics.load(st, i), enumerable: true, configurable: true });
      live('underruns', 3); live('skips', 4);
      A.audioWorklet.addModule('audio_worklet.js').then(() => {
        const q = (Atomics.load(st, 0) - Atomics.load(st, 1)) | 0; audioStat.wkMs = Math.round(performance.now() - t0); audioStat.wkDrop = Math.max(0, q - PREBUF);
        if (q > PREBUF) Atomics.store(st, 1, Atomics.load(st, 0) - PREBUF);
        const n = new AudioWorkletNode(A, 'nk-out', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { ring: sab, st: st.buffer, vol } });
        n.port.onmessage = e => { rateAdj = e.data.adj; if (typeof e.data.low === 'number') { audioStat.rateAdj = rateAdj; audioStat.low = e.data.low; } };
        wk.node = node = n; n.connect(A.destination);
      }).catch(e => { // 폴백: 종전 ScriptProcessor(링은 공유 메모리 그대로, 위치만 이 스레드로)
        console.warn('AudioWorklet 불러오기 실패(ScriptProcessor 로 출력): ' + (e && e.message || e));
        rpos = Atomics.load(st, 1); wk = null;
        ['underruns', 'skips'].forEach((k, j) => Object.defineProperty(audioStat, k, { value: Atomics.load(st, 3 + j), writable: true, enumerable: true, configurable: true }));
        scriptOut();
      });
      return;
    }
    scriptOut();
  }
  function scriptOut() { // 종전 출력 경로(ScriptProcessor, 워클릿이 없는 환경의 폴백)
    audioStat.out = 'script';
    node = actx.createScriptProcessor(1024, 0, 1);
    node.onaudioprocess = ev => { // 출력단(DC 제거 + 게인)은 오라클 프런트(public/app.js)와 같은 식
      const out = ev.outputBuffer.getChannelData(0), sr = actx.sampleRate; let i = 0;
      const emit = s => { hp1 += (s - hp1) * 0.0005; out[i++] = muted || (pre && !holding()) || (drv && menuOn) || (online && menuOn) ? 0 : (s - hp1) * 1.6 * vol; };
      // 안전장치(정상 구동에서는 위 허가율 제어로 여기까지 오지 않는다): 재생 쪽이 멈췄다 풀리는 등으로 밀린 소리가 0.15초를 넘으면
      // 0.06초 지점으로 건너뛰되, 잘라 붙이지 않고 XF 샘플 동안 교차 페이드한다
      if (wpos - rpos > sr * 0.15) {
        const to = wpos - Math.floor(sr * 0.06); audioStat.skips++;
        for (let k = 0; k < XF && i < out.length; k++) { const g = k / XF; emit(ring[(rpos + k) & (RING - 1)] * (1 - g) + ring[(to + k) & (RING - 1)] * g); }
        rpos = to + XF;
      }
      if (!primed && wpos - rpos >= PREBUF) primed = true;
      if (primed) {
        const n = Math.min(out.length - i, wpos - rpos);
        for (let k = 0; k < n; k++) emit(ring[(rpos + k) & (RING - 1)]);
        rpos += n;
        if (i < out.length) { primed = false; if (!paused) audioStat.underruns++; } // 바닥남: 다시 모일 때까지 무음
      }
      for (; i < out.length; i++) out[i] = 0;
      if (paused) { rateAdj = 0; lowWin = Infinity; lowN = 0; } else { // 바닥값 창 → 허가율 보정(바닥났으면 0 으로 본다)
        const low = primed ? wpos - rpos : 0; if (low < lowWin) lowWin = low;
        if (++lowN >= LOW_WIN) { rateAdj = Math.max(-ADJ_MAX, Math.min(ADJ_MAX, (LOW_TGT - lowWin) / sr * ADJ_GAIN)); audioStat.rateAdj = rateAdj; audioStat.low = lowWin; lowWin = Infinity; lowN = 0; }
      }
    };
    node.connect(actx.destination);
  }
  function onWorker(ev) {
    const d = ev.data;
    if (d.ready) { ready = true; pal32 = d.pal32; fit(); if (!ticking) { ticking = true; requestAnimationFrame(tick); } if (ko) setKo(true); return; } // 워커를 새로 만들어도(bootWith) 화면 주기는 하나
    if (d.fatal) { showFatal(d.fatal); return; }
    received++; fcount++; skipSet(0); fbStale = !d.fb; // 생략은 아래 빨리 감기 허가에서만 다시 켠다
    mirror.frame = d.frame; mirror.loops = d.loops; mirror.m = d.ram; viewMode(d.ram);
    if (TAGS) TAGS.frame(d.frame, d.ram); // 선수 표시 층: 화면이 RAM 보다 4프레임 늦어 프레임별 RAM 을 쌓아 둔다(읽기만)
    if (FX) FX.frame(d.frame, d.ram); // 타격 이펙트 층: 명중·다운 감지(읽기만)
    if (window.NKTutorial && !online) window.NKTutorial.frame(d.frame, d.ram); // 튜토리얼(web/tutorial.js, analysis/27 T2): 단계 판정(읽기만, 로컬 전용)
    if (HD) HD.spr = d.spr || null; // HD 층: 그 프레임의 스프라이트 사본(보이는 스프라이트 픽셀을 가르는 데만 쓴다)
    if (rec && !online) recFrame(d);
    if (online) { if (d.fb) img32.set(d.fb); koSnap = d.ko || null; paint(); if (actx && d.audio.length && !menuOn) pushAudio(d.audio); onlineFrame(d); return; } // 온라인: 부팅 화면 복귀·결과·대진표 감지는 하지 않는다
    if (MENU && !menuOn && d.ram[0x641] === BOOT_MODE) { exits++; reset(); return; } // 원작 부팅 화면으로 빠짐 → 신규 타이틀로(이 프레임은 그리지도 소리 내지도 않는다)
    if (MENU && MG && UI === MG && !menuOn) { // 전투 종료 → 결과 화면(15 문서 8절): 1:5 진입 프레임의 RAM 을 잡아 두고, 모드 0(스테이지 선택으로 복귀)이 되면 신규 결과 화면으로 덮는다. 엔진은 덮개 아래 원작 스테이지 선택(0:1)에서 기다린다
      const md = d.ram[0x641], sub = d.ram[0x642] & 0x7F;
      if (md === 1) { if (sub !== 5) endRam = null; else if (!endRam) endRam = d.ram; }
      else if (endRam) { const r = endRam; endRam = null; if (md === 0 && r[0x645] >= 2 && UI.result(r)) { menuOn = true; pre = false; autoPad = 0; autoPad2 = 0; want = null; wantOpt = null; picked = null; drv = null; drvEnd = null; held.clear(); hideMsg(); cover(true); } }
    }
    if (MG && !menuOn) { // 스토리 화면 덮기(COVER 표, 15 문서 16절 · analysis/23 10절): 스토리($0645 0·1)에서 표의 모드에 든 뒤 조건이 처음 맞는 프레임에 NKManga.<함수>(RAM) 으로 덮는다. 원작은 그 화면에서 기다리고, 층이 떠 있는 동안 사용자 입력은 엔진에 넣지 않는다.
      //   함수가 { plan, opt } 를 돌려주면 덮은 채 그 구동(원작 화면을 입력 대기까지 넘김)을 바로 시작한다
      const r = d.ram;
      for (const c of COVER) {
        if (r[0x641] !== c[0]) covSeen[c[0]] = false;
        else if (!covSeen[c[0]] && c[1](r) && r[0x645] <= 1) {
          covSeen[c[0]] = true; const v = !MG.active && !paused && MG[c[2]] ? MG[c[2]](r) : false;
          if (v) { lay = MG; menuOn = true; pre = false; autoPad = 0; autoPad2 = 0; want = null; wantOpt = null; picked = null; drv = null; drvEnd = null; held.clear(); hideMsg(); cover(true); if (v.plan) { want = v.plan; wantOpt = v.opt || null; tryDrive(); } }
        }
      }
    }
    if (MG && (vsk.st || d.ram[0x641] === 1)) vskStep(d.ram); // 승리 연출 건너뛰기(덮기 판정 뒤: 덮개가 뜬 프레임에 끝낸다)
    if (loadWait && MG) storyLift(d);
    if (d.fb) { img32.set(d.fb); if (MID && !menuOn) MID.frame(d, img32); /* 로컬 전투의 화면 픽셀만 바꾼다(자기 점검 실패·대상 밖이면 그대로). 엔진·입력과 무관 */ } koSnap = d.ko || null; if (d.fb) paint(); // 생략 프레임(fb null)은 그리지 않는다(덮개 아래). koSnap(구동기 팔레트)은 그대로 받는다
    if (pre) stepPre(); else if (drv && menuOn) stepDrv();
    if (!fbStale && drvEnd && menuOn) tryLink(); // 생략 프레임에서 끝난 구동: 다음 그린 프레임에서 덮개를 걷는다(tryLink 의 fbStale 대기)
    if (holding() && MG.titleBg) MG.titleBg(d.fb, d.ram); // 타이틀 대기: 원작 타이틀 프레임(모드 3)을 메인 메뉴 배경으로(표시 전용)
    if (menuOn && MG && MG.lobbyBg) MG.lobbyBg(d.fb, d.ram); // 대기실 덮개: 원작 체육관 컷(모드 10, 표시 전용. 층이 대기실일 때만 그린다)
    if (fastOn()) { const sk = turbo ? 0 : 1; /* 덮개 아래 빨리 감기 = 다음 한 프레임 화면·소리 생략(turbo 는 그린다) */ if (rec) { if (!paused) { skipSet(sk); if (!recGrant()) skipSet(0); } return; } writePads(); if (!paused && !fatal && granted === received) { skipSet(sk); granted++; Atomics.store(ctl, CREDIT, granted); Atomics.notify(ctl, CREDIT); } return; }
    if (actx && d.audio.length) pushAudio(d.audio);
    if (rec && !paused && acc >= 1 && recGrant()) acc -= 1; // 기록 중: 받은 즉시 다음 한 프레임(60Hz 예산 안에서)
  }
  function paint() { // 코어 프레임 + (켜져 있으면) 한글 층
    ctx.putImageData(img, OX, 0);
    if (ko && koMod && koSnap) {
      try { koMod.draw(ctx, OX, koSnap, mirror.m); } // 한글 층은 캔버스 상태(save·clip·변환)를 바꾸지 않고 256x240 층 그림 한 장만 얹는다
      catch (e) { koErr = String(e && e.message || e); ko = false; Atomics.store(ctl, KOF, 0); console.error('한글 층 오류: ' + koErr); ctx.putImageData(img, OX, 0); } // 층을 끄고 원작 화면으로 되돌린다
    }
    if (HD) HD.draw(img32, koSnap, mirror.m, menuOn || !hdWant()); // 설정에서 끄면 덮개만 숨긴다(원작 배경) // 전투 배경 HD 층(?hd=1, web/hd_layer.js): 코어 캔버스는 그대로 두고 필드 자리 덮개 캔버스에만 그린다(표시 전용)
  }
  function setKo(on) {
    ko = on; if (!ctl) return;
    Atomics.store(ctl, KOF, on || hdLoad ? 1 : 0); // HD 층이 켜져 있으면 PPU 사본은 계속(글자는 ko 일 때만 그린다)
    if (on && !koMod && !koLoading) {
      koLoading = true;
      const s = document.createElement('script'); s.src = 'korean.js';
      const fail = m => { koErr = m; ko = false; Atomics.store(ctl, KOF, 0); console.error('한글 층 불러오기 실패: ' + koErr); tryLink(); }; // 표·글꼴이 없으면 층만 끈다(게임은 그대로, 워커의 PPU 사본 전송도 멈춤)
      s.onload = () => window.NKKorean.init({ chr: romChr, pal32 }).then(() => { koMod = window.NKKorean; if (received) paint(); tryLink(); }).catch(e => fail(String(e && e.message || e)));
      s.onerror = () => fail('korean.js 불러오기 실패');
      document.head.appendChild(s);
    }
    // 정지(P) 중에 처음 켰으면 PPU 사본이 아직 없다(워커는 켜진 뒤의 프레임만 관측한다) → 한 프레임만 진행시켜 사본을 받는다
    if (on && paused && !koSnap && ready && !fatal) { if (rec) recGrant(); else if (granted === received) { granted++; Atomics.store(ctl, CREDIT, granted); Atomics.notify(ctl, CREDIT); } }
    if (received) paint(); // 정지(P) 중에 껐을 때도 바로 원작 화면으로
  }
  function reset() { // 처음부터: 워커가 현재 엔진을 버리고 시작 상태에서 다시 만든다
    if (!ready) return;
    fatal = null; if (!DEBUG) info.style.display = 'none';
    rec = null; recArm = false; loadWait = 0; // 처음부터 = 스토리 기록 끝. 불러온 상태로 돌던 워커는 시작 상태로 새로 만든다
    const to = MENU ? holdOf() : titleBoot; // 신규 타이틀로 돌아갈 때는 대련부터
    zeroExt(); if (curBoot !== to) bootWith(to); else { Atomics.add(ctl, RESET, 1); Atomics.notify(ctl, RESET); Atomics.notify(ctl, CREDIT); } for (const k in covSeen) covSeen[k] = false;
    if (MENU) openMenu(); // 처음부터 = 신규 타이틀부터
    else if (menuOn && lay) { menuOn = false; drv = null; drvEnd = null; want = null; wantOpt = null; lay.hide(); lay = null; cover(false); } // ?state= 주소에서 신규 층(대진표·대기실)이 덮고 있을 때: 층을 걷고 그 상태부터 다시
  }
  let last = 0, acc = 0, fcount = 0, ft = 0;
  function tick(t) {
    requestAnimationFrame(tick);
    if (!last) last = t; let dt = t - last; last = t; if (dt > 100) dt = 100;
    if (MG) { const g = (navigator.getGamepads ? navigator.getGamepads() : [])[0], sb = KM ? KM.startBtn : 9, st = !!(g && sb >= 0 && g.buttons[sb] && g.buttons[sb].pressed); if (st && !gpStart) openPause(null); gpStart = st; } // 게임패드 START = 일시정지 메뉴
    keyDrain(); writePads(); aSync(); // 게임패드는 이벤트가 없으므로 화면 주기마다 갱신(키보드는 키 이벤트에서 즉시 갱신, 밀린 짧은 탭은 여기서)
    if (ctl) { Atomics.store(ctl, SPD, Math.round(spd() * 1000)); if (ctl.length > SFXQ) Atomics.store(ctl, SFXQ, sfxQuiet() ? 1 : 0); } // 워커 소리 시계에 현재 배율(1000 = 1배속: 소리 종전 그대로). 엔진(게임 로직)에는 영향 없음
    const hs = !online && !!window.NKImpact && window.NKImpact.stop(t); // 히트스톱(web/impact_fx.js, 오프라인만): 참이면 이번 화면 주기는 프레임 허가 없음(허가 시점만 바뀜, 엔진·패드열 불변)
    if (online) { // 리셋 대기(워커가 멈출 때까지 허가하지 않는다) → 락스텝: 내 입력 보내기 + 60Hz 예산(밀려도 2프레임까지만 따라잡기)
      const o = online;
      if (o.phase === 'idle') { if (ready && received >= 1 && granted <= received) onlineReset(); } // 시작 때 bootWith 로 새로 만든 워커 = 준비되고 첫 프레임을 낸 뒤(허가 대기로 멈춤)에 리셋(그 전에 리셋하면 앞 세대 첫 프레임이 run 단계로 들어와 프레임이 어긋난다)
      else { if (!o.tail) o.ls.pump(); if (o.drvState !== 'run' || o.tail) o.acc = Math.min(o.acc + dt * RATE * spd() * (1 + rateAdj) / 1000, 2); onlineAdvance(); }
    } else if (rec) { // 스토리 저장 기록: 60Hz 예산(밀려도 2프레임) 안에서 워커가 멈춰 있을 때 한 프레임씩
      if (!fatal && !paused && ready && !hs) { acc = Math.min(acc + dt * RATE * spd() * (1 + rateAdj) / 1000, 2); if (acc >= 1 && recGrant()) acc -= 1; }
    } else if (!fatal && !paused && ready && !hs) {
      acc += dt * RATE * spd() * (1 + rateAdj) / 1000; // spd() = 전투 속도(로컬 시합 진행 1:2 만, 그 밖·온라인 경로는 1배속 그대로). rateAdj: 소리 대기열 수준에 따른 ±0.1% 이내 보정(소리가 꺼져 있으면 0)
      let n = 0; while (acc >= 1 && n < MAX_AHEAD) { acc -= 1; n++; }
      if (acc >= 1) acc -= Math.floor(acc); // 밀린 분량은 버린다(느린 구간 뒤 따라잡기 배속 방지)
      n = Math.min(n, MAX_AHEAD - (granted - received)); // 워커가 밀려 있으면 더 쌓지 않는다
      if (n > 0) { granted += n; Atomics.store(ctl, CREDIT, granted); Atomics.notify(ctl, CREDIT); }
    }
    if (t - ft > 1000) { if (!fatal) info.textContent = 'fps ' + fcount + ' / 프레임 ' + mirror.frame + (actx ? ' / 소리 ' + actx.state : ' / 소리 꺼짐') + (paused ? ' / 정지(P)' : ''); fcount = 0; ft = t; }
  }
  window.addEventListener('keydown', e => {
    initAudio(); hideMsg();
    const tg = e.target; if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return; // 입력 칸(신규 층 에디트 폼의 이름·고르기)에 쓰는 키는 게임 키(R 다시 시작·P 정지·패드 등)로 쓰지 않는다
    if (MG && MG.overlay) return; // 일시정지 메뉴가 떠 있는 동안 키는 그 메뉴가 받는다
    if (online && !menuOn && MG && MG.forfeitOpen && MG.forfeitKey(e)) { e.preventDefault(); if (keyAt(e.code, false)) writePads(); return; } // 기권 확인 창이 떠 있으면 창 키(Esc·Enter·←→·Tab)는 창이 먹는다(그 밖의 키는 아래로 = 엔진, 판은 계속)
    if (online && !menuOn && e.code === 'Escape' && MG && MG.forfeitTap) { e.preventDefault(); if (!e.repeat && !online.resSent) MG.forfeitTap(); return; } // 온라인 대전 중 Esc = 기권 확인 창(ui_manga.js). 결과를 보낸 뒤(승부 남) = 무시
    if ((online || (MG && MG.online)) && (e.code === 'KeyP' || e.code === 'KeyR')) return; // 온라인(대기방·대전)에서는 정지·처음부터를 막는다
    const pk = kmap[e.code]; // 일시정지 = Esc · 1P 시작 키(기본 Enter, 키 리매핑을 따른다)
    if ((e.code === 'Escape' || (pk && pk[1] === 0 && pk[2] === 8)) && !e.repeat && openPause(e)) { e.preventDefault(); return; }
    if (e.code === 'KeyP' || e.code === 'KeyM' || e.code === 'KeyR' || e.code === 'KeyK') {
      if (e.repeat) return; // 누르고 있는 동안의 자동 반복은 무시
      if (e.code === 'KeyP') { paused = !paused; last = 0; acc = 0; } else if (e.code === 'KeyM') { muted = !muted; if (window.NKSettings) window.NKSettings.set('mute', muted ? 1 : 0); /* 설정 「음소거」와 같은 칸(저장) */ } else if (e.code === 'KeyK') setKo(!ko); else reset();
      aSync(); return;
    }
    const k = kmap[e.code]; if (!k) return;
    e.preventDefault(); if (e.repeat) return;
    if (keyAt(e.code, true)) writePads();
  });
  window.addEventListener('keyup', e => { const k = kmap[e.code]; if (k) { e.preventDefault(); if (keyAt(e.code, false)) writePads(); } });
  window.addEventListener('blur', () => { held.clear(); writePads(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { held.clear(); writePads(); } }); // 탭 전환·최소화로 keyup 을 못 받아 방향이 눌린 채 남지 않게
  window.addEventListener('pointerdown', () => { initAudio(); hideMsg(); });
  window.addEventListener('beforeunload', e => { if (online) { e.preventDefault(); e.returnValue = ''; } }); // 대전 중 새로 고침 = 20초 뒤 기권(16 문서 6.6)
  ctx.fillStyle = '#000'; if (WIDE) ctx.fillRect(OX, 0, 256, CH); else ctx.fillRect(0, 0, CW, CH);
  window.__game = { mirror, audioStat, get engine() { return ready ? mirror : null; }, get fatal() { return fatal; }, get paused() { return paused; },
    touch: { // 터치 패드(web/touch_pad.js) 훅: 가상 키(위 TOUCH)만 키보드와 같은 keyAt 으로. show = 원작 화면이 보이고 사람 입력을 받는 동안(덮개·일시정지·오류 아님)
      key(c, on) { if (c && c[0] === '#' && kmap[c] && keyAt(c, !!on)) writePads(); }, ripe(c) { return !kq.has(c) && keyRipe(c); },
      clear() { for (const k of TOUCH) { held.delete(k[0]); kq.delete(k[0]); kAt.delete(k[0]); } writePads(); },
      pause: () => openPause(null), get fight() { return inFight(mirror.m); }, get online() { return !!online; },
      get show() { return ready && !fatal && !menuOn && !paused && vsk.st !== 2 && !(MG && (MG.active || MG.overlay)); } },
    hold(v) { if (online) return; paused = !!v; last = 0; acc = 0; held.clear(); aSync(); }, /* 오프닝 장면(web/opening_scene.js) 재생 중 본 엔진 프레임 허가 멈춤(정지 P 와 같은 경로: 기록·소리도 멈춤) */ get turbo() { return turbo; }, set turbo(v) { turbo = !!v; if (!turbo) { acc = 0; last = 0; } }, get queued() { return wk ? (Atomics.load(wk.st, 0) - Atomics.load(wk.st, 1)) | 0 : wpos - rpos; }, get speed() { return spd(); }, get noFlicker() { return ctl ? Atomics.load(ctl, NF) === 1 : nfOn(); }, get pads() { return ctl ? [Atomics.load(ctl, PAD), Atomics.load(ctl, PAD + 1), Atomics.load(ctl, PAD3), Atomics.load(ctl, PAD4)] : null; },
    get menu() { return MENU ? { on: menuOn, pre, hold: holding(), recArm, exits, want, opt: wantOpt, picked, drive: drv ? Object.assign({ end: drvEnd }, drv.info) : null, ui: UI.state, layer: UI === window.NKMenu ? 'menu' : 'manga' } : null; },
    get ko() { return { on: ko, ready: !!koMod, error: koErr, stats: koMod ? koMod.stats : null }; },
    get rec() { return rec ? { from: rec.from, n: rec.n, live: rec.live, bad: rec.bad, point: rec.point, key: rec.key } : null; }, get load() { return { wait: !!loadWait, ms: loadMs, boot: curBoot === titleBoot ? 'title' : curBoot && curBoot === holdBoot ? 'hold' : curBoot ? 'state' : '' }; },
    get online() { const o = online; return o ? { phase: o.phase, slot: o.slot, humans: o.H, exec: o.ls.exec, have: o.ls.have, sent: o.ls.sent, drive: o.drvState, result: o.resSent, cover: menuOn } : null; }, get sfxQuiet() { return sfxQuiet(); }, get sfxFlag() { return ctl && ctl.length > SFXQ ? Atomics.load(ctl, SFXQ) : -1; }, get sfxStat() { return ctl && ctl.length > SFXQ + 3 ? { req: Atomics.load(ctl, SFXQ + 1), drop: Atomics.load(ctl, SFXQ + 2), mode: Atomics.load(ctl, SFXQ + 3) } : null; } };
  // 원격(https·비루프백) 접속 = 보호 경로(/rom/ /state/ /ui/ /engine/gen/)를 받기 전에 세션 쿠키부터(web/asset_session.js, analysis/27 M0). 로컬은 바로 동기 실행 = 종전 그대로
  const NKS = window.NKSess, bootAll = () => {
  if (MENU) { // 신규 층 초기화가 실패하면 종전 층으로 폴백
    try { UI.init({ canvas: cv, onPick: pick, onSettings }); } catch (e) { if (UI === window.NKMenu) throw e; console.warn('신규 UI 층 초기화 실패(종전 메뉴 층을 씁니다): ' + (e && e.message || e)); UI = window.NKMenu; UI.init({ canvas: cv, onPick: pick }); }
    openMenu();
  }
  if (!CLASSIC && window.NKManga && window.NKManga.enabled) { try { window.NKManga.initHud({ canvas: cv, mirror, onPick: pick, onSettings }); } catch (e) { console.warn('전투 HUD 층 초기화 실패(원작 HUD 만 씁니다): ' + (e && e.message || e)); } } // 전투 게이지 패널(코어 캔버스 밖, RAM 읽기 전용)
  if (typeof SharedArrayBuffer === 'undefined' || !window.crossOriginIsolated) { info.style.display = ''; info.textContent = '실행 불가: 공유 메모리를 쓸 수 없습니다(node server_game.js 로 연 127.0.0.1 주소에서 실행).'; return; }
  const boot = n => Promise.all([
    fetch('/rom/nekketsu.nes').then(r => { if (!r.ok) throw new Error('ROM 불러오기 실패 ' + r.status); return r.arrayBuffer(); }),
    fetch('/state/' + STATE + '.json').then(r => { if (!r.ok) throw new Error('시작 상태 불러오기 실패 ' + r.status + ' (node tools/make_boot_state.js 필요)'); return r.json(); }),
    MENU && STATE === 'boot_title' && window.NKManga && window.NKManga.enabled ? fetch('/state/title_fight.json').then(r => r.ok ? r.json() : null, () => null) : null, // 없으면 종전(boot_title 인트로부터)
  ]).then(([b, st, hb]) => {
    bootFrame = Number.isInteger(st.frameNo) ? st.frameNo : -1; // 온라인 프레임 번호 k = 엔진 프레임 - 시작 상태 프레임
    romU8 = new Uint8Array(b); titleBoot = st; holdBoot = hb && Number.isInteger(hb.frameNo) && Array.isArray(hb.ram) ? hb : null;
    if (!CLASSIC && window.NKManga && window.NKManga.enabled) { const s = document.createElement('script'); s.src = 'unit_tags.js'; s.onload = () => { window.NKTags.init({ canvas: cv, rom: romU8 }); if (window.NKTags.ready) TAGS = window.NKTags; }; document.head.appendChild(s); } // 선수 표시 층(팀 표식·이름, 메타스프라이트 표는 ROM 에서 읽는다)
    if (!CLASSIC && window.NKManga && window.NKManga.enabled) { const s = document.createElement('script'); s.src = 'hit_fx.js'; s.onload = () => { window.NKHitFx.init({ canvas: cv, rom: romU8 }); if (window.NKHitFx.ready) FX = window.NKHitFx; const t = document.createElement('script'); t.src = 'impact_fx.js'; document.head.appendChild(t); }; document.head.appendChild(s); } // 타격 이펙트 층 + 타격감 층(web/impact_fx.js, hit_fx 구독자)
    { const r = new Uint8Array(b), np = r[4] * 16384; romChr = r.slice(16 + np, 16 + np + r[5] * 8192); } // 한글 층이 글자 타일의 색을 읽는 데 쓴다
    ctl = new Int32Array(new SharedArrayBuffer(128)); applyNf(); // 32칸(종전 16칸 + ctl[16] 타이틀 밖 효과음 끔). 워커가 렌더러를 만들기 전에 깜박임 제거 칸을 채운다
    if (!CLASSIC && /[?&]mid=1(&|$)/.test(location.search)) { const s = document.createElement('script'); s.src = 'sprite_layer.js'; s.onload = () => { MID = window.NKSprite; Atomics.store(ctl, 8, 1); MID.init({ chr: romChr }); }; document.head.appendChild(s); }
    if (hdWant()) loadHd(); // 전투 배경 HD 층(기본 꺼짐): 한글 층 PPU 사본(ctl[5])·스프라이트 사본(ctl[8])을 같이 켠다(?ko=0 이어도 글자는 그리지 않는다. 워커는 읽기 전용 관측만 한다)
    startWorker(MENU ? holdOf() : st); // 신규 층 타이틀 = 대련 상태로 바로(온라인 프레임 번호 bootFrame 은 titleBoot 기준 그대로, 온라인은 시작 때 titleBoot 로 다시 만든다)
    if (MENU) setTimeout(() => { if (!actx) (window.requestIdleCallback || setTimeout)(preAudio); }, 1500); // 타이틀 대기 중 소리 컨텍스트 미리 만들기(위 preAudio)
  }).catch(e => {
    if (NKS && NKS.need && n < 2 && /\s(403|429)\b/.test(String(e))) { NKS.toast('접속 확인 중 — 다시 불러옵니다'); return NKS.renew().then(() => setTimeout(() => { NKS.hideToast(); boot(n + 1); }, n ? 3000 : 300)); } // 원격 세션 만료·쿠키 어긋남 = 세션 갱신 후 2번까지 다시
    info.style.display = ''; info.textContent = String(e);
  });
  boot(0);
  };
  if (NKS) NKS.whenReady(bootAll); else bootAll();
})();
