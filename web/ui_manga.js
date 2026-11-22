'use strict';
// 신규 UI 층 v2(원작 뼈대 + 게이지·초상 카드). 설계·화면 키·흐름: analysis/15_ui_manga_impl.md. 시안·수치: art/ui_manga/mockups_v2/.
// 1단계 범위: 타이틀 → 모드 → 인원 → 캐릭터 선택(1P → 2P → 상대) → 스테이지·룰 → 시합 준비 컷(구동 가림) → 전투 + 게이지 패널(HUD).
// 2단계 범위: 대결 확인(status) · 결과(result, 전투 뒤 1:5 → 모드 0 을 game.js 가 감지해 띄운다) · 일시정지(pause, 전투 위 반투명 덮개) · 설정(settings, localStorage 저장).
// 계약은 web/ui_menu.js(NKMenu)와 같다: init({ canvas, onPick }), show(), hide(), toast(), active, state. game.js 는 어느 층을 띄울지만 고른다.
// 원작은 캐릭터 선택 뒤로 B 로 돌아갈 수 없으므로(14 문서 2.5절) 선택을 이 층에서 전부 모은 뒤 onPick('battle_full', 설정) 한 번으로 넘긴다.
//   구동 계획 battle_full 은 analysis/ui_rework/plan_proto.js(Node 에서 10회 확인)를 그대로 옮겨 NKDriver.plans 에 더한다(menu_driver.js 는 고치지 않는다).
// 3단계 범위: 스토리 모드 메뉴(새 게임 / 이어하기) · 스토리 대진표(bracket, 원작 9:4 를 game.js 가 감지해 띄운다). 패스워드 입력·결과 대기실·승패표는 원작 화면(한글 덧그리기) 그대로.
// 17절: 스토리 새 게임 = 인원 → (1인) 에디트 폼(edit: 한글 이름·생일·혈액형) → 구동 story_edit(원작 에디트 화면에 가나 이름·값을 입력열로 넣는다) → (23 문서 1단계) 신규 파트너 선택(partner) → 구동 story_team(에디트 + 파트너, 5:5 첫 장 대기) → 팀·룰(steam, RAM 판독) → 구동 story_go(5:5 두 장 → 룰 → 9:4) → 신규 대진표. 자료가 없으면 종전대로 원작 5:4 에서 인계. 한글 이름은 NKEditNames(가나 5자 → 한글)로 대진표·HUD·원작 화면 덧그리기에 보인다
// 폴백: ?classic=1 · ?ko=0 · ?ui=menu 에서는 켜지지 않는다(enabled = false → game.js 가 종전 층 NKMenu 를 쓴다). 자료(/ui/characters.json)를 못 읽으면
//   인원 선택 뒤 종전 구동(원작 캐릭터 선택 5:4 + 한글 덧그리기)으로 넘긴다. 구동이 실패하면 game.js 가 덮개를 걷어 원작 화면을 보여 준다. 스토리 모드는 종전대로 원작 화면에 맡긴다.
// 전투 HUD 는 RAM 을 읽기만 한다. 코어 캔버스 픽셀은 건드리지 않고 캔버스 밖(좌우 여백)에 DOM 으로 그린다. 여백이 좁으면 띄우지 않는다(원작 HUD 만).
(function () {
  const Q = location.search, enabled = !/[?&]classic=1(&|$)/.test(Q) && !/[?&]ko=0(&|$)/.test(Q) && !/[?&]ui=menu(&|$)/.test(Q);
  const LW = 1280, LH = 720;
  const IDS = ['kunio', 'shibata', 'ishizuki', 'yamaishi', 'riki', 'ebihara', 'mashiba', 'jinnai', 'himeyama', 'raidou', 'aoi', 'anzawa', 'midou', 'fujikura', 'suga', 'ookuma']; // id = 줄*4 + 칸
  const SCHOOLS = ['격투가', '무술', '쿵푸', '유도가'];
  const STATS = [['hp', 'HP', 255, 50], ['nage', '던지기', 99, 10], ['te', '손기술', 99, 10], ['subaya', '민첩', 99, 10], ['ashi', '발기술', 99, 10], ['bougyo', '방어', 99, 10]]; // [키, 라벨, 눈금 상한, 눈금 간격] 원작 2열 3행 순서
  const RULES = ['콤비 필살기 10회 맞히면 승리.', '지형 대미지 10회로 패배.', '특정 기술 10회 맞히면 승리.', '일정 시간 노 대미지면 승리.', '룰을 사용하지 않는다.']; // 룰1 은 배틀에서 못 고른다(원작)
  // 룰 짧은 이름(룰 번호 옆·대신 표시하는 곳은 모두 이 표만 쓴다). 근거: 원작 룰 선택 문구(analysis/ko/translation_ko.json 「룰 선택」)·판정 코드(15 문서 14절 표). 로비 줄·대기방 룰 칸이 좁아 5자 이내
  const RULE_NAME = ['콤비 필살', '지형 탈락', '기술 10회', '노 대미지', '룰 없음'];
  const ruleName = r => r < 0 ? '랜덤' : RULE_NAME[r] || '', ruleLab = r => r < 0 ? '랜덤' : RULE_NAME[r] || ''; // -1 = 랜덤(온라인). 2026-11-21: 화면에는 「룰 n · 」 번호 없이 이름만
  const roK = t => { const c = String(t).charCodeAt(String(t).length - 1) - 0xAC00; return c >= 0 && c < 11172 && c % 28 && c % 28 !== 8 ? '으로' : '로'; }; // 받침(ㄹ 제외) 있으면 「으로」
  const STAGE_ID = [0, 1, 2, 3, 4, 9, 14]; // 스테이지 선택 커서 0~6 → 스테이지 id($0644, 확정 뒤)
  // ── 에디트(15 문서 17절). 원작 가나 입력표(5:2:2) 6줄 x 12칸(커서 $067A 줄 · $0676 칸, 양쪽 끝에서 돈다). 빈칸 = 글자 없음, 3·4줄 10~11칸 = すすむ·もどる, 5줄 10~11칸 = END [판독: 네임테이블 + 커서 이동]
  const GRID = ['あいうえおはひふへほぢづ', 'かきくけこまみむめもー ', 'さしすせそや ゆ よ  ', 'たちつてとらりるれろ  ', 'なにぬねのわ を ん  ', 'ぁぃぅぇぉっゃゅょ   '], GRID_END = [5, 10];
  const DIM = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // 원작 생일 일 범위(월마다, 2월 29일까지) [판독: 12개월 ↓ 로 1 → 끝]
  const ZOD = ['양', '황소', '쌍둥이', '게', '사자', '처녀', '천칭', '전갈', '사수', '염소', '물병', '물고기'], ZSTART = [21, 19, 21, 21, 22, 22, 23, 23, 24, 24, 23, 22]; // 원작 별자리($05B6+s, 0 = 양)는 달마다 ZSTART 일부터 다음 별자리 [판독: 12개월 경계 앞뒤 13일씩]
  const zodiacOf = (mo, d) => (mo + (d >= ZSTART[mo - 1] ? 9 : 8)) % 12;
  const BLOOD = ['A', 'B', 'O', 'AB']; // $05AC+s: 0 A · 1 B · 2 O · 3 AB(에디트 화면 선택지. 4 「?」는 리키 전용)
  const NAME_MAX = 4; // 한글 이름 최대 글자 수: 원작 이름 칸 5칸(40px)에 korean.js 가 Galmuri9(한글 한 자 10px)로 그린다(전투 HUD 25행·캐릭터 선택 이름 칸 = 4자 40px). 5자부터 칸 끝에서 잘린다
  const kanaTile = k => k === 'ー' ? 0x0B : k.charCodeAt(0) - 0x3010; // 원작 글자 타일 = 히라가나 코드 − $3010(あ $32, ん $83), ー $0B [판독: 입력표 네임테이블]
  const tileKana = t => t === 0x0B ? 'ー' : t >= 0x31 && t <= 0x83 ? String.fromCharCode(t + 0x3010) : null;
  const gridPos = k => { for (let r = 0; r < 6; r++) { const c = GRID[r].indexOf(k); if (c >= 0 && k !== ' ') return [r, c]; } return null; };
  // 한글 → 가나(엔진에 넣을 이름, 입력표에 있는 글자만, 5자 이하). 표시는 NKEditNames 가 보관한 한글을 쓰고, 이 가나는 보관이 없을 때(다른 기기·저장소 지움)의 음역 대체용이라 소리값만 대강 맞춘다.
  // 음절마다 첫소리 + 홀소리 = 1자(필수). 남는 칸에 순서대로: ① 반모음(ㅑ·ㅠ·ㅛ → ゃゅょ, ㅈ·ㅊ 줄) · 받침 ㄴ·ㅇ → ん ② 받침 ㅁ → む · ㄹ → る ③ 그 밖의 받침 → く(ㄱ·ㅋ) / っ
  const CHO = 'kknttrmhhss_ccckthh', ROWS = { '': 'あいうえお', k: 'かきくけこ', s: 'さしすせそ', t: 'たちつてと', n: 'なにぬねの', h: 'はひふへほ', m: 'まみむめも', r: 'らりるれろ' };
  const JUNG = ['a', 'e', 'ya', 'e', 'o', 'e', 'yo', 'e', 'o', 'wa', 'e', 'e', 'yo', 'u', 'wo', 'e', 'wi', 'yu', 'u', 'i', 'i'];
  function toKana(ko) {
    const syl = [];
    for (const ch of ko) {
      const c = ch.charCodeAt(0) - 0xAC00; if (c < 0 || c > 11171) continue;
      const cho = (c / 588) | 0, jung = ((c / 28) | 0) % 21, jong = c % 28, row = cho === 11 ? '' : CHO[cho], v = JUNG[jung], base = v[v.length - 1], vi = 'aiueo'.indexOf(base), ex = [];
      let core;
      if (row === 'c') { core = 'ち'; const g = { a: 'ゃ', u: 'ゅ', o: 'ょ', e: 'ぇ' }[base]; if (g) ex.push([g, 1]); }
      else if (row === '') core = v === 'ya' ? 'や' : v === 'yu' ? 'ゆ' : v === 'yo' ? 'よ' : v === 'wa' ? 'わ' : v === 'wo' ? 'を' : ROWS[''][vi];
      else if (v[0] === 'y' && base !== 'e') { core = ROWS[row][1]; ex.push([{ a: 'ゃ', u: 'ゅ', o: 'ょ' }[base], 1]); }
      else core = ROWS[row][vi];
      if (jong === 4 || jong === 5 || jong === 6 || jong === 21) ex.push(['ん', 1]); else if (jong === 16 || jong === 10) ex.push(['む', 2]); else if (jong >= 8 && jong <= 15) ex.push(['る', 2]); else if (jong === 1 || jong === 2 || jong === 3 || jong === 24) ex.push(['く', 3]); else if (jong) ex.push(['っ', 3]);
      syl.push({ core, ex, use: [] });
    }
    let room = 5 - syl.length; for (let p = 1; p <= 3; p++) for (const s of syl) for (const e of s.ex) if (e[1] === p && room > 0) { s.use.push(e); room--; }
    return syl.map(s => s.core + s.ex.filter(e => s.use.includes(e)).map(e => e[0]).join('')).join('').slice(0, 5);
  }
  // 이름 표시 매핑(localStorage nk_edit_names = { 가나: { ko, t } }, 최근 64개). 원작 RAM 에는 가나 5자만 남으므로 그 가나를 열쇠로 사용자가 쓴 한글을 찾는다.
  // 같은 가나 충돌: 다른 한글 이름이 이미 그 가나를 쓰고 있거나 고정 캐릭터 이름·표 낱말(avoid)과 같으면 끝에 ー(음역에서 버려지는 글자)를 붙이거나 뒷글자를 바꿔 겹치지 않는 가나를 고른다. 같은 한글은 같은 가나를 다시 쓴다
  const NAMES_KEY = 'nk_edit_names', NAMES_MAX = 64, ALT = 'ーんっあいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもらりるれろやゆよわ';
  let names = {}; try { const j = JSON.parse(localStorage.getItem(NAMES_KEY) || 'null'); if (j && typeof j === 'object') names = j; } catch (e) { /* 저장소를 못 쓰면 이번 세션만 */ }
  const NKEditNames = {
    get: kana => { const v = names[kana]; return v && typeof v.ko === 'string' ? v.ko : null; },
    put(ko, avoid) {
      let kana = Object.keys(names).find(k => names[k].ko === ko);
      if (!kana) {
        const base = toKana(ko), cands = [base]; for (let n = 1; base.length + n <= 5; n++) cands.push(base + 'ー'.repeat(n));
        for (let p = Math.min(base.length, 5) - 1; p >= 1; p--) for (const a of ALT) cands.push((base.slice(0, p) + a + base.slice(p + 1)).slice(0, 5));
        kana = cands.find(k => k && !names[k] && !(avoid && avoid.has(k))) || base; // 다 겹치면(사실상 없음) 최근 것이 이긴다
      }
      names[kana] = { ko, t: Date.now() };
      const ks = Object.keys(names); if (ks.length > NAMES_MAX) ks.sort((a, b) => names[a].t - names[b].t).slice(0, ks.length - NAMES_MAX).forEach(k => delete names[k]);
      try { localStorage.setItem(NAMES_KEY, JSON.stringify(names)); } catch (e) { /* 이번 세션만 */ }
      return kana;
    },
    toKana,
  };
  window.NKEditNames = NKEditNames; // korean.js(원작 화면 덧그리기: 전투 HUD 이름 칸·스테이터스 머리줄·안내문 이름)도 같은 표로 바꾼다
  // 에디트 캐릭터 이름(글자 타일 5칸, 0 = 빈칸) → 표시 이름: 보관한 한글 → 없으면 가나 음역(korean.js) → 「에디트」
  function editLabel(tiles) {
    let k = ''; for (const t of tiles) { if (!t) continue; const c = tileKana(t); if (c === null) return '에디트'; k += c; }
    if (!k) return '에디트'; const K = window.NKKorean; return NKEditNames.get(k) || (K && K.translit ? K.translit(k) || '에디트' : '에디트');
  }
  // 「팀·룰」 카드 2장(23 문서 4.2절). m = 스테이터스 첫 장(5:5, 주인 0) 입력 대기 프레임의 RAM, p = 파트너 id. DOM 없이 계산한다(Node 대조 시험 tools/story_team_verify.js 도 쓴다)
  //   1P(에디트) = RAM: 능력치 슬롯 0 배열(HP $05EB · 손 $05EF · 발 $05F3 · 던지기 $05F7 · 방어 $05FB · 민첩 $05FF × 9), 필살기 $0605·$0609 비트(낮은 번호부터 = 원작 5:5 의 줄 순서), 레벨 $05B2 + 1, 이름 $05AD~, 생일 $05B3·$05B4, 혈액형 $05AC, 별자리 $05B6
  //   파트너 = characters.json L1 값(이 프레임의 슬롯 1 은 아직 둘째 장 값이 아니다 [판독]. L1 값 = 둘째 장 RAM·화면 16/16 일치)
  const ownSp = (m, s) => { const a = []; for (let b = 0; b < 8; b++) if (m[0x605 + s] & (1 << b)) a.push(b); if (m[0x609 + s] & 0x40) a.push(8); if (m[0x609 + s] & 0x80) a.push(9); return a; };
  function teamCards(m, p, d) {
    const D = d || data; if (!D || !m || !(p >= 0 && p < 16)) return null; const ch = D.characters[p];
    return [{ id: -1, sch: editSch(m, 0), name: editLabel(Array.from(m.slice(0x5AD, 0x5B2))), lv: m[0x5B2] + 1, month: m[0x5B3], day: m[0x5B4], blood: m[0x5AC] < 4 ? BLOOD[m[0x5AC]] : '?', zodiac: ZOD[m[0x5B6]] || '', stats: { hp: m[0x5EB], te: m[0x5EF], ashi: m[0x5F3], nage: m[0x5F7], bougyo: m[0x5FB], subaya: m[0x5FF] * 9 }, sp: ownSp(m, 0) },
      { id: p, name: ch.name_ko, lv: 1, month: ch.birthday.month, day: ch.birthday.day, blood: ch.blood_type, zodiac: ch.zodiac.ko, stats: Object.assign({}, ch.stats_l1), sp: ch.specials.filter(Boolean).map(x => x.id) }];
  }
  // 대기실(23 문서 10절). 슬롯 s(0 = 1P 에디트, 1 = 파트너 또는 2인 협력의 2P) 능력치·레벨 = RAM. 대기실 10:2 의 값은 그 뒤 원작 스테이터스 5:5 화면 숫자와 같다 [판독: story_lobby_menu 두 장]
  const slotStats = (m, s) => ({ hp: m[0x5EB + s], te: m[0x5EF + s], ashi: m[0x5F3 + s], nage: m[0x5F7 + s], bougyo: m[0x5FB + s], subaya: m[0x5FF + s] * 9 });
  // 시합 시작 때 받아 두는 값(hudTick): 레벨은 시합 끝(마지막 상대가 쓰러질 때), 능력치는 대기실 10:1 진입 때 오르고, 승패는 1:5~10:0 에 는다 [판독: fight0 무입력]
  const lobbySnap = m => ({ cards: [0, 1].map(s => ({ lv: m[0x5B2 + 12 * s] + 1, stats: slotStats(m, s) })), w: m[0x651 + 9], l: m[0x65B + 9], rule: m[0x647] }); // rule = 그 시합 시작 때 룰(전투 중 엔진이 $0647 을 바꿀 수 있어 대기실은 이 값을 쓴다)
  // 대기실 자료(DOM 없음, Node 검증 tools/story_lobby_verify.js 도 쓴다). m = 10:2 입력 대기 프레임 RAM, pre = 그 시합 시작 때 lobbySnap(없거나 다른 시합 것이면 증가분·직전 결과 없음)
  //   이름·생일·혈액형·별자리: 파트너(팀 9 둘째 칸 $00C2 < 16, 1인) = characters.json, 에디트(슬롯 기록 $05AC+12s~) = RAM. 레벨 = $05B2+12s + 1, 필살기 = $0605+s·$0609+s 비트
  //   승패 = 팀 9 $0651+9 / $065B+9, 다음 회전 = 승 + 패 + 1(= $0644 + 2, 대기실 상태 5건 일치), 팀 레벨 = $0619 + 1(원작 19행 「LEVEL n」, 9칸 중 $0619 번째가 다른 칸 [판독 3건]), 현재 룰 = $0647
  function lobbyInfo(m, pre, d) {
    const D = d || data; if (!D || !m) return null;
    const coop = m[0x645] === 1, w = m[0x651 + 9], l = m[0x65B + 9], P = pre && pre.w + pre.l + 1 === w + l ? pre : null;
    const cards = [0, 1].map(s => {
      const id = s === 1 && !coop && m[0xC2] < 16 ? m[0xC2] : -1, ch = id >= 0 ? D.characters[id] : null, b = 0x5AC + 12 * s, lv = m[b + 6] + 1, stats = slotStats(m, s);
      return { id, sch: ch ? -1 : editSch(m, s), name: ch ? ch.name_ko : editLabel(Array.from(m.slice(b + 1, b + 6))), lv, up: P ? Math.max(0, lv - P.cards[s].lv) : 0, prev: P ? P.cards[s].stats : null, stats,
        month: ch ? ch.birthday.month : m[b + 7], day: ch ? ch.birthday.day : m[b + 8], blood: ch ? ch.blood_type : m[b] < 4 ? BLOOD[m[b]] : '?', zodiac: ch ? ch.zodiac.ko : ZOD[m[b + 10]] || '', sp: ownSp(m, s) };
    });
    return { cards, coop, w, l, last: P ? (w > P.w ? 'win' : l > P.l ? 'lose' : '') : '', next: w + l + 1, team: m[0x619], rule: P && P.rule >= 0 && P.rule < 5 ? P.rule : m[0x647] }; // 룰 = 직전 시합 시작 때 값(pre). pre 가 없을 때만 RAM
  }
  const MENUS = {
    title: { items: [{ id: 'solo', t: '혼자 하기', go: 'mode' }, { id: 'online', t: '온라인 대전', online: true }, { id: 'profile', t: '프로필', prof: true }, { id: 'settings', t: '설정', go: 'settings' }] }, // 프로필(analysis/27 P4): 손님도 열람(전부 잠금)
    mode: { head: '모드 선택', back: 'title', items: [{ id: 'battle', t: '배틀 모드', go: 'players' }, { id: 'story', t: '스토리 모드', go: 'story' }, { id: 'back', t: '뒤로', back: true }] }, // 온라인은 타이틀 「온라인 대전」 한 곳에서만 들어간다
    // 3단계(15 문서 16절): 새 게임 = 종전 구동(원작 인원 선택 5:1:3 에서 인계, 에디트는 원작 화면). 이어하기 = 원작의 이어하기 수단 그대로(1P 패스워드 입력 화면 5:2:2 까지 구동해 인계). 새 저장 방식은 만들지 않았다
    // 17절: 새 게임 = 인원(splayers) → 1인은 신규 에디트 폼(edit, 원작 「에디트/패스워드」 선택은 에디트로 구동), 2인 협력은 원작 에디트/패스워드 선택(5:2:1)까지 구동해 인계
    // 이어하기·슬롯(21 문서 14절): 새 게임·이어하기 = storyPick(계정 슬롯). 원작 패스워드 화면(story_cont 구동)은 ?classic=1 · ?ui=menu 경로에만 남는다
    story: { head: '스토리 모드', back: 'mode', items: [{ id: 'new', t: '새 게임', story: 'new' }, { id: 'cont', t: '이어하기', story: 'cont' }, { id: 'back', t: '뒤로', back: true }] },
    splayers: { head: '인원', back: 'story', items: [{ id: 'p1', t: '1인', go: 'edit' }, { id: 'p2', t: '2인 협력', pick: 'story_2p' }, { id: 'back', t: '뒤로', back: true }] },
    players: { head: '인원', back: 'mode', items: [{ id: 'p1', t: '1인', players: 1 }, { id: 'p2', t: '2인', players: 2 }, { id: 'back', t: '뒤로', back: true }] },
    pause: { head: '일시정지', ov: true, items: [{ id: 'resume', t: '계속', back: true }, { id: 'settings', t: '설정', go: 'settings' }, { id: 'quit', t: '종료', pick: 'quit' }] }, // 전투 위 덮개(로고·인물 컷·하단 띠 없음). 뒤로 = 계속
  };
  // 설정(localStorage). vol 0~10(소리 음량), scale = SCALES 의 번호(화면 배율), hud 1/0(전투 게이지 패널), nf 1/0(스프라이트 깜박임 제거, analysis/24), speed = SPEEDS 값(전투 속도 = 시합 진행 중만, 혼자 하기 기본 1.3, 범위 밖(옛 1.25·2 포함) = 1.3). game.js 가 onSettings 로 받아 음량·배율·깜박임 제거·속도에 쓴다(온라인·?classic=1 은 game.js 가 늘 1배)
  const SET_KEY = 'nk_manga_settings', SCALES = ['자동', '꽉 채우기', '2배', '3배', '4배'], SPEEDS = [1, 1.15, 1.3, 1.5], SPEED_T = ['1배', '1.15배', '1.3배', '1.5배'], set = window.NKSettings ? window.NKSettings.data : { vol: 8, scale: 0, hud: 1, nf: 1, speed: 1.3, tags: 2, hitfx: 1, op: 1, fxlv: 2, mute: 0 }, /* fxlv = 이펙트 강도 0 끔 · 1 약 · 2 보통 · 3 강(hitfx = fxlv > 0), mute = 음소거. hitfx = 타격 효과(web/hit_fx.js): 0 끔 · 1 보통(기본), op = 오프닝 장면(web/opening_scene.js): 0 끔 · 1 켬(기본) */ TAGS_T = ['끔', '자리', '자리+이름']; // tags = 선수 표시(web/unit_tags.js): 0 끔 · 1 팀 표식만 · 2 팀 표식 + 이름(기본)
  const NKS = window.NKSettings || null; // 설정 모듈(web/settings.js, 21절): 같은 키·값을 읽어 둔 살아 있는 객체를 그대로 쓴다(fxlv·mute 칸 추가). 없으면 아래 종전 읽기
  if (!NKS) try { const j = JSON.parse(localStorage.getItem(SET_KEY) || 'null'); if (j) { if (j.vol >= 0 && j.vol <= 10) set.vol = j.vol | 0; if (j.scale >= 0 && j.scale < SCALES.length) set.scale = j.scale | 0; set.hud = j.hud === 0 ? 0 : 1; set.nf = j.nf === 0 ? 0 : 1; if (SPEEDS.indexOf(+j.speed) >= 0) set.speed = +j.speed; if (j.tags === 0 || j.tags === 1) set.tags = j.tags; set.hitfx = j.hitfx === 0 ? 0 : 1; set.op = j.op === 0 ? 0 : 1; } } catch (e) { /* 저장소를 못 쓰면 기본값 */ }
  const SET_ROWS = [['vol', '소리'], ['scale', '화면 배율'], ['hud', '게이지 패널'], ['nf', '깜박임 제거'], ['speed', '전투 속도'], ['tags', '선수 표시'], ['fxlv', '이펙트'], ['op', '오프닝 장면'], ['hd', 'HD 배경'], ['mute', '음소거'], ['classic', '클래식 화면'], ['keys', '조작 설정'], ['touch', '터치 패드'], ['cam', '카메라 연출'], ['tut', '튜토리얼'], ['impact', '타격 효과'], ['quality', '화질'], ['a11y', '접근성']], SET_BACK = SET_ROWS.length, FX_T = ['끔', '약', '보통', '강']; // 21절: 이펙트 = 종전 타격 효과(끔·보통)를 4단계로, 클래식 화면 = ?classic=1&ko=1 로 다시 열기, 조작 설정 = web/keymap.js 창 // SET_BACK = 뒤로 버튼의 setIdx
  const FOCUS = { title: [410, 460], mode: [410, 460], story: [410, 460], splayers: [410, 460], players: [410, 460], pause: [410, 460], settings: [370, 540] }; // 세로 화면에서 창 너비에 맞출 논리 구간 [x, 너비](가운데 창만 크게). 없는 화면은 1280 전체
  const BTN_RECT = [[476, 304, 328, 80], [476, 404, 328, 80], [476, 520, 328, 56]];
  const BTN_ROW = [[256, 284, 232, 64], [524, 284, 232, 64], [792, 284, 232, 64]]; // 메인 메뉴(덮개 아닌 MENUS) 가로 배치: 원작 판 가운데 768 폭(256~1024)에 세 칸
  const BTN_RECT4 = [[476, 300, 328, 72], [476, 384, 328, 72], [476, 482, 328, 56], [476, 548, 328, 56]], BTN_ROW4 = [[256, 284, 165, 64], [457, 284, 165, 64], [658, 284, 165, 64], [859, 284, 165, 64]]; // 4칸 메뉴(타이틀: 혼자 하기·온라인 대전 | 프로필·설정). 가로 칸 사이 36 = 타이틀 커서 ▶ 자리
  //   가로 화면의 메인 메뉴(타이틀 배경)는 로고와 원작 대련 띠(원작 128~193행 = 384~579) 사이의 가로 한 줄로 둬 두 사람을 가리지 않는다. 세로 화면(탭 높이 확보)·덮개(일시정지)는 종전 세로 창
  let rowNow = null;
  function menuLayout(row) {
    if (row === rowNow) return; rowNow = row;
    for (const k of Object.keys(MENUS)) {
      const s = els[k]; if (!s || !s.btns) continue; const h = row && !s.ov;
      if (h) { abs(s.win, 208, 254, 864, 124); abs(s.sep, s.n4 ? 640 : 774, 290, 1, 52); } else { abs(s.win, 430, 276, 420, 340); abs(s.sep, 476, s.n4 ? 469 : 500, 328, 1); }
      s.btns.forEach((e, i) => abs(e, ...(h ? (s.n4 ? BTN_ROW4 : BTN_ROW) : (s.n4 ? BTN_RECT4 : BTN_RECT))[i]));
    }
  }
  // 초상 = 원작 ROM 전투 HUD 얼굴 16x17(표정 1종, 승패도 같은 그림 + 프레임·딱지). 크기는 CSS 가 칸에 맞는 정수배로(ui_manga.css .nkm-cut img)
  const face = id => '/ui/portraits_orig/hud/' + IDS[id] + '_hud_base_1x.png';
  const pfetch = (u, o) => window.NKSess && window.NKSess.fetch ? window.NKSess.fetch(u, o) : fetch(u, o); // 보호 경로 지연 fetch(web/asset_session.js: 원격 복귀 중 welcome 대기·403 = 세션 갱신 뒤 1번 다시, 로컬 = fetch 그대로)
  // 에디트 캐릭터 = 유파별 원작 HUD 얼굴(manifest_orig extra edit_*). 유파 r: 0 격투가 · 1 무술 · 2 쿵푸 · 3 유도가 = 슬롯 기록 $05B5+12s(23 문서 14.3, 이름으로 결정. 스테이터스 5:5 부터 유효), 전투 중 $0401+s(칸 $0409+s = 4). 4 이상 = 모름(초상 없음)
  const EFACE = ['edit_kakutouka', 'edit_martialarts', 'edit_kungfu', 'edit_judo'], eface = r => '/ui/portraits_orig/hud/' + EFACE[r] + '_hud_base_1x.png', editSch = (m, s) => m[0x5B5 + 12 * s] < 4 ? m[0x5B5 + 12 * s] : -1;
  // 덮개를 걷기 전에 곧 보일 초상(전투 HUD)을 미리 받아 디코드해 둔다(걷는 순간 디코드가 몰리지 않게). 참조는 다음 호출까지 잡아 둔다
  const warmImgs = []; function warmFaces(ids) { warmImgs.length = 0; for (const id of ids) if (id >= 0 && id < 16) { const im = new Image(); im.src = face(id); warmImgs.push(im); if (im.decode) im.decode().catch(() => { /* 없음 = 종전대로 표시 때 디코드 */ }); } }
  const roles = n => n === 2 ? [['1P', 'p1'], ['2P', 'p2'], ['상대 1', 'com'], ['상대 2', 'com']] : [['1P', 'p1'], ['상대 1', 'com'], ['상대 2', 'com'], ['상대 3', 'com']]; // [표시, 색 토큰]
  const el = (tag, cls, parent, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; if (parent) parent.appendChild(e); return e; };
  const abs = (e, x, y, w, h) => { const s = e.style; s.left = x + 'px'; s.top = y + 'px'; if (w !== undefined) s.width = w + 'px'; if (h !== undefined) s.height = h + 'px'; return e; };
  const cvar = (e, name) => e.style.setProperty('--c', 'var(--' + name + ')');
  const chip = (parent, text, color, line) => { const c = el('span', 'nkm-chip' + (line ? ' line' : ''), parent, text); if (color) cvar(c, color); return c; };
  function gauge(parent, color, max, tick) { const g = el('div', 'nkm-g', parent); cvar(g, color); g.style.setProperty('--tick', (tick / max * 100) + '%'); g.lag = el('u', '', g); g.fill = el('i', '', g); return g; }

  let root = null, wall = null, stageEl = null, cv = null, onPick = null, onSettings = null, ovl = false, skipKey = null, setIdx = 0, setBack = 'title', scr = 'title', active = false, busy = false, toastTm = 0, gpRaf = 0, gpPrev = 255, ptX = null, ptY = null, ptMoved = false;
  let data = null, dataErr = null, fetched = false; // /ui/characters.json (16명 수치·필살기 이름). 못 읽으면 캐릭터 화면 대신 종전 구동으로 넘긴다
  const els = {}, idx = { title: 0, mode: 0, story: 0, splayers: 0, edit: 0, steam: 0, players: 0, pause: 0, status: 0, result: 0, bracket: 0, lobby: 0, oname: 0, olobby: 0, ocreate: 0, oroom: 0, oend: 0, orank: 0, oprof: 0 }, sel = { players: 1, picks: [], cur: 0, stageCur: 0, stage: null, zone: 'stage', rule: 1, again: false, ran: null }; // again = 전투 뒤 다시 하기(엔진은 원작 스테이지 선택 0:1 에서 기다린다 → 스테이지·룰만 구동). ran = 이 층이 구동한 { stage, rule }(대결 시작 때 확정. 결과·HUD·다시 하기는 이 값을 쓴다 — 엔진이 전투 중 $0647 을 줄이기 때문, 15 문서 12절)
  const res = { win: [], lose: [], human: false, sec: 0 }; // 결과 화면 자료(result() 가 채운다)
  const brk = { order: [], team: {}, round: 0, nameTiles: [], name2Tiles: [], sch: [-1, -1], coop: false }; let koTiles = null, koTab = null, koFetched = false;
  // 23 문서 1단계: 파트너 선택(partner)·팀·룰(steam). cur = 격자 커서, edit = 에디트 폼이 만든 구동 설정(가나 타일·생일·혈액형), partner = 구동한 파트너, rule = 고른 룰(0~4, 스토리는 룰1 포함),
  //   driven = 엔진이 지금 서 있는 구동 설정의 열쇠(5:5 첫 장 대기, '' = 아직 구동 안 함 → 다른 설정이면 처음부터 다시 구동), team = 카드 2장(teamCards), run = 결과를 기다리는 구동 이름
  const pt = { cur: 0, edit: null, partner: -1, rule: 0, driven: '', want: '', team: null, run: '', tap: -1, sch: {} }; // sch = { 가나 이름: 유파 } (story_team 에서 읽은 값. 유파는 이름만으로 정해진다) // tap = 터치로 한 번 누른 칸(같은 칸을 한 번 더 누르면 확정)
  // 대기실(23 문서 10절). view = main(대기실) | status(스테이터스 패널, 엔진 입력 없음) | quit(대회 그만두기 확인), q = 확인 창 커서(0 그만두기 · 1 취소), info = lobbyInfo, wait = 10:2 까지 구동 중, pre = 이번 시합 시작 때 lobbySnap(hudTick)
  const lb = { view: 'main', q: 1, info: null, wait: false, pre: null }, LB_IDS = ['next', 'quit']; // 2026-11-21: 스테이터스(카드와 중복, 룰은 한 줄로 흡수)·승패표(준비 중) 버튼 제거
  const ed = { name: '', month: 1, day: 1, blood: 0 }; // 에디트 폼 값(이 세션에서 마지막으로 쓴 값을 남긴다) // 스토리 대진표 자료(bracket() 가 채운다). koTiles = ko_table.json 의 글자 타일표(에디트 이름 읽기용, 처음 대진표 때 한 번 받는다)

  // ── 구동 계획(전투 입장 1:4 까지). analysis/ui_rework/plan_proto.js 와 같은 단계(근거: 14 문서 2절) ──
  function addPlan() {
    const D = window.NKDriver; if (!D || D.plans.battle_full) return;
    const { A, U, D: DN, R } = D.BTN;
    const is = (m, a, b) => m[0x641] === a && (m[0x642] & 0x7F) === b, rdy = (m, a, b) => is(m, a, b) && m[0x642] >= 0x80;
    const two = o => o.players === 2, one = o => !two(o), at = (m, s, c) => m[0x401 + s] === c.row && m[0x409 + s] === c.col;
    // 줄 맞추기: 원작의 ↓ 는 지금 칸(열)에서 이미 고른 캐릭터가 있는 줄을 건너뛴다 → 목표 줄의 그 열이 고른 칸이면 ↓ 만으로는 영영 못 간다(0→2→3→0 …, 300프레임 뒤 fail. 판독: 1·4 / 5·13 에서 「상대 1 줄」, 15 문서 19절).
    //   그때는 → 로 열을 먼저 옮긴다(→ 는 그 줄의 고른 칸을 건너뛰어 돈다). 누를 버튼은 on 이 RAM 커서와 앞서 고른 칸(설정의 순서 n 앞쪽)을 보고 정한다. ↓ 만으로 갈 수 있으면 종전과 같은 입력열이다
    const all = o => [o.p1].concat(two(o) ? [o.p2] : [], o.enemies);
    function rowBtn(r0, c0, t, taken) {
      const T = new Set(taken.map(c => c.row * 4 + c.col)), free = (r, c) => !T.has(r * 4 + c);
      const dn = (r, c) => { for (let k = 1; k < 4; k++) if (free((r + k) & 3, c)) return (r + k) & 3; return r; }, rt = (r, c) => { for (let k = 1; k < 4; k++) if (free(r, (c + k) & 3)) return (c + k) & 3; return c; };
      for (let r = r0, k = 0; k < 4; k++) { r = dn(r, c0); if (r === t.row) return DN; }
      const seen = new Set([r0 * 4 + c0]); let q = [[r0, c0, 0]]; // 너비 우선: ↓·→ 로 목표 줄에 닿는 가장 짧은 길의 첫 버튼
      while (q.length) { const nq = []; for (const [r, c, b] of q) for (const [nr, nc, nb] of [[dn(r, c), c, DN], [r, rt(r, c), R]]) { if (seen.has(nr * 4 + nc)) continue; seen.add(nr * 4 + nc); if (nr === t.row) return b || nb; nq.push([nr, nc, b || nb]); } q = nq; }
      return DN;
    }
    function pick(name, scrNo, slot, who, n, port, okNext) { // 한 명 고르기(설정의 n 번째 = all(o)[n]): 줄(↓, 막히면 → 로 비켜서) → 칸(→, 고른 칸은 원작이 건너뛴다) → A
      const mine = m => rdy(m, 5, scrNo) && m[0x697] === who && m[0x672] === n, cell = o => all(o)[n]; let b = DN;
      return [
        { name: name + ' 줄', on: (m, o) => { if (!mine(m) || m[0x401 + slot] === cell(o).row) return false; b = rowBtn(m[0x401 + slot], m[0x409 + slot], cell(o), all(o).slice(0, n)); return true; }, get btn() { return b; }, port, ok: (m, o) => mine(m) && m[0x401 + slot] === cell(o).row },
        { name: name + ' 칸', on: (m, o) => mine(m) && m[0x401 + slot] === cell(o).row && m[0x409 + slot] !== cell(o).col, btn: R, port, ok: (m, o) => mine(m) && at(m, slot, cell(o)) },
        { name: name + ' 확정', on: (m, o) => mine(m) && at(m, slot, cell(o)), btn: A, port, ok: okNext },
      ];
    }
    const st = (m, who) => is(m, 5, 5) && (m[0x670] & 0x7F) === 4 && m[0x670] >= 0x80 && m[0x6A9] === who;
    const only = (f, steps) => steps.map(s => { s.when = f; return s; }); // 단계 객체에 그대로 단다(Object.assign 사본은 btn 접근자를 값으로 굳힌다)
    const steps = D.plans.battle.steps.concat(
      only(one, pick('1P 캐릭터', 4, 0, 2, 0, 0, m => is(m, 5, 5))),
      only(one, [{ name: '1P 스테이터스 확인', on: m => st(m, 0), btn: A, ok: m => is(m, 5, 6) }]),
      only(one, pick('상대 1', 6, 1, 3, 1, 0, m => m[0x672] === 2)),
      only(one, pick('상대 2', 6, 2, 4, 2, 0, m => m[0x672] === 3)),
      only(one, pick('상대 3', 6, 3, 5, 3, 0, m => m[0x672] === 4 || m[0x641] === 0)),
      only(two, pick('1P 캐릭터', 4, 0, 2, 0, 0, m => m[0x672] === 1)),
      only(two, pick('2P 캐릭터', 4, 1, 3, 1, 1, m => is(m, 5, 5))),
      only(two, [{ name: '1P 스테이터스 확인', on: m => st(m, 0), btn: A, ok: m => is(m, 5, 6) || (is(m, 5, 5) && m[0x6A9] === 1) },
        { name: '2P 스테이터스 확인', on: m => st(m, 1), btn: A, port: 1, ok: m => is(m, 5, 6) }]),
      only(two, pick('상대 1', 6, 2, 4, 2, 0, m => m[0x672] === 3)),
      only(two, pick('상대 2', 6, 3, 5, 3, 0, m => m[0x672] === 4 || m[0x641] === 0)),
      [
        { name: '스테이지 줄', on: (m, o) => rdy(m, 0, 1) && (m[0x644] >> 2) !== (o.stage >> 2), btn: DN, ok: (m, o) => rdy(m, 0, 1) && (m[0x644] >> 2) === (o.stage >> 2) },
        { name: '스테이지 칸', on: (m, o) => rdy(m, 0, 1) && (m[0x644] >> 2) === (o.stage >> 2) && m[0x644] !== o.stage, btn: R, ok: (m, o) => rdy(m, 0, 1) && m[0x644] === o.stage },
        { name: '스테이지 확정', on: (m, o) => rdy(m, 0, 1) && m[0x644] === o.stage, btn: A, ok: m => is(m, 5, 8) },
        { name: '룰 커서 ↓', on: (m, o) => rdy(m, 5, 8) && m[0x647] < o.rule, btn: DN, ok: (m, o) => rdy(m, 5, 8) && m[0x647] >= o.rule },
        { name: '룰 커서 ↑', on: (m, o) => rdy(m, 5, 8) && m[0x647] > o.rule, btn: U, ok: (m, o) => rdy(m, 5, 8) && m[0x647] === o.rule },
        { name: '룰 확정', on: (m, o) => rdy(m, 5, 8) && m[0x647] === o.rule, btn: A, ok: m => is(m, 5, 7) || m[0x641] === 1 },
      ]);
    const cellOk = c => c && c.row >= 0 && c.row < 4 && c.col >= 0 && c.col < 4;
    function valid(o) {
      if (!o || (o.players !== 1 && o.players !== 2) || o.edit !== false) return '인원 1·2, 에디트 안 함만 구동한다';
      const cs = [o.p1].concat(two(o) ? [o.p2] : [], o.enemies || []);
      if (cs.length !== 4 || !cs.every(cellOk)) return '캐릭터 4명의 줄·칸이 필요하다';
      if (new Set(cs.map(c => c.row * 4 + c.col)).size !== 4) return '같은 캐릭터를 두 번 고를 수 없다';
      if (!(o.stage >= 0 && o.stage <= 6)) return '스테이지 커서는 0~6';
      if (!(o.rule >= 1 && o.rule <= 4)) return '배틀 모드 룰 커서는 1~4';
      return '';
    }
    D.plans.battle_full = { valid, steps, end: m => m[0x641] === 1 && (m[0x642] & 0x7F) === 4, check: (m, o) => m[0x645] !== o.players + 1 ? '$0645 = ' + m[0x645] : '' };
    // 사람 3·4명(온라인 O3). analysis/ui_rework/plan_proto4.js 의 battle_full4 와 같은 단계(근거·측정: 17 문서 2절). 설정 { players: 3|4, edit: false, humans: [{row, col} × players], enemies: [{row, col} × (4 − players)], stage, rule }
    //   인원 확정 뒤 $0645 = 사람 수 + 1(4·5) → 원작이 패드 4개를 따로 읽는다. 에디트 여부·캐릭터·스테이터스는 사람마다 자기 패드(port = 자리, $0697 = 자리 + 2, 스테이터스 주인 $06A9 = 자리), 상대(3인만 1명)·스테이지·룰은 1P 패드
    {
      const scr5 = (m, a, b) => m[0x641] === 5 && (m[0x642] & 0x7F) === a && (b === undefined || (m[0x670] & 0x7F) === b);
      const modeSel = m => scr5(m, 1, 1), plSel = m => scr5(m, 1, 3) && m[0x670] >= 0x80, editQ = (m, who) => scr5(m, 1, 4) && m[0x670] >= 0x80 && m[0x697] === who, left14 = m => scr5(m, 2) || scr5(m, 4);
      const all4 = o => o.humans.concat(o.enemies || []), ge = n => o => o.players >= n, PN = ['1P', '2P', '3P', '4P'];
      function pick4(name, scrNo, slot, n, port, okNext) { // 설정의 n 번째(all4(o)[n])를 자리 slot 커서로 고른다. 고르는 차례 $0697 = slot + 2, 고른 수 $0672 = n
        const mine = m => rdy(m, 5, scrNo) && m[0x697] === slot + 2 && m[0x672] === n, cell = o => all4(o)[n]; let b = DN;
        return [
          { name: name + ' 줄', on: (m, o) => { if (!mine(m) || m[0x401 + slot] === cell(o).row) return false; b = rowBtn(m[0x401 + slot], m[0x409 + slot], cell(o), all4(o).slice(0, n)); return true; }, get btn() { return b; }, port, ok: (m, o) => mine(m) && m[0x401 + slot] === cell(o).row },
          { name: name + ' 칸', on: (m, o) => mine(m) && m[0x401 + slot] === cell(o).row && m[0x409 + slot] !== cell(o).col, btn: R, port, ok: (m, o) => mine(m) && at(m, slot, cell(o)) },
          { name: name + ' 확정', on: (m, o) => mine(m) && at(m, slot, cell(o)), btn: A, port, ok: okNext },
        ];
      }
      let s4 = [
        { name: '커서 → 배틀', on: m => modeSel(m) && m[0x672] === 0, btn: DN, ok: m => modeSel(m) && m[0x672] === 1 },
        { name: '배틀 확정', on: m => modeSel(m) && m[0x672] === 1, btn: A, ok: m => scr5(m, 1, 3) },
        { name: '인원 커서 ↓', on: (m, o) => plSel(m) && m[0x674] < o.players - 1, btn: DN, ok: (m, o) => scr5(m, 1, 3) && m[0x674] >= o.players - 1 },
        { name: '인원 커서 ↑', on: (m, o) => plSel(m) && m[0x674] > o.players - 1, btn: U, ok: (m, o) => scr5(m, 1, 3) && m[0x674] === o.players - 1 },
        { name: '인원 확정', on: (m, o) => plSel(m) && m[0x674] === o.players - 1, btn: A, ok: m => scr5(m, 1, 4) },
      ];
      for (let i = 0; i < 4; i++) s4 = s4.concat(only(ge(i + 1), [
        { name: PN[i] + ' 커서 → 안 한다', on: m => editQ(m, i + 2) && m[0x6AB] === 0, btn: R, port: i, ok: m => editQ(m, i + 2) && m[0x6AB] === 1 },
        { name: PN[i] + ' 안 한다 확정', on: m => editQ(m, i + 2) && m[0x6AB] === 1, btn: A, port: i, ok: (m, o) => i + 1 < o.players ? editQ(m, i + 3) : left14(m) },
      ]));
      for (let i = 0; i < 4; i++) s4 = s4.concat(only(ge(i + 1), pick4(PN[i] + ' 캐릭터', 4, i, i, i, (m, o) => i + 1 < o.players ? m[0x672] === i + 1 : is(m, 5, 5))));
      for (let i = 0; i < 4; i++) s4 = s4.concat(only(ge(i + 1), [{ name: PN[i] + ' 스테이터스 확인', on: m => st(m, i), btn: A, port: i, ok: (m, o) => i + 1 < o.players ? is(m, 5, 5) && m[0x6A9] === i + 1 : (is(m, 5, 6) || m[0x641] === 0) }]));
      s4 = s4.concat(only(o => o.players === 3, pick4('상대 1', 6, 3, 3, 0, m => m[0x672] === 4 || m[0x641] === 0)), steps.slice(-6)); // 3인: 상대 1명(자리 3, 1P 패드). 4인: 상대 화면 없이 바로 스테이지. 스테이지·룰 6단계는 battle_full 과 같은 것
      const valid4 = o => {
        if (!o || (o.players !== 3 && o.players !== 4) || o.edit !== false) return '인원 3·4, 에디트 안 함만 구동한다';
        if (!Array.isArray(o.humans) || o.humans.length !== o.players) return '사람 캐릭터(humans)가 인원 수만큼 필요하다';
        const cs = all4(o); if (cs.length !== 4 || !cs.every(cellOk)) return '캐릭터 4명(사람 + 상대)의 줄·칸이 필요하다';
        if (new Set(cs.map(c => c.row * 4 + c.col)).size !== 4) return '같은 캐릭터를 두 번 고를 수 없다';
        return !(o.stage >= 0 && o.stage <= 6) ? '스테이지 커서는 0~6' : !(o.rule >= 1 && o.rule <= 4) ? '배틀 모드 룰 커서는 1~4' : '';
      };
      D.plans.battle_full4 = { valid: valid4, steps: s4, end: m => m[0x641] === 1 && (m[0x642] & 0x7F) === 4, check: (m, o) => m[0x645] !== o.players + 1 ? '$0645 = ' + m[0x645] : '' };
    }
    // 다시 하기(전투 뒤 원작 스테이지 선택 0:1 에서 출발): 스테이지 3단계 + 룰 1단계. 근거: 15 문서 8절(끝난 뒤 0:1 로 돌아오고 커서 $0644 는 0 에서 시작, 룰 화면 5:8 을 다시 거친다. 캐릭터 4명은 그대로)
    // 룰은 한 단계가 커서를 보고 누를 버튼을 그때그때 고른다(on 이 정하고 btn 이 돌려준다): 두 번째 판의 룰 화면은 앞 판의 커서 값($0647)에서 시작했다가 바뀌어, 첫 판용 3단계(↓ → ↑ → A)로는 「룰 확정」에서 멈췄다(실측 1건)
    let rb = A; const ruleStep = { name: '룰 맞추고 확정', on: (m, o) => { if (!rdy(m, 5, 8)) return false; rb = m[0x647] < o.rule ? DN : m[0x647] > o.rule ? U : A; return true; }, get btn() { return rb; }, ok: m => is(m, 5, 7) || m[0x641] === 1 };
    D.plans.battle_again = { valid: o => !o || !(o.stage >= 0 && o.stage <= 6) ? '스테이지 커서는 0~6' : !(o.rule >= 1 && o.rule <= 4) ? '배틀 모드 룰 커서는 1~4' : '', steps: steps.slice(-6, -3).concat([ruleStep]), end: m => m[0x641] === 1 && (m[0x642] & 0x7F) === 4, check: (m, o) => m[0x647] !== o.rule ? '$0647 = ' + m[0x647] : '' };
    // 3단계(15 문서 16절). 이어하기: 스토리 → 인원 1P → 「에디트/패스워드」(5:2:1)에서 패스워드 → 원작 패스워드 입력(5:2:2)에서 인계. 커서 $06EE: 5 = 에디트, 12 = 패스워드(→ 로 12, ← 로 5, 끝에서 돌지 않음) [판독 1건]
    const in521 = m => is(m, 5, 2) && (m[0x670] & 0x7F) === 1 && m[0x670] >= 0x80, in522 = m => is(m, 5, 2) && (m[0x670] & 0x7F) === 2;
    D.plans.story_cont = { steps: D.plans.story.steps.concat([
      { name: '인원 커서 → 1P', on: m => is(m, 5, 1) && (m[0x670] & 0x7F) === 3 && m[0x670] >= 0x80 && m[0x674] > 0, btn: U, ok: m => is(m, 5, 1) && (m[0x670] & 0x7F) === 3 && m[0x674] === 0 },
      { name: '인원 확정', on: m => is(m, 5, 1) && (m[0x670] & 0x7F) === 3 && m[0x670] >= 0x80 && m[0x674] === 0, btn: A, ok: m => is(m, 5, 2) },
      { name: '커서 → 패스워드', on: m => in521(m) && m[0x6EE] === 5, btn: R, ok: m => in521(m) && m[0x6EE] === 12 },
      { name: '패스워드 확정', on: m => in521(m) && m[0x6EE] === 12, btn: A, ok: in522 },
    ]), end: m => in522(m) && m[0x670] >= 0x80, check: m => m[0x645] !== 0 ? '$0645 = ' + m[0x645] : '' };
    // 17절. 새 게임 1인 + 신규 에디트 폼: 스토리 → 인원 1P → 「에디트/패스워드」(5:2:1)에서 에디트 → 이름(5:2:2) 가나 입력표를 커서로 짚어 A → END → 생일(5:2:3) 월 ↑↓ A 일 ↑↓ A → 혈액형(5:2:4) ↑↓ A
    //   → 확인(5:2:5) 「좋아!」(기본 커서) A → 파트너 패스워드(5:2:6) 「안 한다」(기본) A → 파트너 선택(5:4)에서 인계. RAM [판독: Node 엔진 실행]: 이름 칸 번호 $06A9(0~4, 다섯째 뒤로는 4 에 머물며 덮어씀), 입력 중 이름 $06AD~,
    //   END 뒤 $05AD~ = 이름 타일. 생일 칸 $06D5(0 월 · 1 일), 월 $06F2(1~12) · 일 $06F6(1~그 달 끝), ↑ = +1 · ↓ = −1(양 끝에서 돈다). 혈액형 $05AC(↓ = +1, ↑ = −1, 0~3 에서 돈다). 별자리 $05B6 = 일 확정 때 원작이 계산
    //   안내문이 찍히는 동안 원작이 입력을 받지 않는 것은 구동기의 다시 누르기(RETRY)가 처리한다. 누를 버튼은 단계의 on 이 RAM 을 보고 그때그때 정한다(battle_again 의 룰 단계와 같은 방식)
    const sub = (m, n) => is(m, 5, 2) && (m[0x670] & 0x7F) === n && m[0x670] >= 0x80, wrapBtn = (cur, want, n, up, dn) => ((want - cur + n) % n) <= n / 2 ? up : dn;
    const toEditSteps = D.plans.story.steps.concat([
      { name: '인원 커서 → 1P', on: m => is(m, 5, 1) && (m[0x670] & 0x7F) === 3 && m[0x670] >= 0x80 && m[0x674] > 0, btn: U, ok: m => is(m, 5, 1) && (m[0x670] & 0x7F) === 3 && m[0x674] === 0 },
      { name: '인원 확정', on: m => is(m, 5, 1) && (m[0x670] & 0x7F) === 3 && m[0x670] >= 0x80 && m[0x674] === 0, btn: A, ok: m => is(m, 5, 2) },
      { name: '커서 → 에디트', on: m => in521(m) && m[0x6EE] === 12, btn: D.BTN.L, ok: m => in521(m) && m[0x6EE] === 5 },
      { name: '에디트 확정', on: m => in521(m) && m[0x6EE] === 5, btn: A, ok: in522 },
    ]);
    const gridStep = (name, at, when, extra) => { let b = A; return { name, when, on: (m, o) => { if (!sub(m, 2) || (extra && !extra(m, o))) return false; const [r, c] = at(o); if (m[0x67A] === r && m[0x676] === c) return false; b = m[0x67A] !== r ? wrapBtn(m[0x67A], r, 6, DN, U) : wrapBtn(m[0x676], c, 12, R, D.BTN.L); return true; }, get btn() { return b; }, ok: (m, o) => { const [r, c] = at(o); return sub(m, 2) && m[0x67A] === r && m[0x676] === c; } }; };
    const nameSteps = [];
    for (let i = 0; i < 5; i++) {
      const at = o => gridPos(tileKana(o.tiles[i])), when = o => o.tiles.length > i;
      nameSteps.push(gridStep('이름 ' + (i + 1) + ' 커서', at, when, m => m[0x6A9] === i),
        { name: '이름 ' + (i + 1) + ' 입력', when, on: (m, o) => { const [r, c] = at(o); return sub(m, 2) && m[0x6A9] === i && m[0x67A] === r && m[0x676] === c; }, btn: A, ok: (m, o) => i < 4 ? m[0x6A9] === i + 1 : m[0x6AD + 4] === o.tiles[4] });
    }
    // 값 맞추기(↑↓, 양 끝에서 돈다): fld = [화면 5:2:n, 생일 칸 $06D5(−1 = 안 봄)], base = 첫 값(1 또는 0), size(o) = 값 개수, inc·dec = 1 늘리는·줄이는 버튼
    const valStep = (name, fld, addr, key, base, size, inc, dec) => { let b = A; const here = m => sub(m, fld[0]) && (fld[1] < 0 || m[0x6D5] === fld[1]); return { name, on: (m, o) => { if (!here(m) || m[addr] === o[key]) return false; b = wrapBtn(m[addr] - base, o[key] - base, size(o), inc, dec); return true; }, get btn() { return b; }, ok: (m, o) => here(m) && m[addr] === o[key] }; };
    D.plans.story_edit = {
      valid: o => !o || !Array.isArray(o.tiles) || !o.tiles.length || o.tiles.length > 5 || !o.tiles.every(t => tileKana(t) !== null && gridPos(tileKana(t))) ? '이름 = 입력표 가나 1~5자' : !(o.month >= 1 && o.month <= 12) || !(o.day >= 1 && o.day <= DIM[o.month - 1]) ? '생일 범위 밖' : !(o.blood >= 0 && o.blood <= 3) ? '혈액형 0~3' : '',
      steps: toEditSteps.concat(nameSteps, [
        gridStep('END 커서', () => GRID_END),
        { name: 'END 확정', on: m => sub(m, 2) && m[0x67A] === GRID_END[0] && m[0x676] === GRID_END[1], btn: A, ok: m => is(m, 5, 2) && (m[0x670] & 0x7F) === 3 },
        valStep('생일 월', [3, 0], 0x6F2, 'month', 1, () => 12, U, DN),
        { name: '생일 월 확정', on: (m, o) => sub(m, 3) && m[0x6D5] === 0 && m[0x6F2] === o.month, btn: A, ok: m => sub(m, 3) && m[0x6D5] === 1 },
        valStep('생일 일', [3, 1], 0x6F6, 'day', 1, o => DIM[o.month - 1], U, DN),
        { name: '생일 일 확정', on: (m, o) => sub(m, 3) && m[0x6D5] === 1 && m[0x6F6] === o.day, btn: A, ok: m => is(m, 5, 2) && (m[0x670] & 0x7F) === 4 },
        valStep('혈액형', [4, -1], 0x5AC, 'blood', 0, () => 4, DN, U),
        { name: '혈액형 확정', on: (m, o) => sub(m, 4) && m[0x5AC] === o.blood, btn: A, ok: m => is(m, 5, 2) && (m[0x670] & 0x7F) === 5 },
        { name: '확인 「좋아!」', on: m => sub(m, 5), btn: A, ok: m => is(m, 5, 2) && (m[0x670] & 0x7F) === 6 },
        { name: '파트너 패스워드 「안 한다」', on: m => sub(m, 6), btn: A, ok: m => is(m, 5, 4) },
      ]),
      end: m => is(m, 5, 4) && m[0x642] >= 0x80,
      check: (m, o) => m[0x645] !== 0 ? '$0645 = ' + m[0x645] : o.tiles.some((t, i) => m[0x5AD + i] !== t) || (o.tiles.length < 5 && m[0x5AD + o.tiles.length]) ? '이름 타일 불일치' : m[0x5AC] !== o.blood ? '혈액형 $05AC = ' + m[0x5AC] : m[0x6F2] !== o.month || m[0x6F6] !== o.day ? '생일 ' + m[0x6F2] + '/' + m[0x6F6] : '',
    };
    // 23 문서 1단계: 스토리 1인 새 게임. 새 UI 가 에디트·파트너를 다 모은 뒤 story_team 한 번으로 에디트(story_edit 단계 그대로) → 파트너 선택(5:4) → 스테이터스 첫 장(5:5, 주인 0) 입력 대기까지 간다.
    //   그 프레임의 RAM(에디트 캐릭터 능력치는 5:5 에 와야 생긴다 — 5:4 에서는 0)으로 「팀·룰」 화면을 띄우고, 「대회 시작」 = story_go(스테이터스 두 장 넘김 → 룰 5:8 → 대진표 9:4 입력 대기 → 신규 대진표)
    //   파트너 커서 $0402(줄)·$040A(칸), 네 방향 모두 0~3 에서 돈다. 고른 칸이 없어(1P 는 격자 밖 에디트 캐릭터) ↓ 로 줄 → → 로 칸 → A [판독 16/16]. 고르는 차례 $0697 = 3, 고른 수 $0672 = 1
    //   룰(5:8) $0647 = 0~4, 스토리는 0 에서 시작, ↓ +1 · ↑ −1, 양 끝에서 멈춘다 [판독]. 5:5 는 B·되돌리기가 없다(START = A 와 같이 넘김, 판독) → 팀·룰에서 파트너를 바꾸면 엔진을 처음부터 다시 구동한다(reboot)
    const ptTurn = m => rdy(m, 5, 4) && m[0x697] === 3 && m[0x672] === 1, pRow = o => o.partner >> 2, pCol = o => o.partner & 3, okP = p => Number.isInteger(p) && p >= 0 && p < 16;
    D.plans.story_team = {
      valid: o => D.plans.story_edit.valid(o) || (!okP(o.partner) ? '파트너 0~15' : ''),
      steps: D.plans.story_edit.steps.concat([
        { name: '파트너 줄', on: (m, o) => ptTurn(m) && m[0x402] !== pRow(o), btn: DN, ok: (m, o) => ptTurn(m) && m[0x402] === pRow(o) },
        { name: '파트너 칸', on: (m, o) => ptTurn(m) && m[0x402] === pRow(o) && m[0x40A] !== pCol(o), btn: R, ok: (m, o) => ptTurn(m) && m[0x402] === pRow(o) && m[0x40A] === pCol(o) },
        { name: '파트너 확정', on: (m, o) => ptTurn(m) && m[0x402] === pRow(o) && m[0x40A] === pCol(o), btn: A, ok: m => is(m, 5, 5) },
      ]),
      end: m => st(m, 0),
      check: (m, o) => m[0x645] !== 0 ? '$0645 = ' + m[0x645] : o.tiles.some((t, i) => m[0x5AD + i] !== t) ? '이름 타일 불일치' : m[0x5AC] !== o.blood ? '혈액형 $05AC = ' + m[0x5AC] : m[0x5B3] !== o.month || m[0x5B4] !== o.day ? '생일 ' + m[0x5B3] + '/' + m[0x5B4] : m[0x402] * 4 + m[0x40A] !== o.partner ? '파트너 커서 ' + m[0x402] + ',' + m[0x40A] : '',
    };
    let gb = A; const goRule = { name: '룰 맞추고 확정', on: (m, o) => { if (!rdy(m, 5, 8)) return false; gb = m[0x647] < o.rule ? DN : m[0x647] > o.rule ? U : A; return true; }, get btn() { return gb; }, ok: m => is(m, 5, 7) || m[0x641] === 9 };
    D.plans.story_go = {
      valid: o => !o || !(Number.isInteger(o.rule) && o.rule >= 0 && o.rule <= 4) ? '스토리 룰 커서는 0~4' : !okP(o.partner) ? '파트너 0~15' : '',
      steps: [
        { name: '1P 스테이터스 넘김', on: m => st(m, 0), btn: A, ok: m => is(m, 5, 5) && m[0x6A9] === 1 },
        { name: '파트너 스테이터스 넘김', on: m => st(m, 1), btn: A, ok: m => !is(m, 5, 5) },
        goRule,
      ],
      end: m => rdy(m, 9, 4),
      check: (m, o) => m[0x645] !== 0 ? '$0645 = ' + m[0x645] : m[0x647] !== o.rule ? '$0647 = ' + m[0x647] : m[0xC1] !== 20 || m[0xC2] !== o.partner ? '팀 9 = ' + m[0xC1] + ',' + m[0xC2] : '',
    };
    // 새 게임 2인 협력: 인원 2P 확정 → 원작 에디트/패스워드 선택(5:2:1, 1P 부터)에서 인계. 각자 원작 화면에서 입력한다. $0645 = 1 [13 문서 11.6절 판독]
    D.plans.story_2p = { steps: D.plans.story.steps.concat([
      { name: '인원 커서 → 2P', on: m => is(m, 5, 1) && (m[0x670] & 0x7F) === 3 && m[0x670] >= 0x80 && m[0x674] === 0, btn: DN, ok: m => is(m, 5, 1) && (m[0x670] & 0x7F) === 3 && m[0x674] === 1 },
      { name: '인원 확정', on: m => is(m, 5, 1) && (m[0x670] & 0x7F) === 3 && m[0x670] >= 0x80 && m[0x674] === 1, btn: A, ok: m => is(m, 5, 2) },
    ]), end: in521, check: m => m[0x645] !== 1 ? '$0645 = ' + m[0x645] : '' };
    // 스토리 대진표(9:4, 입력 대기 = $0642 bit7. 원작은 A 를 누를 때까지 기다린다 — 무입력 1800프레임 확인) → A → 0:0 → 1:0 → 1:1 → 전투 입장 1:4 [판독]
    D.plans.story_next = { steps: [{ name: '대진표 넘기기', on: m => rdy(m, 9, 4), btn: A, ok: m => m[0x641] !== 9 }], end: m => is(m, 1, 4) };
    // 대기실(23 문서 10절). 시합 뒤 10:0 → 10:3(1P 레벨업 안내, 오른 때만 약 183프레임) → 10:4(파트너 레벨업 안내, 약 181) → 10:1(질문, 약 79) → 10:2 선택지 입력 대기($0642 bit7, 스크립트 $068C = 37).
    //   모두 시간으로 넘어가고 A·START 로 앞당겨지지 않는다 [판독: story_levelup·story_lobby_q 상태 재생] → 버튼을 누르지 않고(on = 늘 거짓) 화면 키만 따라 기다린다. 단계마다 300프레임 안
    const lob = (m, ...subs) => m[0x641] === 10 && subs.includes(m[0x642] & 0x7F), wait = (name, ok) => ({ name, on: () => false, btn: 0, ok });
    D.plans.story_lobby = { steps: [wait('대기실 입장', m => lob(m, 1, 2, 3, 4)), wait('1P 레벨업 안내', m => lob(m, 1, 2, 4)), wait('파트너 레벨업 안내', m => lob(m, 1, 2)), wait('대기실 질문', m => lob(m, 2))],
      end: m => rdy(m, 10, 2), check: m => m[0x645] > 1 ? '$0645 = ' + m[0x645] : '' };
    // 대기실 「다음 시합」: 10:2 커서 $06D5 는 2x2(0 다음 시합 · 1 스테이터스 / 2 승패표 · 3 시합 포기, ↓ = +2, ↑ = −2) [판독]. 10:2 도착 때 0. 안내문이 찍히는 약 80프레임은 입력을 받지 않는다(다시 누르기로 처리)
    //   A → 10:2 페이드 → 9:3 → 9:4 입력 대기 → 신규 대진표(driveDone). 라이벌 논평(6:x)은 1:5 바로 뒤(대기실 앞)에 나온다 [판독: story_index 기록]
    let nb = A; D.plans.story_lobby_next = { steps: [
      { name: '대기실 커서 → 다음 시합', on: m => { if (!rdy(m, 10, 2) || !m[0x6D5]) return false; nb = m[0x6D5] & 2 ? U : D.BTN.L; return true; }, get btn() { return nb; }, ok: m => rdy(m, 10, 2) && !m[0x6D5] },
      { name: '다음 시합 확정', on: m => rdy(m, 10, 2) && !m[0x6D5], btn: A, ok: m => m[0x641] !== 10 },
    ], end: m => rdy(m, 9, 4), check: m => m[0x645] > 1 ? '$0645 = ' + m[0x645] : '' };
  }

  // ── 벽지 타일(자체 제작): KUNIO ■ RIKI 한 줄 = 186, 줄 간격 26, 줄마다 62 밀림 → 186x78 반복 ──
  function drawWall() {
    const c = document.createElement('canvas'); c.width = 372; c.height = 156; const x = c.getContext('2d'), T = 'KUNIO ■ RIKI ';
    x.fillStyle = '#8814B0'; x.fillRect(0, 0, 372, 156); x.font = 'bold 48px Galmuri11'; x.textBaseline = 'middle'; x.fillStyle = 'rgba(228,84,236,.62)';
    const w = x.measureText(T).width || 372; x.setTransform(372 / w, 0, 0, 1, 0, 0);
    for (let r = 0; r < 3; r++) for (let k = -1; k < 2; k++) x.fillText(T, (r * 124 % 372) / (372 / w) + k * w, r * 52 + 27);
    wall.style.backgroundImage = 'url(' + c.toDataURL('image/png') + ')';
  }
  // ── 메인 메뉴 배경(A안, 2026-11-21): 타이틀·모드·스토리·인원(MENUS, 덮개 제외)만 원작 타이틀 판. 다른 화면은 위 벽지 그대로
  //   title_bg_A.png 428x240 = 원작 1배 판(판 0열 = x 86, 두 사람 포함), title_bg_A_tile.png 256x240 = 좌우 연장 반복(띠 주기 256). 원작 파생 = 로컬 전용(docs/title_bg_rights.md)
  //   크기는 원작 1px = 기기 픽셀 정수배(place), 가로 가운데·풀밭 끝(판 216.67행)을 하단 띠(650)에 맞춘다. 판 밖 위 = 하늘색, 아래 = 검정, 좌우 = 타일 반복
  let tbgEl = null, crEl = null;
  function buildTbg() { tbgEl = el('div', 'nkm-tbg', root); tbgEl.style.backgroundImage = 'url(/img/title_bg_A.png),url(/img/title_bg_A_tile.png),linear-gradient(#000,#000)'; buildTbgLive(); }
  function placeTbg(k, x, y) {
    if (!tbgEl || !root.classList.toggle('tbg', menuFam(scr))) return;
    const d = window.devicePixelRatio || 1, p = Math.max(1, Math.round(3 * k * d - 0.01)) / d, r = v => Math.round(v * d) / d;
    const bx = r(x + 640 * k - 214 * p), by = r(y + 650 * k - 650 / 3 * p), s = tbgEl.style;
    s.backgroundSize = 428 * p + 'px ' + 240 * p + 'px,' + 256 * p + 'px ' + 240 * p + 'px,100% 100%';
    s.backgroundPosition = bx + 'px ' + by + 'px,' + (bx + 86 * p) + 'px ' + by + 'px,0 ' + (by + 224 * p) + 'px';
    if (tl.cv) { const c = tl.cv.style; c.left = r(bx + (86 - TL_X0) * p) + 'px'; c.top = by + 'px'; c.width = TL_W * p + 'px'; c.height = 240 * p + 'px'; }
  }
  // ── 원작 타이틀 실시간 배경(2026-11-21): game.js 가 타이틀 대기(hold) 동안 엔진 프레임(256x240, 모드 3)을 titleBg 로 넘긴다 → 위 판 자리(정수배)에 원작 그대로 그린다.
  //   엔진은 대련 데모(3:5) 진입 상태(title_fight)에서 시작하므로 띠가 이미 멈춰 있다. 가운데 256열 128~223행 = 엔진 화면 그대로(강변·풀밭·두 사람 대련, 저작권 줄 208~215행만 판),
  //   위 하늘·원작 로고 자리(0~127행)·아래 검정·좌우 연장 = 정적 판 title_bg_A_tile.png(원작 판에서 로고·저작권 줄을 뺀 것, 멈춘 띠와 같은 자리라 이음매가 맞는다)
  //   띠가 아직 흐르는 프레임(행 220 이 판과 맞지 않음: 인트로·3:5 첫 약 40프레임 — title_fight 가 없을 때의 폴백 경로)과 페이드 프레임은 건너뛴다(직전 그림 유지).
  //   판을 못 읽었거나 프레임이 오지 않으면 위 정적 배경(A) 그대로. 표시 전용(엔진·입력 무관). 원작 파생 = 로컬 전용(docs/title_bg_rights.md)
  const TL_W = 640, TL_X0 = 192; // 캔버스 폭(원작 픽셀)·판 0열 자리. 1280 논리 폭 = 427 원작 픽셀이라 가로로 긴 창까지 덮는다
  const tl = { cv: null, ctx: null, img: null, out: null, tile: null, base: null, s1: 0, s2: 0, on: false, frames: 0, skip: 0 };
  function buildTbgLive() {
    const c = tl.cv = el('canvas', 'nkm-tbg-live', tbgEl); c.width = TL_W; c.height = 240; c.style.display = 'none'; tl.ctx = c.getContext('2d');
    tl.img = tl.ctx.createImageData(TL_W, 240); tl.out = new Uint32Array(tl.img.data.buffer);
    const im = new Image(); im.onload = () => { try { const t = document.createElement('canvas'); t.width = 256; t.height = 240; const x = t.getContext('2d'); x.drawImage(im, 0, 0); tl.tile = new Uint32Array(x.getImageData(0, 0, 256, 240).data.buffer); } catch (e) { tl.tile = null; } };
    im.src = '/img/title_bg_A_tile.png';
  }
  function titleBg(fb, ram) {
    const T = tl.tile; if (!T || !tl.cv || !fb || fb.length < 61440 || !ram || ram[0x641] !== 3 || !root.classList.contains('tbg')) return; // 판이 숨은 화면(온라인 로비·설정 등)에서는 그리지 않는다
    if ((fb[10 * 256 + 4] ^ T[10 * 256 + 4]) & 0xFFFFFF) { tl.skip++; return; } // 페이드 중
    for (let x = 0, o = 220 * 256; x < 256; x++) if ((fb[o + x] ^ T[o + x]) & 0xFFFFFF) { tl.skip++; return; } // 띠가 흐르는 중(행 220 = 두 배 속도 띠, 두 사람이 닿지 않는 행: 원작 3:5 두 사람은 130~193행)
    const O = tl.out, full = tl.base !== T; // 정적 판(띠 밖·좌우 연장) = 판이 바뀐 첫 그림에서 한 번만 채운다. 그 뒤로는 가운데 256열 128~223행만 다시 쓴다(결과 픽셀 동일)
    for (let y = full ? 0 : 128, ye = full ? 240 : 224; y < ye; y++) {
      const live = y >= 128 && y < 224 && !(y >= 208 && y <= 215), o = y * 256, q = y * TL_W;
      if (full) for (let c = 0; c < TL_W; c++) { const x = c - TL_X0; O[q + c] = live && x >= 0 && x < 256 ? fb[o + x] | 0xFF000000 : T[o + (x & 255)]; }
      else if (live) for (let x = 0; x < 256; x++) O[q + TL_X0 + x] = fb[o + x] | 0xFF000000;
    }
    if (full) { tl.base = T; tl.ctx.putImageData(tl.img, 0, 0); } else tl.ctx.putImageData(tl.img, 0, 0, TL_X0, 128, 256, 96);
    tl.frames++;
    if (!tl.on) { tl.on = true; tl.cv.style.display = ''; }
  }


  // 그림을 못 읽으면(404 등) 깨진 그림 아이콘 대신 자리를 비운다(틀·배경은 그대로). 다시 읽히면 보인다. error·load 는 거품이 없어 잡기 단계로 받는다
  function noBroken(r) { const f = on => e => { const t = e.target; if (t && t.tagName === 'IMG') t.classList.toggle('nkm-noimg', on); }; r.addEventListener('error', f(true), true); r.addEventListener('load', f(false), true); }
  function hoverable(e, fn) { // 마우스를 올리면 커서 이동. 포인터가 실제로 움직였을 때만(화면이 바뀌어 멈춰 있는 포인터 아래에 놓인 항목은 무시)
    const h = ev => { if (ev.pointerType !== 'mouse' || !(ev.type === 'pointermove' ? ptMoved : ev.clientX !== ptX || ev.clientY !== ptY)) return; if (active && !busy) fn(); };
    e.addEventListener('pointerenter', h); e.addEventListener('pointermove', h);
  }
  function tapOnce(e, fn) { // 확인 창 단추(마우스·터치·펜): 보통은 click 으로 한 번 실행. 같은 단추에서 누르고 단추 안에서 뗐는데 click 이 빠지면 250ms 뒤 대신 실행. 0.7초 안 중복(click+대체·연타)은 버림. 창이 click 보다 먼저 닫혀 아래 단추로 click 이 새지 않게 pointerup 에서 바로 실행하지 않는다
    let pid = null, tm = 0, t = -1e9; const off = () => { pid = null; e.classList.remove('down'); };
    const run = () => { clearTimeout(tm); tm = 0; if (performance.now() - t < 700) return; t = performance.now(); fn(); };
    e.addEventListener('pointerdown', ev => { if (ev.button > 0) return; pid = ev.pointerId; e.classList.add('down'); });
    e.addEventListener('pointerup', ev => { const ok = pid === ev.pointerId, r = e.getBoundingClientRect(); off(); if (ok && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) { clearTimeout(tm); tm = setTimeout(run, 250); } });
    e.addEventListener('pointercancel', off); e.addEventListener('pointerleave', off);
    e.addEventListener('click', run);
  }
  function head(s, text) { return el('div', 'nkm-win nkm-head', s, text); }
  const keyHints = [], keyLab = id => { const K = window.NKKeymap, v = K && K.keyName ? K.keyName(0, id) : ''; return v && v !== '—' ? v : id === 'a' ? 'A' : 'S'; }; // 하단 띠 키 안내: 결정 = 1P a 칸, 뒤로 = 1P b 칸(기본 A·S, web/keymap.js)
  function keyHintsSync() { for (const k of keyHints) { k.ok.textContent = keyLab('a'); if (k.bk) k.bk.textContent = keyLab('b'); } }
  if (window.NKKeymap && window.NKKeymap.on) window.NKKeymap.on(keyHintsSync);
  function foot(s, hint, backKey) {
    el('div', 'nkm-foot', s); const h = el('div', 'nkm-hint', s, hint || ''), k = el('div', 'nkm-keys', s);
    k.ok = el('b', '', k, keyLab('a')); k.appendChild(document.createTextNode('결정')); if (backKey) { k.bk = el('b', '', k, keyLab('b')); k.appendChild(document.createTextNode('뒤로')); } keyHints.push(k); // 글자 = 1P 키 표의 지금 키(리매핑하면 keyHintsSync 가 바꾼다)
    return h;
  }

  function build() {
    root = el('div', '', document.body); root.id = 'nkm'; wall = el('div', 'nkm-wall', root); buildTbg(); stageEl = el('div', 'nkm-root', root); noBroken(root);
    // 타이틀·모드·인원: 같은 창, 목록만 바뀐다
    for (const k of Object.keys(MENUS)) {
      const d = MENUS[k], s = els[k] = el('div', k === 'title' ? 'nkm-scr nkm-title' : 'nkm-scr', stageEl); // nkm-title = 버튼 커서 ▶ 를 그리는 유일한 화면(ui_manga.css)
      if (!d.ov) {
        const l = el('img', 'nkm-side', s), r = el('img', 'nkm-side', s); l.src = '/ui/portraits_orig/body/kunio_body_1x.png'; r.src = '/ui/portraits_orig/body/riki_body_1x.png'; r.style.transform = 'scaleX(-1)'; l.style.left = '10px'; r.style.right = '10px'; l.alt = r.alt = ''; l.draggable = r.draggable = false;
        const lg = el('img', 'nkm-logo', s); lg.alt = '열혈격투전설'; lg.draggable = false; lg.src = '/logo/logo_ko_1x.png';
      }
      if (d.head) head(s, d.head);
      s.win = el('div', 'nkm-win', s); s.sep = el('div', 'nkm-sep', s); s.ov = !!d.ov; s.n4 = d.items.length === 4; // 자리는 menuLayout(가로 화면의 메인 메뉴 = 가로 한 줄, 세로 화면·덮개 = 종전 세로 창)
      s.btns = d.items.map((it, i) => {
        const b = el('div', 'nkm-btn', s, it.t); b.dataset.id = it.id; b.setAttribute('role', 'menuitem');
        hoverable(b, () => { if (scr === k && idx[k] !== i) { idx[k] = i; render(); } });
        b.addEventListener('click', () => { if (!active || busy || scr !== k) return; idx[k] = i; render(); confirm(); });
        return b;
      });
      if (!d.ov) foot(s, '', !!d.back);
    }
    buildChar('charsel'); buildChar('partner'); buildTeam(); buildStage(); buildStatus(); buildResult(); buildSettings(); buildVs(); buildBracket(); buildLobby(); buildEdit(); buildOnline(); buildSlots();
    els.rot = el('div', 'nkm-rot', root, '가로 화면 권장'); // 세로 화면 안내(전용 세로 배치는 없다)
    // 메인 메뉴 하단 저작권 줄(타이틀·모드·스토리·인원 = #nkm.tbg 일 때만, CSS). 1줄 = 원작 타이틀 화면 저작권 줄 원문(3:5 네임테이블 1 26행 타일 f0 f1 f3 f3 f2 · f4~fa · fb fc fd fc f8 · f6 f9 fe fd ff = 「©1992 TECHNOS JAPAN CORP.」, 오라클 캡처 idle_f07560 육안 대조)
    crEl = el('div', 'nkm-cr', stageEl); el('div', '', crEl, '©1992 TECHNOS JAPAN CORP.'); el('div', '', crEl, 'Remake by 흑칠랑'); crEl.setAttribute('aria-hidden', 'true');
    els.toast = el('div', 'nkm-toast', stageEl); els.toast.setAttribute('role', 'status');
    const touch = () => document.documentElement.classList.add('nk-touch'); // 터치 기기: 키보드 조작 안내문(#msg)을 숨긴다
    if (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) touch();
    window.addEventListener('touchstart', touch, { once: true, passive: true });
    window.addEventListener('pointermove', e => { if (e.pointerType !== 'mouse') return; ptMoved = e.clientX !== ptX || e.clientY !== ptY; ptX = e.clientX; ptY = e.clientY; }, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    (document.fonts && document.fonts.load ? document.fonts.load('bold 48px Galmuri11', 'KUNIO ■') : Promise.resolve()).then(drawWall, drawWall);
  }
  // 캐릭터 선택 격자 + 상세 패널. k = 'charsel'(배틀) | 'partner'(스토리 파트너, 23 문서 4.1절: 같은 구성 + 「내 팀」 줄, 상대 자동·단계 표시 없음)
  const curOf = k => k === 'partner' ? pt.cur : sel.cur, setCur = (k, id) => { if (k === 'partner') pt.cur = id; else sel.cur = id; };
  function buildChar(k) {
    const P = k === 'partner', s = els[k] = el('div', P ? 'nkm-scr nkp' : 'nkm-scr', stageEl), h = head(s, P ? '파트너' : '캐릭터 선택'); s.headEl = h; // nkp = 파트너 전용 배치(상세 창을 줄여 아래에 뒤로 버튼)
    if (!P) { s.turn = chip(s, '1P', 'p1'); s.turn.classList.add('nkm-turn'); }
    abs(el('div', 'nkm-win', s), 32, 84, 620, 556);
    s.cells = [];
    for (let r = 0; r < 4; r++) {
      const lb = el('div', 'nkm-school', s, SCHOOLS[r]); lb.style.top = 136 + 131 * r + 'px'; cvar(lb, 'sch' + r);
      for (let c = 0; c < 4; c++) {
        const id = r * 4 + c, e = abs(el('div', 'nkm-cell', s), 164 + 120 * c, 100 + 131 * r); cvar(e, 'sch' + r); e.dataset.id = IDS[id];
        const im = el('img', '', e); im.src = face(id); im.alt = ''; im.draggable = false; e.nm = el('span', '', e); e.tag = el('em', 'nkm-chip', e);
        hoverable(e, () => { if (scr === k && curOf(k) !== id) { setCur(k, id); render(); } });
        e.addEventListener('pointerdown', ev => { e.pt = ev.pointerType; });
        e.addEventListener('click', ev => { // 마우스 = 바로 결정(배틀 charsel 과 같음). 파트너 화면의 터치·펜 = 첫 탭 커서·상세 미리보기, 같은 칸 두 번째 탭 결정
          if (!active || busy || scr !== k) return;
          if (P && (ev.pointerType || e.pt || 'mouse') !== 'mouse' && pt.tap !== id) { pt.tap = id; setCur(k, id); return render(); }
          setCur(k, id); render(); confirm();
        });
        s.cells.push(e);
      }
    }
    s.brk = abs(el('div', 'nkm-brk', s), 0, 0, 122, 136);
    // 상세: 초상 + 이름 + 정보 3칸 + 능력치 게이지 6 + 필살기 3
    abs(el('div', 'nkm-win', s), 672, 84, 576, P ? 492 : 556);
    s.cut = abs(el('div', 'nkm-cut', s), 688, 100, 208, 232); s.cutImg = el('img', '', s.cut); s.cutImg.alt = ''; s.cutImg.draggable = false;
    s.chips = abs(el('div', 'nkm-abs', s), 912, 104); s.chips.style.whiteSpace = 'nowrap'; s.c1 = chip(s.chips, '1P', 'p1'); s.c1.style.marginRight = '8px'; s.c2 = chip(s.chips, '', 'sch0');
    s.name = el('div', 'nkm-name', s);
    s.info = [['생일', 912, 124], ['혈액형', 1042, 76], ['별자리', 1124, 108]].map(([t, x, w]) => { const b = abs(el('div', 'nkm-info', s, t), x, 264, w); return el('b', '', b); });
    el('div', 'nkm-rule-h', s).style.top = '346px'; el('div', 'nkm-rule-h', s).style.top = P ? '466px' : '484px';
    s.stats = STATS.map(([key, label, max, tick], i) => {
      const row = abs(el('div', 'nkm-stat', s, label), 688 + 280 * (i & 1), 354 + (P ? 36 : 42) * (i >> 1)); cvar(row, key);
      const g = gauge(row, key, max, tick), num = el('b', '', row); return { key, max, g, num };
    });
    el('div', 'nkm-sp-h', s, '필살기');
    s.sp = [0, 1, 2].map(i => { const c = el('div', 'nkm-sp', s); c.style.left = 688 + 186 * i + 'px'; el('s', '', c, String(i + 1)); c.nm = el('span', '', c); return c; });
    s.hint = foot(s, '', true);
    if (P) { // 「내 팀」: 에디트 캐릭터(중립 그림 + 이름) & 지금 커서의 파트너
      const t = s.team = abs(el('div', 'nkp-team', s), 672, 18, 576, 52); chip(t, '내 팀', 'focus', true);
      t.me = el('div', 'nkm-cut', t); t.me.im = el('img', '', t.me); t.me.im.alt = ''; t.me.im.draggable = false; t.meNm = el('span', '', t); /* 에디트 캐릭터: 유파를 알면(같은 이름으로 구동한 적 있음) 유파 얼굴, 모르면 이름만 */ el('span', 'nkp-amp', t, '&'); t.pa = el('div', 'nkm-cut', t); t.pa.im = el('img', '', t.pa); t.pa.im.alt = ''; t.pa.im.draggable = false; t.paNm = el('span', '', t);
      s.back = abs(el('div', 'nkm-btn', s, '뒤로'), 872, 592, 344, 46); s.back.dataset.id = 'back'; // 터치·마우스용(팀·룰의 뒤로와 같은 자리·모양). 키보드 커서 순환에는 넣지 않는다(B = 뒤로)
      s.back.addEventListener('click', () => { if (active && !busy && scr === 'partner') back(); });
      return;
    }
    s.auto = abs(el('div', 'nkm-btn nkm-auto', s, '상대 자동'), 872, 20, 216, 46); s.auto.dataset.id = 'auto'; el('b', '', s.auto, 'C'); // 1인: 남은 상대를 무작위로 채운다(C 키)
    s.auto.addEventListener('click', () => { if (active && !busy && scr === 'charsel') autoPick(); });
  }
  // 팀·룰(23 문서 4.2절): 원작 스테이터스 5:5 ×2 + 룰 5:8 을 한 화면으로. 왼쪽 팀 카드 2장(대결 확인 카드 구성, PASSWORD 칸 없음), 오른쪽 룰 5줄(스토리는 룰1 포함) + 대회 시작 / 뒤로
  //   커서 idx.steam: 0~4 = 룰, 5 = 대회 시작, 6 = 뒤로. 룰에서 결정 = 그 룰을 고르고 커서를 대회 시작으로
  // 팀 카드(팀·룰 · 대기실 · 대기실 스테이터스 공용, 392x556): 초상 · 딱지(1P/파트너 · L n · 유파) · 이름 · 생일·혈액형·별자리 · 게이지 6 · 필살기 3.
  //   lob = 대기실 카드: 생일 줄 대신 「레벨 업! +n」 띠, 게이지에 증가분 띠(em)와 「+n」 글자(s)
  function teamCard(parent, i, lob) {
    const w = abs(el('div', 'nkm-win nkm-card nkt-card' + (lob ? ' nkl-card' : ''), parent), 32 + 404 * i, 84, 392, 556), c = { w };
    c.cut = abs(el('div', 'nkm-cut', w), 14, 14, 136, 160); c.im = el('img', '', c.cut); c.im.alt = ''; c.im.draggable = false;
    c.chips = el('div', 'nkm-card-chips', w); c.who = chip(c.chips, i ? '파트너' : '1P', i ? 'focus' : 'p1'); c.lv = chip(c.chips, '', 'focus', true); c.sch = chip(c.chips, '', 'sch0', true);
    c.nm = el('div', 'nkm-card-name', w);
    if (lob) c.up = el('div', 'nkl-up', w); else c.info = ['생일', '혈액형', '별자리'].map((t, j) => el('b', '', abs(el('div', 'nkt-info', w, t), 164, 100 + 26 * j)));
    abs(el('div', 'nkm-sep', w), 14, 190, 358);
    c.stats = STATS.map(([key, label, max, tick], j) => { const row = abs(el('div', 'nkm-stat nkm-cstat nkt-stat' + (lob ? ' nkl-stat' : ''), w, label), 14, 202 + 30 * j); cvar(row, key); const g = gauge(row, key, max, tick), num = el('b', '', row), x = { key, max, g, num }; if (lob) { x.band = el('em', '', g); x.plus = el('s', '', row); } return x; });
    abs(el('div', 'nkt-sp-h', w, '필살기'), 14, 390);
    c.sp = [0, 1, 2].map(j => { const r = el('div', 'nkh-sp', w); r.style.top = 426 + 32 * j + 'px'; r.style.left = '14px'; return r; });
    return c;
  }
  // 카드 채우기. t = teamCards / lobbyInfo 의 카드(없으면 숨김). t.prev(시합 전 능력치)가 있으면 오른 만큼 띠·「+n」, t.up > 0 이면 레벨 업 띠
  function fillCard(c, t) {
    c.w.style.visibility = t ? '' : 'hidden'; if (!t) return;
    const r = t.id >= 0 ? t.id >> 2 : t.sch >= 0 ? t.sch : -1, ok = r >= 0; c.cut.classList.toggle('anon', !ok); c.im.style.display = ok ? '' : 'none'; if (ok) { c.im.src = t.id >= 0 ? face(t.id) : eface(r); cvar(c.cut, 'sch' + r); } else c.cut.style.removeProperty('--c'); // 에디트 캐릭터 = 유파 얼굴(t.sch)
    c.w.classList.toggle('nocut', !ok); if (c.info) c.info.forEach(b => { b.parentNode.style.left = ok ? '164px' : '14px'; }); // 유파를 모르면 초상 칸을 빼고 글자를 왼쪽부터
    if (t.who) { c.who.textContent = t.who[0]; cvar(c.who, t.who[1]); }
    c.lv.textContent = 'L' + t.lv; c.sch.style.display = ok ? '' : 'none'; if (ok) { c.sch.textContent = SCHOOLS[r]; cvar(c.sch, 'sch' + r); }
    c.nm.textContent = t.name; if (c.info) { c.info[0].textContent = t.month + '월 ' + t.day + '일'; c.info[1].textContent = t.blood + '형'; c.info[2].textContent = t.zodiac ? t.zodiac + '자리' : '—'; }
    const pc = (v, x) => Math.min(100, v / x.max * 100);
    for (const x of c.stats) {
      const v = t.stats[x.key], p = t.prev ? t.prev[x.key] : v; x.g.fill.style.width = pc(v, x) + '%'; x.num.textContent = v;
      if (x.band) { const d = v > p; x.band.style.display = d ? '' : 'none'; if (d) { x.band.style.left = pc(p, x) + '%'; x.band.style.width = pc(v, x) - pc(p, x) + '%'; } x.plus.textContent = d ? '+' + (v - p) : ''; }
    }
    if (c.up) { c.w.classList.toggle('lvup', t.up > 0); c.up.textContent = t.up > 0 ? '레벨 업! +' + t.up : ''; }
    c.sp.forEach((e, j) => { const mv = t.sp[j] !== undefined && data ? data.special_moves[t.sp[j]] : null; e.classList.toggle('none', !mv); e.textContent = mv ? mv.ko : '없음'; cvar(e, ok ? 'sch' + r : 'focus'); });
  }
  function buildTeam() {
    const s = els.steam = el('div', 'nkm-scr', stageEl); head(s, '팀 · 룰');
    s.cards = [0, 1].map(i => teamCard(s, i));
    const w = abs(el('div', 'nkm-win', s), 840, 84, 408, 420); el('div', 'nkm-tab', w, '♥ 룰 ♥');
    s.rules = RULES.map((t, i) => {
      const e = el('div', 'nkm-rule nkt-rule', w); e.style.top = 18 + 80 * i + 'px'; if (i === 0) e.style.borderTopColor = 'transparent'; e.dataset.id = 'rule' + (i + 1);
      el('s', '', e, String(i + 1)); el('span', '', e, t);
      hoverable(e, () => { if (scr === 'steam' && idx.steam !== i) { idx.steam = i; render(); } });
      e.addEventListener('click', () => { if (!active || busy || scr !== 'steam') return; idx.steam = i; confirm(); });
      return e;
    });
    s.go = [['start', '대회 시작', [872, 522, 344, 60]], ['back', '뒤로', [872, 592, 344, 46]]].map(([id, t, r], j) => {
      const b = abs(el('div', 'nkm-btn', s, t), ...r); b.dataset.id = id; b.setAttribute('role', 'menuitem');
      hoverable(b, () => { if (scr === 'steam' && idx.steam !== 5 + j) { idx.steam = 5 + j; render(); } });
      b.addEventListener('click', () => { if (!active || busy || scr !== 'steam') return; idx.steam = 5 + j; confirm(); });
      return b;
    });
    foot(s, '', true);
  }
  function renderTeam() {
    const s = els.steam, T = pt.team || [];
    s.cards.forEach((c, i) => fillCard(c, T[i]));
    s.rules.forEach((e, i) => { e.classList.toggle('cur', idx.steam === i); e.classList.toggle('sel', pt.rule === i && idx.steam !== i); });
    s.go.forEach((b, j) => b.classList.toggle('cur', idx.steam === 5 + j));
  }
  function autoPick() {
    if (sel.players !== 1 || !sel.picks.length || sel.picks.length >= 4) return;
    while (sel.picks.length < 4) { const free = IDS.map((_, i) => i).filter(i => !sel.picks.includes(i)); sel.picks.push(free[Math.floor(Math.random() * free.length)]); }
    go('stage');
  }
  let stgAsk = -1, stgAskCur = 0; // 맵 확인 창: 물어보는 스테이지(-1 = 닫힘) · 창 커서(0 = 예, 1 = 아니오)
  function buildStage() {
    const s = els.stage = el('div', 'nkm-scr', stageEl); head(s, '스테이지 · 룰');
    abs(el('div', 'nkm-win', s), 32, 84, 800, 556);
    s.cards = [];
    for (let i = 0; i < 8; i++) {
      const e = abs(el('div', 'nkm-stg' + (i === 7 ? ' exit' : ''), s, i === 7 ? '나가기' : undefined), 56 + 192 * (i & 3), 124 + 152 * (i >> 2)); e.dataset.id = i === 7 ? 'exit' : 'stage' + (i + 1);
      if (i < 7) { e.style.backgroundImage = 'url(/ui/stage_' + STAGE_ID[i] + '.png)'; el('b', '', e, String(i + 1)); }
      hoverable(e, () => { if (scr === 'stage' && sel.zone === 'stage' && sel.stageCur !== i) { sel.stageCur = i; render(); } });
      e.addEventListener('click', () => { // 마우스·터치: 스테이지 = 확인 창(예 = 대결 확인, 키보드·게임패드 결정도 같은 창), 나가기 = 바로 결정
        if (!active || busy || scr !== 'stage' || stgAsk >= 0) return;
        if (i === 7) { sel.zone = 'stage'; sel.stageCur = i; render(); return confirm(); }
        if (sel.zone === 'stage') sel.stageCur = i; stgAsk = i; stgAskCur = 0; render();
      });
      s.cards.push(e);
    }
    s.brk = abs(el('div', 'nkm-brk', s), 0, 0, 190, 146);
    s.prev = el('div', 'nkm-prev', s); s.prevT = el('b', '', s.prev);
    const w = abs(el('div', 'nkm-win', s), 848, 84, 400, 556); el('div', 'nkm-tab', w, '♥ 룰 ♥');
    s.rules = RULES.map((t, i) => {
      const e = el('div', 'nkm-rule' + (i === 0 ? ' lock' : ''), w); e.style.top = 23 + 102 * i + 'px'; if (i === 0) e.style.borderTopColor = 'transparent'; e.dataset.id = 'rule' + (i + 1);
      el('s', '', e, String(i + 1)); el('span', '', e, t); if (i === 0) chip(e, '스토리 전용', null, true);
      hoverable(e, () => { if (scr === 'stage' && sel.zone === 'rule' && i > 0 && sel.rule !== i) { sel.rule = i; render(); } });
      e.addEventListener('click', () => {
        if (!active || busy || scr !== 'stage') return;
        if (i === 0) return toast('배틀 모드에서는 쓸 수 없는 룰');
        if (sel.zone !== 'rule') return toast('스테이지를 먼저 골라 주세요');
        sel.rule = i; render(); confirm();
      });
      return e;
    });
    s.hint = foot(s, '', true);
    // 맵 확인 창(마우스·터치로 스테이지를 눌렀을 때만, 대기실 「정말 그만둘까요?」와 같은 덮개). 바깥(덮개) 클릭 = 아니오
    const av = s.ask = el('div', 'nkl-ov nks-ask', s); abs(el('div', 'nkm-win', av), 400, 170, 480, 360);
    av.thumb = abs(el('div', 'nkm-stg nkm-thumb', av), 573, 194, 134, 100); av.nm = el('div', 'nks-ask-nm', av); el('div', 'nkl-q nks-ask-q', av, '이 맵으로 하시겠습니까?');
    av.addEventListener('click', ev => { if (ev.target === av && active && !busy && scr === 'stage' && stgAsk >= 0) askStage(false); });
    s.askB = [['ask_yes', '예', [432, 446, 196, 60]], ['ask_no', '아니오', [652, 446, 196, 60]]].map(([id, t, r], i) => {
      const b = abs(el('div', 'nkm-btn', av, t), ...r); b.dataset.id = id; b.setAttribute('role', 'button');
      hoverable(b, () => { if (scr === 'stage' && stgAsk >= 0 && stgAskCur !== i) { stgAskCur = i; render(); } });
      tapOnce(b, () => { if (active && !busy && scr === 'stage' && stgAsk >= 0) askStage(i === 0); });
      return b;
    });
    root.addEventListener('click', ev => { if (active && !busy && scr === 'stage' && stgAsk >= 0 && !s.contains(ev.target)) askStage(false); }); // 좁은 화면에서 논리 화면 밖(벽지) 탭도 = 아니오
  }
  function askStage(yes) { const i = stgAsk; stgAsk = -1; if (!yes) return render(); els.stage.ask.classList.remove('on'); sel.stageCur = sel.stage = i; sel.zone = 'rule'; if (!(sel.rule >= 1 && sel.rule <= 4)) sel.rule = 1; idx.status = 0; go('status'); } // 예 = 스테이지 확정 + 지금 룰(기본 룰2)로 바로 대결 확인. 대결 확인의 뒤로 = 룰 영역(스테이지 유지)에서 룰을 다시 고름
  function listBtns(s, k, items, rects) { // 세로 버튼 목록(커서 = idx[k])
    s.btns = items.map(([id, t], i) => {
      const b = abs(el('div', 'nkm-btn', s, t), ...rects[i]); b.dataset.id = id; b.setAttribute('role', 'menuitem');
      hoverable(b, () => { if (scr === k && idx[k] !== i) { idx[k] = i; render(); } });
      b.addEventListener('click', () => { if (!active || busy || scr !== k) return; idx[k] = i; render(); confirm(); });
      return b;
    });
  }
  function buildStatus() { // 대결 확인: 선수 카드 4장(초상·이름·능력치 6·필살기 3) + 스테이지·룰 요약 + 대결 시작 / 뒤로. 배틀 모드는 개인전이라 4장을 같은 크기로 늘어놓는다
    const s = els.status = el('div', 'nkm-scr', stageEl); head(s, '대결 확인');
    s.cards = [0, 1, 2, 3].map(i => {
      const w = abs(el('div', 'nkm-win nkm-card', s), 32 + 306 * i, 84, 298, 412), c = { w };
      c.cut = abs(el('div', 'nkm-cut', w), 12, 12, 116, 128); c.im = el('img', '', c.cut); c.im.alt = ''; c.im.draggable = false;
      c.chips = el('div', 'nkm-card-chips', w); c.who = chip(c.chips, '', 'com'); c.sch = chip(c.chips, '', 'sch0', true); c.nm = el('div', 'nkm-card-name', w);
      c.stats = STATS.map(([key, label, max, tick], j) => { const row = abs(el('div', 'nkm-stat nkm-cstat', w, label), 14, 150 + 26 * j); cvar(row, key); const g = gauge(row, key, max, tick), num = el('b', '', row); return { key, max, g, num }; });
      c.sp = [0, 1, 2].map(j => { const r = el('div', 'nkh-sp', w); r.style.top = 316 + 28 * j + 'px'; r.style.left = '14px'; return r; });
      return c;
    });
    abs(el('div', 'nkm-win', s), 32, 512, 1216, 128);
    s.thumb = abs(el('div', 'nkm-stg nkm-thumb', s), 48, 526, 134, 100); s.stg = el('div', 'nkm-sum-stage', s); s.rule = el('div', 'nkm-sum-rule', s);
    listBtns(s, 'status', [['start', '대결 시작'], ['back', '뒤로']], [[928, 524, 300, 50], [928, 580, 300, 46]]);
    foot(s, '', true);
  }
  function buildResult() { // 결과: 승패 글자 + 이긴 선수 컷·남은 HP / 스테이지·룰·시간 + 진 선수 카드 / 버튼 3
    const s = els.result = el('div', 'nkm-scr nkm-resS', stageEl); head(s, '결과'); // nkm-rr = 오른쪽 창의 요소(세로 화면에서 왼쪽 창 아래로 옮긴다, CSS)
    abs(el('div', 'nkm-win', s), 32, 84, 600, 556); s.ttl = el('div', 'nkm-res-title', s); s.wins = el('div', 'nkm-res-wins', s);
    abs(el('div', 'nkm-win nkm-rr', s), 648, 84, 600, 336);
    s.thumb = abs(el('div', 'nkm-stg nkm-thumb', s), 664, 100, 134, 100);
    s.infoRows = ['스테이지', '룰', '시간'].map((t, i) => { const r = el('div', 'nkm-res-info', s, t); r.style.setProperty('--ic', 'url(/img/result/stat_' + ['stage', 'rule', 'time'][i] + '_1x.png)'); return r; }); s.info = s.infoRows.map(r => el('b', '', r)); // 자리는 renderResult 가 정한다(무승부는 왼쪽 패널)
    s.sep = abs(el('div', 'nkm-sep nkm-rr', s), 664, 214, 568); s.loses = el('div', 'nkm-res-loses nkm-rr', s);
    abs(el('div', 'nkm-win nkm-rr', s), 648, 436, 600, 204);
    listBtns(s, 'result', [['again', '한 판 더'], ['stage', '스테이지 바꾸기'], ['card', '카드 이미지 저장'], ['exit', '나가기']], [[784, 448, 328, 42], [784, 496, 328, 42], [784, 544, 328, 42], [784, 592, 328, 40]]); s.btns.forEach(b => b.classList.add('nkm-rr', 'nkm-resb')); // R1: 카드 이미지 저장(saveCard) = 화면 그대로, 커서만 한 칸 늘어남
    foot(s, '', false);
  }
  function buildSettings() { // 설정: 소리 음량 · 화면 배율 · 게이지 패널(HUD) · 깜박임 제거 · 게임 속도 + 뒤로. ← → 로 바꾸면 바로 적용·저장
    const s = els.settings = el('div', 'nkm-scr nkm-setS', stageEl); s.headEl = head(s, '설정'); const sy = SET_ROWS.length > 7 ? 28 : 0, sh = SET_ROWS.length > 7 ? 55 : 0, T = SET_ROWS.length > 8, RS = SET_ROWS.length > 17 ? 28 : SET_ROWS.length > 16 ? 30 : SET_ROWS.length > 14 ? 34 : SET_ROWS.length > 13 ? 36 : SET_ROWS.length > 12 ? 39 : SET_ROWS.length > 11 ? 42 : 46; s.win = abs(el('div', 'nkm-win', s), 390, T ? 104 : 150 - sy, 500, T ? 600 : 488 + sh); // 8줄(오프닝 장면 추가): 창을 위로 28, 아래로 27 늘림. 9줄 이상(21절, 11줄) = 줄 46 간격(t46)
    s.rows = SET_ROWS.map(([key, label], i) => {
      const r = abs(el('div', 'nkm-set' + (T ? ' t' + RS : ''), s, label), 410, T ? 118 + RS * i : 166 - sy + 55 * i, 460, T ? RS : 56); r.dataset.id = key; // 7줄(타격 효과 추가): 줄 간격 62 → 55, 높이 56(글줄 높이와 같음)
      const dn = el('em', '', r, '◀'), v = el('span', '', r), up = el('em', '', r, '▶'); up.style.right = '0';
      if (key === 'vol') r.g = gauge(v, 'focus', 10, 1); r.num = el('b', '', v);
      hoverable(r, () => { if (scr === 'settings' && setIdx !== i) { setIdx = i; render(); } });
      const tap = d => ev => { ev.stopPropagation(); if (!active || busy || scr !== 'settings') return; setIdx = i; adjust(d); };
      dn.addEventListener('click', tap(-1)); up.addEventListener('click', tap(1)); r.addEventListener('click', tap(1));
      return r;
    });
    s.sepE = abs(el('div', 'nkm-sep', s), 436, T ? 632 : 558 - sy + sh, 408);
    s.back = abs(el('div', 'nkm-btn', s, '뒤로'), 476, T ? 640 : 570 - sy + sh, 328, T ? 52 : 56); s.back.dataset.id = 'back';
    hoverable(s.back, () => { if (scr === 'settings' && setIdx !== SET_BACK) { setIdx = SET_BACK; render(); } });
    s.back.addEventListener('click', () => { if (active && !busy && scr === 'settings') back(); });
    for (const e of [s.win, s.sepE, s.back, ...s.rows]) e.o = [e.style.left, e.style.top, e.style.width, e.style.height]; // 가로 배치 원본(세로 배치에서 돌아올 때)
  }
  function setLayout(s, port) { // 세로 화면(M4): 줄 높이를 늘려 실제 누름 칸 ≥ 44px(창 높이가 모자라면 들어가는 만큼). 가로 = 종전 배치 그대로
    const f = FOCUS.settings, k = port ? Math.min(window.innerWidth / f[1], window.innerHeight / LH) : 1, Hv = port ? window.innerHeight / k : LH, top = (LH - Hv) / 2, n = s.rows.length;
    const rh = port ? Math.max(34, Math.min(Math.ceil(46 / k), Math.floor((Hv - 8) / (n + 1)))) : 0, sig = port ? rh + ':' + Math.round(top) : ''; if (s.lay === sig) return; s.lay = sig;
    const put = (e, r) => { e.style.left = r[0]; e.style.top = r[1]; e.style.width = r[2]; e.style.height = r[3]; };
    if (!port) { for (const e of [s.win, s.sepE, s.back, ...s.rows]) put(e, e.o); s.rows.forEach(r => r.classList.remove('tp')); s.headEl.style.display = ''; return; }
    const y0 = top + 4; s.headEl.style.display = 'none'; s.style.setProperty('--rh', rh + 'px'); // 세로 = 제목 숨김(18줄 + 뒤로를 실제 44px 이상으로 넣을 높이)
    abs(s.win, 390, y0 - 3, 500, n * rh + rh + 7); s.rows.forEach((r, i) => { abs(r, 410, y0 + rh * i, 460, rh); r.classList.add('tp'); }); abs(s.sepE, 436, y0 + n * rh + 1, 408); abs(s.back, 476, y0 + n * rh + 3, 328, rh);
  }
  function adjust(d) { // 설정 값 바꾸기 → 저장 → 적용(game.js: 음량·배율, HUD: 다음 프레임)
    if (setIdx === 0) set.vol = Math.max(0, Math.min(10, set.vol + d)); else if (setIdx === 1) set.scale = (set.scale + d + SCALES.length) % SCALES.length; else if (setIdx === 2) set.hud = set.hud ? 0 : 1; else if (setIdx === 3) set.nf = set.nf ? 0 : 1; else if (setIdx === 4 && !speedLocked()) set.speed = SPEEDS[(SPEEDS.indexOf(set.speed) + d + SPEEDS.length) % SPEEDS.length]; else if (setIdx === 5) set.tags = (set.tags + d + 3) % 3; else if (setIdx === 6) { set.fxlv = ((set.fxlv | 0) + d + 4) % 4; set.hitfx = set.fxlv ? 1 : 0; } else if (setIdx === 7) set.op = set.op ? 0 : 1; else if (setIdx === 8) set.hd = set.hd ? 0 : 1; else if (setIdx === 9) set.mute = set.mute ? 0 : 1;
    else if (setIdx === 10) { if (!classicLocked() && NKS) NKS.toClassic(); return; } // 클래식 화면: 이 탭을 ?classic=1&ko=1 로 다시 연다(저장하지 않는다. 온라인·일시정지 중에는 잠금)
    else if (setIdx === 11) { if (window.NKKeymap) window.NKKeymap.open({ onClose: render }); return; }
    else if (setIdx === 12) { if (window.NKTouch) window.NKTouch.open({ onClose: render }); return; } // 터치 패드 창(web/touch_pad.js: 자동·켬·끔 · 달리기 보조 · 진동)
    else if (setIdx === 13) set.cam = ((set.cam === undefined ? 1 : set.cam) + d + 3) % 3; // 카메라 연출(web/cam_fx.js, analysis/27 Z1): 끔 · 약 · 보통
    else if (setIdx === 15) set.impact = (((set.impact === undefined ? 2 : set.impact) | 0) + d + 4) % 4; // 타격 효과(web/impact_fx.js): 끔·약·보통·강
    else if (setIdx === 16) { const L = QUAL; set.quality = L[(Math.max(0, L.indexOf(set.quality)) + d + L.length) % L.length]; } // 화질(web/quality.js): 자동·높음·보통·낮음(자동으로 바꾸면 아래에서 NKQuality.reset)
    else if (SET_ROWS[setIdx] && SET_ROWS[setIdx][0] === 'a11y') { if (window.NKA11y) window.NKA11y.open({ onClose: render }); return; } // 접근성 창(web/a11y.js: 색약·글자 크기)
    else if (setIdx === 14) { const T = window.NKTutorial; if (!T || speedLocked()) return; if (ovl) { T.start(); hide(); onPick('resume', null); } else if (!tutGo()) toast('지금은 시작할 수 없습니다'); return; } // 튜토리얼 다시 보기(web/tutorial.js): 일시정지 중 = 지금 판에서, 그 밖 = 튜토리얼 판(tutGo)
    else return;
    if (NKS) { if (!NKS.save()) toast('설정을 저장하지 못했습니다'); } else try { localStorage.setItem(SET_KEY, JSON.stringify(set)); } catch (e) { toast('설정을 저장하지 못했습니다'); }
    if (setIdx === 16 && set.quality === 'auto' && window.NKQuality) window.NKQuality.reset(); // 자동 = 높음부터 다시 잰다
    if (onSettings) onSettings(set); render();
  }
  const QUAL = ['auto', 'high', 'mid', 'low'], QUAL_T = { auto: '자동', high: '높음', mid: '보통', low: '낮음' };
  const speedLocked = () => net.playing || !!net.room; // 온라인 방·대전 중 = 게임 속도 1배 고정(game.js 도 온라인은 1배). 행만 흐리게, 저장 값은 그대로
  function renderSettings() {
    const s = els.settings; s.rows.forEach((r, i) => r.classList.toggle('cur', i === setIdx)); s.back.classList.toggle('cur', setIdx === SET_BACK);
    s.rows[0].g.fill.style.width = set.vol * 10 + '%'; s.rows[0].num.textContent = set.vol; s.rows[1].num.textContent = SCALES[set.scale]; s.rows[2].num.textContent = set.hud ? '켬' : '끔'; s.rows[3].num.textContent = set.nf ? '켬' : '끔';
    const lk = speedLocked(); s.rows[4].classList.toggle('off', lk); s.rows[4].num.textContent = lk ? SPEED_T[0] : SPEED_T[SPEEDS.indexOf(set.speed)]; s.rows[5].num.textContent = TAGS_T[set.tags]; s.rows[6].num.textContent = FX_T[set.fxlv | 0] || '끔'; s.rows[7].num.textContent = set.op ? '켬' : '끔';
    const hq = /[?&]hd=[01](&|$)/.test(Q); s.rows[8].classList.toggle('off', hq); s.rows[8].num.textContent = (hq ? /[?&]hd=1/.test(Q) : set.hd) ? '켬' : '끔'; // ?hd= 주소는 고정(행만 흐리게)
    s.rows[9].num.textContent = set.mute ? '켬' : '끔'; const cl = classicLocked(); s.rows[10].classList.toggle('off', cl); s.rows[10].num.textContent = '끔'; s.rows[11].classList.toggle('off', !window.NKKeymap); s.rows[11].num.textContent = '열기'; if (s.rows[12]) { s.rows[12].classList.toggle('off', !window.NKTouch); s.rows[12].num.textContent = window.NKTouch ? window.NKTouch.label() : '—'; }
    if (s.rows[15]) { s.rows[15].classList.toggle('off', !!(window.NKQuality && window.NKQuality.off('fx'))); s.rows[15].num.textContent = FX_T[set.impact === undefined ? 2 : set.impact | 0] || '보통'; } // 화질 낮음 = 타격 효과 꺼짐(행만 흐리게, 값은 그대로)
    if (s.rows[16]) { const Qm = window.NKQuality, q = QUAL.indexOf(set.quality) >= 0 ? set.quality : 'auto'; s.rows[16].num.textContent = q === 'auto' && Qm ? '자동 · ' + (Qm.NAMES[Qm.level] || '') : QUAL_T[q]; }
    { const ai = SET_ROWS.findIndex(r => r[0] === 'a11y'), r = s.rows[ai]; if (r) { r.classList.toggle('off', !window.NKA11y); r.num.textContent = window.NKA11y ? window.NKA11y.label() : '—'; } }
    if (s.rows[14]) { s.rows[14].classList.toggle('off', !window.NKTutorial || speedLocked()); s.rows[14].num.textContent = '다시 보기'; }
    if (s.rows[13]) { s.rows[13].classList.toggle('off', !window.NKCam || window.NKCam.blocked); s.rows[13].num.textContent = ['끔', '약', '보통'][set.cam === undefined ? 1 : set.cam]; } // 카메라 연출: 동작 줄이기·클래식 = 늘 끔(행만 흐리게)
  }
  const classicLocked = () => !NKS || ovl || speedLocked(); // 일시정지 덮개(진행 중인 판)·온라인 방에서는 다른 주소로 다시 열지 않는다
  function fillStats(list, ch) { for (const st of list) { const v = ch.stats_l1[st.key]; st.g.fill.style.width = Math.min(100, v / st.max * 100) + '%'; st.num.textContent = v; } }
  const ruleText = r => ruleLab(r) + ' · ' + RULES[r];
  function renderStatus() {
    const s = els.status, rs = roles(sel.players);
    s.cards.forEach((c, i) => {
      const id = sel.picks[i], ch = data.characters[id], r = id >> 2;
      cvar(c.cut, 'sch' + r); c.im.src = face(id);
      c.who.textContent = rs[i][1] === 'com' ? 'COM' : rs[i][0]; cvar(c.who, rs[i][1]); c.sch.textContent = SCHOOLS[r]; cvar(c.sch, 'sch' + r); c.nm.textContent = ch.name_ko;
      fillStats(c.stats, ch); c.sp.forEach((e, j) => { const m = ch.specials[j]; e.classList.toggle('none', !m); e.textContent = m ? m.ko : '—'; cvar(e, 'sch' + r); });
    });
    s.thumb.style.backgroundImage = 'url(/ui/stage_' + STAGE_ID[sel.stage] + '.png)'; s.stg.textContent = 'STAGE ' + (sel.stage + 1); s.rule.textContent = ruleText(sel.rule);
  }
  function renderResult() {
    const s = els.result, sig = res.win.concat(res.lose).map(f => f.id + ':' + f.hp).join() + '|' + res.win.length + '|' + sel.stage + '|' + sel.rule + '|' + res.sec; if (s.sig === sig) return; s.sig = sig; // 커서만 움직일 때는 다시 만들지 않는다
    const card = (parent, f, win) => {
      const c = el('div', 'nkm-res-f' + (win ? '' : ' lose'), parent), cut = el('div', 'nkm-cut', c), im = el('img', '', cut); im.alt = ''; im.draggable = false; im.src = face(f.id); cvar(cut, 'sch' + (f.id >> 2));
      const t = el('div', 'nkm-res-tag', c); chip(t, f.who[0], f.who[1]); t.appendChild(document.createTextNode(data.characters[f.id].name_ko));
      const h = el('div', 'nkm-res-hp', c, 'HP'), col = f.hp / f.max > 0.5 ? 'hp' : f.hp / f.max > 0.25 ? 'hp-mid' : 'hp-low', g = gauge(h, col, 1, 1); g.fill.style.transition = 'none'; g.fill.style.width = f.hp / f.max * 100 + '%'; cvar(el('b', '', h, String(f.hp)), col);
    };
    const draw = !res.win.length; s.classList.toggle('draw', draw); s.sep.style.display = draw ? 'none' : ''; // 무승부: 왼쪽 패널 = 글자 + 스테이지·룰·시간, 오른쪽 위 패널 = 카드 4장(2x2, 보통 폭)
    s.thumb.classList.toggle('nkm-rr', !draw); s.infoRows.forEach(r => r.classList.toggle('nkm-rr', !draw));
    if (draw) { abs(s.thumb, 265, 262, 134, 100); s.infoRows.forEach((r, i) => abs(r, 96, 396 + 40 * i)); } else { abs(s.thumb, 664, 100, 134, 100); s.infoRows.forEach((r, i) => abs(r, 832, 104 + 34 * i)); } // 줄 아이콘(::before, 왼쪽 30px)이 미리보기와 겹치지 않게 814 → 832
    s.ttl.textContent = draw ? '무승부' : res.human ? '승리!' : '패배'; s.ttl.classList.toggle('lose', !res.human); s.ttl.dataset.r = draw ? 'draw' : res.human ? 'win' : 'lose'; // R1 리본(web/img/result, 글자 포함 그림 = CSS 배경)
    s.wins.textContent = ''; s.loses.textContent = ''; s.wins.classList.toggle('many', res.win.length > 2);
    res.win.forEach(f => card(s.wins, f, true)); res.lose.forEach(f => card(s.loses, f, false));
    s.thumb.style.backgroundImage = sel.stage >= 0 ? 'url(/ui/stage_' + STAGE_ID[sel.stage] + '.png)' : 'none';
    s.info[0].textContent = sel.stage >= 0 ? 'STAGE ' + (sel.stage + 1) : '—'; s.info[1].textContent = RULES[sel.rule] || '—';
    s.info[2].textContent = String(Math.floor(res.sec / 60)).padStart(2, '0') + ':' + String(res.sec % 60).padStart(2, '0');
  }
  // ── 결과 카드 PNG(R1, web/img/result/manifest.json card): 1x 320x180 자리 x4 = 1280x720 캔버스, imageSmoothingEnabled=false. 그리는 순서 = manifest draw_order
  //   값 = 클라이언트가 이미 아는 것만(스테이지·룰·경기 시간·1P 남은 HP / 온라인 = 내 캐릭터·닉네임·장착 칭호·레이팅 변동). MVP = 근거 자료가 없어 그리지 않는다. 글자 = fillText(HTML 없음)
  const RC = { bg: [0, 0], ribbon: [8, 4, 92, 20], portrait: [16, 30, 100, 96], name: [16, 130, 100, 18], title: [132, 4, 182, 14], match: [[138, 26], [138, 44], [138, 62]], stat: [[138, 84], [138, 102], [138, 120], [138, 138]], logo: [8, 165, 150, 12], right: [200, 165, 112, 12] };
  const rcImg = u => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = u; });
  const mmss = sec => String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  function cardSpec() { // 지금 결과 화면 → { kind: win|lose|draw, label(리본 글자 없는 판의 글자), face, name, title, match[[아이콘, 글자]], stat[[아이콘, 글자]] } | null
    if (scr === 'result') {
      const draw = !res.win.length, all = res.win.concat(res.lose), me = all.find(f => f.who === OROLE[0]) || all[0]; if (!me) return null;
      const match = [['stage', sel.stage >= 0 ? 'STAGE ' + (sel.stage + 1) : ''], ['rule', ruleLab(sel.rule)], ['time', mmss(res.sec)]].filter(r => r[1]);
      return { kind: draw ? 'draw' : res.human ? 'win' : 'lose', face: me.id, name: cname(me.id), title: '', match, stat: [['hp', '남은 HP ' + me.hp + ' / ' + me.max]] };
    }
    if (scr === 'oend' && oe.card) {
      const c = oe.card, r = net.rr, stat = [], eq = pf.data && pf.data.self && !pf.data.guest && pf.data.equipped, T = eq && eq.title ? (pf.data.titles || []).find(x => x.id === eq.title) : null;
      if (r && r.counted) { const d = r.delta | 0; stat.push([d > 0 ? 'rate_up' : d < 0 ? 'rate_down' : 'rate_same', '레이팅 ' + (r.before | 0) + ' → ' + (r.after | 0) + ' (' + (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d) + ')']); }
      if (r && TIER[r.tier]) stat.push(['trophy', r.placement ? '배치 ' + (5 - (r.placementLeft | 0)) + '/5' : TIER[r.tier]]);
      const match = [['stage', c.stage >= 0 ? 'STAGE ' + (c.stage + 1) : ''], ['rule', ruleLab(c.rule)], ['time', c.sec > 0 ? mmss(c.sec) : '']].filter(x => x[1]);
      return { kind: c.kind, label: c.label, face: c.ch, name: c.nick || cname(c.ch), sub: c.nick ? cname(c.ch) : '', title: T ? String(T.name) : '', match, stat };
    }
    return null;
  }
  async function cardCanvas(sp) {
    const S = 4, cv = document.createElement('canvas'); cv.width = 320 * S; cv.height = 180 * S; const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
    try { await document.fonts.load('48px Galmuri11'); } catch (e) { /* 글꼴 없음 = 대체 글꼴 */ }
    const ribbon = sp.label ? 'ribbon_' + sp.kind + '_blank' : 'ribbon_' + sp.kind, icons = [...new Set(sp.match.concat(sp.stat).map(r => r[0]))];
    const [bg, rb, fc, ...ic] = await Promise.all([rcImg('/img/result/card_bg_' + sp.kind + '_4x.png'), rcImg('/img/result/' + ribbon + '_4x.png'), rcImg(face(sp.face)), ...icons.map(k => rcImg('/img/result/stat_' + k + '_4x.png'))]);
    if (!bg) throw new Error('card_bg');
    const icon = {}; icons.forEach((k, i) => { icon[k] = ic[i]; });
    const txt = (t, x, y, w, o) => { o = o || {}; g.font = (o.px || 48) + 'px Galmuri11,monospace'; g.fillStyle = o.color || '#FFFDF5'; g.textBaseline = 'middle'; g.textAlign = o.align || 'left'; let s = String(t); while (s.length > 1 && g.measureText(s).width > w) s = s.slice(0, -2) + '…'; g.fillText(s, o.align === 'center' ? x + w / 2 : o.align === 'right' ? x + w : x, y); };
    g.drawImage(bg, 0, 0); // 1) 바탕
    const P = RC.portrait; if (fc) { const n = Math.max(1, Math.floor(Math.min(P[2] * S / fc.width, P[3] * S / fc.height))), w = fc.width * n, h = fc.height * n; g.save(); g.beginPath(); g.rect(P[0] * S, P[1] * S, P[2] * S, P[3] * S); g.clip(); g.drawImage(fc, P[0] * S + ((P[2] * S - w) >> 1), P[1] * S + ((P[3] * S - h) >> 1), w, h); g.restore(); } // 2) 초상(정수배, 자리 밖은 자름)
    const N = RC.name; txt(sp.name, N[0] * S + 8, (N[1] + N[3] / 2) * S, N[2] * S - 16, { align: 'center' }); // 3) 이름
    const R = RC.ribbon; if (rb) g.drawImage(rb, R[0] * S, R[1] * S); if (sp.label) txt(sp.label, R[0] * S, (R[1] + R[3] / 2) * S, R[2] * S, { align: 'center', color: '#14121E' }); // 4) 리본(글자 없는 리본 = 앱 글자)
    // 5) MVP 배지: 근거 자료 없음 = 그리지 않는다
    if (sp.title) { const T = RC.title; txt(sp.title, T[0] * S, (T[1] + T[3] / 2) * S, T[2] * S, { color: '#FFE14D', align: 'right' }); }
    const row = (r, at) => { const im = icon[r[0]]; if (im) g.drawImage(im, (at[0] + 3) * S, (at[1] + 3) * S); txt(r[1], (at[0] + 20) * S, (at[1] + 9) * S, 150 * S); }; // 6) 줄 아이콘 + 글자
    sp.match.slice(0, 3).forEach((r, i) => row(r, RC.match[i])); sp.stat.slice(0, 4).forEach((r, i) => row(r, RC.stat[i]));
    if (sp.sub) txt(sp.sub, (RC.stat[3][0] + 20) * S, (RC.stat[3][1] + 9) * S, 150 * S, { color: '#B8B4CC' }); // 온라인: 내 캐릭터 이름(마지막 줄, 아이콘 없음)
    const d = new Date(), L = RC.logo, Rt = RC.right; txt('열혈격투전설', L[0] * S, (L[1] + L[3] / 2) * S, L[2] * S); txt(d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0'), Rt[0] * S, (Rt[1] + Rt[3] / 2) * S, Rt[2] * S, { align: 'right', color: '#B8B4CC' }); // 7) 바닥 글자
    return cv;
  }
  let cardBusy = false;
  function saveCard() { // 「카드 이미지 저장」: PNG 내려받기. 실패 = 토스트
    const sp = cardSpec(); if (!sp) return toast('저장할 결과가 없습니다', 'hp-low'); if (cardBusy) return; cardBusy = true;
    cardCanvas(sp).then(cv => new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('blob')), 'image/png'))).then(b => {
      const d = new Date(), p = n => String(n).padStart(2, '0'), a = document.createElement('a'), u = URL.createObjectURL(b);
      a.href = u; a.download = 'nekketsu_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.png'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
      toast('카드를 저장했습니다', 'focus');
    }).catch(e => { console.warn('결과 카드 저장 실패: ' + (e && e.message || e)); toast('카드를 저장하지 못했습니다', 'hp-low'); }).then(() => { cardBusy = false; });
  }
  function buildVs() { // 시합 준비 컷: 구동(빨리 감기) 동안 덮는다. 고른 4명 + 스테이지·룰
    const s = els.vs = el('div', 'nkm-scr', stageEl); abs(el('div', 'nkm-win', s), 96, 120, 1088, 520);
    s.strip = el('div', 'nkm-vs-strip', s);
    s.cuts = [0, 1, 2, 3].map(i => { const c = abs(el('div', 'nkm-cut nkm-vs-cut', s), 136 + 258 * i, 236); c.im = el('img', '', c); c.im.alt = ''; c.tag = el('div', 'nkm-vs-tag', s); c.tag.style.left = 136 + 258 * i + 'px'; return c; });
    const g = gauge(s, 'focus', 1, 1); g.classList.add('nkm-vs-bar'); el('div', 'nkm-foot', s);
  }

  // ── 3단계: 스토리 대진표(원작 9:4 를 덮는다, 15 문서 16절). 대진 순서·팀 구성·승패는 원작 RAM(읽기만), 결정 = 원작 대진표를 넘겨 전투 입장까지 구동(story_next) ──
  function buildBracket() {
    const s = els.bracket = el('div', 'nkm-scr', stageEl); s.headEl = head(s, '대진표'); s.round = chip(s, '', 'focus'); s.round.classList.add('nkb-round');
    abs(el('div', 'nkm-win', s), 32, 84, 864, 556);
    s.rows = [0, 1, 2, 3].map(i => {
      const r = abs(el('div', 'nkb-row', s), 48, 100 + 136 * i, 832, 124); r.dataset.id = 'match' + (i + 1);
      el('div', 'nkb-vs', r, 'VS'); r.next = chip(r, '다음 시합', 'focus'); r.next.classList.add('nkb-next');
      r.side = [0, 1].map(k => { // k 0 = 왼쪽 팀, 1 = 오른쪽 팀(초상은 바깥쪽, 이름·승패는 VS 쪽)
        const x = k ? 'right' : 'left', o = { cuts: [0, 1].map(j => { const c = el('div', 'nkm-cut', r); c.style[x] = 12 + 88 * (k ? 1 - j : j) + 'px'; c.im = el('img', '', c); c.im.alt = ''; c.im.draggable = false; return c; }) };
        o.nm = el('div', 'nkb-nm', r); o.wl = el('div', 'nkb-wl', r); o.nm.style[x] = o.wl.style[x] = '196px'; if (k) o.nm.style.textAlign = o.wl.style.textAlign = 'right';
        o.p1 = chip(r, '1P', 'p1'); o.p1.classList.add('nkb-1p'); o.p1.style[x] = (k ? 94 : 6) + 'px'; o.p2 = chip(r, '2P', 'p2'); o.p2.classList.add('nkb-1p'); o.p2.style[x] = (k ? 6 : 94) + 'px'; // 딱지는 그 선수 초상의 바깥 위 모서리(첫째 선수 = 1P, 둘째 = 2인 협력의 2P)
        return o;
      });
      return r;
    });
    const w = abs(el('div', 'nkm-win', s), 912, 84, 336, 556); el('div', 'nkm-tab', w, '내 팀');
    s.me = [0, 1].map(k => { const c = abs(el('div', 'nkm-cut nkb-me', s), 936 + 152 * k, 120, 136, 152); c.im = el('img', '', c); c.im.alt = ''; c.im.draggable = false; return c; });
    s.meNm = el('div', 'nkb-me-nm', s); s.meWl = el('div', 'nkb-me-wl', s);
    listBtns(s, 'bracket', [['start', '시합 시작']], [[944, 568, 272, 56]]);
    foot(s, '', false);
  }
  // ── 17절: 에디트 폼(원작 5:2:2~5:2:4 를 대신한다). 이름 = 한글 입력(최대 NAME_MAX 자), 생일 = 월·일 고르기(그 달의 날만), 별자리 = 자동, 혈액형 = A·B·O·AB. 확인 = 구동 story_edit(원작 입력표·값을 입력열로 재생)
  function buildEdit() {
    const s = els.edit = el('div', 'nkm-scr nkm-edit', stageEl); head(s, '에디트');
    abs(el('div', 'nkm-win', s), 200, 108, 880, 456);
    // 에디트 캐릭터는 원작에 전용 초상이 없어(이름으로 유파·외형이 정해짐) 초상 카드 없이 폼만 가운데(가로 370~910, 중심 640). 1P 구분 = 폼 위 작은 칩
    abs(chip(s, '1P', 'p1'), 370, 124).classList.add('nke-who');
    const row = (t, y) => abs(el('div', 'nke-lab', s, t), 370, y);
    const field = (tag, x, y, w, id) => { const f = abs(el(tag, 'nke-f', s), x, y, w); f.dataset.id = id; f.addEventListener('focus', () => { if (scr === 'edit') { s.cur = id; render(); } }); return f; };
    row('이름', 176); s.name = field('input', 510, 164, 400, 'name'); s.name.type = 'text'; s.name.maxLength = NAME_MAX; s.name.autocomplete = 'off'; s.name.spellcheck = false; s.name.setAttribute('aria-label', '이름');
    row('생일', 252); s.month = field('select', 510, 240, 112, 'month'); el('span', 'nke-unit', s, '월').style.cssText = 'left:632px;top:252px'; s.day = field('select', 670, 240, 112, 'day'); el('span', 'nke-unit', s, '일').style.cssText = 'left:792px;top:252px';
    for (let i = 1; i <= 12; i++) el('option', '', s.month, String(i)).value = i;
    row('혈액형', 328); s.blood = field('select', 510, 316, 112, 'blood'); el('span', 'nke-unit', s, '형').style.cssText = 'left:632px;top:328px';
    s.zod = row('별자리', 400); s.zodV = abs(el('b', 'nke-unit nke-zod', s), 510, 400);
    BLOOD.forEach((b, i) => { el('option', '', s.blood, b).value = i; });
    s.month.setAttribute('aria-label', '월'); s.day.setAttribute('aria-label', '일'); s.blood.setAttribute('aria-label', '혈액형');
    s.name.addEventListener('input', () => { ed.name = s.name.value; });
    s.month.addEventListener('change', () => { ed.month = +s.month.value; ed.day = Math.min(ed.day, DIM[ed.month - 1]); fillDays(); renderEdit(); });
    s.day.addEventListener('change', () => { ed.day = +s.day.value; renderEdit(); });
    s.blood.addEventListener('change', () => { ed.blood = +s.blood.value; });
    abs(el('div', 'nkm-sep', s), 370, 456, 540);
    listBtns(s, 'edit', [['ok', '확인'], ['back', '뒤로']], [[420, 480, 220, 60], [660, 480, 200, 60]]);
    s.btns.forEach((b, i) => { b.tabIndex = 0; b.addEventListener('focus', () => { if (scr === 'edit') { s.cur = null; idx.edit = i; render(); } }); });
    foot(s, '', true);
  }
  function fillDays() { const d = els.edit.day, n = DIM[ed.month - 1]; if (d.options.length !== n) { d.textContent = ''; for (let i = 1; i <= n; i++) el('option', '', d, String(i)).value = i; } d.value = ed.day; }
  function renderEdit() {
    const s = els.edit; s.month.value = ed.month; fillDays(); s.blood.value = ed.blood; if (document.activeElement !== s.name && s.name.value !== ed.name) s.name.value = ed.name;
    s.zodV.textContent = ZOD[zodiacOf(ed.month, ed.day)] + '자리';
    for (const f of [s.name, s.month, s.day, s.blood]) { f.classList.toggle('cur', s.cur === f.dataset.id); f.disabled = busy; }
  }
  function openEdit() { // 1인 → 에디트 폼(이름 칸에 커서). 표 낱말(가나 충돌 피하기)이 아직 없으면 받아 둔다
    loadKo(); idx.edit = 0; els.edit.cur = 'name'; go('edit');
    setTimeout(() => { if (active && scr === 'edit' && !busy) els.edit.name.focus(); }, 0);
  }
  function submitEdit() {
    if (busy) return; const s = els.edit, name = (s.name.value || '').trim(); ed.name = name;
    if (!new RegExp('^[가-힣]{1,' + NAME_MAX + '}$').test(name)) { toast('이름: 한글 1~' + NAME_MAX + '자'); s.name.focus(); return; }
    const avoid = new Set(); if (data) data.characters.forEach(c => avoid.add(c.name_ja)); if (koTab) for (const k of ['names', 'zodiac', 'moves']) Object.keys(koTab[k] || {}).forEach(x => avoid.add(x)); if (koTab && koTab.ui) koTab.ui.forEach(u => avoid.add(u.ja)); // 고정 캐릭터 이름·표 낱말과 같은 가나는 쓰지 않는다(korean.js 가 그쪽으로 읽는다)
    const kana = NKEditNames.put(name, avoid), opt = { tiles: [...kana].map(kanaTile), month: ed.month, day: ed.day, blood: ed.blood, name, kana, fast: true };
    if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur(); // 걷은 뒤 키가 입력 칸으로 가지 않게
    // 오프닝 장면(web/opening_scene.js): 새 게임 첫 확인이면 원작 오프닝(편지 장면)을 재생한 뒤 이어 간다(그동안 busy = 이 층 입력 막음 + 준비 중이면 진행 막대)
    const opening = f => { const O = window.NKOpening; if (!O || O.on) return f(); busy = true; root.classList.add('busy'); O.play(() => { busy = false; root.classList.remove('busy'); f(); }); };
    if (data && window.NKDriver && window.NKDriver.plans.story_team) { pt.edit = opt; if (!(pt.partner >= 0)) pt.cur = 0; return opening(() => go('partner')); } // 23 문서 1단계: 파트너 선택도 새 UI(구동은 파트너를 고른 뒤 한 번에)
    opening(() => { busy = true; root.classList.add('busy'); renderEdit(); onPick('story_edit', opt); }); // 자료가 없으면 종전대로 원작 파트너 선택(5:4)에서 인계
  }
  function pickPartner() { // 에디트 + 파트너 → story_team(5:5 첫 장 대기까지). 엔진이 이미 같은 설정으로 5:5 에 있으면 구동 없이 팀·룰로, 다른 설정이면 처음부터 다시(reboot)
    const o = Object.assign({}, pt.edit, { partner: pt.cur, fast: true }), k = JSON.stringify(o), c = els.partner.cells[pt.cur];
    c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
    if (pt.driven && pt.driven === k && pt.team) { idx.steam = pt.rule; return go('steam'); }
    if (pt.driven) o.reboot = true;
    pt.want = k; pt.partner = pt.cur; pt.run = 'story_team'; pt.driven = ''; busy = true; root.classList.add('busy'); render(); onPick('story_team', o);
  }
  function startStory() { // 대회 시작: 스테이터스 두 장 넘김 → 룰 → 대진표 9:4(game.js 가 끝나면 driveDone → 신규 대진표)
    pt.run = 'story_go'; busy = true; root.classList.add('busy'); render(); onPick('story_go', { rule: pt.rule, partner: pt.partner, fast: true });
  }
  // 구동이 끝났을 때(game.js): 이 층이 이어서 띄울 화면이 있으면 덮개를 걷지 않고 true. m = 끝 프레임의 RAM
  function driveDone(mode, m) {
    if (!root || !active || mode !== pt.run) return false; pt.run = '';
    if (mode === 'story_team') { const t = teamCards(m, pt.partner); if (!t) return false; pt.team = t; if (pt.edit && t[0].sch >= 0) pt.sch[pt.edit.kana] = t[0].sch; pt.driven = pt.want; pt.rule = 0; idx.steam = 0; busy = false; root.classList.remove('busy'); go('steam'); return true; }
    if (mode === 'story_go') { pt.driven = ''; active = false; if (bracket(m)) return true; active = true; return false; } // 대진표를 못 읽으면 원작 대진표 그대로(덮개를 걷는다)
    if (mode === 'story_lobby') { const v = m[0x68C] === 37 ? lobbyInfo(m, lb.pre) : null; if (!v) return false; lb.info = v; lb.wait = false; busy = false; root.classList.remove('busy'); render(); return true; } // 스크립트 37 = 보통 대기실 선택지. 대회 종료 대기실(110 「패스워드 보기 / 그만두기」, 4단계 범위)·자료 없음 = 덮개를 걷어 원작 화면
    if (mode === 'story_lobby_next') { active = false; if (bracket(m)) return true; active = true; return false; }
    return false;
  }
  function loadKo() { if (!koTiles && !koFetched) { koFetched = true; const K = window.NKKorean && window.NKKorean.table; (K ? K.catch(() => null) : fetch('ko_table.json').then(r => r.ok ? r.json() : null)).then(j => { if (j && j.tiles) { koTiles = j.tiles; koTab = j; if (active && scr === 'bracket') render(); } }).catch(() => { /* 표 없음 = 음역 없이 「에디트」 */ }); } }
  const editName = () => editLabel(brk.nameTiles); // 에디트 캐릭터(팀 칸 값 20) 이름: $05AD~$05B1 글자 타일 → 보관한 한글 → 가나 음역 → 「에디트」(editLabel)
  const memberName = id => id < 16 ? data.characters[id].name_ko : id === 20 ? editName() : id === 21 ? editLabel(brk.name2Tiles) : '에디트'; // 0~15 = 캐릭터 표, 20 = 1P 에디트 캐릭터 [판독 2건], 21 = 2인 협력의 2P 에디트 캐릭터(이 층이 붙이는 값, bracket() 참고). 그 밖(관측: 팀 0 의 16·17)은 표 밖이라 「에디트」로 적는다
  function setCut(c, id) { const r = id < 16 ? id >> 2 : id === 20 ? brk.sch[0] : id === 21 ? brk.sch[1] : -1, ok = r >= 0; c.classList.toggle('anon', !ok); c.im.style.display = ok ? '' : 'none'; if (ok) { c.im.src = id < 16 ? face(id) : eface(r); cvar(c, 'sch' + r); } else c.style.removeProperty('--c'); } // 20·21 = 1P·2P 에디트 캐릭터 → 유파 얼굴
  function wl(parent, t) { parent.textContent = ''; chip(parent, t.w + '승', 'hp', true); chip(parent, t.l + '패', 'hp-low', true); }
  function renderBracket() {
    const s = els.bracket, sig = JSON.stringify(brk) + !!koTiles; s.round.style.left = 32 + s.headEl.offsetWidth + 16 + 'px'; if (s.sig === sig) return; s.sig = sig;
    s.round.textContent = '♥ 제 ' + brk.round + '회전 ♥';
    const nm = t => brk.team[t].ids.map(memberName).join('&');
    s.rows.forEach((r, i) => {
      const pair = [brk.order[2 * i], brk.order[2 * i + 1]], mine = pair.includes(9); r.classList.toggle('mine', mine); r.next.style.display = mine ? '' : 'none';
      r.side.forEach((o, k) => { const t = pair[k], T = brk.team[t]; T.ids.forEach((id, j) => setCut(o.cuts[j], id)); o.nm.textContent = nm(t); wl(o.wl, T); o.p1.style.display = t === 9 ? '' : 'none'; o.p2.style.display = t === 9 && brk.coop ? '' : 'none'; });
    });
    const me = brk.team[9]; me.ids.forEach((id, j) => setCut(s.me[j], id)); s.meNm.textContent = nm(9); wl(s.meWl, me);
  }
  // 대진표(game.js 가 스토리($0645 0·1)의 9:4 입력 대기 첫 프레임에 부른다). m = 그 프레임의 RAM 사본. 띄웠으면 true
  // 근거(15 문서 16절): 대진 순서 $0621~$0628(팀 번호, 두 개씩 한 시합, 화면 위 → 아래·왼쪽 → 오른쪽 순서와 같음), 팀 t 의 두 선수 $00AF+2t·$00B0+2t, 승 $0651+t, 패 $065B+t, 팀 9 = 플레이어 팀 [확정: 코드 + 판독 4회전], 회전 = $0644 + 1 [판독]
  function bracket(m) {
    if (!root || !data || active) return false;
    const order = Array.from(m.slice(0x621, 0x629));
    if (new Set(order).size !== 8 || !order.every(t => t <= 9) || !order.includes(9)) return false; // 판독과 다른 모양이면 원작 대진표를 그대로 둔다
    brk.order = order; brk.round = m[0x644] + 1; brk.team = {}; brk.nameTiles = Array.from(m.slice(0x5AD, 0x5B2)); brk.name2Tiles = Array.from(m.slice(0x5B9, 0x5BE)); brk.sch = [editSch(m, 0), editSch(m, 1)]; brk.coop = m[0x645] === 1;
    for (const t of order) brk.team[t] = { ids: [m[0xAF + 2 * t], m[0xB0 + 2 * t]], w: m[0x651 + t], l: m[0x65B + t] };
    // 2인 협력($0645 = 1): 팀 9 의 둘째 칸($00C2)은 2P 를 가리키지 않는다(관측: 캐릭터 표 값 12 가 그대로 남음). 원작 대진표(f03_AC6A)는 팀 9 만 팀 칸을 쓰지 않고
    // 고정 주소 $05AD(슬롯 0 기록 이름)·$05B9(슬롯 1 기록 이름)를 그린다(ROM $AC99~ = AD 05 B9 05) [확정: 코드 + Node 엔진 1·2회전 화면 「あ ・か」, 15 문서 18절]. 그래서 둘째 선수를 2P 에디트(21)로 바꿔 적는다
    if (brk.coop && brk.team[9]) brk.team[9].ids[1] = 21;
    loadKo();
    { const i = order.indexOf(9) >> 1, p = [order[2 * i], order[2 * i + 1]]; warmFaces([].concat(brk.team[p[0]].ids, brk.team[p[1]].ids)); } // 내 시합 4명의 HUD 초상
    idx.bracket = 0; open('bracket'); return true;
  }

  // ── 23 문서 10절: 대기실(lobby). 원작 10:0~10:2(레벨업 안내·질문·선택지)를 한 화면으로. 왼쪽 내 팀 카드 2장(레벨 업 띠·능력치 증가분), 오른쪽 직전 시합·승패·팀 레벨 + 버튼 4개.
  //   엔진: 모드 10 첫 프레임에 game.js 가 덮고(lobby) 구동 story_lobby 로 10:2 입력 대기까지 기다린다 → driveDone 이 그 프레임 RAM 으로 채운다. 「다음 시합」 = 구동 story_lobby_next(→ 9:4 → 신규 대진표).
  //   스테이터스 = 같은 화면 위 카드 상세 패널(엔진 입력 없음, 10:2 그대로), 승패표 = 준비 중(3단계), 대회 그만두기 = 확인 1회 뒤 처음부터 다시 시작(엔진에 「시합 포기」를 넣지 않는다)
  // 2026-11-21 레이아웃: 1P 카드 | 원작 체육관 장면(엔진 실시간, lobbyBg) + 직전 시합·버튼 | 파트너 카드. 스테이터스 패널은 카드와 중복이라 없앴다(현재 룰 = 가운데 한 줄)
  //   체육관 = 원작 10:x 화면 가운데 컷 그림(원작 픽셀 x 80~175, y 64~127, 96x64). 제목 띠(4행)·LEVEL 줄·하단 메시지/선택지(25·27행)·RIKI KUNIO 무늬는 잘라 낸다
  const LG_X = 80, LG_Y = 64, LG_W = 96, LG_H = 64;
  const lg = { cv: null, ctx: null, img: null, out: null, on: false, frames: 0 };
  function lobbyBg(fb, ram) { // game.js: 덮개가 떠 있는 동안 매 엔진 프레임(표시 전용, 엔진·입력 무관). 원작 파생 = 로컬 전용(docs/title_bg_rights.md)
    if (!active || scr !== 'lobby' || !lg.cv || !fb || fb.length < 61440 || !ram || ram[0x641] !== 10) return;
    if ((fb[100 * 256 + 76] & 0xFFFFFF) !== 0xECEEEC || (fb[60 * 256 + 80] & 0xFFFFFF) !== 0xECEEEC) return; // 컷 그림 흰 테두리가 아니면(페이드·그림 전) 직전 그림 유지
    const O = lg.out; for (let y = 0; y < LG_H; y++) { const o = (LG_Y + y) * 256 + LG_X, q = y * LG_W; for (let x = 0; x < LG_W; x++) O[q + x] = fb[o + x] | 0xFF000000; }
    lg.ctx.putImageData(lg.img, 0, 0); lg.frames++;
    if (!lg.on) { lg.on = true; lg.cv.style.visibility = ''; }
  }
  function buildLobby() {
    const s = els.lobby = el('div', 'nkm-scr nkl', stageEl); s.headEl = head(s, '대기실'); s.round = chip(s, '', 'focus'); s.round.classList.add('nkb-round');
    const mv = s.mv = el('div', 'nkl-view on', s);
    s.cards = [0, 1].map(i => teamCard(mv, i, true)); s.cards[1].w.style.left = '856px';
    const gy = abs(el('div', 'nkl-gym', mv), 444, 84, 392, 264), c = lg.cv = el('canvas', '', gy); c.width = LG_W; c.height = LG_H; c.style.visibility = 'hidden'; lg.ctx = c.getContext('2d'); lg.img = lg.ctx.createImageData(LG_W, LG_H); lg.out = new Uint32Array(lg.img.data.buffer);
    const w = s.side = abs(el('div', 'nkm-win', mv), 444, 360, 392, 280);
    s.res = el('div', 'nkl-res', mv); s.wl = el('div', 'nkl-wl', mv);
    const tr = el('div', 'nkl-team', mv), lr = el('div', 'nkh-lvr', tr); s.tlT = el('b', 'nkh-lvt', lr); s.tlT.style.width = '128px'; const lv = el('div', 'nkh-lv', lr); s.tlC = []; for (let i = 0; i < 9; i++) s.tlC.push(el('i', '', lv));
    s.ruleL = el('div', 'nkl-rule', mv);
    s.btns2 = [['다음 시합', [0, 0]], ['대회 그만두기', [0, 0]]].map(([t, r], i) => { // 자리는 layLobbySide(창 안 줄 배치)
      const b = abs(el('div', 'nkm-btn', mv, t), ...r); b.dataset.id = LB_IDS[i]; b.setAttribute('role', 'menuitem');
      hoverable(b, () => { if (scr === 'lobby' && lb.view === 'main' && idx.lobby !== i) { idx.lobby = i; render(); } });
      b.addEventListener('click', () => { if (!active || busy || scr !== 'lobby' || lb.view !== 'main') return; idx.lobby = i; render(); confirm(); });
      return b;
    });
    // 대회 그만두기 확인(한 줄 + 버튼 2, 기본 커서 = 취소)
    const qv = s.qv = el('div', 'nkl-ov', s); abs(el('div', 'nkm-win', qv), 400, 240, 480, 230); el('div', 'nkl-q', qv, '정말 그만둘까요?');
    s.qb = [['quit_yes', '그만두기', [432, 380, 196, 60]], ['quit_no', '취소', [652, 380, 196, 60]]].map(([id, t, r], i) => {
      const b = abs(el('div', 'nkm-btn', qv, t), ...r); b.dataset.id = id; b.setAttribute('role', 'button');
      hoverable(b, () => { if (scr === 'lobby' && lb.view === 'quit' && lb.q !== i) { lb.q = i; render(); } });
      tapOnce(b, () => { if (!active || busy || scr !== 'lobby' || lb.view !== 'quit') return; lb.q = i; render(); confirm(); });
      return b;
    });
    s.hint = foot(s, '', false);
  }
  function renderStoryLobby() {
    const s = els.lobby, v = lb.info, wt = lb.wait || !v;
    s.round.style.left = 32 + s.headEl.offsetWidth + 16 + 'px'; s.round.style.visibility = v ? '' : 'hidden'; if (v) s.round.textContent = '다음 · 제 ' + v.next + '회전';
    s.qv.classList.toggle('on', lb.view === 'quit');
    s.hint.textContent = wt ? '준비 중…' : lb.view === 'main' ? '다음은 무엇을 할까요?' : ''; s.hint.classList.toggle('wait', wt);
    const who = i => i && v && v.coop ? ['2P', 'p2'] : null;
    {
      s.cards.forEach((c, i) => { const t = v ? Object.assign({ who: who(i) }, v.cards[i]) : null; fillCard(c, t); }); // 원작 초상은 표정 1종: 승패는 프레임·딱지로
      s.res.textContent = v && v.last ? (v.last === 'win' ? '승리!' : '패배') : ''; s.res.classList.toggle('lose', !!v && v.last === 'lose');
      s.wl.textContent = ''; if (v) { chip(s.wl, v.w + '승', 'hp', true); chip(s.wl, v.l + '패', 'hp-low', true); }
      const tr = s.tlT.parentNode.parentNode; tr.style.visibility = v ? '' : 'hidden'; if (v) { const t = Math.min(8, v.team); s.tlT.textContent = '팀 레벨 ' + (t + 1); tr.title = '팀 레벨 ' + (t + 1) + ' / 9'; s.tlC.forEach((c, i) => c.classList.toggle('on', i === t)); }
      s.side.style.visibility = ''; s.btns2.forEach((b, i) => { b.classList.toggle('cur', !wt && lb.view === 'main' && idx.lobby === i); b.style.visibility = v ? '' : 'hidden'; });
      s.qb.forEach((b, i) => b.classList.toggle('cur', lb.q === i));
      const r = v && v.rule >= 0 && v.rule < 5 ? v.rule : -1; s.ruleL.textContent = r >= 0 ? ruleLab(r) : ''; s.ruleL.title = r >= 0 ? RULES[r] : '';
      layLobbySide(s);
    }
  }
  // 직전 시합 창(444,360 392x280, 체육관 그림 아래) 안 줄 배치: 위→아래 [승리/패배(없으면 접음)] [승패] [팀 레벨] [룰(없으면 접음)] [다음 시합] [대회 그만두기].
  //   좌우 안쪽 여백 40, 위아래 16, 줄 사이 간격은 남는 높이를 똑같이 나눈다
  const LBS = { x: 444 + 40, w: 392 - 80, top: 360 + 16, h: 280 - 32 };
  function layLobbySide(s) {
    const rows = [];
    if (s.res.textContent) rows.push([s.res, 40]); s.res.style.display = s.res.textContent ? '' : 'none';
    rows.push([s.wl, 26], [s.tlT.parentNode.parentNode, 24]);
    if (s.ruleL.textContent) rows.push([s.ruleL, 24]); s.ruleL.style.display = s.ruleL.textContent ? '' : 'none';
    s.btns2.forEach(b => rows.push([b, 44]));
    const g = (LBS.h - rows.reduce((a, r) => a + r[1], 0)) / (rows.length - 1); let y = LBS.top;
    for (const [e, h] of rows) { abs(e, LBS.x, Math.round(y), LBS.w, h); y += h + g; }
  }
  // 대기실(game.js 가 스토리($0645 0·1)에서 모드 10 첫 프레임에 부른다). 덮었으면 이어서 돌릴 구동({ plan, opt })을 돌려준다: 10:2 입력 대기까지 기다린 뒤 driveDone 이 채운다
  function lobby(m) {
    if (!root || !data || active || m[0x645] > 1) return false;
    lb.view = 'main'; lb.q = 1; lb.info = null; lb.wait = true; idx.lobby = 0; pt.run = 'story_lobby'; lg.on = false; if (lg.cv) lg.cv.style.visibility = 'hidden'; // 지난 대기실 그림을 남기지 않는다
    open('lobby'); busy = true; root.classList.add('busy'); render();
    return { plan: 'story_lobby', opt: { fast: true } };
  }
  function lobbyConfirm() {
    if (lb.view === 'quit') { if (lb.q) return lobbyBack(); busy = true; root.classList.add('busy'); return onPick('quit', null); } // 처음부터 다시 시작해 신규 타이틀(R 키·결과 「나가기」와 같은 길)
    const id = LB_IDS[idx.lobby];
    if (id === 'next') { pt.run = 'story_lobby_next'; busy = true; root.classList.add('busy'); render(); return onPick('story_lobby_next', { fast: true }); }
    lb.q = 1; lb.view = 'quit'; render();
  }
  function lobbyBack() { if (lb.view !== 'main') { lb.view = 'main'; render(); } } // 대기실 자체에서는 뒤로 가지 않는다(원작과 같음)
  function lobbyMove(dx, dy) {
    if (lb.view === 'quit') { if (dx || dy) { lb.q ^= 1; render(); } return; }
    if (lb.view === 'main' && dy) { idx.lobby = (idx.lobby + dy + 2) % 2; render(); }
  }

  // ── 스토리 이어하기·슬롯(analysis/21 13·14절, 23 문서 11절). 서버 계정 세션의 슬롯 3칸: story_slots · story_begin{slot, mode, eng, rec, overwrite?} · story_seg · story_delete.
  //   이어하기 = 슬롯 카드 → story_begin{cont} 의 state 로 game.js 가 워커를 새로 만들어 바로 이어 간다(원작 패스워드 화면·메뉴 구동·빨리 감기 없음). 대진표(9:4)·대기실에 닿으면 그 신규 화면.
  //   새 게임 = 슬롯 고르기(찬 칸 = 덮어쓰기 확인, 기본 커서 취소) → story_begin{new} → game.js 가 엔진을 처음부터 다시 만들어 기록(rec_new) → 종전 새 게임 화면(인원 → 에디트 …).
  //   저장 = game.js 가 저장 지점(9:4 진입·대회 종료)마다 알리면(storyPoint) 지금까지의 패드 기록을 rec 1(런 길이 → gzip → base64)로 story_seg 전송(비동기, 게임은 그대로). saved:true = 기준을 옮기고 앞 기록 버림 + 「저장됨」,
  //   saved:false = 기준 그대로 더 길게. 실패 = 토스트 한 줄 + 재시도(save_stale 은 서버 기준으로 잘라 다시). 손님 = 이어하기는 로그인 화면(oname 로그인 탭, 로그인 뒤 슬롯으로), 새 게임은 저장 없이 종전대로. 서버 없음·DB 없음 = 이어하기 흐림 + 토스트
  //   sx.st = '' | 'probe' | 'ok'(계정) | 'guest' | 'off'(acct_off) | 'down'(연결 불가), ses = 기록 중인 슬롯 { slot, base, from, name, ow }
  const sx = { st: '', probeP: null, slots: null, srvEng: '', engP: null, mode: 'cont', q: 1, ask: false, askSlot: -1, wait: null, hello: null, ses: null, segOn: false, segTm: 0, again: false, retry: 0, back: '', saved: 0, fails: 0 };
  const SERR = { save_build: '새로 고침이 필요합니다', save_busy: '저장 처리 중입니다', save_old: '저장 데이터를 쓸 수 없습니다', save_rom: '저장 데이터를 쓸 수 없습니다', save_empty: '비어 있음', save_bad: '저장 요청 오류', acct_required: '로그인이 필요합니다', acct_off: '계정 기능이 꺼져 있습니다', down: '서버에 연결할 수 없습니다', replaced: '다른 창에서 접속했습니다', timeout: '서버 응답이 없습니다', rate: '잠시 뒤에 다시 시도하세요', state: '지금은 할 수 없습니다' }; // replaced = 다른 창이 같은 계정으로 접속(소켓 4002, OERR.replaced 와 같은 문구)
  const storyErr = e => SERR[e && e.code] || (e && e.msg) || '오류';
  const SEG_ERR = /^(save_stale|save_desync|save_fast|save_too_long|replay_timeout)$/, BEGIN_ERR = /^(save_exists|save_empty|save_old|save_rom)$/, ST_ERR = /^(save_[a-z_]+|acct_off|acct_required|state|rate|replay_timeout)$/;
  function storyNet(m) { // onNet 앞: 이 층의 스토리 응답이면 처리하고 true(그 밖은 종전 처리로)
    if (m.t === 'welcome' || (m.t === 'err' && sx.hello && /^(token_bad|rate|name_registered|login_locked)$/.test(m.code))) { const h = sx.hello; if (h) { sx.hello = null; h(m.t === 'welcome' && !!m.account); } return false; }
    if (m.t === 'story_slots' || m.t === 'story_begun' || m.t === 'story_deleted') { const w = sx.wait; if (w) { sx.wait = null; clearTimeout(w.tm); w.res(m); } return true; }
    if (m.t === 'story_saved') { segDone(m); unlockToast(m.unlocked, 1300); return true; } // 「저장됨」 뒤에 새 칭호 한 줄
    if (m.t !== 'err' || !ST_ERR.test(m.code)) return false;
    const w = sx.wait;
    if (w && !SEG_ERR.test(m.code)) { if (m.code === 'acct_off') net.acctOff = true; sx.wait = null; clearTimeout(w.tm); w.rej(m); return true; }
    if (sx.segOn && !BEGIN_ERR.test(m.code)) { if (m.code === 'acct_off') net.acctOff = true; segErr(m); return true; }
    return false;
  }
  function sreq(msg, ms) { return new Promise((res, rej) => { if (sx.wait) { clearTimeout(sx.wait.tm); sx.wait.rej({ code: 'state' }); } const w = sx.wait = { res, rej, tm: setTimeout(() => { if (sx.wait === w) { sx.wait = null; rej({ code: 'timeout' }); } }, ms || 8000) }; nsend(msg); }); }
  function ensureAcct() { // 계정 세션 준비: 붙어 있고 계정이면 true, 저장한 토큰이 있으면 hello{token}(자동 로그인), 없으면 false(손님). 연결 불가 = 거절 { code:'down' }
    if (net.acctOff) return Promise.reject({ code: 'acct_off' });
    return ensureConn().then(() => {
      if (net.account) return true;
      sx.tokFail = false; const tk = net.url && aStore.tokens[net.url]; if (!tk) return false;
      return new Promise(res => { const h = sx.hello = res; nsend({ t: 'hello', token: tk }); setTimeout(() => { if (sx.hello === h) { sx.hello = null; res(false); } }, 6000); }).then(a => { if (!a) sx.tokFail = true; return a; }); // tokFail = 저장한 토큰으로 자동 로그인 실패(만료·시간 초과, 프로필 = 손님 안내 토스트)
    }, () => Promise.reject({ code: 'down' }));
  }
  function myEng() { // 엔진 지문 eng = SHA-1(/engine/core.js + /engine/gen/code.js + /engine/apu.js), 21 문서 13.1절(서버 RS.ids().eng 와 같은 식)
    if (!sx.engP) sx.engP = Promise.all(['/engine/core.js', '/engine/gen/code.js', '/engine/apu.js'].map(u => pfetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.arrayBuffer(); })))
      .then(bs => { const n = bs.reduce((a, b) => a + b.byteLength, 0), all = new Uint8Array(n); let o = 0; for (const b of bs) { all.set(new Uint8Array(b), o); o += b.byteLength; } return crypto.subtle.digest('SHA-1', all); })
      .then(h => Array.from(new Uint8Array(h)).map(x => x.toString(16).padStart(2, '0')).join('')).catch(e => { sx.engP = null; throw e; });
    return sx.engP;
  }
  function encPads(p) { // rec 1: (값 u8, 길이 LEB128) 런 → gzip → base64(server/engine/replay_save.js encodePads 와 같은 런 바이트열. gzip 머리말 차이는 무관)
    const out = []; let i = 0;
    while (i < p.length) { const v = p[i]; let j = i + 1; while (j < p.length && p[j] === v) j++; out.push(v); let n = j - i; do { let b = n & 127; n >>>= 7; if (n) b |= 128; out.push(b); } while (n); i = j; }
    return new Response(new Blob([Uint8Array.from(out)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
      .then(b => { const u = new Uint8Array(b); let s = ''; for (let k = 0; k < u.length; k += 8192) s += String.fromCharCode.apply(null, u.subarray(k, k + 8192)); return btoa(s); });
  }
  function dimCont() { const b = els.story && els.story.btns && els.story.btns.find(x => x.dataset.id === 'cont'); if (b) b.classList.toggle('nks-off', sx.st === 'off' || sx.st === 'down'); }
  function storyForget() { sx.st = ''; sx.slots = null; sx.probeP = null; if (sx.ses) { sx.ses = null; if (onPick) onPick('rec_off', null); } clearTimeout(sx.retry); sx.retry = 0; } // 로그아웃·계정 바뀜: 앞 계정의 슬롯·확인 결과·저장 세션을 버린다(다음 스토리 진입 때 다시 확인)
  function slotsIn(m) { sx.slots = Array.isArray(m.slots) ? m.slots : null; sx.srvEng = String(m.eng || ''); }
  function storyProbe() { // 스토리 메뉴에 들어올 때 서버·DB·로그인 상태를 본다(이어하기 흐림, 슬롯 목록 미리 받기). 손님 = story_slots → acct_required
    if (sx.probeP) return sx.probeP;
    sx.st = 'probe';
    const p = sx.probeP = ensureAcct().then(() => sreq({ t: 'story_slots' }).then(m => { slotsIn(m); return 'ok'; }, e => e.code === 'acct_required' ? 'guest' : e.code === 'acct_off' ? 'off' : 'down'), e => e && e.code === 'acct_off' ? 'off' : 'down')
      .then(st => { if (sx.probeP === p) { sx.probeP = null; sx.st = st; dimCont(); } return st; });
    return p;
  }
  function storyEnter() { idx.story = 0; go('story'); storyProbe(); myEng().catch(() => { /* 이어하기 때 다시 */ }); } // 모드 선택 → 스토리 모드
  function storyPick(kind) { // 스토리 메뉴의 새 게임(new)·이어하기(cont)
    if (window.NKOpening) window.NKOpening.arm(kind === 'new'); // 오프닝 장면(web/opening_scene.js): 새 게임이면 재생 자격 + 미리 준비
    const after = st => {
      busy = false; root.classList.remove('busy'); if (!active || scr !== 'story') return;
      if (kind === 'new') { if (st === 'ok') return openSlots('new'); idx.splayers = 0; return go('splayers'); } // 손님·서버 없음 = 저장 없이 종전 새 게임
      if (st === 'ok') return openSlots('cont');
      if (st === 'guest') { sx.back = 'cont'; loadLs(); openName('login', oStore.name || ''); return toast('로그인이 필요합니다', 'hp-low'); } // go 가 토스트를 지우므로 화면을 바꾼 뒤에 띄운다
      toast(st === 'off' ? SERR.acct_off : SERR.down, 'hp-low');
    };
    if (kind === 'new' && !net.account && !Object.keys(aStore.tokens).length) return after('guest'); // 로그인한 적 없음 = 기다리지 않고 저장 없는 새 게임
    if (sx.st && sx.st !== 'probe' && !(kind === 'cont' && (sx.st === 'off' || sx.st === 'down'))) return after(sx.st);
    busy = true; root.classList.add('busy'); storyProbe().then(after); // 확인 중이거나 흐린 이어하기 = 한 번 더 확인하고 판단
  }
  function storyAfterLogin(m) { // 이어하기 → 로그인 화면에서 로그인·가입하면 로비 대신 슬롯으로
    if (!sx.back || !m.account || net.playing || !active || scr !== 'oname') return false;
    const k = sx.back; sx.back = ''; sx.st = 'ok'; if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur(); idx.story = k === 'cont' ? 1 : 0; openSlots(k); return true;
  }
  function storyBackFromName() { if (!sx.back) return false; sx.back = ''; idx.story = 1; go('story'); storyProbe(); return true; } // 로그인 화면 뒤로 = 스토리 메뉴
  function openSlots(mode) {
    sx.mode = mode; sx.ask = false; sx.q = 1; els.sslots.headEl.textContent = mode === 'new' ? '새 게임' : '이어하기';
    idx.sslots = slotCur(); go('sslots'); renderSlots(); refreshSlots();
  }
  function slotCur() { const L = sx.slots; if (!L) return 0; const i = L.findIndex(v => sx.mode === 'new' ? v.empty : !v.empty && v.usable); return i >= 0 ? i : 0; } // 처음 커서: 새 게임 = 빈 칸, 이어하기 = 쓸 수 있는 찬 칸
  function refreshSlots() {
    const first = !sx.slots;
    ensureAcct().then(a => a ? sreq({ t: 'story_slots' }) : Promise.reject({ code: 'acct_required' })).then(m => { slotsIn(m); if (active && scr === 'sslots') { if (first) idx.sslots = slotCur(); sRender(); } },
      e => { if (!active || scr !== 'sslots') return; if (e.code === 'acct_required' && sx.mode === 'cont') { sx.back = 'cont'; loadLs(); openName('login', oStore.name || ''); } toast(storyErr(e), 'hp-low'); });
  }
  const sRender = () => { render(); if (scr === 'sslots') renderSlots(); };
  const pad2 = n => String(n).padStart(2, '0'), fmtAt = ms => { const d = new Date(ms); return (d.getMonth() + 1) + '.' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  function buildSlots() { // 슬롯 카드 3장 + 뒤로 + 덮어쓰기 확인(대기실 그만두기 확인과 같은 모양)
    const s = els.sslots = el('div', 'nkm-scr nks', stageEl); s.headEl = head(s, '이어하기');
    s.cards = [0, 1, 2].map(i => {
      const b = abs(el('div', 'nkm-btn nks-card', s), 96 + 376 * i, 108, 336, 400); b.dataset.id = 'slot' + (i + 1); b.setAttribute('role', 'menuitem');
      chip(b, '슬롯 ' + (i + 1), 'focus'); b.nm = el('div', 'nks-nm', b); b.l1 = el('div', 'nks-l', b); b.l2 = el('div', 'nks-l', b); b.l3 = el('div', 'nks-s', b); b.dt = el('div', 'nks-dt', b);
      hoverable(b, () => { if (scr === 'sslots' && !sx.ask && idx.sslots !== i) { idx.sslots = i; sRender(); } });
      b.addEventListener('click', () => { if (!active || busy || scr !== 'sslots' || sx.ask) return; idx.sslots = i; sRender(); slotsConfirm(); });
      return b;
    });
    const bk = abs(el('div', 'nkm-btn', s, '뒤로'), 476, 540, 328, 56); bk.dataset.id = 'back'; bk.setAttribute('role', 'button');
    hoverable(bk, () => { if (scr === 'sslots' && !sx.ask && idx.sslots !== 3) { idx.sslots = 3; sRender(); } });
    bk.addEventListener('click', () => { if (!active || busy || scr !== 'sslots' || sx.ask) return; slotsBack(); });
    s.btns = s.cards.concat([bk]);
    const qv = s.qv = el('div', 'nkl-ov', s); abs(el('div', 'nkm-win', qv), 400, 240, 480, 230); el('div', 'nkl-q', qv, '덮어쓸까요?');
    s.qb = [['ow_yes', '덮어쓰기', [432, 380, 196, 60]], ['ow_no', '취소', [652, 380, 196, 60]]].map(([id, t, r], i) => {
      const b = abs(el('div', 'nkm-btn', qv, t), ...r); b.dataset.id = id; b.setAttribute('role', 'button');
      hoverable(b, () => { if (scr === 'sslots' && sx.ask && sx.q !== i) { sx.q = i; renderSlots(); } });
      tapOnce(b, () => { if (!active || busy || scr !== 'sslots' || !sx.ask) return; sx.q = i; renderSlots(); slotsConfirm(); });
      return b;
    });
    s.hint = foot(s, '', true);
  }
  function renderSlots() {
    const s = els.sslots, L = sx.slots, wait = busy || !L;
    s.cards.forEach((b, i) => {
      const v = L && L[i], full = !!v && !v.empty, bad = full && !v.usable;
      b.classList.toggle('nks-empty', !!v && v.empty); b.classList.toggle('nks-bad', bad);
      b.nm.textContent = !v ? '…' : !full ? '비어 있음' : v.name || editLabel(Array.isArray(v.nameKana) ? v.nameKana : []);
      b.l1.textContent = !full ? '' : bad ? '쓸 수 없음' : v.done ? '대회 종료' : '제 ' + ((v.match | 0) + 1) + '회전';
      b.l2.textContent = !full || bad ? '' : (v.wins | 0) + '승 ' + (v.losses | 0) + '패';
      b.l3.textContent = !full || bad ? '' : [ruleName(v.rule | 0), 'Lv ' + ((v.level | 0) + 1), v.players === 2 ? '2인' : ''].filter(Boolean).join(' · ');
      b.dt.textContent = full && v.updatedAt ? fmtAt(v.updatedAt) : '';
    });
    s.qv.classList.toggle('on', sx.ask); s.qb.forEach((b, i) => b.classList.toggle('cur', sx.q === i));
    s.hint.textContent = wait ? '불러오는 중…' : ''; s.hint.classList.toggle('wait', wait);
  }
  function slotsMove(dx, dy) {
    if (sx.ask) { if (dx || dy) { sx.q ^= 1; renderSlots(); } return; }
    let i = idx.sslots; if (dy > 0 && i < 3) { sx.lastCard = i; i = 3; } else if (dy < 0 && i === 3) i = sx.lastCard | 0; else if (dx && i < 3) i = (i + dx + 3) % 3; else if (dy && i < 3) i = 3;
    idx.sslots = i; sRender();
  }
  function slotsBack() { if (sx.ask) { sx.ask = false; return renderSlots(); } idx.story = sx.mode === 'cont' ? 1 : 0; go('story'); }
  function slotsConfirm() {
    if (sx.ask) { const i = sx.askSlot; sx.ask = false; renderSlots(); if (sx.q === 0) storyBegin({ slot: i, mode: 'new', overwrite: true }); return; }
    const i = idx.sslots; if (i === 3) return slotsBack();
    const v = sx.slots && sx.slots[i]; if (!v) return;
    if (sx.mode === 'cont') { if (v.empty) return toast('비어 있음'); if (!v.usable) return toast(SERR.save_old, 'hp-low'); return storyBegin({ slot: i, mode: 'cont' }); }
    if (!v.empty) { sx.ask = true; sx.q = 1; sx.askSlot = i; return renderSlots(); } // 찬 칸 = 덮어쓰기 확인(기본 커서 취소)
    storyBegin({ slot: i, mode: 'new' });
  }
  function storyBegin(o) {
    busy = true; root.classList.add('busy'); renderSlots(); sx.t0 = performance.now();
    myEng().then(eng => {
      if (sx.srvEng && eng !== sx.srvEng) throw { code: 'save_build' }; // 엔진 지문 불일치(서버 갱신 뒤 이 탭이 옛 파일) = 새로 고침 안내
      return ensureAcct().then(a => { if (!a) throw { code: 'acct_required' }; return sreq(Object.assign({ t: 'story_begin', eng, rec: 1 }, o), 15000); });
    }, () => { throw { code: 'down' }; }).then(m => begun(m, o), e => {
      busy = false; root.classList.remove('busy');
      if (e && e.code === 'save_exists') { sx.ask = true; sx.q = 1; sx.askSlot = o.slot; } else toast(storyErr(e), 'hp-low');
      if (active && scr === 'sslots') { sRender(); if (e && /^(save_empty|save_old|save_rom|save_exists)$/.test(e.code)) refreshSlots(); }
    });
  }
  function restoreName(tiles, ko) { // 슬롯의 한글 이름을 이 브라우저의 이름 표(NKEditNames)에 되살린다(다른 기기에서도 같은 이름)
    if (!ko || !Array.isArray(tiles)) return; let k = '';
    for (const t of tiles) { if (!t) continue; const c = tileKana(t); if (c === null) return; k += c; }
    if (!k) return; names[k] = { ko: String(ko), t: Date.now() }; try { localStorage.setItem(NAMES_KEY, JSON.stringify(names)); } catch (e) { /* 이번 세션만 */ }
  }
  function begun(m, o) {
    if (!active || scr !== 'sslots') { busy = false; root.classList.remove('busy'); return; }
    clearTimeout(sx.retry); sx.retry = 0; sx.again = false;
    if (m.mode === 'new') {
      const ok = onPick('rec_new', { from: m.from }) === true;
      sx.ses = ok ? { slot: m.slot, base: m.base, from: m.from, name: '', ow: !!o.overwrite } : null; sx.saved = 0; sx.fails = 0;
      busy = false; root.classList.remove('busy'); if (!ok) toast('저장 없이 진행합니다', 'hp-low');
      idx.splayers = 0; return go('splayers');
    }
    restoreName(m.nameKana, m.name);
    sx.ses = { slot: m.slot, base: m.base, from: m.from, name: String(m.name || ''), ow: false }; sx.saved = 0; sx.fails = 0;
    if (onPick('story_load', { state: m.state }) !== true) { sx.ses = null; busy = false; root.classList.remove('busy'); sRender(); return toast('불러올 수 없습니다', 'hp-low'); }
    renderSlots(); // 덮개(이 화면, 불러오는 중) 그대로. game.js 가 대진표·대기실에 닿으면 hide → bracket/lobby
  }
  function storyPoint() { if (!sx.ses) return; if (sx.segOn) { sx.again = true; return; } segSend(); } // game.js: 저장 지점이 지났다
  function segSend() {
    const S = sx.ses; clearTimeout(sx.retry); sx.retry = 0; if (!S || sx.segOn) return;
    const g = onPick('rec_seg', null);
    if (!g) { const G = window.__game && window.__game.rec; if (G && G.bad) { sx.ses = null; onPick('rec_off', null); toast('저장 기록 오류 — 이번 진행은 저장되지 않습니다', 'hp-low', 3000); } return; }
    if (g.from !== S.from) { if (onPick('rec_trim', { from: S.from }) === true) return segSend(); sx.ses = null; onPick('rec_off', null); return toast('저장 실패', 'hp-low', 3000); } // 기록 기준을 서버 기준에 맞춘다
    sx.segOn = true;
    Promise.all([encPads(g.pads), g.pads2 ? encPads(g.pads2) : null, myEng()]).then(([pads, pads2, eng]) => ensureAcct().then(a => {
      if (!a) throw { code: 'acct_required' }; if (sx.ses !== S || !sx.segOn) throw { code: 'gone' };
      const nm = S.name || (pt.edit && pt.edit.name) || '';
      nsend(Object.assign({ t: 'story_seg', slot: S.slot, base: S.base, from: g.from, pads, end: g.end, eng, rec: 1 }, pads2 ? { pads2 } : null, nm ? { name: nm } : null));
      clearTimeout(sx.segTm); sx.segTm = setTimeout(() => { if (sx.segOn) segErr({ code: 'timeout' }); }, 240000); // 재현 상한(서버 180초) + 여유
    })).catch(e => { if (sx.segOn) segErr(e && e.code ? e : { code: 'down' }); });
  }
  function segDone(m) {
    clearTimeout(sx.segTm); sx.segOn = false; const S = sx.ses;
    if (S && m.slot === S.slot && m.saved) { S.base = String(m.base); S.from = m.from | 0; onPick('rec_trim', { from: S.from }); sx.saved++; sx.fails = 0; toast('저장됨', 'hp', 1200); } // 앞 기록은 버리고 이 지점부터 다음 구간
    if (sx.again && sx.ses) { sx.again = false; segSend(); }
  }
  function segErr(e) {
    clearTimeout(sx.segTm); sx.segOn = false; const S = sx.ses, c = e && e.code; if (!S || c === 'gone') return;
    if (c === 'save_stale' && typeof e.base === 'string' && Number.isInteger(e.from)) { S.base = e.base; S.from = e.from; if (onPick('rec_trim', { from: e.from }) === true) return segSend(); } // 응답을 잃었다: 서버는 이미 그 지점으로 옮겼다
    if (c === 'save_stale') return relock(S);
    if (/^(save_build|save_desync|save_too_long|save_bad|acct_required|acct_off|save_old|save_rom|save_stale)$/.test(c)) { sx.ses = null; onPick('rec_off', null); return toast(c === 'save_build' ? '저장 실패 — 새로 고침이 필요합니다' : c === 'acct_required' ? '저장 실패 — 로그인이 필요합니다' : '저장 실패', 'hp-low', 3000); }
    if (++sx.fails > 5) { sx.ses = null; onPick('rec_off', null); return toast(c === 'save_fast' ? '저장 실패 — 진행이 너무 빠릅니다' : '저장 실패', 'hp-low', 3000); } // 계속 실패하면 이번 진행 저장 중단
    toast('저장 실패 — 다시 시도 중', 'hp-low', 2400);
    sx.retry = setTimeout(segSend, c === 'rate' ? 20000 : c === 'save_fast' ? 30000 : 5000);
  }
  function relock(S) { // 서버 잠금이 없다(서버 재시작 등): 같은 슬롯을 다시 잡고 서버 기준이 내 기준과 같으면 이어서 보낸다
    myEng().then(eng => ensureAcct().then(a => { if (!a) throw { code: 'acct_required' }; return sreq(Object.assign({ t: 'story_begin', eng, rec: 1 }, S.base === 'boot' ? { slot: S.slot, mode: 'new', overwrite: S.ow } : { slot: S.slot, mode: 'cont' }), 15000); }))
      .then(m => { if (sx.ses !== S) return; if (m.base === S.base && m.from === S.from) return segSend(); sx.ses = null; onPick('rec_off', null); toast('다른 기기에서 진행 중', 'hp-low', 3000); },
        e => { if (sx.ses !== S) return; sx.ses = null; onPick('rec_off', null); toast('저장 실패 — ' + storyErr(e), 'hp-low', 3000); });
  }
  const storyState = () => ({ st: sx.st, mode: sx.mode, ask: sx.ask, q: sx.q, segOn: sx.segOn, saved: sx.saved, srvEng: sx.srvEng, back: sx.back, slots: sx.slots ? sx.slots.map(v => v.empty ? null : { match: v.match, wins: v.wins, losses: v.losses, name: v.name, usable: v.usable, engMatch: v.engMatch, kind: v.kind }) : null, ses: sx.ses ? Object.assign({}, sx.ses) : null, contOff: !!(els.story && els.story.btns.some(b => b.dataset.id === 'cont' && b.classList.contains('nks-off'))) });

  function roomTtl() { // 래더 방: 시작 제한(ladder_matched.startBy, 서버 시각) 남은 시간 한 줄(하단 띠, 설정 줄 아래). 그 밖 방 = 숨김
    const s = els.oroom, R = net.room, lm = net.lm, on = !!(s && s.ttl && R && lm && lm.code === R.code && Number.isFinite(lm.startBy) && !net.playing); if (!s || !s.ttl) return;
    s.ttl.style.display = on ? '' : 'none'; if (!on) return;
    const w = Math.max(0, Math.ceil((lm.startBy - sNow()) / 1000)); s.ttl.textContent = '시작 제한 ' + Math.floor(w / 60) + ':' + String(w % 60).padStart(2, '0');
  }
  function place() { // 창에 맞춘 16:9 비례 확대(가운데). 벽지는 창 전체에 같은 배율로 잇는다
    if (!root || !active) return; const w = window.innerWidth, h = window.innerHeight, port = h > w * 1.1, f = port && FOCUS[scr] || [0, LW]; // 세로 화면: 가운데 창만 있는 화면은 그 창 너비에 맞춰 키운다(탭 영역 확보). 나머지는 너비에 맞춘 축소 + 가로 안내
    const pl = port && (scr === 'oroom' || scr === 'oprof' || scr === 'result'); root.classList.toggle('port', port); root.classList.toggle('pl', pl); menuLayout(!port); // pl = 세로 대기방·프로필(논리 600x1300 전용 배치, roomLayout·profLayout)
    root.classList.toggle('pset', port && scr === 'settings'); if (scr === 'settings' && els.settings) setLayout(els.settings, port); // pset = 세로 설정(전용 줄 배치라 가로 안내 숨김). result = 세로 전용 배치(오른쪽 두 창을 아래로, CSS .nkm-resS), settings = 세로 줄 높이(setLayout)
    if (scr === 'oroom' && els.oroom && els.oroom.pl !== pl) { roomLayout(els.oroom, pl); if (net.room) { renderRoom(els.oroom); els.oroom.list.forEach(it => it.el.classList.toggle('off', oOff(it))); } } // 화면 돌림: 배치·켜짐 다시(세로 전용 버튼)
    if (scr === 'oprof' && els.oprof && els.oprof.pl !== pl) profLayout(els.oprof, pl);
    const k = pl ? Math.min(w / 600, h / 1300) : Math.min(w / f[1], h / LH), x = pl ? (w - 600 * k) / 2 : (w - f[1] * k) / 2 - f[0] * k, y = (h - (pl ? 1300 : LH) * k) / 2;
    stageEl.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + k + ')'; stageEl.style.setProperty('--tk', k); // --tk = 배율(작은 화면에서 방 목록 줄·초대 버튼 누름 칸 ≥ 44px, ui_manga.css)
    wall.style.backgroundSize = 186 * k + 'px ' + 78 * k + 'px'; wall.style.backgroundPosition = x + 'px ' + y + 'px';
    placeTbg(k, x, y);
    if (crEl) crEl.style.fontSize = Math.max(13, 10.5 / k) + 'px'; // 실제 글자 10px 이상(작은 창에서도)
  }
  const curRole = () => roles(sel.players)[Math.min(sel.picks.length, 3)];
  // 타이틀·모드·스토리·인원 메뉴끼리 넘어갈 때는 로고·초상·창·하단 띠가 같은 자리 같은 그림이므로 화면 전체 페이드(nkm-in)를 다시 틀지 않고 머리·버튼만 바꾼다(nkm-keep, ui_manga.css). 층이 걷혔다 다시 뜨면(hide → shown = null) 종전처럼 페이드
  const menuFam = k => !!MENUS[k] && !MENUS[k].ov;
  let shown = null;
  function render() {
    if (scr !== shown) { if (els[scr]) els[scr].classList.toggle('nkm-keep', menuFam(scr) && menuFam(shown)); shown = scr; }
    for (const k of Object.keys(els)) if (k !== 'toast' && k !== 'rot') els[k].classList.toggle('on', k === scr);
    if (els[scr] && els[scr].btns) els[scr].btns.forEach((b, i) => b.classList.toggle('cur', i === idx[scr]));
    if (scr === 'charsel' || scr === 'partner') renderChar(scr); else if (scr === 'steam') renderTeam(); else if (scr === 'stage') renderStage(); else if (scr === 'status') renderStatus(); else if (scr === 'result') renderResult(); else if (scr === 'settings') renderSettings(); else if (scr === 'bracket') renderBracket(); else if (scr === 'lobby') renderStoryLobby(); else if (scr === 'edit') renderEdit(); else if (OSCR.has(scr)) renderOnline();
    place();
  }
  function renderChar(k) {
    const P = k === 'partner', s = els[k], rs = roles(sel.players), role = P ? ['파트너', 'focus'] : curRole(), id = curOf(k), ch = data.characters[id], r = id >> 2;
    if (!P) { s.turn.textContent = role[0]; cvar(s.turn, role[1]); s.turn.style.left = 32 + s.headEl.offsetWidth + 16 + 'px'; }
    s.cells.forEach((e, i) => {
      const k = P ? -1 : sel.picks.indexOf(i), t = k >= 0; e.classList.toggle('taken', t); e.nm.textContent = data.characters[i].name_ko;
      if (t) { e.tag.textContent = rs[k][1] === 'com' ? 'COM' : rs[k][0]; cvar(e.tag, rs[k][1]); e.style.setProperty('--pc', 'var(--' + rs[k][1] + ')'); }
    });
    abs(s.brk, 164 + 120 * (id & 3) - 7, 100 + 131 * r - 7); s.brk.style.setProperty('--g', 'var(--' + role[1] + ')');
    cvar(s.cut, 'sch' + r); s.cutImg.src = face(id);
    s.c1.textContent = role[0]; cvar(s.c1, role[1]); s.c2.textContent = SCHOOLS[r]; cvar(s.c2, 'sch' + r);
    s.name.textContent = ch.name_ko; cvar(s.name, 'sch' + r);
    s.info[0].textContent = ch.birthday.month + '월 ' + ch.birthday.day + '일'; s.info[1].textContent = ch.blood_type + '형'; s.info[2].textContent = ch.zodiac.ko + '자리'; s.info[2].classList.toggle('sm', ch.zodiac.ko.length > 2); // 5자(쌍둥이자리 등)는 칸에 맞게 작은 글꼴
    fillStats(s.stats, ch);
    s.sp.forEach((c, i) => { const m = ch.specials[i]; c.classList.toggle('none', !m); c.nm.textContent = m ? m.ko : '—'; cvar(c, 'sch' + r); }); // 기술 입력 뱃지는 전투 HUD 에서만(2026-11-21 사용자 지시)
    if (P) { const t = s.team, es = pt.edit && pt.sch[pt.edit.kana] >= 0 ? pt.sch[pt.edit.kana] : -1; t.me.style.display = es >= 0 ? '' : 'none'; if (es >= 0) { t.me.im.src = eface(es); cvar(t.me, 'sch' + es); } t.meNm.textContent = pt.edit ? pt.edit.name : '에디트'; cvar(t.pa, 'sch' + r); t.pa.im.src = face(id); t.paNm.textContent = ch.name_ko; const w = busy && pt.run === 'story_team'; s.hint.textContent = w ? '준비 중…' : '파트너를 골라 주세요'; s.hint.classList.toggle('wait', w); return; } // 구동(약 4초, reboot 약 6.6초) 동안 대기 표시. 끝나면 팀·룰로 넘어가고, 돌아오면 안내로
    s.hint.textContent = role[1] === 'com' ? '상대를 골라 주세요' : '누구로 싸울까?'; s.auto.style.display = sel.players === 1 && role[1] === 'com' ? '' : 'none';
  }
  function renderStage() {
    const s = els.stage, i = sel.stageCur, z = sel.zone === 'stage';
    s.cards.forEach((e, k) => e.classList.toggle('sel', !z && k === sel.stage));
    s.brk.style.display = z ? '' : 'none'; abs(s.brk, 56 + 192 * (i & 3) - 7, 124 + 152 * (i >> 2) - 7);
    const p = z ? i : sel.stage; s.prev.style.backgroundImage = p < 7 ? 'url(/ui/stage_' + STAGE_ID[p] + '.png)' : 'none'; s.prevT.textContent = p < 7 ? 'STAGE ' + (p + 1) : '나가기';
    s.rules.forEach((e, k) => { e.classList.toggle('cur', !z && k === sel.rule); e.classList.toggle('sel', z && k === sel.rule); });
    s.hint.textContent = z ? '어느 스테이지에서 싸울까?' : '어느 룰로 싸울까?';
    const a = s.ask, q = stgAsk; a.classList.toggle('on', q >= 0 && q < 7); if (q >= 0 && q < 7) { a.thumb.style.backgroundImage = 'url(/ui/stage_' + STAGE_ID[q] + '.png)'; a.nm.textContent = 'STAGE ' + (q + 1); }
    s.askB.forEach((b, k) => b.classList.toggle('cur', stgAskCur === k));
  }
  function toast(text, color, ms) {
    if (!root) return;
    if (!active && btoast) { btoast.textContent = text; btoast.style.setProperty('--c', 'var(--' + (color || 'te') + ')'); btoast.classList.add('on'); clearTimeout(btTm); btTm = setTimeout(() => btoast.classList.remove('on'), ms || 2400); return; } // 층이 걷힌 동안(온라인 전투) = 화면 위 작은 토스트
    els.toast.textContent = text; els.toast.style.setProperty('--c', 'var(--' + (color || 'te') + ')'); els.toast.classList.add('on');
    clearTimeout(toastTm); toastTm = setTimeout(() => els.toast.classList.remove('on'), ms || 1600);
  }
  function go(k) { if (k === 'partner') pt.tap = -1; stgAsk = -1; scr = k; els.toast.classList.remove('on'); render(); }
  function move(dx, dy) {
    if (OSCR.has(scr)) return omove(dx, dy);
    if (scr === 'sslots') return slotsMove(dx, dy);
    if (scr === 'lobby') return lobbyMove(dx, dy);
    if (els[scr] && els[scr].btns) { const n = els[scr].btns.length, v = dy || (menuFam(scr) ? dx : 0); if (v) { idx[scr] = (idx[scr] + v + n) % n; render(); } return; } // 메인 메뉴(가로 한 줄)는 ←→ 도
    if (scr === 'settings') { if (dy) { setIdx = (setIdx + dy + SET_BACK + 1) % (SET_BACK + 1); render(); } else if (dx) adjust(dx); return; }
    if (scr === 'charsel' || scr === 'partner') { pt.tap = -1; const v = curOf(scr), r = ((v >> 2) + dy + 4) & 3, c = ((v & 3) + dx + 4) & 3; setCur(scr, r * 4 + c); render(); return; }
    if (scr === 'steam') { if (dy) { idx.steam = (idx.steam + dy + 7) % 7; render(); } return; }
    if (scr !== 'stage') return;
    if (stgAsk >= 0) { if (dx || dy) { stgAskCur ^= 1; render(); } return; } // 맵 확인 창: ←→↑↓ = 예/아니오
    if (sel.zone === 'stage') { const r = ((sel.stageCur >> 2) + dy + 2) & 1, c = ((sel.stageCur & 3) + dx + 4) & 3; sel.stageCur = r * 4 + c; }
    else if (dy) sel.rule = Math.max(1, Math.min(4, sel.rule + dy)); // 원작과 같이 룰1 로는 못 가고 끝에서 돌지 않는다
    render();
  }
  function back() {
    if (OSCR.has(scr)) return oback();
    if (scr === 'sslots') return slotsBack();
    if (scr === 'lobby') return lobbyBack();
    if (scr === 'pause') { hide(); onPick('resume', null); return; }
    if (scr === 'settings') return go(setBack);
    if (scr === 'status') { sel.zone = 'rule'; return go('stage'); }
    if (scr === 'edit') { if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur(); if (pt.driven) { pt.driven = ''; pt.team = null; onPick('reboot', null); } return go('splayers'); } // 엔진이 이미 5:5 에 가 있으면(팀·룰에서 되돌아옴) 덮개 아래에서 처음부터 다시 시작해 원작 모드 선택에 세워 둔다
    if (scr === 'partner') { openEdit(); return; }
    if (scr === 'steam') { pt.cur = pt.partner; return go('partner'); } // 엔진은 5:5 첫 장에서 기다린다. 같은 파트너를 다시 고르면 그대로 돌아오고, 다른 파트너면 처음부터 다시 구동
    if (scr === 'result' || scr === 'bracket') return; // 원작은 결과·대진표에서 되돌아가지 않는다
    if (MENUS[scr]) { if (MENUS[scr].back) go(MENUS[scr].back); return; }
    if (scr === 'charsel') { if (sel.picks.length) { sel.cur = sel.picks.pop(); render(); } else go('players'); return; }
    if (scr === 'stage' && stgAsk >= 0) return askStage(false); // 맵 확인 창: B·Esc = 아니오
    if (scr === 'stage') { if (sel.zone === 'rule') { sel.zone = 'stage'; sel.stage = null; render(); } else if (sel.again) { sel.stage = sel.last; sel.rule = sel.lastRule; go('result'); } /* 결과로 돌아가면 스테이지·룰을 결과 때 값으로 되돌린다(룰 커서·hover 로 바뀐 값으로 「한 판 더」가 구동되지 않게) */ else { sel.cur = sel.picks.pop(); go('charsel'); } } // 다시 하기에서는 캐릭터를 바꿀 수 없다(원작은 스테이지 선택으로만 돌아온다)
  }
  function confirm() {
    if (OSCR.has(scr)) return oconfirm();
    if (scr === 'sslots') return slotsConfirm();
    if (scr === 'lobby') return lobbyConfirm();
    if (MENUS[scr]) {
      const it = MENUS[scr].items[idx[scr]];
      if (it.online) enterOnline(); else if (it.prof) openProfile(null); else if (it.story) storyPick(it.story); else if (it.go === 'story') storyEnter(); else if (it.go === 'settings') { setBack = scr; setIdx = 0; go('settings'); } else if (it.go === 'edit') openEdit(); else if (it.go) { idx[it.go] = 0; go(it.go); } else if (it.toast) toast(it.toast); else if (it.back) back();
      else if (it.pick === 'quit') { hide(); onPick('quit', null); } // 일시정지 → 종료: game.js 가 처음부터 다시 시작해 신규 타이틀을 연다
      else if (it.pick) { busy = true; root.classList.add('busy'); onPick(it.pick, null); } // 스토리: 종전대로 원작 인원 선택(5:1:3)까지만 구동하고 원작 화면에 맡긴다
      else if (it.players) {
        if (it.players === 1 && window.NKTutorial && window.NKTutorial.auto() && tutGo()) return; // 첫 「배틀 → 1인」 = 튜토리얼 판(web/tutorial.js, 확인 없이 한 번)
        sel.players = it.players; sel.picks = []; sel.cur = 0; sel.stageCur = 0; sel.stage = null; sel.zone = 'stage'; sel.rule = 1;
        const ok = () => data && window.NKDriver && window.NKDriver.plans.battle_full, k0 = scr;
        const fallback = () => { if (dataErr) console.warn('신규 캐릭터 화면 자료 없음(원작 캐릭터 선택으로 넘깁니다): ' + dataErr); busy = true; root.classList.add('busy'); onPick('battle', { players: it.players, edit: false }); }; // 폴백
        if (ok()) go('charsel');
        else if (dataErr) { busy = true; loadData().then(() => { if (!active || scr !== k0) return; busy = false; if (ok()) go('charsel'); else fallback(); }); } // 처음 받기에 실패했으면(서버 일시 오류 등) 한 번 더 받아 보고 그래도 없을 때만 원작 화면으로
        else fallback();
      }
      return;
    }
    if (scr === 'charsel') {
      if (sel.picks.includes(sel.cur)) return toast('이미 고른 캐릭터');
      const c = els.charsel.cells[sel.cur]; c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
      sel.picks.push(sel.cur);
      if (sel.picks.length === 4) return go('stage');
      let n = -1; // 커서는 같은 줄의 다음 빈칸으로(없으면 그다음 빈칸)
      for (let k = 1; k < 4 && n < 0; k++) { const c = (sel.cur & 12) | ((sel.cur + k) & 3); if (!sel.picks.includes(c)) n = c; }
      for (let k = 1; k < 16 && n < 0; k++) { const c = (sel.cur + k) & 15; if (!sel.picks.includes(c)) n = c; }
      sel.cur = n;
      return render();
    }
    if (scr === 'settings') { if (setIdx === SET_BACK) back(); else if (setIdx > 0) adjust(1); return; }
    if (scr === 'partner') return pickPartner();
    if (scr === 'steam') { const i = idx.steam; if (i < 5) { pt.rule = i; idx.steam = 5; return render(); } return i === 5 ? startStory() : back(); }
    if (scr === 'edit') { if (idx.edit === 1) back(); else submitEdit(); return; }
    if (scr === 'status') { if (idx.status === 0) start(); else back(); return; }
    if (scr === 'bracket') { busy = true; root.classList.add('busy'); return onPick('story_next', { fast: true }); } // 시합 시작: 원작 대진표를 A 로 넘겨 전투 입장(1:4)까지 빨리 감기 → game.js 가 층을 걷는다
    if (scr === 'result') {
      const id = els.result.btns[idx.result].dataset.id;
      if (id === 'again') { if (sel.stage < 0 || !(sel.rule >= 1 && sel.rule <= 4)) return toast('스테이지·룰을 다시 골라 주세요'); return start(); } // 같은 스테이지·룰로 바로
      if (id === 'card') return saveCard();
      if (id === 'stage') { sel.last = sel.stage; sel.lastRule = sel.rule; sel.zone = 'stage'; sel.stageCur = Math.max(0, sel.stage); sel.stage = null; if (!(sel.rule >= 1 && sel.rule <= 4)) sel.rule = 1; return go('stage'); }
      busy = true; root.classList.add('busy'); return onPick('quit', null); // 나가기: 엔진이 원작 스테이지 선택에 있으므로 처음부터 다시 시작해 신규 타이틀로
    }
    if (scr !== 'stage') return;
    if (stgAsk >= 0) return askStage(stgAskCur === 0); // 맵 확인 창: A = 커서 쪽(예/아니오)
    if (sel.zone === 'stage') {
      if (sel.stageCur === 7) { if (sel.again) { busy = true; root.classList.add('busy'); return onPick('quit', null); } return show('title'); } // 나가기 = 신규 타이틀로(첫 판 전에는 엔진이 덮개 아래 원작 모드 선택에서 그대로 기다린다)
      stgAsk = sel.stageCur; stgAskCur = 0; return render(); // 키보드·게임패드 결정도 마우스와 같이 확인 창(예 = 대결 확인)
    }
    idx.status = 0; go('status');
  }
  function tutGo() { // 튜토리얼 판(analysis/28 3.2절 권고 조합: 쿠니오 vs 이시즈키·야마이시·진나이, 스테이지 1·룰 5) = 고른 것과 같은 start() 경로. 자료·구동 계획이 없으면 false
    const T = window.NKTutorial; if (!T || !data || !window.NKDriver || !window.NKDriver.plans.battle_full || busy) return false;
    sel.players = 1; sel.picks = T.PICKS.slice(); sel.cur = 0; sel.stageCur = T.OPT.stage; sel.stage = T.OPT.stage; sel.rule = T.OPT.rule; sel.zone = 'rule'; sel.again = false; T.arm(); start(); return true;
  }
  function start() { // 모은 선택을 한 번에 넘긴다 → game.js 가 구동기(battle_full, 다시 하기는 battle_again)를 빨리 감기로 돌리고 전투 입장(1:4)에서 hide() 를 부른다
    const cell = id => ({ row: id >> 2, col: id & 3 }), p = sel.picks.map(cell), two = sel.players === 2, rs = roles(sel.players), s = els.vs;
    const opt = { players: sel.players, edit: false, p1: p[0], enemies: p.slice(two ? 2 : 1), stage: sel.stage, rule: sel.rule, fast: true }; if (two) opt.p2 = p[1];
    s.strip.textContent = 'STAGE ' + (sel.stage + 1) + ' · ' + ruleLab(sel.rule);
    s.cuts.forEach((c, i) => { const id = sel.picks[i]; cvar(c, 'sch' + (id >> 2)); c.im.src = face(id); c.tag.textContent = ''; chip(c.tag, rs[i][1] === 'com' ? 'COM' : rs[i][0], rs[i][1]); c.tag.appendChild(document.createTextNode(data.characters[id].name_ko)); });
    sel.ran = { stage: sel.stage, rule: sel.rule }; busy = true; root.classList.add('busy'); warmFaces(sel.picks); go('vs');
    if (sel.again) onPick('battle_again', { stage: sel.stage, rule: sel.rule, fast: true }); else onPick('battle_full', opt);
  }
  // 메뉴 키 = 키 표(web/keymap.js nav: 방향키·Enter·Esc + 1P·2P 방향·A 결정·B 뒤로, 표에 없는 Z·X 는 종전대로). keymap.js 가 없으면 종전 고정 키
  const menuKey = c => window.NKKeymap ? window.NKKeymap.nav(c) : { dy: c === 'ArrowUp' || c === 'KeyW' ? -1 : c === 'ArrowDown' || c === 'KeyS' ? 1 : 0, dx: c === 'ArrowLeft' || c === 'KeyA' ? -1 : c === 'ArrowRight' || c === 'KeyD' ? 1 : 0, ok: c === 'KeyZ' || c === 'Enter' || c === 'NumpadEnter' || c === 'KeyG', bk: c === 'KeyX' || c === 'Escape' || c === 'KeyH' };
  function onKey(e) {
    if (!active || e === skipKey) return;
    if (OSCR.has(scr)) return okey(e);
    if (scr === 'edit') { // 에디트 폼: 글자·Tab·방향키(고르기 값)는 브라우저 기본 동작. Enter = 확인(뒤로 버튼에 초점이면 뒤로), Esc = 뒤로. 한글 조합 중(isComposing)은 건드리지 않는다
      if (e.isComposing || e.keyCode === 229) return;
      const c = e.code; if (c !== 'Enter' && c !== 'NumpadEnter' && c !== 'Escape') return;
      e.preventDefault(); if (busy || e.repeat) return;
      if (c === 'Escape') return back();
      const f = document.activeElement; if (f && f.dataset && f.dataset.id === 'back') return back(); return submitEdit();
    }
    if (e.code === 'KeyC' && scr === 'charsel' && !busy && !e.repeat) { e.preventDefault(); return autoPick(); }
    const c = e.code, mk = menuKey(c), dy = mk.dy, dx = mk.dx;
    const ok = mk.ok, bk = mk.bk;
    if (!dx && !dy && !ok && !bk) return;
    e.preventDefault(); if (busy) return;
    if (dx || dy) move(dx, dy); else if (!e.repeat) { if (ok) confirm(); else back(); }
  }
  function gpTick() { // 게임패드: 층이 떠 있는 동안만 읽는다(누른 순간만 반응)
    if (!active) { gpRaf = 0; return; }
    gpRaf = requestAnimationFrame(gpTick);
    let v = 0; const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const g of gps) {
      if (!g) continue; const p = i => !!(g.buttons[i] && g.buttons[i].pressed);
      if (p(12) || g.axes[1] < -0.5) v |= 1; if (p(13) || g.axes[1] > 0.5) v |= 2; if (p(14) || g.axes[0] < -0.5) v |= 16; if (p(15) || g.axes[0] > 0.5) v |= 32; if (p(0)) v |= 4; if (p(1) || p(2)) v |= 8; if (p(9)) v |= 64;
    }
    const hit = v & ~gpPrev; gpPrev = v; if (busy || (window.NKKeymap && window.NKKeymap.isOpen) || (window.NKTouch && window.NKTouch.isOpen)) return; // 조작 설정 창(web/keymap.js)이 떠 있으면 그 창이 읽는다
    if (hit & 1) move(0, -1); else if (hit & 2) move(0, 1); else if (hit & 16) move(-1, 0); else if (hit & 32) move(1, 0); else if (hit & 4) confirm(); else if (hit & 8) back(); else if ((hit & 64) && scr === 'pause') back();
  }
  // ── 온라인 O1(analysis/16_wide_hd_online_plan.md 6절·부록 A·B). 이름 입력(oname) → 로비(olobby) → 방 만들기(ocreate) → 대기방(oroom) → 시합 준비 컷(vs) → 전투(game.js 락스텝) → 결과(oend) ──
  //   소켓·로비·대기방은 이 층이 맡는다. start 를 받으면 onPick('online', { cfg, slot, send, attach }) 로 game.js 에 넘기고, 대전 메시지(f·start 재개·peer·desync·end)는 game.js 가 attach 로 건 쪽에 그대로 넘긴다.
  //   서버·상대가 준 문자열(이름·제목·오류)은 textContent 로만 넣는다. 오류는 토스트. 주소: ?ws=포트|ws://… > 같은 출처에 /online/status 가 있으면 그 서버 > ws://<호스트>:3500/ws
  const OSCR = new Set(['oname', 'olobby', 'ocreate', 'oroom', 'oend', 'orank', 'oprof']), O_KEY = 'nk_online', NAME_RE = /^[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9 _.!?-]{2,8}$/; // 이름 규칙 = 서버 hello(2~8자, NFC, 허용 글자)
  const OERR = { name_taken: '이미 접속 중인 이름입니다', name_bad: '이름: 2~8자 한글·영문·숫자', noname: '이름을 먼저 정해 주세요', noroom: '없는 방입니다', busy: '들어갈 수 없는 방입니다', char_taken: '이미 고른 캐릭터입니다', seat_taken: '그 자리에 사람이 있습니다', host: '방장만 바꿀 수 있습니다', nochar: '캐릭터를 먼저 고르세요', rate: '잠시 뒤에 다시 시도하세요', full: '방을 더 만들 수 없습니다', build: '버전이 달라 시작할 수 없습니다', replaced: '다른 창에서 접속했습니다', stall: '입력이 끊겨 연결이 끊겼습니다', norejoin: '재접속할 수 없습니다', state: '지금은 할 수 없습니다', server: '서버 오류',
    // 계정·래더(analysis/22 2·3·10절)
    acct_off: '계정 기능이 꺼져 있습니다', name_registered: '가입된 이름입니다 · 로그인하세요', acct_exists: '이미 가입된 이름입니다', pw_bad: '비밀번호: 6~64자', pw_empty: '비밀번호를 입력하세요', login_failed: '이름 또는 비밀번호가 맞지 않습니다', login_locked: '로그인 실패가 많아 잠시 막힘', token_bad: '로그인이 만료되었습니다', acct_required: '래더는 가입한 계정만 할 수 있습니다', ranked_fixed: '래더 방은 설정을 바꿀 수 없습니다', ranked_locked: '기권·분쟁이 많아 래더 잠금' };
  // 래더 티어(analysis/22 10.1절, 통키 i18n TIER 와 같은 이름). 배치 중 = tier null → 「배치 n/5」
  const TIER = { bronze: '브론즈', silver: '실버', gold: '골드', platinum: '플래티넘', diamond: '다이아', master: '마스터' }, TIER_ORDER = Object.keys(TIER);
  const RWHY = { VOID: '반영 안 됨', SAME_IP: '같은 네트워크', TOO_FAST: '너무 짧은 판', GUEST: '손님 상대 한도', PAIR_LIMIT: '같은 상대 하루 3판', SAME_KEY: '반영 안 됨', DISPUTE: '결과 불일치' }; // ranking_result.why → 결과 화면 사유 딱지
  const OROLE = [['1P', 'p1'], ['2P', 'p2'], ['3P', 'p3'], ['4P', 'p4']], OCOM = ['COM', 'com'], orole = (i, H) => i < H ? OROLE[i] : OCOM; // 자리 i = 엔진 슬롯 i = 패드 포트 i. 앞 H 자리(사람 수 2·3·4, 17 문서)가 사람, 나머지 CPU
  let oStore = { name: '', sids: {} }; try { const j = JSON.parse(localStorage.getItem(O_KEY) || 'null'); if (j && typeof j === 'object') { if (typeof j.name === 'string') oStore.name = j.name; if (j.sids && typeof j.sids === 'object') for (const k of Object.keys(j.sids)) if (typeof j.sids[k] === 'string') oStore.sids[k] = j.sids[k]; } } catch (e) { /* 저장소 없음 = 이번 세션만 */ } // sids = { 접속 주소: sid }(그 서버가 준 sid 는 그 서버에만 보낸다. 종전의 주소 없는 sid 값은 버린다)
  // 계정 로그인 토큰(analysis/22 2절, 30일): 손님 nk_online 과 별개 키 nk_account = { tokens: { 접속 주소: 토큰 }, acct: 마지막 접속이 계정이었나(접속 화면 기본 탭) }. 비밀번호는 저장하지 않는다
  const A_KEY = 'nk_account', aStore = { tokens: {}, acct: false }; try { const j = JSON.parse(localStorage.getItem(A_KEY) || 'null'); if (j && typeof j === 'object') { aStore.acct = j.acct === true; if (j.tokens && typeof j.tokens === 'object') for (const k of Object.keys(j.tokens)) if (typeof j.tokens[k] === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(j.tokens[k])) aStore.tokens[k] = j.tokens[k]; } } catch (e) { /* 이번 세션만 */ }
  const aSave = () => { try { localStorage.setItem(A_KEY, JSON.stringify(aStore)); } catch (e) { /* 이번 세션만 */ } };
  let lobbyTab = 'normal'; try { if (localStorage.getItem('nk_lobby_tab') === 'ladder') lobbyTab = 'ladder'; } catch (e) { /* 기본 탭 */ }
  const net = { ws: null, connP: null, url: '', name: '', sid: '', rooms: [], room: null, playing: false, sink: null, lostAt: 0, rjTm: 0, buildP: null, game: null, gone: [], // game = 이번 판의 { H, names, chars }(결과 화면의 승자 표시), gone = 판에서 빠진 자리(3·4인, 게이지 패널의 「나감」 표식)
    account: false, acctOff: false, auto: false, ls: null, lsAt: 0, lq: { queued: false }, lm: null, rr: null, board: null, boardAt: 0, skew: 0, lockUntil: 0 }; // 계정·래더: account = 이 세션이 계정, acctOff = 서버 DB 없음(acct_off), auto = 토큰 자동 로그인 대기, ls = ladder_status, lq = 줄 상태, lm = ladder_matched, rr = 이번 판 ranking_result, board = ladder_board, skew = 서버 시각 − 내 시각
  const sNow = () => Date.now() + net.skew;
  const oa = { mode: 'guest' }; // 접속 화면 탭: guest(손님 hello{name}) | login | register
  const placeN = () => (net.ls && net.ls.config && net.ls.config.placementGames) || 5;
  function tierChip(parent, tier, placement, left) { // 티어 딱지. 배치 중 = 「배치 n/5」(n = 마친 판 수)
    if (placement) { const P = placeN(); return chip(parent, Number.isInteger(left) ? '배치 ' + Math.max(0, P - left) + '/' + P : '배치 중', 'com', true); }
    return TIER[tier] ? chip(parent, TIER[tier], 't-' + tier) : chip(parent, '—', 'com', true);
  }
  function seasonText(se) { if (!se || !Number.isInteger(se.n)) return ''; const ms = (se.endsAt || 0) - sNow(); return '시즌 ' + se.n + ' · ' + (ms <= 0 ? '곧 종료' : ms >= 864e5 ? Math.floor(ms / 864e5) + '일 남음' : ms >= 36e5 ? Math.floor(ms / 36e5) + '시간 남음' : Math.max(1, Math.ceil(ms / 6e4)) + '분 남음'); }
  const lockLeft = () => { const u = Math.max((net.ls && net.ls.me && net.ls.me.lockUntil) || 0, net.lockUntil || 0); return u > sNow() ? u : 0; };
  const lockText = u => OERR.ranked_locked + ' (' + Math.max(1, Math.ceil((u - sNow()) / 6e4)) + '분)'; const lockShort = u => '래더 잠금 · ' + Math.max(1, Math.ceil((u - sNow()) / 6e4)) + '분';
  const og = { cur: 0, zone: 'grid' }, oc = { stage: 0, rule: 1, humans: 2 }, oe = { title: '', sub: '', win: false, wn: null, card: null }; // wn = 승자 표시 { role: [딱지, 색], name, ch }(내가 이긴 판·승자 없는 판은 null)
  const OWHY = { leave: '기권', stall: '화면이 멈춰 기권 처리', slow: '진행이 너무 느려 기권 처리', drops: '재접속 반복으로 기권 처리', time: '시간 초과' }; // 서버 end{reason:'forfeit'}.why 별 진 쪽 문구. 그 밖(disconnect = 재접속 대기 초과) = 연결 끊김
  let btoast = null, btTm = 0, lsLoad = false, ffEl = null, ffTm = 0, ffAt = 0;
  // 대전 중 기권(온라인 판에서 덮개가 걷힌 동안만 보이는 화면 구석 버튼, Esc 도 같다): 2단 눌림 — 한 번 = 「기권?」(3초 뒤 풀림), 한 번 더 = 서버 leave(종전 경로 그대로). 본인은 end{forfeit, loser: 나} → 결과 「패배·기권」
  const ffArm = a => { if (a) ffAt = Date.now(); clearTimeout(ffTm); ffTm = a ? setTimeout(() => ffArm(false), 3000) : 0; ffEl.classList.toggle('arm', a); ffEl.textContent = a ? '기권?' : '기권'; };
  function ffSync() { if (!ffEl) return; const on = net.playing && !active; ffEl.classList.toggle('on', on); if (!on) { ffArm(false); ffEl.classList.remove('sent'); } }
  function forfeitTap() {
    if (!ffEl || !net.playing || active || ffEl.classList.contains('sent')) return false;
    if (!ffEl.classList.contains('arm')) { ffArm(true); return true; }
    if (Date.now() - ffAt < 400) return true; // 무장 직후 400ms 의 두 번째 입력은 삼킨다(더블클릭·Esc 연타로 바로 기권되는 것 방지)
    ffArm(false); if (!(net.ws && net.ws.readyState === 1) || net.lostAt) return true; // 끊겨 있는 동안은 보내지 못한다(재접속 뒤 다시 누른다)
    ffEl.classList.add('sent'); nsend({ t: 'leave' }); return true;
  }
  function setGone(a) { net.gone = Array.isArray(a) ? a.filter(x => Number.isInteger(x) && x >= 0 && x < 4) : []; hud.sig = ''; }
  const cname = i => data && data.characters[i] ? data.characters[i].name_ko : IDS[i] || '?';
  const roomH = () => { const R = net.room, n = R ? (R.seats || []).filter(x => x && x.kind === 'human').length : 0; return n >= 2 && n <= 4 ? n : 2; }; // 대기방의 사람 자리 수(서버 seats[i].kind)
  function oPush(s, k, e, o, arr) { // 커서 항목(마우스 올리기 = 커서, 누르기 = 실행). o: { act, adj(d), input, off(), col }
    const it = Object.assign({ el: e }, o); (arr || s.list).push(it); const at = () => els[k].list.indexOf(it);
    const sel = () => { const i = at(); if (i < 0 || (it.off && it.off())) return false; if (idx[k] !== i || (k === 'oroom' && og.zone !== 'side')) { idx[k] = i; og.zone = 'side'; render(); } return true; };
    if (it.input) e.addEventListener('focus', () => { if (active && scr === k) sel(); });
    else {
      hoverable(e, () => { if (scr === k) sel(); });
      e.addEventListener('click', () => { if (!active || busy || scr !== k || !sel()) return; if (it.act) it.act(); else if (it.adj) { it.adj(1); render(); } });
    }
    return it;
  }
  function oBtn(s, k, id, t, r, act, o) { const b = abs(el('div', 'nkm-btn', s, t), ...r); b.dataset.id = id; b.setAttribute('role', 'button'); return oPush(s, k, b, Object.assign({ act }, o)); }
  function oInput(s, k, id, r, max, act, ph) { const f = abs(el('input', 'nke-f', s), r[0], r[1], r[2]); f.type = 'text'; f.maxLength = max; f.autocomplete = 'off'; f.spellcheck = false; f.dataset.id = id; f.setAttribute('aria-label', ph || id); if (ph) f.placeholder = ph; oPush(s, k, f, { input: true, act }); return f; }
  function oSet(s, k, id, label, r, adj, off) { // ◀ 값 ▶ 줄(설정 화면 모양). ← → 로 바꾼다
    const e = abs(el('div', 'nkm-set', s, label), ...r); e.dataset.id = id;
    const dn = el('em', '', e, '◀'), v = el('span', '', e), up = el('em', '', e, '▶'); up.style.right = '0'; e.val = el('b', '', v);
    let it = null; const tap = d => ev => { ev.stopPropagation(); if (!active || busy || scr !== k || (off && off())) return; idx[k] = els[k].list.indexOf(it); og.zone = 'side'; adj(d); render(); };
    dn.addEventListener('click', tap(-1)); up.addEventListener('click', tap(1));
    it = oPush(s, k, e, { adj, off }); return e;
  }
  function buildOnline() {
    btoast = el('div', 'nko-bt', document.body); btoast.id = 'nko-bt'; btoast.setAttribute('role', 'status');
    ffEl = el('div', '', document.body, '기권'); ffEl.id = 'nko-ff'; ffEl.setAttribute('role', 'button'); ffEl.addEventListener('click', forfeitTap);
    // 접속(analysis/22 2절): 탭 손님 / 로그인 / 가입. 손님 = 종전 hello{name}, 로그인·가입 = login·register{name, pw}(비밀번호 칸 1개만). 토큰이 있으면 들어올 때 hello{token} 자동 로그인
    let s = els.oname = el('div', 'nkm-scr nkm-edit nko', stageEl); s.list = []; head(s, '온라인');
    abs(el('div', 'nkm-win', s), 340, 140, 600, 420);
    s.tabs = [['guest', '손님'], ['login', '로그인'], ['register', '가입']].map(([m, t], i) => { const it = oBtn(s, 'oname', 'mode_' + m, t, [372 + 184 * i, 164, 168, 52], () => setMode(m, true), { row: 'tab', off: () => net.acctOff && m !== 'guest' }); it.el.classList.add('nko-tab'); it.mode = m; return it; });
    abs(el('div', 'nke-lab', s, '이름'), 384, 252);
    s.name = oInput(s, 'oname', 'name', [500, 240, 400], 8, () => { const p = els.oname.pw; if (oa.mode !== 'guest' && !p.value) return p.focus(); nameSubmit(); }, '이름');
    s.pwLab = abs(el('div', 'nke-lab', s, '비밀번호'), 384, 322);
    s.pw = oInput(s, 'oname', 'pw', [500, 310, 400], 64, nameSubmit, '비밀번호'); s.pw.type = 'password'; s.pwIt = s.list[s.list.length - 1]; s.pwIt.off = () => oa.mode === 'guest';
    abs(el('div', 'nkm-sep', s), 384, 396, 512);
    s.enter = oBtn(s, 'oname', 'enter', '입장', [420, 420, 220, 64], nameSubmit, { row: 'btn' }).el; oBtn(s, 'oname', 'back', '뒤로', [660, 420, 200, 64], oback, { row: 'btn' });
    foot(s, '', true);

    s = els.olobby = el('div', 'nkm-scr nkm-edit nko', stageEl); s.list = []; s.fixed = []; s.rowItems = []; s.headEl = head(s, '로비'); s.me = chip(s, '', 'p1'); s.me.classList.add('nkm-turn'); s.meK = el('span', 'nko-meK', s);
    abs(el('div', 'nkm-win', s), 32, 84, 880, 556);
    // 탭 「일반 경기 / 래더 경기」(머리줄 오른쪽, 선택은 localStorage nk_lobby_tab). 서버 DB 가 없으면(acct_off) 탭·랭킹을 숨긴다
    s.tabs = [['normal', '일반 경기'], ['ladder', '래더 경기']].map(([k, t], i) => { const b = abs(el('div', 'nkm-btn nko-tab', s, t), 592 + 164 * i, 22, 152, 48); b.dataset.id = 'tab_' + k; const it = oPush(s, 'olobby', b, { act: () => setTab(k), row: 'tab', col: 0 }, []); it.tab = k; return it; });
    s.th = abs(el('div', 'nko-th', s), 48, 100, 848, 40); ['방 제목', '방장', '인원', '상태', '스테이지 · 룰'].forEach(t => el('span', '', s.th, t));
    s.rows = abs(el('div', 'nko-rows', s), 48, 144, 848, 480); s.empty = abs(el('div', 'nko-empty', s, '방이 없습니다'), 48, 340, 848);
    // 래더 탭(analysis/22 10절): 시즌 · 내 티어·레이팅·승패·순위 · 잠금 · 큰 「래더 대전」 / 대기 중(대기 시간 · 허용 차 · 줄 인원 · 취소) / 손님 = 가입
    const P = s.ld = abs(el('div', 'nko-ld', s), 32, 84, 880, 556); s.ldItems = [];
    P.season = abs(el('div', 'nko-ld-season', P), 0, 28, 880); P.badge = abs(el('div', 'nko-ld-badge', P), 0, 84, 880); P.wl = abs(el('div', 'nko-ld-wl', P), 0, 178, 880); P.lock = abs(el('div', 'nko-ld-lock', P), 0, 220, 880);
    P.q = abs(el('div', 'nko-ld-q', P), 0, 262, 880); P.qT = el('b', '', P.q); P.qS = el('div', '', P.q);
    const LD = (id, t, r, act) => { const b = abs(el('div', 'nkm-btn', P, t), ...r); b.dataset.id = id; oPush(s, 'olobby', b, { act, col: 0 }, s.ldItems); return b; };
    P.join = LD('ladder', '래더 대전', [240, 290, 400, 96], ladderJoin); P.join.classList.add('nko-big-btn');
    P.cancel = LD('ladder_cancel', '취소', [340, 400, 200, 64], () => nsend({ t: 'ladder_leave' }));
    P.signup = LD('signup', '가입', [340, 410, 200, 60], () => { if (!net.name) return enterOnline(); openName('register', net.name); });
    abs(el('div', 'nkm-win', s), 928, 84, 320, 556);
    const L = (id, t, y, h, act) => { const b = abs(el('div', 'nkm-btn', s, t), 952, y, 272, h); b.dataset.id = id; return oPush(s, 'olobby', b, { act, col: 1 }, s.fixed); };
    L('create', '방 만들기', 108, 64, () => { oc.stage = 0; oc.rule = 1; oc.humans = 2; els.ocreate.tin.value = ''; idx.ocreate = 0; go('ocreate'); setTimeout(() => { if (active && scr === 'ocreate') els.ocreate.tin.focus(); }, 0); });
    abs(el('div', 'nkm-sep', s), 952, 196, 272);
    // 방 코드 입력·코드로 입장 칸은 없앴다(2026-11-21): 방 목록에서 골라 들어가고, 코드는 초대 링크(?room=)로만 쓴다(서버 join{code} 그대로)
    s.rankIt = L('rank', '랭킹', 220, 56, openRank); s.profIt = L('profile', '프로필', 220, 56, () => openProfile(null)); s.outIt = L('logout', '로그아웃', 288, 56, () => nsend({ t: 'logout' }));
    abs(s.rankIt.el, 952, 220, 132); abs(s.profIt.el, 1092, 220, 132); s.rankIt.row = s.profIt.row = 'rkpf'; s.profIt.off = () => net.acctOff; // 랭킹 | 프로필 한 줄(←→)
    { const b = abs(el('div', 'nkm-btn nko-inv', s, '친구 초대'), 1056, 20, 192, 48); b.dataset.id = 'invite'; b.setAttribute('role', 'button'); oPush(s, 'olobby', b, { act: () => copyInvite(''), col: 1 }, s.fixed); } // 머리줄 오른쪽 끝: 로비 초대 링크(?online=1). 목록 순서는 오른쪽 줄 뒤(처음 커서 = 방 만들기 그대로)
    s.rankIt.off = () => net.acctOff; s.outIt.off = () => !net.account;
    abs(el('div', 'nkm-sep', s), 952, 540, 272);
    L('back', '나가기', 560, 56, oback);
    s.list = s.fixed.slice();
    foot(s, '', true);

    s = els.ocreate = el('div', 'nkm-scr nkm-edit nko', stageEl); s.list = []; head(s, '방 만들기');
    abs(el('div', 'nkm-win', s), 240, 84, 800, 556); abs(el('div', 'nke-lab', s, '제목'), 280, 124);
    s.tin = oInput(s, 'ocreate', 'title', [420, 112, 580], 16, () => omove(0, 1), '제목');
    oSet(s, 'ocreate', 'stage', '스테이지', [264, 180, 752, 56], d => { oc.stage = (oc.stage + d + 7) % 7; });
    oSet(s, 'ocreate', 'rule', '룰', [264, 240, 752, 56], d => { oc.rule = (oc.rule - 1 + d + 4) % 4 + 1; });
    s.hum = oSet(s, 'ocreate', 'humans', '인원', [264, 300, 752, 56], d => { oc.humans = (oc.humans - 2 + d + 3) % 3 + 2; }); // 사람 수 2·3·4(기본 2) → create{opts{humans}}. 나머지 자리는 CPU
    s.thumb = abs(el('div', 'nkm-stg nkm-thumb', s), 280, 372, 176, 132); s.ruleT = abs(el('div', 'nko-rule', s), 480, 380, 520);
    abs(el('div', 'nkm-sep', s), 280, 520, 720);
    oBtn(s, 'ocreate', 'make', '만들기', [420, 544, 220, 60], createRoom); oBtn(s, 'ocreate', 'back', '뒤로', [660, 544, 200, 60], oback);
    foot(s, '', true);

    s = els.oroom = el('div', 'nkm-scr nko nko-room', stageEl); s.list = []; s.headEl = head(s, ''); // 방 코드는 화면에 내지 않는다(초대 링크 안에만)
    s.gw = el('div', 'nkm-win nko-gw', s); s.sht = el('div', 'nko-sht', s, '캐릭터'); // 캐릭터 칸 바탕(세로 배치 = 아래에서 덮는 시트)
    s.cells = [];
    for (let i = 0; i < 16; i++) { // 캐릭터 선택 칸(캐릭터 선택 화면의 칸 그대로). 고른 칸 = 회색 + 자리 딱지
      const e = abs(el('div', 'nkm-cell', s), 56 + 120 * (i & 3), 100 + 131 * (i >> 2)); cvar(e, 'sch' + (i >> 2)); e.dataset.id = IDS[i];
      const im = el('img', '', e); im.src = face(i); im.alt = ''; im.draggable = false; e.nm = el('span', '', e); e.tag = el('em', 'nkm-chip', e);
      hoverable(e, () => { if (scr === 'oroom' && (og.zone !== 'grid' || og.cur !== i)) { og.zone = 'grid'; og.cur = i; render(); } });
      e.addEventListener('click', () => { if (!active || busy || scr !== 'oroom') return; og.zone = 'grid'; og.cur = i; render(); pickCell(i); });
      s.cells.push(e);
    }
    s.brk = abs(el('div', 'nkm-brk', s), 0, 0, 122, 136);
    s.seats = [0, 1, 2, 3].map(i => {
      const w = abs(el('div', 'nkm-win nko-seat', s), 564 + 172 * i, 84, 164, 254), c = { w };
      c.cut = abs(el('div', 'nkm-cut', w), 8, 8, 142, 142); c.im = el('img', '', c.cut); c.im.alt = ''; c.im.draggable = false;
      c.who = chip(w, OROLE[i][0], OROLE[i][1]); c.who.classList.add('nko-who'); c.nm = el('div', 'nko-nm', w); c.ch = el('div', 'nko-ch', w); c.st = el('div', 'nko-st', w);
      c.rk = el('div', 'nko-rk', w); // 랭크·래더 방만: 티어(배치 n/5)·레이팅 / 손님 (초상 아래쪽에 겹침, 카드 배치는 그대로)
      c.hb = chip(w, '방장', 'focus', true); c.hb.classList.add('nko-hb'); // 자동 시작 방(래더)의 방장 표시. 하단 띠는 상태 딱지 1개만(두 딱지가 띠를 넘쳐 잘리던 것 방지)
      w.addEventListener('click', () => roomCard(i));
      return c;
    });
    s.cd = el('div', 'nko-cd', s); s.cdN = el('b', '', s.cd); // 방장 시작 카운트다운 3·2·1(자리 카드 위 가운데)
    s.setW = el('div', 'nkm-win', s); s.pbar = el('div', 'nko-pbar', s); // 세로: 아래 고정 띠(큰 버튼 밑)
    const notHost = () => !net.room || net.room.you !== 0 || !!net.room.opts.ranked || !!net.count; // 랭크·래더 방 = 설정 고정(서버 ranked_fixed). 카운트다운 중 = 잠금(서버 state)
    const rnd = (it, id) => { it.el.classList.add('nko-rnd'); return it; };
    // 설정(방장만 바꾼다, 그 밖은 읽기만): 인원(사람 자리 수 2~4 = set{humans}, 앞자리부터 사람) · 스테이지(+랜덤) · 룰(+랜덤) · CPU 캐릭터(줄 수 = 4 − 사람 수, 4인이면 없음). 랜덤 = -1(시작 때 서버가 정한다)
    s.rowH = oSet(s, 'oroom', 'humans', '인원', [0, 0, 420, 56], d => { const n = roomH() + d; if (n >= 2 && n <= 4) nsend({ t: 'set', humans: n }); }, notHost);
    s.rowS = oSet(s, 'oroom', 'stage', '스테이지', [0, 0, 340, 56], d => { nsend({ t: 'set', stage: (((net.room.opts.stage | 0) + 1 + d + 8) % 8) - 1 }); }, notHost); s.rowS.classList.add('nko-sh');
    s.rndS = rnd(oBtn(s, 'oroom', 'stage_rnd', '랜덤', [0, 0, 72, 48], () => nsend({ t: 'set', stage: net.room.opts.stage === -1 ? 0 : -1 }), { off: notHost }));
    s.rowR = oSet(s, 'oroom', 'rule', '룰', [0, 0, 340, 56], d => { const r = net.room.opts.rule | 0, n = ((r < 0 ? 0 : r) + d + 5) % 5; nsend({ t: 'set', rule: n === 0 ? -1 : n }); }, notHost); s.rowR.classList.add('nko-sh', 'nko-rl'); // nko-rl = 룰 이름(5자) 글자 크기
    s.rndR = rnd(oBtn(s, 'oroom', 'rule_rnd', '랜덤', [0, 0, 72, 48], () => nsend({ t: 'set', rule: net.room.opts.rule === -1 ? 1 : -1 }), { off: notHost }));
    s.rowC = [0, 1].map(j => oSet(s, 'oroom', 'cpu' + j, 'CPU ' + (j + 1), [0, 0, 420, 56], d => cpuAdj(j, d), () => notHost() || j >= 4 - roomH()));
    s.sth = el('div', 'nkm-stg nkm-thumb nko-sth', s); s.sthB = el('b', '', s.sth); s.ruleT = el('div', 'nko-rule nko-plo', s); // 스테이지 썸네일(/ui/stage_N.png, 랜덤 = ?) · 룰 설명(세로만)
    s.mainIt = oBtn(s, 'oroom', 'ready', '준비', [0, 0, 216, 88], roomMain); s.ready = s.mainIt.el; // 방장(방장 시작 서버) = 시작/취소(data-id start), 그 밖 = 준비/준비 취소
    { const it = oBtn(s, 'oroom', 'invite', '친구 초대', [0, 0, 192, 48], () => copyInvite(net.room ? net.room.code : ''), { off: () => !net.room || !!(net.lm && net.lm.code === net.room.code) }); it.el.classList.add('nko-inv'); s.invEl = it.el; } // 머리줄 오른쪽 끝: 이 방 초대 링크(?room=코드). 래더 방은 남이 못 들어와 끈다
    s.leaveEl = oBtn(s, 'oroom', 'leave', '나가기', [0, 0, 216, 56], oback).el;
    s.chrEl = oBtn(s, 'oroom', 'pick_open', '캐릭터', [0, 0, 156, 88], () => roomCard(net.room ? net.room.you : -1), { off: () => !oPl() }).el; s.chrEl.classList.add('nko-plo'); // 세로: 캐릭터 시트 열기
    s.shX = oBtn(s, 'oroom', 'sheet_x', '×', [0, 0, 64, 52], () => { og.zone = 'side'; idx.oroom = s.list.indexOf(s.mainIt); render(); }, { off: () => !oPl() || og.zone !== 'grid' }).el; s.shX.classList.add('nko-plo', 'nko-sho');
    s.addB = [0, 1, 2, 3].map(i => { const it = oBtn(s, 'oroom', 'cpu_add' + i, '+CPU', [0, 0, 110, 34], () => nsend({ t: 'set', humans: Math.max(2, i) }), { off: () => notHost() || !(i >= 2 && net.room.seats[i] && net.room.seats[i].kind === 'human' && !net.room.seats[i].name) }); it.el.classList.add('nko-sb'); return it; }); // 빈 사람 자리 → CPU(humans = 자리 번호, 최소 2)
    s.xB = [0, 1, 2, 3].map(i => { const it = oBtn(s, 'oroom', 'cpu_x' + i, '×', [0, 0, 34, 34], () => nsend({ t: 'set', humans: i + 1 }), { off: () => notHost() || !(net.room.seats[i] && net.room.seats[i].kind !== 'human') }); it.el.classList.add('nko-sb'); return it; }); // CPU 자리 → 사람 자리(humans = 자리 번호 + 1)
    s.hint = foot(s, '', true); s.ttl = el('div', 'nkm-hint nko-ttl', s); // 래더 방: 시작 제한 남은 시간(roomTtl)
    roomLayout(s, false);

    s = els.oend = el('div', 'nkm-scr nko', stageEl); s.list = []; head(s, '결과');
    abs(el('div', 'nkm-win', s), 340, 160, 600, 400); s.big = abs(el('div', 'nko-big', s), 340, 196, 600); s.sub = abs(el('div', 'nko-sub', s), 340, 306, 600); s.wn = abs(el('div', 'nko-wn', s), 340, 306, 600);
    s.rr = abs(el('div', 'nko-rr', s), 340, 346, 600); s.rr1 = el('div', '', s.rr); s.rr2 = el('div', '', s.rr); // 랭크·래더 판: ranking_result(레이팅 변화 · 티어 승강 · 배치 잔여)
    oBtn(s, 'oend', 'lobby', '로비로', [476, 452, 328, 56], oback); oBtn(s, 'oend', 'card', '카드 이미지 저장', [476, 516, 328, 40], saveCard, { off: () => !oe.card }); // R1: 승부가 난 판만(무효·중단 = 흐림)
    foot(s, '', false);

    // 랭킹보드(ladder_board, analysis/22 10.3절): 순위·이름·티어·레이팅·승패(배치 완료·활동 중 상위 50) + 내 줄 고정(배치 중·비활동 = 순위 「-」)
    s = els.orank = el('div', 'nkm-scr nko', stageEl); s.list = []; s.headEl = head(s, '랭킹'); s.season = chip(s, '', 'focus', true); s.season.classList.add('nkm-turn');
    abs(el('div', 'nkm-win', s), 32, 84, 1216, 556);
    s.th = abs(el('div', 'nko-th nko-rk-row', s), 48, 100, 1184, 40); ['순위', '이름', '티어', '레이팅', '승패'].forEach(t => el('span', '', s.th, t));
    s.rows = abs(el('div', 'nko-rows', s), 48, 144, 1184, 412); s.empty = abs(el('div', 'nko-empty', s, '기록이 없습니다'), 48, 330, 1184);
    s.mine = abs(el('div', 'nko-row nko-rk-row nko-pf me pin', s), 48, 568, 1184, 56); s.mine.addEventListener('click', () => { if (active && !busy && scr === 'orank' && net.board && net.board.me) openProfile(null); }); // 내 줄 = 내 프로필
    oBtn(s, 'orank', 'back', '뒤로', [1056, 20, 192, 48], oback);
    foot(s, '', true);
    buildProfile(); // 프로필(oprof)
    setInterval(onlineTick, 500); // 래더 대기 시간·시즌 남은 시간·잠금 표시(글자만 바꾼다)
  }
  // 연결
  function wsUrl() {
    if (net.url) return Promise.resolve(net.url);
    const q = /[?&]ws=([^&]+)/.exec(location.search), v = q ? decodeURIComponent(q[1]) : '', h = location.hostname;
    if (/^\d{2,5}$/.test(v) && +v > 0 && +v < 65536) return Promise.resolve(net.url = 'ws://' + h + ':' + +v + '/ws');
    if (v) { // 주소 전체는 같은 호스트·루프백의 ws(s) 만 받는다(링크의 ?ws= 로 이름·sid 가 남의 서버로 가지 않게). 그 밖의 값은 버리고 기본 주소를 쓴다
      let u = null; try { u = new URL(v); } catch (e) { /* 주소 아님 */ }
      if (u && (u.protocol === 'ws:' || u.protocol === 'wss:') && !u.username && !u.password && (u.hostname === h || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) return Promise.resolve(net.url = u.href);
      console.warn('?ws= 값을 쓰지 않습니다(포트 번호 또는 같은 호스트·루프백 ws 주소만)');
    }
    return fetch('/online/status', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)
      .then(j => (net.url = (j && j.proto ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host : 'ws://' + h + ':3500') + '/ws'));
  }
  function ensureConn() {
    if (net.ws && net.ws.readyState === 1) return Promise.resolve();
    if (net.connP) return net.connP;
    const p = net.connP = wsUrl().then(u => new Promise((res, rej) => {
      let ws, opened = false; try { ws = new WebSocket(u); } catch (e) { return rej(e); }
      net.ws = ws;
      ws.onopen = () => { opened = true; res(); };
      ws.onclose = ev => { if (!opened) { if (net.ws === ws) net.ws = null; return rej(new Error('연결 실패')); } onClose(ws, ev); };
      ws.onmessage = ev => { if (net.ws !== ws) return; let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m && typeof m.t === 'string') onNet(m); };
    }));
    p.then(() => { if (net.connP === p) net.connP = null; }, () => { if (net.connP === p) net.connP = null; });
    return p;
  }
  const ffUnsend = () => { if (ffEl) ffEl.classList.remove('sent'); }; // 기권(leave)을 보낸 직후 끊기면 서버에 닿지 않았을 수 있다: 끊김·재접속 때 풀어 다시 누를 수 있게 한다
  const nsend = m => { if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(m)); };
  function onClose(ws, ev) {
    if (ws !== net.ws) return; net.ws = null;
    if (net.playing) { ffUnsend(); if (ev.code === 4002) return lost(); if (!net.lostAt) net.lostAt = Date.now(); toast('연결 끊김 — 재접속 중', 'hp-low', 4000); return rejoinLater(); }
    const why = ev.code === 4002 ? 'replaced' : 'down'; // 4002 = 다른 창이 같은 계정으로 접속(서버 err replaced): 「연결할 수 없습니다」 대신 그 사유를 알린다
    if (sx.wait) { const w = sx.wait; sx.wait = null; clearTimeout(w.tm); w.rej({ code: why }); } if (sx.hello) { const h = sx.hello; sx.hello = null; h(false); } if (sx.segOn) segErr({ code: why }); // 스토리 요청·저장 = 다시 시도
    net.lockUntil = 0; net.who = ''; if (els.oname) els.oname.pw.value = '';
    net.room = null; net.account = false; net.auto = false; net.lq = { queued: false }; cdSet(null); net.noHs = false; // 끊기면 서버가 줄에서 뺀다(알림 없음)
    profAbort(); pf.pend = []; // 프로필 요청 대기 풀기, 대전 중에 쌓인 획득 알림 버림(끊긴 세션)
    if (active && scr === 'oprof') return toast(ev.code === 4002 ? OERR.replaced : '서버 연결이 끊겼습니다', 'hp-low'); // 프로필은 받아 둔 내용 그대로 둔다(뒤로 = 온 곳)
    if (active && OSCR.has(scr)) { go('oname'); toast(ev.code === 4002 ? OERR.replaced : '서버 연결이 끊겼습니다', 'hp-low'); }
    else if (ev.code === 4002) toast(OERR.replaced, 'hp-low'); // 온라인 화면 밖(스토리·타이틀·전투 중 메뉴 등)에서도 사유를 한 줄 알린다
  }
  function rejoinLater() { if (!net.rjTm) net.rjTm = setTimeout(() => { net.rjTm = 0; tryRejoin(); }, 1000); }
  function tryRejoin() { // 대전 중 끊김: 같은 sid 로 이름을 되찾고 rejoin(서버 대기 20초 안). 실패하면 1초 뒤 다시. lostAt = 끊긴 시각(0 = 붙어 있음. 재입장 room 을 받으면 0)
    if (!net.playing || !net.lostAt) return; // 소켓이 다시 열렸어도 재입장(room)을 받기 전이면 hello·rejoin 을 다시 보낸다(서버가 rate·state 등으로 거절한 경우)
    if (Date.now() - net.lostAt > 18000) return lost();
    ensureConn().then(() => { nsend({ t: 'hello', name: net.name, sid: net.sid }); nsend({ t: 'rejoin', code: net.room.code, token: net.room.token, have: net.sink ? net.sink.have() : 0 }); rejoinLater(); /* 답(room)이 없으면 1초 뒤 다시(room 을 받으면 타이머를 지운다) */ }, rejoinLater);
  }
  function lost() { net.lostAt = 0; if (net.sink) net.sink.msg({ t: 'end', reason: 'lost' }); }
  function onNet(m) {
    if (storyNet(m)) return; // 스토리 슬롯 응답(이어하기 블록)
    const R = net.room;
    switch (m.t) {
      case 'ping': return nsend({ t: 'pong', id: m.id });
      case 'welcome':
        unlockToast(m.unlocked); // 로그인 때 새로 얻은 칭호 등(analysis/22 11.1)
        net.name = String(m.name || ''); net.sid = String(m.sid || ''); oStore.name = net.name; if (net.url) { delete oStore.sids[net.url]; oStore.sids[net.url] = net.sid; const ks = Object.keys(oStore.sids); if (ks.length > 8) delete oStore.sids[ks[0]]; } try { localStorage.setItem(O_KEY, JSON.stringify(oStore)); } catch (e) { /* 이번 세션만 */ }
        net.auto = false; { const who = (m.account ? 'a:' : 'g:') + net.name.toLowerCase(); if (net.who !== who) { net.ls = null; net.board = null; net.lockUntil = 0; net.lm = null; net.rr = null; if (net.who) storyForget(); } net.who = who; } net.account = !!m.account; // 계정·이름이 바뀜 = 래더 상태·순위표·잠금 다시 받기(앞 계정 값이 남지 않게) // 계정 바뀜 = 래더 상태·순위표 다시 받기
        if (m.account) { aStore.acct = true; if (net.url && typeof m.token === 'string' && m.token) { delete aStore.tokens[net.url]; aStore.tokens[net.url] = m.token; const ks = Object.keys(aStore.tokens); if (ks.length > 8) delete aStore.tokens[ks[0]]; } aSave(); if ((set.tutok | 0) === 1) setTimeout(tutReport, 0); } // 재접속(hello{name,sid})의 welcome 에는 토큰이 없다 = 저장한 토큰 유지. 튜토리얼을 손님·끊김 중에 마쳤으면 로그인 때 tutorial_done 1회(서버 계정당 멱등, 보낸 기록 있으면 안 보냄)
        if (els.oname) els.oname.pw.value = '';
        if (!net.playing && active && scr === 'oname') { if (!storyAfterLogin(m)) toLobby(); } else if (active && scr === 'olobby') render(); return;
      case 'logged_out':
        net.account = false; net.name = ''; net.who = ''; net.lockUntil = 0; net.ls = null; net.board = null; net.lq = { queued: false }; if (net.url) { delete aStore.tokens[net.url]; aSave(); } storyForget(); ch.data = null; pf.pend = [];
        if (active && OSCR.has(scr) && !net.playing) openName('login', oStore.name); return;
      case 'ladder_status':
        net.ls = m; net.lsAt = Date.now(); if (Number.isFinite(m.serverTime)) net.skew = m.serverTime - Date.now(); if (m.queue) net.lq = m.queue; if (m.me) net.lockUntil = m.me.lockUntil || 0; /* 서버 값이 권위 */
        if (active && scr === 'olobby') render(); return;
      case 'ladder_queue':
        net.lq = m; if (Number.isFinite(m.serverTime)) net.skew = m.serverTime - Date.now();
        if (m.reason === 'error' && active && OSCR.has(scr)) toast('래더 매칭 실패 · 다시 시도하세요', 'hp-low');
        if (active && scr === 'olobby') render(); return;
      case 'ladder_matched': { // 바로 뒤에 room{…}(종전 경로로 대기방). 상대 정보는 토스트 + 대기방 좌석 칩
        net.lm = m; net.lq = { queued: false, reason: 'room' }; const o = m.opp || {};
        toast('상대 ' + String(o.name || '') + ' · ' + (o.placement ? '배치 중' : TIER[o.tier] || '') + ' ' + (o.rating | 0) + (m.counted === false ? ' · 반영 안 됨' : ''), 'hp', 3200); return; }
      case 'ladder_board': case 'ranking_list':
        net.board = m; net.boardAt = Date.now(); if (active && scr === 'orank') render(); return;
      case 'ranking_result':
        net.rr = m; net.ls = null; net.board = null; unlockToast(m.unlocked); if (active && scr === 'oend') render(); return; // 결과 화면에 표시. 래더 상태·순위표는 다음에 다시 받는다
      case 'profile': case 'profile_set': case 'tutorial_done': return profNet(m);
      case 'challenge_list': case 'challenge_claim': return chNet(m);
      case 'rooms': net.rooms = Array.isArray(m.list) ? m.list : []; if (active && scr === 'olobby') { render(); if (net.invWait) invJoin(); } return;
      case 'room':
        if (net.playing) { ffUnsend(); if (R && m.token) R.token = m.token; net.lostAt = 0; clearTimeout(net.rjTm); net.rjTm = 0; if (Array.isArray(m.left)) setGone(m.left); return; } // 재접속(3·4인: 그동안 빠진 자리 left)
        if (Number.isFinite(m.proto)) net.proto = m.proto;
        if (m.moved && R && R.code === String(m.code || '')) { R.you = m.you | 0; if (m.token) R.token = m.token; if (m.seats) R.seats = m.seats; if (m.opts) R.opts = m.opts; if (m.title !== undefined) R.title = m.title; if (m.host !== undefined) R.host = m.host; if (active && scr === 'oroom') render(); return; } // 자리 당기기(analysis/25 4.5): 자리·토큰만 바꾸고 화면은 그대로(you 0 = 이제 방장)
        net.room = { code: String(m.code || ''), you: m.you | 0, token: m.token, title: m.title, host: m.host, seats: m.seats || [], opts: m.opts || {} }; cdSet(null);
        og.cur = 0; og.zone = 'grid'; idx.oroom = els.oroom.list.indexOf(els.oroom.mainIt); /* 준비·시작 버튼 */ if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur(); if (active) go('oroom'); return;
      case 'peers': if (R && !net.playing) { if (m.seats) R.seats = m.seats; if (m.opts) R.opts = m.opts; if (m.title !== undefined) R.title = m.title; if (Array.isArray(m.changes)) chgToast(m.changes); if (active && scr === 'oroom') render(); } return;
      case 'count': if (!R || net.playing) return; // 방장 시작 카운트다운(analysis/25 4.2): ms = 남은 시간, cancel = 취소(why 별 토스트)
        if (m.cancel) { cdSet(null); net.stAt = 0; net.cxAt = Date.now(); if (active && scr === 'oroom') { toast(CWHY[m.why] || '시작 취소', 'hp-low'); render(); } return; }
        net.stAt = 0; net.cntAt = Date.now(); /* cntAt = 카운트 받은 시각(직후 0.7초 취소 클릭 무시, roomMain) */ cdSet(Math.max(0, +m.ms || 0)); if (oPl() && og.zone === 'grid') og.zone = 'side'; if (active && scr === 'oroom') render(); return;
      case 'start': if (m.resume) { ffUnsend(); if (net.sink) net.sink.msg(m); return; } cdSet(null); return startBattle(m.cfg);
      case 'f': case 'peer': case 'desync': if (m.t === 'peer' && m.ev === 'gone' && net.playing) setGone(Array.isArray(m.left) ? m.left : net.gone.concat(m.slot | 0)); if (net.sink) net.sink.msg(m); return;
      case 'end':
        if (net.playing) { if (net.sink) net.sink.msg(m); return; }
        if (R) { net.room = null; toLobby(); toast(m.reason === 'host_left' ? '방장이 나가 방이 닫혔습니다' : m.reason === 'ladder_cancel' ? '상대가 나가 래더 대전 취소' : m.reason === 'ladder_timeout' ? '시간 초과로 래더 대전 취소' : '방이 닫혔습니다'); } return;
      case 'err':
        if (profErr(m)) return; // 프로필 요청(profile_get·profile_set·tutorial_done)의 오류 = 토스트
        if (net.playing) { // 대전 중: norejoin = 끝, stall = 알림(서버가 곧 끊는다 → onClose 가 재접속). 그 밖(rate·state·name_taken 등)은 재접속 중(lostAt)일 때만 1초 뒤 다시 시도하고 18초 한도에서 로비로(tryRejoin). 붙어 있는 동안의 오류는 판을 끊지 않는다
          if (m.code === 'norejoin') lost(); else if (m.code === 'stall') toast(OERR.stall, 'hp-low'); else if (net.lostAt) rejoinLater(); return; }
        if (m.code === 'acct_off') { // 서버 DB 없음: 래더 탭·랭킹·로그인 탭을 숨긴다. 로그인·가입을 누른 때만 알린다
          const was = net.acctOff; net.acctOff = true; net.auto = false; if (!was && lobbyTab === 'ladder' && active && scr === 'olobby') render();
          if (active && scr === 'oname') { if (oa.mode !== 'guest') toast(OERR.acct_off, 'hp-low'); setMode('guest'); } else if (active && scr === 'orank') { toast(OERR.acct_off); toLobby(); } return; }
        if (m.code === 'ranked_locked' && Number.isFinite(m.until)) net.lockUntil = m.until;
        if (m.code === 'token_bad' && net.url) { delete aStore.tokens[net.url]; aSave(); }
        if (net.auto && (m.code === 'token_bad' || m.code === 'rate')) { net.auto = false; if (active && scr === 'oname') setMode('login'); } // 자동 로그인 실패 = 로그인 탭
        if (!active || !OSCR.has(scr)) return;
        if (m.code === 'start') { net.stAt = 0; return toast(SWHY[m.why] || String(m.msg || '시작할 수 없습니다'), 'hp-low'); } // 방장 시작 조건 미충족(analysis/25 4.3)
        // 자동 시작 서버(NK_ROOM_HOST_START=0) = start 거절 → 종전 준비 버튼으로. 새 서버는 host_start_off, 그 코드가 없는 서버는 「직전에 보낸 것이 start{build} + 대기 중인 방이 아닙니다」만(늦은 start{cancel} 의 state 는 해당 없음)
        if (scr === 'oroom' && (m.code === 'host_start_off' || (m.code === 'state' && net.stLast === 'build' && net.stAt && Date.now() - net.stAt < 3000 && !net.count && m.msg === '대기 중인 방이 아닙니다'))) { net.stAt = 0; net.noHs = true; render(); return toast('준비를 눌러 주세요'); }
        if (m.code === 'state') net.stAt = 0;
        if (m.code === 'noname') go('oname');
        toast(m.code === 'ranked_locked' ? (m.why === 'ladder_cancel' ? '시작 전 이탈이 많아 래더 잠금 (' + Math.max(1, Math.ceil(((lockLeft() || sNow() + 6e4) - sNow()) / 6e4)) + '분)' : lockText(lockLeft() || sNow() + 6e4)) : OERR[m.code] || String(m.msg || m.code || '오류'), /^(name_taken|name_bad|name_registered|acct_exists|pw_bad|login_failed|login_locked|token_bad|acct_required|ranked_locked)$/.test(m.code) ? 'hp-low' : null);
        if (scr === 'oname') {
          const S = els.oname;
          if (m.code === 'name_registered') { setMode('login'); S.pw.focus(); } // 가입된 이름 = 로그인 탭으로
          else if (m.code === 'login_failed' || m.code === 'pw_bad') { S.pw.value = ''; S.pw.focus(); }
          else if (/^(name_taken|name_bad|acct_exists)$/.test(m.code)) S.name.focus();
        }
        if (m.code === 'acct_required' && scr === 'olobby') { const it = els.olobby.ldItems[2]; if (it && els.olobby.list.includes(it)) { idx.olobby = els.olobby.list.indexOf(it); render(); } } // 손님 래더 = 가입 버튼으로 커서
        if (m.code === 'ranked_locked' && scr === 'olobby') render();
    }
  }
  function loadLs() { if (window.NKLockstep || lsLoad) return; lsLoad = true; const sc = document.createElement('script'); sc.src = 'online_lockstep.js'; sc.onerror = () => { lsLoad = false; }; document.head.appendChild(sc); }
  function buildPrint() { // 지문(ready.build): 엔진·워커·구동기·이 층(구동 계획)·락스텝·시작 상태·ROM 의 SHA-1. 양쪽이 같은 서버 파일을 받으면 같다
    if (net.buildP) return net.buildP;
    const fs = ['/engine/core.js', '/engine/gen/code.js', '/engine/render.js', '/engine/apu.js', 'worker.js', 'menu_driver.js', 'ui_manga.js', 'online_lockstep.js', '/state/boot_title.json', '/rom/nekketsu.nes'];
    return net.buildP = Promise.all(fs.map(u => pfetch(u, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.arrayBuffer(); })))
      .then(bs => { const n = bs.reduce((a, b) => a + b.byteLength, 0), all = new Uint8Array(n); let o = 0; for (const b of bs) { all.set(new Uint8Array(b), o); o += b.byteLength; } return crypto.subtle.digest('SHA-1', all); })
      .then(h => 'w1:' + Array.from(new Uint8Array(h)).map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 24))
      .catch(e => { net.buildP = null; throw e; });
  }
  function enterOnline() {
    loadLs(); buildPrint().catch(() => { /* 준비 때 다시 */ });
    if (net.ws && net.ws.readyState === 1 && net.name) return toLobby();
    openName(aStore.acct && !net.acctOff ? 'login' : 'guest', oStore.name || net.name || '');
    if (Object.keys(aStore.tokens).length) /* 저장한 토큰이 있을 때만 주소를 미리 찾는다(없으면 종전처럼 입장 때) */ wsUrl().then(u => { const tk = aStore.tokens[u]; if (!tk || net.acctOff) return; net.auto = true; ensureConn().then(() => { if (net.auto && active && scr === 'oname' && !net.name) nsend({ t: 'hello', token: tk }); else net.auto = false; }, () => { net.auto = false; }); }, () => { /* 주소 없음 = 손님 입력 그대로 */ });
  }
  function openName(mode, name) { // 접속 화면 열기(탭·이름 미리 채움). 초점 = 이름(계정 탭이고 이름이 있으면 비밀번호)
    const S = els.oname; S.name.value = name || ''; S.pw.value = ''; if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur(); idx.oname = 0; setMode(mode); go('oname');
    setTimeout(() => { if (active && scr === 'oname') (oa.mode !== 'guest' && S.name.value ? S.pw : S.name).focus(); }, 0);
  }
  function setMode(m, user) { // 탭 바꾸기: 손님 = 비밀번호 칸 숨김. 버튼 글자 = 입장 / 로그인 / 가입. user = 누른 탭(초점을 입력 칸으로)
    if (net.acctOff && m !== 'guest') { if (user) toast(OERR.acct_off); m = 'guest'; }
    oa.mode = m; const S = els.oname; if (!S) return;
    S.enter.textContent = m === 'guest' ? '입장' : m === 'login' ? '로그인' : '가입'; S.pw.autocomplete = m === 'register' ? 'new-password' : 'current-password'; S.name.autocomplete = m === 'guest' ? 'off' : 'username';
    if (m === 'guest') S.pw.value = '';
    if (user) (m !== 'guest' && S.name.value ? S.pw : S.name).focus();
    if (active && scr === 'oname') render();
  }
  function nameSubmit() {
    const f = els.oname.name, v = (f.value || '').normalize('NFC').replace(/ +/g, ' ').trim(), mode = oa.mode, pw = els.oname.pw.value;
    if (!NAME_RE.test(v)) { toast(OERR.name_bad, 'hp-low'); f.focus(); return; }
    if (mode !== 'guest') { if (!pw) { toast(OERR.pw_empty, 'hp-low'); els.oname.pw.focus(); return; } if (mode === 'register' && (pw.length < 6 || pw.length > 64)) { toast(OERR.pw_bad, 'hp-low'); els.oname.pw.focus(); return; } }
    net.auto = false;
    ensureConn().then(() => {
      if (mode === 'guest') { const sid = oStore.sids[net.url] || ''; return nsend(Object.assign({ t: 'hello', name: v }, /^[0-9a-f]{32}$/.test(sid) ? { sid } : null)); }
      nsend({ t: mode, name: v, pw }); // 비밀번호는 서버로만 보낸다(로그·저장소에 남기지 않음). welcome 을 받으면 칸을 비운다
    }, () => toast('서버에 연결할 수 없습니다', 'hp-low'));
  }
  function toLobby() {
    net.room = null; cdSet(null); net.noHs = false; net.stAt = 0; /* 방마다 다시 판정(시작 기능이 꺼진 서버면 다음 방에서 또 host_start_off) */ if (net.inv !== undefined && net.inv !== null) { net.invWait = net.inv; net.inv = null; } /* 초대 링크로 왔다: 다음 rooms 목록을 받으면 그 방에 1회 참가(invJoin) */ if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur(); idx.olobby = -1; /* 첫 내용 줄(탭 다음) */ if (active) go('olobby'); else open('olobby'); nsend({ t: 'lobby', on: true });
    if (!net.acctOff && (!net.ls || Date.now() - net.lsAt > 5000)) nsend({ t: 'ladder_status' }); // DB 없는 서버 = acct_off(조용히 탭 숨김)
  }
  const ladderOut = () => { if (net.lq && net.lq.queued) { nsend({ t: 'ladder_leave' }); net.lq = { queued: false }; } }; // 래더 대기 중 다른 탭·랭킹으로 = 줄에서 빠진다(유령 대기 방지)
  function setTab(k) { if (k !== 'ladder') ladderOut(); lobbyTab = k; try { localStorage.setItem('nk_lobby_tab', k); } catch (e) { /* 이번 세션만 */ } if (k === 'ladder' && !net.acctOff && (!net.ls || Date.now() - net.lsAt > 5000)) nsend({ t: 'ladder_status' }); render(); }
  function ladderJoin() { // 손님도 보낸다 → 서버 acct_required 토스트 + 가입 버튼으로 커서. 잠금 중이면 보내지 않고 토스트
    const u = net.account ? lockLeft() : 0; if (u) return toast(lockText(u), 'hp-low');
    nsend({ t: 'ladder_join' });
  }
  function openRank() { if (net.acctOff) return; ladderOut(); idx.orank = 0; els.orank.rows.scrollTop = 0; go('orank'); if (!net.board || Date.now() - net.boardAt > 15000) nsend({ t: 'ladder_board', top: 50 }); }
  function onlineTick() { // 0.5초: 글자만 갱신(래더 대기 시간·시즌·잠금 분). 대기 화면에서만
    if (active && scr === 'oroom') return roomTtl();
    if (!active || scr !== 'olobby' || lobbyTab !== 'ladder' || net.acctOff) return;
    const P = els.olobby.ld, q = net.lq;
    if (q && q.queued) { const w = Math.max(0, Math.floor((sNow() - (q.since || sNow())) / 1000)); P.qT.textContent = '상대 찾는 중 ' + Math.floor(w / 60) + ':' + String(w % 60).padStart(2, '0'); }
    P.season.textContent = seasonText(net.ls && net.ls.season); const u = net.account ? lockLeft() : 0; P.lock.textContent = u ? lockShort(u) : '';
  }
  // 방 고르기(목록 줄): 가득 찬 방·대전 중인 방은 흐리게 두고 누르면 이유 토스트, 그 밖 = join{code}
  const roomWhy = r => r.state === 'playing' ? '대전 중인 방입니다' : (r.seats | 0) >= (r.humans | 0) ? '가득 찬 방입니다' : '';
  function pickRoom(r) { const w = roomWhy(r); if (w) return toast(w, 'hp-low'); nsend({ t: 'join', code: r.code }); }
  // 초대 링크(통키 invite.js 방식): 「친구 초대」 = location 기준 링크 복사 → 토스트. 방 안 = ?room=코드(들어오면 그 방 참가), 로비 = ?online=1(온라인 로비로).
  //   링크에는 방 코드만 넣는다(이름·sid·토큰 없음). ?ws= 는 포트 번호일 때만 이어 붙인다(개발·검증 서버). 받는 쪽: 부팅 때 주소창에서 읽어 sessionStorage 에 두고 쿼리를 지운다 → 타이틀이 뜨면 온라인 입장 → 로비 rooms 를 받으면 1회 참가
  const INV_KEY = 'nk_invite', INV_RE = /^[A-Z0-9]{4}$/; // 서버 newCode = 4글자
  (function invCapture() {
    let u; try { u = new URL(location.href); } catch (e) { return; }
    const p = u.searchParams; if (!p.has('room') && !p.has('online')) return;
    const c = String(p.get('room') || '').trim().toUpperCase(), v = INV_RE.test(c) ? c : p.get('online') === '1' || p.has('room') ? '*' : ''; // 형식이 틀린 방 코드 = 로비로만
    try { if (v) sessionStorage.setItem(INV_KEY, v); } catch (e) { /* 저장 불가 = 무시 */ }
    p.delete('room'); p.delete('online'); try { history.replaceState(history.state, '', u.pathname + (p.toString() ? '?' + p : '') + u.hash); } catch (e) { /* 무시 */ }
  })();
  function invRun() { // 타이틀이 뜰 때(show): 대기 중인 초대가 있으면 꺼내(1회) 온라인 입장
    let v = null; try { v = sessionStorage.getItem(INV_KEY); sessionStorage.removeItem(INV_KEY); } catch (e) { /* 없음 */ }
    if (v !== '*' && !INV_RE.test(v || '')) return;
    net.inv = v === '*' ? '' : v; setTimeout(() => { if (active && scr === 'title') enterOnline(); }, 0);
  }
  function invJoin() { // 로비에서 rooms 를 받은 직후 1회: 목록에 있고 가득/대전 중이면 토스트, 그 밖 = join(없는 방은 서버 noroom 토스트)
    const c = net.invWait; net.invWait = null; if (!c || net.room) return;
    const r = net.rooms.find(x => x.code === c); if (r && roomWhy(r)) return toast(roomWhy(r), 'hp-low');
    nsend({ t: 'join', code: c });
  }
  function copyInvite(code) {
    const ws = (/[?&]ws=(\d{2,5})(&|$)/.exec(location.search) || [])[1], q = [];
    if (code) { if (!INV_RE.test(code)) return; q.push('room=' + code); } else q.push('online=1');
    if (ws) q.push('ws=' + ws);
    const url = location.origin + location.pathname + '?' + q.join('&'); net.invUrl = url;
    const done = ok => toast(ok ? '초대 링크를 복사했습니다' : '링크를 복사하지 못했습니다', ok ? 'hp' : 'hp-low');
    const fb = () => { const a = document.activeElement, ta = document.createElement('textarea'); ta.value = url; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0'; document.body.appendChild(ta); let ok = false; try { ta.select(); ta.setSelectionRange(0, url.length); ok = document.execCommand('copy'); } catch (e) { ok = false; } ta.remove(); if (a && a.focus && a !== document.body) a.focus({ preventScroll: true }); return ok; };
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(() => done(true), () => done(fb())); else done(fb());
  }
  function createRoom() { nsend({ t: 'create', title: (els.ocreate.tin.value || '').trim(), opts: Object.assign({ stage: oc.stage, rule: oc.rule }, oc.humans > 2 ? { humans: oc.humans } : null) }); } // 2인은 종전 메시지 그대로(humans 없음 = 서버 기본 2)
  const owner = c => net.room ? net.room.seats.findIndex(x => x && x.char === c) : -1;
  function pickCell(i) {
    const R = net.room; if (!R) return; if (net.count) return toast(LOCKT); const o = owner(i); if (o === R.you) return nsend({ t: 'pick', char: -1 }); if (o >= 0) return toast(OERR.char_taken); nsend({ t: 'pick', char: i });
    if (oPl()) { og.zone = 'side'; idx.oroom = els.oroom.list.indexOf(els.oroom.mainIt); render(); } // 세로: 고르면 시트를 닫는다
  }
  // ── 대기방 4인 개편(analysis/25 4·7절): 방장 시작·카운트다운·이유 토스트·자리 당기기·랜덤·자리별 CPU·세로 배치 ──
  const SWHY = { seat_empty: '빈 자리가 있습니다', offline: '접속이 끊긴 사람이 있습니다', nochar: '캐릭터를 고르지 않은 사람이 있습니다', not_ready: '준비하지 않은 사람이 있습니다', build: '버전이 다른 사람이 있습니다' }; // err{code:'start'}.why
  const CWHY = Object.assign({ unready: '준비가 풀려 시작 취소', leave: '나간 사람이 있어 시작 취소', drop: '연결이 끊겨 시작 취소', host_cancel: '방장이 시작을 취소했습니다' }, ...Object.keys(SWHY).map(k => ({ [k]: '시작 취소 · ' + SWHY[k] }))); // count{cancel}.why
  const LOCKT = '시작하는 중에는 바꿀 수 없습니다';
  const oPl = () => scr === 'oroom' && window.innerHeight > window.innerWidth * 1.1; // 세로 화면의 대기방 = 세로 전용 배치(논리 600x1300)
  const hostMode = () => { const R = net.room; return !!R && net.proto >= 3 && !net.noHs && !(net.lm && net.lm.code === R.code); }; // 방장 시작 서버의 자리 방(래더 방 = 종전 자동 시작)
  const canStart = (S, H) => S.slice(0, H).every((x, i) => x && x.kind === 'human' && !!x.name && x.on !== false && x.char >= 0 && (i === 0 || x.ready)); // 버튼 흐림 표시용(판단은 서버)
  function roomMain() { // 큰 버튼: 방장 = 시작 / 카운트다운 중 취소, 그 밖 = 준비 토글
    const R = net.room; if (!R) return;
    if (R.you === 0 && hostMode()) { // 시작 연타: 응답(count·err) 전 두 번째 클릭은 버림, count 직후 0.7초 안 클릭(= 같은 연타)은 취소로 보내지 않음
      if (net.count) { if (Date.now() - (net.cntAt || 0) < 700) return; net.stAt = 0; net.stLast = 'cancel'; net.cxAt = Date.now(); return nsend({ t: 'start', cancel: true }); }
      if ((net.stAt && Date.now() - net.stAt < 3000) || Date.now() - (net.cxAt || 0) < 700) return; // cxAt = 취소를 보내거나 받은 시각(취소 연타·서버 취소와 겹친 클릭이 새 시작이 되지 않게)
      net.stAt = Date.now(); net.stLast = 'build'; return buildPrint().then(b => nsend({ t: 'start', build: b }), () => { net.stAt = 0; toast('파일을 읽지 못했습니다', 'hp-low'); }); }
    readyToggle();
  }
  function roomCard(i) { // 자리 카드 누름: 내 카드 = 캐릭터 고르기(세로 = 시트 열기), CPU 카드(방장) = CPU 캐릭터 바꾸기
    const R = net.room; if (!active || busy || scr !== 'oroom' || !R || i < 0) return; const x = R.seats[i];
    if (i === R.you) { if (net.count) return toast(LOCKT); og.zone = 'grid'; if (x && x.char >= 0) og.cur = x.char; return render(); }
    if (x && x.kind !== 'human' && R.you === 0 && !R.opts.ranked && !net.count) cpuAdj(i - roomH(), 1);
  }
  function cdSet(ms) { clearTimeout(net.cdTm); net.cdTm = 0; net.count = ms === null ? null : { at: Date.now(), ms }; cdTick(); }
  function cdTick() { const s = els.oroom, c = net.count; if (!s || !s.cd) return; s.cd.classList.toggle('on', !!c); if (!c) return; const left = c.at + c.ms - Date.now(); s.cdN.textContent = left > 0 ? String(Math.ceil(left / 1000)) : ''; if (left > 0) net.cdTm = setTimeout(cdTick, Math.min(250, left)); }
  const ro = n => [0, 3, 6].includes(n % 10) ? '으로' : '로';
  function chgToast(cs) { // peers.changes → 토스트(내가 바꾼 설정은 알리지 않는다)
    const t = []; let host = false;
    for (const c of cs) {
      const v = c && c.value, who = String(c && c.who || '');
      if (c.key === 'left') t.push(who + ' 나감');
      else if (c.key === 'host') { host = true; t.push(who === net.name ? '내가 방장' : who + ' 님이 방장'); }
      else if (who === net.name) continue;
      else if (c.key === 'stage') t.push(v < 0 ? '스테이지 랜덤' : '스테이지 ' + (v + 1) + ro(v + 1) + ' 변경');
      else if (c.key === 'rule') t.push(v < 0 ? '룰 랜덤' : '룰: ' + ruleName(v) + roK(ruleName(v)) + ' 변경');
      else if (c.key === 'humans') t.push('사람 ' + v + '명');
      else if (c.key === 'cpu') t.push('CPU 변경');
    }
    if (t.length && active && scr === 'oroom') toast(t.join(' · '), host ? 'focus' : null, 2400);
  }
  const RL = { // 대기방 배치 [가로(1280x720), 세로(600x1300)]. 카드·창·색은 종전 그대로, 자리만 옮긴다
    gw: [[32, 84, 516, 556], [8, 600, 584, 592]], g0: [[56, 100], [66, 666]], sht: [[0, 0], [24, 610]], cd: [[564, 84, 684, 254], [16, 148, 568, 516]], setW: [[564, 352, 684, 288], [8, 676, 584, 508]],
    rowH: [[580, 358, 420, 56], [24, 864, 448, 56]], rowS: [[580, 413, 340, 56], [24, 922, 448, 56]], rndS: [[928, 417, 72, 48], [480, 926, 96, 48]], rowR: [[580, 468, 340, 56], [24, 980, 448, 56]], rndR: [[928, 472, 72, 48], [480, 984, 96, 48]],
    rowC0: [[580, 523, 420, 56], [24, 1038, 448, 56]], rowC1: [[580, 578, 420, 56], [24, 1096, 448, 56]], sth: [[1060, 360, 128, 96], [24, 692, 213, 160]], ruleT: [[0, 0], [252, 700, 324]],
    main: [[1016, 468, 216, 88], [16, 1204, 400, 88]], chr: [[0, 0], [428, 1204, 156, 88]], inv: [[1056, 20, 192, 48], [300, 76, 136, 60]], leave: [[1016, 568, 216, 56], [448, 76, 136, 60]], shX: [[0, 0], [516, 606, 64, 52]], pbar: [[0, 0], [0, 1192, 600, 108]], ttl: [[600, 674], [16, 1150]] };
  function roomLayout(s, pl) {
    s.pl = pl; const j = pl ? 1 : 0, A = (e, k) => abs(e, ...RL[k][j]);
    A(s.gw, 'gw'); A(s.sht, 'sht'); A(s.cd, 'cd'); A(s.setW, 'setW'); A(s.rowH, 'rowH'); A(s.rowS, 'rowS'); A(s.rndS.el, 'rndS'); A(s.rowR, 'rowR'); A(s.rndR.el, 'rndR'); A(s.rowC[0], 'rowC0'); A(s.rowC[1], 'rowC1');
    A(s.sth, 'sth'); A(s.ruleT, 'ruleT'); A(s.ready, 'main'); A(s.chrEl, 'chr'); A(s.invEl, 'inv'); A(s.leaveEl, 'leave'); A(s.shX, 'shX'); A(s.pbar, 'pbar'); A(s.ttl, 'ttl');
    const g = s.g0 = RL.g0[j]; s.cells.forEach((e, i) => abs(e, g[0] + 120 * (i & 3), g[1] + 131 * (i >> 2)));
    s.seats.forEach((c, i) => {
      const r = pl ? [16 + 288 * (i & 1), 148 + 262 * (i >> 1), 280, 254] : [564 + 172 * i, 84, 164, 254], cx = (r[2] - 148) / 2; abs(c.w, ...r); abs(c.cut, cx, 8, 142, 142); // 세로 = 같은 카드(초상 위·글자 아래)를 넓게 2x2
      abs(s.addB[i].el, r[0] + (r[2] - 110) / 2, r[1] + 214, 110, 34); abs(s.xB[i].el, r[0] + cx + 108, r[1] + 12, 34, 34);
    });
  }
  function cpuAdj(j, d) { // CPU 자리: 자동(-1) → 남은 캐릭터 순서로 돈다(다른 자리와 겹치는 캐릭터는 건너뛴다)
    const S = net.room.seats, H = roomH(), at = H + j; if (at > 3 || !S[at]) return; // CPU 자리 = 사람 자리 뒤(자리 H … 3). set{cpu} 길이 = 4 − H
    const cur = S[at].char, used = new Set(S.filter((x, i) => i !== at && x.char >= 0).map(x => x.char)), vs = [-1]; for (let c = 0; c < 16; c++) if (!used.has(c)) vs.push(c);
    const cpu = S.slice(H, 4).map(x => x.char); cpu[j] = vs[(Math.max(0, vs.indexOf(cur)) + d + vs.length) % vs.length]; nsend({ t: 'set', cpu });
  }
  function readyToggle() {
    const R = net.room, me = R && R.seats[R.you]; if (!me) return;
    if (me.char < 0) return toast(OERR.nochar);
    const on = !me.ready; buildPrint().then(b => nsend({ t: 'ready', on, build: b }), () => toast('파일을 읽지 못했습니다', 'hp-low'));
  }
  function startBattle(cfg) { // start: 시합 준비 컷을 띄우고 game.js 에 넘긴다(구동 중 덮개)
    const R = net.room; if (!R || !cfg || !cfg.plan) return;
    if (!window.NKLockstep) { nsend({ t: 'leave' }); return toast('온라인 모듈을 읽지 못했습니다', 'hp-low'); }
    const s = els.vs, ch = cfg.chars || [], H = cfg.humans >= 2 && cfg.humans <= 4 ? cfg.humans | 0 : 2, names = [0, 1, 2, 3].map(i => i < H && R.seats[i] && R.seats[i].name ? String(R.seats[i].name) : '');
    s.strip.textContent = 'STAGE ' + ((cfg.stage | 0) + 1) + ' · ' + ruleLab(cfg.rule | 0);
    s.cuts.forEach((c, i) => { const id = ch[i] | 0; cvar(c, 'sch' + (id >> 2)); c.im.src = face(id); c.tag.textContent = ''; chip(c.tag, orole(i, H)[0], orole(i, H)[1]); c.tag.appendChild(document.createTextNode(names[i] || cname(id))); });
    net.playing = true; net.lostAt = 0; net.rr = null; net.game = { H, names, chars: [0, 1, 2, 3].map(i => ch[i] | 0), stage: Number.isInteger(cfg.stage) ? cfg.stage : -1, rule: Number.isInteger(cfg.rule) ? cfg.rule : -1 }; setGone(null); if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur(); busy = true; root.classList.add('busy'); go('vs');
    const ok = onPick('online', { cfg, slot: R.you, names, send: nsend, attach: sink => { net.sink = sink; } });
    if (ok !== true) { net.playing = false; net.sink = null; net.game = null; busy = false; root.classList.remove('busy'); nsend({ t: 'leave' }); toLobby(); toast('시작할 수 없습니다', 'hp-low'); }
  }
  // 대전 끝(game.js 가 엔진을 처음부터 다시 만든 뒤 부른다). m = 서버 end(또는 끊김 { reason: 'lost' | 'error' }), slot = 내 자리
  function onlineEnd(m, slot) {
    const G = net.game; net.playing = false; net.sink = null; net.room = null; net.game = null; setGone(null); clearTimeout(net.rjTm); net.rjTm = 0; net.lostAt = 0; if (btoast) btoast.classList.remove('on');
    const r = m && m.reason, w = m && Number.isInteger(m.winner) ? m.winner : -1; let t = '무승부', sub = '', win = false;
    oe.wn = r === 'result' && m.agree !== false && w >= 0 && w < 4 && w !== slot && G ? { role: orole(w, G.H), name: w < G.H ? G.names[w] || OROLE[w][0] : 'CPU', ch: cname(G.chars[w]) } : null; // 승부가 난 판에서 내가 이기지 않았으면 승자(이름·자리 딱지, CPU 면 「CPU」)를 알린다
    if (r === 'result') { if (m.agree === false) { t = '무효'; sub = '양쪽 결과가 달라 인정되지 않았습니다'; } else if (w === slot) { t = '승리!'; win = true; } else if (w >= 0) t = '패배'; }
    else if (r === 'forfeit') { // 3·4인(17 문서 5.1): 내가 빠지면 나에게만 winner −1·loser = 나, 남은 사람이 1명 이하가 되면 winner = 남은 자리(없으면 −1)·left = 빠진 자리 목록. 2인(left 없음)은 종전 그대로
      const out = m.loser === slot || (Array.isArray(m.left) && m.left.includes(slot));
      if (out) { t = '패배'; sub = (m.loser === slot && OWHY[m.why]) || '연결 끊김으로 기권 처리'; } else if (w === slot || !Array.isArray(m.left)) { t = '승리!'; win = true; sub = '상대 기권'; } else { t = '중단'; sub = '상대 기권'; } }
    else { t = '중단'; sub = r === 'lost' || r === 'error' ? '연결이 끊겼습니다' : r === 'stall' ? (m.why === 'slow' ? '양쪽 진행이 너무 느렸습니다' : '양쪽 입력이 멈췄습니다') : r === 'timeout' ? '시간 초과' : ''; }
    oe.title = t; oe.sub = sub; oe.win = win; const kind = t === '승리!' ? 'win' : t === '패배' ? 'lose' : t === '무승부' ? 'draw' : '';
    oe.card = kind && G ? { kind, ch: G.chars[slot] | 0, nick: String(net.name || ''), stage: G.stage, rule: G.rule, sec: hud.t > 0 ? Math.floor(hud.t / 60.0988) : 0 } : null; // 결과 카드(R1) 자료: 이 판에서 이미 아는 값만
    for (const n of Object.keys(idx)) idx[n] = 0; open('oend'); unlockFlush(); // 대전 중에 받은 ranking_result.unlocked = 결과 화면에서 한 줄
  }
  function oback() {
    if (scr === 'oprof') return profBack();
    if (scr === 'orank' || (scr === 'oname' && net.ws && net.ws.readyState === 1 && net.name)) return toLobby(); // 접속 화면을 로비의 「가입」으로 연 때 = 로비로
    if (scr === 'oname' || scr === 'olobby') { const ws = net.ws; net.ws = null; net.room = null; net.inv = net.invWait = null; /* 초대 포기 */ net.account = false; net.auto = false; net.lq = { queued: false }; net.name = ''; net.who = ''; net.lockUntil = 0; els.oname.pw.value = ''; if (ws) try { ws.close(1000); } catch (e) { /* 무시 */ } if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur(); if (scr === 'oname' && storyBackFromName()) return; idx.title = 0; return go('title'); }
    if (scr === 'ocreate') { if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur(); return go('olobby'); }
    if (scr === 'oroom' && oPl() && og.zone === 'grid') { og.zone = 'side'; idx.oroom = els.oroom.list.indexOf(els.oroom.mainIt); return render(); } // 세로: 뒤로 = 캐릭터 시트 닫기
    if (scr === 'oroom') { nsend({ t: 'leave' }); return toLobby(); }
    if (scr === 'oend') { if (net.ws && net.ws.readyState === 1 && net.name) return toLobby(); return enterOnline(); }
  }
  const oOff = it => !!(it && it.off && it.off());
  function omove(dx, dy) {
    const s = els[scr], L = s.list, k = scr;
    if (k === 'oroom' && og.zone === 'grid') {
      if (dx > 0 && (og.cur & 3) === 3 && !oPl()) { og.zone = 'side'; if (oOff(L[idx.oroom])) idx.oroom = L.findIndex(it => !oOff(it)); }
      else og.cur = (((og.cur >> 2) + dy + 4) & 3) * 4 + (((og.cur & 3) + dx + 4) & 3);
      return render();
    }
    if (k === 'orank' && dy) { s.rows.scrollTop += dy * 60; return; } // 랭킹: ↑↓ = 표 넘기기
    if (k === 'oprof' && profMove(dx, dy)) return;
    const it = L[idx[k]];
    if (dx) {
      if (it && it.adj && !oOff(it)) { it.adj(dx); return render(); }
      if (it && it.row) { const R = L.filter(x => x.row === it.row && !oOff(x)), n = R[R.indexOf(it) + dx]; if (n) { idx[k] = L.indexOf(n); oFocus(); return render(); } } // 같은 줄(탭·버튼 줄)의 옆 항목
      if (k === 'oroom' && dx < 0 && !oPl()) { og.zone = 'grid'; return render(); }
      if (k === 'olobby' && it) { const want = (it.col || 0) + dx, j = L.findIndex(x => (x.col || 0) === want); if (j >= 0) { idx[k] = j; oFocus(); } return render(); }
      if (!dy) return;
    }
    if (!dy || !L.length) return;
    let i = idx[k]; for (let n = 0; n < L.length; n++) { i = (i + dy + L.length) % L.length; if (!oOff(L[i]) && !(it && it.row && L[i].row === it.row)) break; } // ↑↓ 는 같은 줄(탭) 안에서 멈추지 않는다
    idx[k] = i; oFocus(); render();
  }
  function oFocus() { const it = els[scr].list[idx[scr]], a = document.activeElement; if (it && it.input) it.el.focus(); else if (a && root.contains(a)) a.blur(); }
  function oconfirm() {
    if (scr === 'oroom' && og.zone === 'grid') return pickCell(og.cur);
    const it = els[scr].list[idx[scr]]; if (!it || oOff(it)) return;
    if (it.input) { it.el.focus(); return; } if (it.act) it.act(); else if (it.adj) { it.adj(1); render(); }
  }
  function okey(e) { // 온라인 화면 키: 입력 칸에서는 글자·조합은 브라우저에 맡기고 Enter = 실행, Esc = 뒤로, ↑↓ = 커서 이동
    if (e.isComposing || e.keyCode === 229) return;
    const c = e.code, t = e.target;
    if (t && t.tagName === 'INPUT') {
      if (c === 'Enter' || c === 'NumpadEnter') { e.preventDefault(); if (busy || e.repeat) return; const it = els[scr].list.find(x => x.el === t); if (it && it.act) it.act(); }
      else if (c === 'Escape') { e.preventDefault(); t.blur(); if (!busy) oback(); }
      else if (c === 'ArrowUp' || c === 'ArrowDown') { e.preventDefault(); if (!busy) omove(0, c === 'ArrowUp' ? -1 : 1); }
      return;
    }
    const mk = menuKey(c), dy = mk.dy, dx = mk.dx;
    const ok = mk.ok, bk = mk.bk;
    if (!dx && !dy && !ok && !bk) return;
    e.preventDefault(); if (busy) return;
    if (dx || dy) omove(dx, dy); else if (!e.repeat) { if (ok) oconfirm(); else oback(); }
  }
  function renderOnline() {
    const s = els[scr];
    if (scr === 'olobby') renderLobby(s);
    else if (scr === 'ocreate') { s.list[1].el.val.textContent = 'STAGE ' + (oc.stage + 1); s.list[2].el.val.textContent = ruleLab(oc.rule); s.hum.val.textContent = oc.humans + '인'; s.thumb.style.backgroundImage = 'url(/ui/stage_' + STAGE_ID[oc.stage] + '.png)'; s.ruleT.textContent = RULES[oc.rule]; s.tin.placeholder = net.name ? net.name + '의 방' : '제목'; }
    else if (scr === 'oroom') renderRoom(s);
    else if (scr === 'oend') { s.big.textContent = oe.title; s.big.classList.toggle('win', oe.win); if (oe.card) s.big.dataset.r = oe.card.kind; else delete s.big.dataset.r; s.sub.textContent = oe.sub; const w = oe.wn; s.wn.textContent = ''; if (w) { el('span', '', s.wn, '승자'); chip(s.wn, w.role[0], w.role[1]); el('b', '', s.wn, w.name); if (w.ch) el('span', '', s.wn, w.ch); } renderRR(s); }
    else if (scr === 'oname') { s.tabs.forEach(t => { t.el.classList.toggle('sel', t.mode === oa.mode); t.el.style.display = net.acctOff && t.mode !== 'guest' ? 'none' : ''; }); const g = oa.mode === 'guest'; s.pw.style.display = s.pwLab.style.display = g ? 'none' : ''; }
    else if (scr === 'orank') renderRank(s);
    else if (scr === 'oprof') renderProf(s);
    const grid = scr === 'oroom' && og.zone === 'grid';
    s.list.forEach((it, i) => { it.el.classList.toggle('cur', !grid && i === idx[scr]); it.el.classList.toggle('off', oOff(it)); });
  }
  function renderLobby(s) {
    s.me.textContent = net.name; s.me.style.left = 32 + s.headEl.offsetWidth + 16 + 'px';
    const me = net.account && net.ls ? net.ls.me : null; s.meK.textContent = ''; s.meK.style.left = 32 + s.headEl.offsetWidth + 16 + s.me.offsetWidth + 8 + 'px'; // 내 이름 옆: 손님 / 티어(배치 n/5)
    if (!net.acctOff) { if (!net.account) chip(s.meK, '손님', 'com', true); else if (me) tierChip(s.meK, me.tier, me.placement, me.placementLeft); }
    const ld = lobbyTab === 'ladder' && !net.acctOff, cur = s.list[idx.olobby], curCode = cur && cur.code;
    const list = net.rooms, sig = JSON.stringify(list);
    if (s.sig !== sig) { // 목록이 바뀔 때만 줄을 다시 만든다(커서는 같은 방 코드에 남긴다)
      s.sig = sig; s.rows.textContent = ''; const rows = [];
      list.forEach(r => {
        const e = el('div', 'nko-row' + (r.state === 'playing' ? ' play' : roomWhy(r) ? ' full' : ''), s.rows); e.dataset.id = 'room_' + r.code; e.setAttribute('role', 'button');
        el('span', '', e, String(r.title || '')); el('span', '', e, String(r.host || '')); el('span', '', e, (r.seats | 0) + '/' + (r.humans | 0)); el('span', '', e, r.state === 'playing' ? '대전 중' : '대기');
        { const st = Number.isInteger(r.stage) ? r.stage : 0, ru = Number.isInteger(r.rule) ? r.rule : 1, c = el('span', 'nko-rs', e), th = el('i', 'nko-rth' + (st < 0 ? ' rnd' : ''), c); if (st >= 0 && st < 7) th.style.backgroundImage = 'url(/ui/stage_' + STAGE_ID[st] + '.png)'; el('b', '', c, st < 0 ? '랜덤' : 'STAGE ' + (st + 1)); el('em', '', c, ruleName(ru)).title = ruleLab(ru); } // 스테이지 썸네일(/ui/stage_N.png, 랜덤 = ?) · 룰
        const it = oPush(s, 'olobby', e, { act: () => pickRoom(r), col: 0 }, rows); it.code = r.code;
      });
      s.rowItems = rows;
    }
    s.tabs.forEach(t => { t.el.style.display = net.acctOff ? 'none' : ''; t.el.classList.toggle('sel', (t.tab === 'ladder') === ld); });
    s.th.style.display = s.rows.style.display = ld ? 'none' : ''; s.ld.style.display = ld ? '' : 'none'; s.empty.style.display = !ld && !list.length ? '' : 'none';
    s.rankIt.el.style.display = s.profIt.el.style.display = net.acctOff ? 'none' : ''; s.outIt.el.style.display = net.account ? '' : 'none';
    if (ld) renderLadder(s);
    const body = ld ? s.ldItems.filter(x => x.el.style.display !== 'none') : s.rowItems;
    s.list = (net.acctOff ? [] : s.tabs).concat(body, s.fixed); // 순서: 탭 → 방 목록(또는 래더) → 오른쪽 버튼
    let j = curCode ? s.list.findIndex(x => x.code === curCode) : cur ? s.list.indexOf(cur) : -1;
    if (j < 0 || oOff(s.list[j])) j = body.length ? s.list.indexOf(body[0]) : s.list.indexOf(s.fixed[0]); // 처음 들어옴(idx −1)·항목이 사라짐 = 첫 내용 줄
    idx.olobby = j;
    const it = s.list[idx.olobby]; if (it && it.code) { const e = it.el, R = s.rows; if (e.offsetTop < R.scrollTop) R.scrollTop = e.offsetTop; else if (e.offsetTop + e.offsetHeight > R.scrollTop + R.clientHeight) R.scrollTop = e.offsetTop + e.offsetHeight - R.clientHeight; }
  }
  function renderLadder(s) { // 래더 탭(내 현황 + 대기열). 대기 시간 글자는 onlineTick 이 0.5초마다 바꾼다
    const P = s.ld, ls = net.ls, me = net.account && ls ? ls.me : null, q = net.lq && net.lq.queued, u = net.account ? lockLeft() : 0;
    P.badge.textContent = '';
    if (!net.account) chip(P.badge, '손님', 'com', true);
    else if (me) { tierChip(P.badge, me.tier, me.placement, me.placementLeft); el('b', '', P.badge, String(me.rating | 0)); }
    P.wl.textContent = me ? (me.w | 0) + '승 ' + (me.l | 0) + '패' + (me.rank ? ' · ' + me.rank + '위' : '') : '';
    P.q.style.display = q ? '' : 'none'; P.join.style.display = q ? 'none' : ''; P.cancel.style.display = q ? '' : 'none'; P.signup.style.display = !net.account && !q ? '' : 'none';
    P.join.classList.toggle('dim', !net.account || !!u);
    if (q) { const w = net.lq.window; P.qS.textContent = '허용 차 ' + (Number.isFinite(w) ? '±' + w : '제한 없음') + ' · 대기 ' + (net.lq.waiting | 0) + '명'; }
    onlineTick();
  }
  function renderRank(s) {
    const B = net.board, top = B && Array.isArray(B.top) ? B.top : [], me = B && B.me ? B.me : null;
    s.season.textContent = seasonText((B && B.season) || (net.ls && net.ls.season)); s.season.style.display = s.season.textContent ? '' : 'none'; s.season.style.left = 32 + s.headEl.offsetWidth + 16 + 'px';
    const row = (e, x) => { e.textContent = ''; el('span', '', e, x.rank ? String(x.rank) : '-'); el('span', '', e, String(x.nick || '')); tierChip(el('span', '', e), x.tier, x.placement === true, x.placementLeft); el('span', '', e, String(x.rating | 0)); el('span', '', e, (x.w | 0) + '승 ' + (x.l | 0) + '패'); };
    const sig = JSON.stringify(B && [top, me]); if (s.sig !== sig) {
      s.sig = sig; s.rows.textContent = '';
      top.forEach(x => { const e = el('div', 'nko-row nko-rk-row nko-pf' + (me && x.nick === me.nick ? ' me' : ''), s.rows); row(e, x); e.dataset.id = 'rk_' + String(x.nick || ''); e.addEventListener('click', () => { if (active && !busy && scr === 'orank') openProfile(String(x.nick || '')); }); }); // 줄 누름 = 그 사람 프로필(읽기 전용)
      s.empty.textContent = B ? '기록이 없습니다' : '불러오는 중'; s.empty.style.display = top.length ? 'none' : '';
      s.mine.style.display = me ? '' : 'none'; if (me) row(s.mine, me); // 내 줄 = 표 아래 고정(배치 중 = 순위 「-」 + 배치 n/5)
    }
  }
  function renderRR(s) { // ranking_result: 1줄 = 레이팅 전 → 후 + 변동(미반영이면 사유), 2줄 = 티어(승급·강등·배치 완료) 또는 배치 n/5
    const r = net.rr; s.rr.style.display = r ? '' : 'none'; s.rr1.textContent = ''; s.rr2.textContent = ''; if (!r) return;
    if (r.counted) { el('span', '', s.rr1, '레이팅 ' + (r.before | 0) + ' → '); el('b', '', s.rr1, String(r.after | 0)); const d = r.delta | 0; chip(s.rr1, (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d), d > 0 ? 'hp' : d < 0 ? 'hp-low' : 'com'); }
    else { el('span', '', s.rr1, '레이팅 변동 없음'); chip(s.rr1, r.dispute ? RWHY.DISPUTE : RWHY[r.why] || RWHY.VOID, 'com', true); }
    tierChip(s.rr2, r.tier, r.placement, r.placementLeft);
    const a = TIER_ORDER.indexOf(r.tierBefore), b = TIER_ORDER.indexOf(r.tier);
    if (b >= 0 && a < 0 && !r.placement) chip(s.rr2, '배치 완료', 'focus'); else if (a >= 0 && b > a) chip(s.rr2, '승급', 'focus'); else if (a >= 0 && b >= 0 && b < a) chip(s.rr2, '강등', 'hp-low');
    if (r.lockUntil > sNow()) chip(s.rr2, lockShort(r.lockUntil), 'hp-low', true);
  }
  // ── 프로필(analysis/27 P4, 서버 계약 = analysis/22 11절): 초상 판 + 닉네임·칭호·티어 / 탭 「전적 · 칭호 · 꾸미기」. 목록·잠금 조건·장착은 서버 profile 응답이 원본(전체 카탈로그 + got)
  //   장착 = profile_set(미획득은 화면에서 잠금·선택 불가, 서버 거부 = 토스트). 타인(랭킹 줄) = 읽기 전용(전적·칭호). 손님 = 전부 잠금. 받을 때·누를 때만 다시 그린다(프레임 비용 없음)
  //   판(web/img/profile/manifest.json): 24x24, 배경 → 얼굴(16x17 at 4,4, 가장자리 보라 176,98,236 만 투명) → 프레임 → 스탬프(9x9 at 18,18, 넘침). 정수배 n: 4 = 4x 파일, 3 = 1x 파일 확대(2x 는 잔장식이 뭉개져 안 씀)
  const PF_KIND = { title: '칭호', frame: '프레임', bg: '배경', stamp: '스탬프' }, PF_LIST = { title: 'titles', frame: 'frames', bg: 'bgs', stamp: 'stamps' }, PF_EQ = { title: 'title', frame: 'frame', bg: 'portrait_bg', stamp: 'portrait_stamp' }, PF_SUB = ['title', 'frame', 'bg', 'stamp'];
  const PERR = { bad: '프로필 미지원', acct_off: '프로필 미지원', acct_required: '로그인이 필요합니다', rate: OERR.rate, name_bad: '없는 계정입니다', profile_none: '없는 계정입니다', down: '서버에 연결할 수 없습니다', timeout: '서버 응답이 없습니다' };
  const PF_SEEN = 'nk_prof_seen', TUT_SENT = 'nk_tut_sent';
  const pf = { back: 'title', nick: null, data: null, tab: 'stats', sub: 'frame', wait: '', tm: 0, tut: false, fresh: new Set(), seen0: null, pend: [], q: [], req: 0 }; // q = 보낸 프로필 계열 요청 순서(get·set·tut·chl·chc, 응답·오류를 보낸 순서로 짝짓는다), req = 프로필 받기 차례(닫고 다시 열면 앞 차례 무시) // wait = 'get' | 'set'(응답 대기), tut = tutorial_done 대기, fresh = 새 항목(kind:id), pend = 대전 중에 받은 획득 알림
  const PL = { back: [[1056, 20, 192, 48], [448, 12, 136, 68]], card: [[32, 84, 1216, 148], [8, 92, 584, 196]], hp: [[60, 108], [28, 112]], nm: [[188, 100, 1000], [152, 108, 424]], ttl: [[188, 146, 1000], [152, 160, 424]], tier: [[188, 186, 1000], [152, 210, 424]],
    tab: [[32, 248, 188, 56, 200], [8, 300, 140, 68, 146]], body: [[32, 316, 1216, 324], [8, 380, 584, 912]], stats: [[56, 336, 1168, 284], [24, 400, 552, 600]], boxT: [[56, 332, 1168, 292], [24, 396, 552, 880]], boxD: [[248, 332, 976, 292], [24, 484, 552, 792]],
    sub: [[56, 336, 168, 56, 0, 68], [24, 396, 128, 72, 140, 0]], empty: [[32, 452, 1216], [8, 620, 584]] }; // 배치 [가로 1280x720, 세로 600x1300]. tab·sub 다섯째·여섯째 = 칸 간격(가로·세로)
  const pfFace = nick => { if (!nick) return 0; let h = 0; for (const c of String(nick).toLowerCase()) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 16; }; // 계정마다 고정된 원작 얼굴(닉네임 해시, 손님 = 쿠니오). 초상 고르기는 카탈로그에 없다(가정)
  const pfKeyed = {};
  function pfFaceImg(img, id) { // 얼굴 = 원작 HUD 16x17 에서 가장자리와 이어진 보라 바탕만 투명(4연결 채우기, 얼굴 픽셀 그대로). 만들기 전·실패 = 원본 그대로
    img.dataset.f = id; const u = pfKeyed[id]; img.src = typeof u === 'string' ? u : face(id); if (u) return;
    pfKeyed[id] = 1; const im = new Image();
    im.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = 16; c.height = 17; const x = c.getContext('2d'); x.drawImage(im, 0, 0);
        const d = x.getImageData(0, 0, 16, 17), p = d.data, seen = new Uint8Array(272), st = [];
        for (let i = 0; i < 16; i++) st.push(i, 256 + i); for (let j = 0; j < 17; j++) st.push(j * 16, j * 16 + 15);
        while (st.length) { const k = st.pop(); if (seen[k]) continue; seen[k] = 1; const o = k * 4; if (p[o] !== 176 || p[o + 1] !== 98 || p[o + 2] !== 236 || p[o + 3] !== 255) continue; p[o + 3] = 0; const cx = k % 16, cy = (k / 16) | 0; if (cx > 0) st.push(k - 1); if (cx < 15) st.push(k + 1); if (cy > 0) st.push(k - 16); if (cy < 16) st.push(k + 16); }
        x.putImageData(d, 0, 0); const url = pfKeyed[id] = c.toDataURL('image/png');
        root.querySelectorAll('img[data-f="' + id + '"]').forEach(e => { e.src = url; });
      } catch (e) { delete pfKeyed[id]; }
    };
    im.onerror = () => { delete pfKeyed[id]; }; im.src = face(id);
  }
  function pfPlate(parent, n, eq, fid) { // 판 1장(정수배 n). eq = { frame, portrait_bg, portrait_stamp }
    const p = el('div', 'nkpf-plate', parent), f = n === 4 ? 4 : 1; p.style.setProperty('--n', n);
    const ok = v => typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v); // 서버 id 만 경로에 넣는다(그 밖 = 기본 판)
    const L = (c, k, id) => { const i = el('img', c, p); i.alt = ''; i.draggable = false; if (k && ok(id)) i.src = '/img/profile/' + k + '/' + id + '_' + f + 'x.png'; return i; };
    L('b', 'bg', ok(eq.portrait_bg) ? eq.portrait_bg : 'default'); pfFaceImg(L('f'), fid); L('r', 'frame', ok(eq.frame) ? eq.frame : 'default'); if (ok(eq.portrait_stamp)) L('s', 'stamp', eq.portrait_stamp);
    return p;
  }
  function buildProfile() {
    const s = els.oprof = el('div', 'nkm-scr nko nkpf', stageEl); s.list = []; s.tiles = []; s.headEl = head(s, '프로필');
    s.card = el('div', 'nkm-win', s); s.hp = el('div', 'nkpf-hp', s); s.nm = el('div', 'nkpf-nm', s); s.ttl = el('div', 'nkpf-ttl', s); s.tier = el('div', 'nkpf-tier', s);
    s.tabs = [['stats', '전적'], ['titles', '칭호'], ['deco', '꾸미기'], ['chal', '도전']].map(([k, t]) => { const it = oBtn(s, 'oprof', 'tab_' + k, t, [0, 0, 0, 0], () => { // 도전(analysis/27 P4b) = 내 계정만. 손님 = 토스트(탭 그대로)
      if (k === 'chal') { if (!pf.data) return; if (pf.data.guest) return toast('로그인이 필요합니다', 'hp-low'); }
      pf.tab = k; s.box.scrollTop = 0; if (k === 'chal') chGet(); render(); }, { row: 'tab', off: () => (k === 'deco' || k === 'chal') && !!pf.data && !pf.data.self }); it.el.classList.add('nko-tab'); it.tab = k; return it; });
    s.backIt = oBtn(s, 'oprof', 'back', '뒤로', [0, 0, 0, 0], profBack);
    s.body = el('div', 'nkm-win', s); s.stats = el('div', 'nkpf-stats', s);
    s.st = ['통산 승', '통산 패', '승률', '최고 연승', '시즌 참가', '로그인 일수'].map(t => { const c = el('div', 'nkpf-st', s.stats); el('span', '', c, t); c.v = el('b', '', c, '—'); return c; });
    s.box = el('div', 'nkpf-box', s); // 칭호 목록 · 꾸미기 격자(세로 넘침 = 스크롤)
    s.subs = PF_SUB.map(k => { const it = oBtn(s, 'oprof', 'sub_' + k, PF_KIND[k], [0, 0, 0, 0], () => { pf.sub = k; s.box.scrollTop = 0; render(); }); it.sub = k; it.el.classList.add('nkpf-sub'); return it; });
    s.empty = el('div', 'nko-empty', s, '불러오는 중'); foot(s, '', true);
    profLayout(s, false);
  }
  function profLayout(s, pl) {
    s.pl = pl; const j = pl ? 1 : 0, P = k => PL[k][j];
    abs(s.backIt.el, ...P('back')); abs(s.card, ...P('card')); abs(s.hp, ...P('hp')); abs(s.nm, ...P('nm')); abs(s.ttl, ...P('ttl')); abs(s.tier, ...P('tier')); abs(s.body, ...P('body')); abs(s.stats, ...P('stats')); abs(s.empty, ...P('empty'));
    const t = P('tab'), u = P('sub'); s.tabs.forEach((it, i) => abs(it.el, t[0] + t[4] * i, t[1], t[2], t[3])); s.subs.forEach((it, i) => abs(it.el, u[0] + u[4] * i, u[1] + u[5] * i, u[2], u[3]));
    s.hsig = ''; if (active && scr === 'oprof') renderProf(s);
  }
  function openProfile(nick) { // nick 없음 = 나(손님이면 전부 잠금), nick = 그 계정(읽기 전용). 뒤로 = 온 곳(타이틀·로비·랭킹)
    if (busy) return;
    if (scr === 'olobby') ladderOut();
    pf.back = scr === 'olobby' || scr === 'orank' ? scr : 'title'; pf.nick = nick || null; pf.data = null; pf.tab = 'stats'; pf.sub = 'frame'; pf.fresh = new Set(); pf.seen0 = null; ch.data = null; chDone();
    const s = els.oprof; s.sig = ''; s.hsig = ''; s.box.scrollTop = 0; idx.oprof = 0; go('oprof'); profGet();
  }
  const toP = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej({ code: 'timeout' }), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); }); // 연결·자동 로그인 대기 상한
  function pq(kind, msg) { pf.q.push(kind); if (pf.q.length > 8) pf.q.shift(); nsend(msg); } // 프로필 계열 요청 보내기(응답·오류 짝 = 보낸 순서)
  function pqTake(kind) { const i = pf.q.indexOf(kind); if (i < 0) return false; pf.q.splice(i, 1); return true; }
  function profGet() {
    const r = ++pf.req, ask = () => { if (pf.req !== r || !(active && scr === 'oprof')) return; pfWait('get'); pq('get', Object.assign({ t: 'profile_get' }, pf.nick ? { nick: pf.nick } : null)); }; // 앞 차례(닫고 다시 연 경우)의 대기는 보내지 않는다
    if (net.ws && net.ws.readyState === 1) return ask(); // 접속 중(손님 이름 포함) = 그 세션 그대로
    toP(ensureAcct(), 10000).then(a => { if (pf.req !== r) return; if (!a && sx.tokFail && !pf.nick) toast('자동 로그인 실패 · 손님으로 봅니다', 'hp-low', 2400); ask(); }, e => { if (pf.req === r) profFail(e); }); // 접속 전 = 저장한 토큰이 있으면 자동 로그인, 없으면 손님(hello 없이 조회). 10초 = 토스트 + 온 곳으로
  }
  function pfWait(w) { pf.wait = w; clearTimeout(pf.tm); pf.tm = setTimeout(() => { if (!pf.wait) return; const g = pf.wait === 'get'; pfDone(); if (g) profFail({ code: 'timeout' }); else toast(PERR.timeout, 'hp-low'); }, 8000); }
  function pfDone() { pf.wait = ''; clearTimeout(pf.tm); pf.tm = 0; }
  function profAbort() { pfDone(); pf.tut = false; pf.q = []; chDone(); }
  function profFail(e) { pfDone(); if (!(active && scr === 'oprof')) return; if (!pf.data) profBack(); toast(PERR[e && e.code] || '오류', 'hp-low'); } // 처음 받기 실패 = 온 곳으로 + 토스트
  function profBack() {
    pfDone(); pf.req++; chDone(); const on = !!(net.ws && net.ws.readyState === 1 && net.name);
    if (pf.back === 'orank' && on && !net.acctOff) { go('orank'); if (!net.board) nsend({ t: 'ladder_board', top: 50 }); return; }
    if (pf.back === 'olobby' || pf.back === 'orank') return on ? toLobby() : enterOnline();
    idx.title = 2; go('title');
  }
  function profNet(m) {
    if (m.t === 'tutorial_done') {
      pqTake('tut'); pf.tut = false; if (net.account) tutMark(); unlockToast(m.unlocked);
      if (Array.isArray(m.unlocked) && m.unlocked.length && active && scr === 'oprof' && pf.data && pf.data.self && !pf.wait) profGet(); return;
    }
    if (m.t === 'profile_set') { pqTake('set'); if (pf.wait === 'set') pfDone(); if (pf.data && pf.data.self && m.equipped) { pf.data.equipped = m.equipped; if (active && scr === 'oprof') render(); } return; }
    if (!pqTake('get') || pf.wait !== 'get') return; // profile: 보낸 요청의 답만
    const want = pf.nick ? !m.self && String(m.nick || '').toLowerCase() === pf.nick.toLowerCase() : !!m.self; if (!want) return; // 지금 연 대상(나 · 그 계정)과 다르면 무시
    pfDone(); pf.data = m; if (m.self && !m.guest) pfSeen(m);
    if (active && scr === 'oprof') { if (!m.self && (pf.tab === 'deco' || pf.tab === 'chal')) pf.tab = 'stats'; render(); }
  }
  const PQ_ERR = { get: /^(bad|acct_off|acct_required|rate|name_bad|profile_none)$/, set: /^(bad|acct_off|acct_required|rate|profile_bad)$/, tut: /^(bad|acct_off|acct_required|rate)$/, chl: /^(bad|acct_off|acct_required|rate)$/, chc: /^(bad|acct_off|acct_required|rate|challenge_bad)$/ };
  function profErr(m) { // 프로필 계열 요청(보낸 순서의 맨 앞)의 오류만 가로챈다(그 밖 = 종전 처리). 구서버(모르는 메시지) = bad → 「프로필 미지원」
    const c = m.code, k = pf.q[0]; if (!k || !PQ_ERR[k].test(c)) return false;
    pf.q.shift(); if (c === 'acct_off') net.acctOff = true;
    if (k === 'tut') { pf.tut = false; return true; } // 튜토리얼 완료 보고 실패 = 조용히(로컬 tutok 은 그대로, 다음 로그인·완료 때 다시)
    if (k === 'chl' || k === 'chc') { chErr(m); return true; }
    if (k === 'get') { if (pf.wait === 'get') profFail(m); return true; }
    if (pf.wait === 'set') pfDone();
    if (c === 'profile_bad') { toast(m.why === 'locked' ? '아직 얻지 못한 항목입니다' : m.why === 'unknown' ? '알 수 없는 항목입니다' : '바꿀 항목이 없습니다', 'hp-low'); if (active && scr === 'oprof') profGet(); return true; } // 서버 기준으로 다시 받기
    toast(PERR[c] || String(m.msg || c), 'hp-low'); return true;
  }
  // ── 일일·주간 도전(analysis/27 P4b, 서버 계약 = analysis/22 11.5절): 프로필 「도전」 탭. 진행도·기간은 서버 challenge_list 가 원본, 받기 = challenge_claim(서버 재검증·멱등)
  const ch = { data: null, wait: '', tm: 0 }, CHBAD = { notyet: '아직 달성하지 못했습니다', expired: '기간이 바뀌었습니다', unknown: '알 수 없는 도전입니다' };
  const chOn = () => !!(net.ws && net.ws.readyState === 1);
  function chWait(w) { ch.wait = w; clearTimeout(ch.tm); ch.tm = setTimeout(() => { if (!ch.wait) return; chDone(); toast(PERR.timeout, 'hp-low'); if (active && scr === 'oprof') render(); }, 8000); }
  function chDone() { ch.wait = ''; clearTimeout(ch.tm); ch.tm = 0; }
  function chGet() { if (ch.wait === 'list') return; if (!chOn()) return toast(PERR.down, 'hp-low'); chWait('list'); pq('chl', { t: 'challenge_list' }); }
  function chClaim(c, period) {
    const D = pf.data; if (!D || !D.self) return; if (D.guest) return toast('로그인이 필요합니다', 'hp-low');
    if (!c.done || c.claimed || ch.wait) return; if (!chOn()) return toast(PERR.down, 'hp-low');
    chWait('claim'); pq('chc', { t: 'challenge_claim', id: c.id, period });
  }
  function chNet(m) {
    if (m.t === 'challenge_list') { if (!pqTake('chl')) return; if (ch.wait === 'list') chDone(); ch.data = m; if (Number.isFinite(m.serverTime)) net.skew = m.serverTime - Date.now(); if (active && scr === 'oprof') render(); return; }
    if (!pqTake('chc')) return; if (ch.wait === 'claim') chDone(); // challenge_claim: already = 이미 받음(두 번째 받기 = 아무 일 없음)
    const D = ch.data; if (D) for (const k of ['daily', 'weekly']) for (const c of (D[k] && D[k].period === m.period && D[k].list) || []) if (c.id === m.id) c.claimed = true;
    if (!m.already) { if (Array.isArray(m.unlocked) && m.unlocked.length) { unlockToast(m.unlocked); if (pf.data && pf.data.self && !pf.wait) profGet(); } else toast('받았습니다', 'focus'); }
    if (active && scr === 'oprof') render();
  }
  function chErr(m) {
    chDone();
    if (m.code === 'challenge_bad') { toast(CHBAD[m.why] || '받을 수 없습니다', 'hp-low'); chGet(); return; } // 서버 기준으로 다시 받기(기간이 바뀌었으면 새 기간 목록)
    toast(m.code === 'bad' || m.code === 'acct_off' ? '도전 미지원' : PERR[m.code] || String(m.msg || m.code), 'hp-low'); if (active && scr === 'oprof') render();
  }
  const chLeft = end => { const ms = (+end || 0) - sNow(); return ms <= 0 ? '' : ms >= 864e5 ? Math.floor(ms / 864e5) + '일 남음' : ms >= 36e5 ? Math.floor(ms / 36e5) + '시간 남음' : Math.max(1, Math.ceil(ms / 6e4)) + '분 남음'; };
  function renderChal(s, guest) { // 도전 탭 본문: 일일 · 주간 두 칸(세로 화면 = 위아래로 쌓임). 줄 = 이름·조건 / 진행 막대 n/goal / 보상 칭호 / 받기(달성·미수령만 커서·누름)
    if (!ch.data) { el('div', 'nkpf-chw', s.box, guest ? '로그인이 필요합니다' : ch.wait ? '불러오는 중' : '—'); return; }
    const w = el('div', 'nkpf-chs', s.box);
    for (const [k, lab] of [['daily', '일일'], ['weekly', '주간']]) {
      const P = ch.data[k]; if (!P || !Array.isArray(P.list)) continue;
      const col = el('div', 'nkpf-chc', w), h = el('div', 'nkpf-chh', col); el('b', '', h, lab); el('span', '', h, chLeft(P.endsAt));
      for (const c of P.list) {
        const goal = Math.max(1, c.goal | 0), pr = Math.max(0, Math.min(goal, c.progress | 0)), can = !!c.done && !c.claimed;
        const r = el('div', 'nkpf-ch' + (c.claimed ? ' got' : c.done ? ' done' : ''), col); r.dataset.id = 'ch_' + String(c.id || '');
        el('b', 'nm', r, String(c.name || '')); el('span', 'd', r, String(c.desc || ''));
        const g = gauge(r, c.done ? 'hp' : 'focus', goal, 1); g.classList.add('bar'); g.fill.style.transition = 'none'; g.fill.style.width = pr / goal * 100 + '%';
        el('span', 'n', r, pr + '/' + goal); el('span', 'rw', r, c.reward && c.reward.name ? String(c.reward.name) : '');
        const b = el('div', 'nkm-btn nkpf-chb' + (can ? '' : ' off'), r, c.claimed ? '받음' : '받기'); b.dataset.id = 'chb_' + String(c.id || ''); b.setAttribute('role', 'button');
        if (can) oPush(s, 'oprof', b, { act: () => chClaim(c, P.period), tile: true }, s.tiles);
      }
    }
  }
  function pfSeen(m) { // 내 프로필: 지난번 열어 본 서버 시각 뒤에 얻은 항목(at) = 새 항목(시즌 종료 일괄 지급은 알림이 없어 여기서만 보인다)
    let o = {}; try { const j = JSON.parse(localStorage.getItem(PF_SEEN) || 'null'); if (j && typeof j === 'object') o = j; } catch (e) { /* 이번 세션만 */ }
    const k = (net.url || '') + '|' + String(m.nick || '').toLowerCase(); if (pf.seen0 === null) pf.seen0 = Number.isFinite(o[k]) ? o[k] : 0;
    for (const kind of PF_SUB) for (const i of m[PF_LIST[kind]] || []) if (i && i.got && Number.isFinite(i.at) && i.at > pf.seen0) pf.fresh.add(kind + ':' + i.id);
    delete o[k]; o[k] = Math.max(pf.seen0, +m.serverTime || 0); const ks = Object.keys(o); if (ks.length > 16) delete o[ks[0]];
    try { localStorage.setItem(PF_SEEN, JSON.stringify(o)); } catch (e) { /* 이번 세션만 */ }
  }
  function pfPick(kind, it) { // 꾸미기 칸 누름. it = 카탈로그 원소 | null(해제 = 칭호·스탬프 없음)
    const D = pf.data; if (!D || !D.self) return;
    if (D.guest) return toast('로그인이 필요합니다', 'hp-low');
    if (it && !it.got) return toast('잠김 · ' + (it.desc || ''));
    const f = PF_EQ[kind], v = it ? it.id : null; if ((D.equipped[f] || null) === v || pf.wait) return;
    if (!(net.ws && net.ws.readyState === 1)) return toast(PERR.down, 'hp-low');
    pfWait('set'); pq('set', { t: 'profile_set', [f]: v });
  }
  function profMove(dx, dy) { // 칭호 탭 ↑↓ = 목록 넘기기, 꾸미기 칸 ←→ = 이웃 칸
    const s = els.oprof, it = s.list[idx.oprof];
    if (pf.tab === 'titles' && dy) { s.box.scrollTop += dy * 60; return true; }
    if (dx && it && it.tile) { const T = s.tiles, n = T[T.indexOf(it) + dx]; if (n) { idx.oprof = s.list.indexOf(n); render(); } return true; }
    return false;
  }
  function renderProf(s) {
    const D = pf.data, guest = !!(D && D.guest), eq = (D && D.equipped) || { title: null, frame: 'default', portrait_bg: 'default', portrait_stamp: null }, st = D && D.stats;
    const fid = pfFace(D ? (guest ? '' : D.nick) : pf.nick), hs = [eq.frame, eq.portrait_bg, eq.portrait_stamp, fid].join('|');
    if (s.hsig !== hs) { s.hsig = hs; s.hp.textContent = ''; pfPlate(s.hp, 4, eq, fid); }
    s.nm.textContent = D ? String(D.nick || (guest ? net.name || '손님' : '')) : String(pf.nick || '');
    s.ttl.textContent = ''; const T = D && eq.title ? (D.titles || []).find(x => x.id === eq.title) : null; if (T) chip(s.ttl, T.name, 'focus');
    s.tier.textContent = ''; if (guest) chip(s.tier, '손님', 'com', true); else if (st && Number.isInteger(st.rating)) { tierChip(s.tier, st.tier, !!st.placement); el('b', '', s.tier, String(st.rating)); }
    const fr = k => [...pf.fresh].some(x => k.includes(x.split(':')[0]));
    s.tabs.forEach(t => { t.el.classList.toggle('sel', t.tab === pf.tab); t.el.style.display = oOff(t) ? 'none' : ''; t.el.classList.toggle('new', t.tab === 'titles' ? fr(['title']) : t.tab === 'deco' ? fr(['frame', 'bg', 'stamp']) : false); });
    const tab = pf.tab; s.stats.style.display = tab === 'stats' && D ? '' : 'none'; s.box.style.display = tab !== 'stats' && D ? '' : 'none'; s.empty.style.display = D ? 'none' : '';
    s.subs.forEach(it => { it.el.style.display = tab === 'deco' && D ? '' : 'none'; it.el.classList.toggle('sel', it.sub === pf.sub); });
    abs(s.box, ...PL[tab === 'deco' ? 'boxD' : 'boxT'][s.pl ? 1 : 0]);
    if (tab === 'stats') { const v = st ? [st.w, st.l, Number.isFinite(st.winRate) ? st.winRate + '%' : null, st.maxStreak, st.seasons, st.loginDays] : []; s.st.forEach((c, i) => { const x = v[i]; c.v.textContent = x === null || x === undefined ? '—' : String(x); }); }
    const sig = tab + '|' + pf.sub + '|' + fid + '|' + [...pf.fresh].join() + '|' + JSON.stringify(D && [D.titles, D.frames, D.bgs, D.stamps, D.equipped, D.self, D.guest]) + (tab === 'chal' ? '|' + ch.wait + JSON.stringify(ch.data) : '');
    if (s.sig !== sig) {
      s.sig = sig; s.box.textContent = ''; s.tiles = [];
      if (D && tab === 'chal') renderChal(s, guest);
      if (D && tab === 'titles') for (const x of D.titles || []) { // 칭호: 전체 카탈로그. 잠긴 항목 = 달성 조건 한 줄
        const r = el('div', 'nkpf-row' + (x.got ? ' got' : ''), s.box); r.dataset.id = 'tt_' + x.id; el('b', '', r, x.name);
        if (x.got) chip(r, eq.title === x.id ? '장착' : '획득', eq.title === x.id ? 'focus' : 'hp', eq.title !== x.id); else el('span', 'd', r, x.desc || '');
        if (pf.fresh.has('title:' + x.id)) chip(r, '새 항목', 'focus');
      }
      if (D && tab === 'deco') { // 꾸미기: 고른 종류의 칸(판 미리보기 3x). 칭호·스탬프는 「없음」 칸이 맨 앞
        const k = pf.sub, L = D[PF_LIST[k]] || [], cur = eq[PF_EQ[k]] || null, g = el('div', 'nkpf-grid', s.box);
        (k === 'title' || k === 'stamp' ? [null] : []).concat(L).forEach(it => {
          const id = it ? it.id : null, lock = !!it && !it.got, e = el('div', 'nkm-btn nkpf-tile' + (k === 'title' ? ' tt' : '') + (lock || guest ? ' lock' : '') + (cur === id ? ' on' : ''), g);
          e.dataset.id = k + '_' + (id || 'none'); e.setAttribute('role', 'button');
          if (k !== 'title') { const q = Object.assign({}, eq, { portrait_stamp: null }); if (k === 'frame') q.frame = id; else if (k === 'bg') q.portrait_bg = id; else q.portrait_stamp = id; pfPlate(e, 3, q, fid); }
          el('span', 'nm', e, it ? it.name : '없음'); if (lock) el('i', 'nkpf-lock', e, '잠김');
          if (pf.fresh.has(k + ':' + id)) chip(e, '새', 'focus').classList.add('nkpf-new');
          oPush(s, 'oprof', e, { act: () => pfPick(k, it), tile: true }, s.tiles);
        });
      }
    }
    const cur = s.list[idx.oprof], curId = cur && cur.el.dataset.id;
    s.list = s.tabs.filter(t => !oOff(t)).concat(D && tab === 'deco' ? s.subs.concat(s.tiles) : D && tab === 'chal' ? s.tiles : [], [s.backIt]);
    let j = curId ? s.list.findIndex(x => x.el.dataset.id === curId) : -1; if (j < 0) j = s.list.findIndex(x => x.tab === pf.tab); idx.oprof = Math.max(0, j);
    const ci = s.list[idx.oprof]; if (ci && ci.tile) { const e = ci.el.closest('.nkpf-ch') || ci.el, B = s.box; if (e.offsetTop < B.scrollTop) B.scrollTop = e.offsetTop; else if (e.offsetTop + e.offsetHeight > B.scrollTop + B.clientHeight) B.scrollTop = e.offsetTop + e.offsetHeight - B.clientHeight; } // 키보드 커서 칸이 보이게
  }
  function unlockToast(a, ms) { // 새 획득(welcome·ranking_result·story_saved·tutorial_done 의 unlocked[]) = 기존 토스트 한 줄. 대전 중 = 결과 화면에서
    if (!Array.isArray(a)) return; const L = a.filter(u => u && PF_KIND[u.kind] && typeof u.name === 'string').sort((x, y) => (x.kind === 'title' ? 0 : 1) - (y.kind === 'title' ? 0 : 1)); if (!L.length) return;
    if (net.playing) { pf.pend.push(...L); return; }
    setTimeout(() => toast(PF_KIND[L[0].kind] + ' 획득: ' + L[0].name + (L.length > 1 ? ' 외 ' + (L.length - 1) : ''), 'focus', 3200), ms || 60); // 화면 전환(go = 토스트 지움) 뒤에 띄운다
  }
  function unlockFlush() { const a = pf.pend.splice(0); if (a.length) unlockToast(a, 400); }
  // 튜토리얼 완료(web/tutorial.js onDone) → 로그인 상태면 tutorial_done(계정당 1회, 「신입 열혈」). 손님 = 보내지 않음(로컬 tutok 유지). 저장한 토큰만 있으면 자동 로그인 뒤 보낸다
  const tutKey = () => (net.url || '') + '|' + String(net.name || '').toLowerCase();
  const tutSent = () => { try { const j = JSON.parse(localStorage.getItem(TUT_SENT) || 'null'); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } };
  function tutMark() { const o = tutSent(), k = tutKey(); delete o[k]; o[k] = 1; const ks = Object.keys(o); if (ks.length > 16) delete o[ks[0]]; try { localStorage.setItem(TUT_SENT, JSON.stringify(o)); } catch (e) { /* 이번 세션만 */ } }
  function tutReport() {
    const send = () => { if (!net.account || !(net.ws && net.ws.readyState === 1) || pf.tut || tutSent()[tutKey()]) return; pf.tut = true; pq('tut', { t: 'tutorial_done' }); };
    if (net.account) return send();
    if (net.acctOff || net.playing || (net.ws && net.ws.readyState === 1 && net.name) || !Object.keys(aStore.tokens).length) return; // 손님 접속 중·토큰 없음 = 보내지 않음
    wsUrl().then(u => { if (aStore.tokens[u]) ensureAcct().then(a => { if (a) send(); }, () => { /* 서버 없음 = 보내지 않음 */ }); }, () => { /* 주소 없음 */ });
  }
  if (window.NKTutorial) window.NKTutorial.onDone = () => tutReport();
  const pfState = () => { const D = pf.data; return { tab: pf.tab, sub: pf.sub, wait: pf.wait, back: pf.back, tut: pf.tut, nick: D ? D.nick : null, self: D ? D.self : null, guest: D ? D.guest : null, equipped: D ? Object.assign({}, D.equipped) : null, stats: D && D.stats ? Object.assign({}, D.stats) : null, got: D ? Object.keys(PF_LIST).reduce((o, k) => { o[k] = (D[PF_LIST[k]] || []).filter(i => i.got).map(i => i.id); return o; }, {}) : null, count: D ? (D.titles || []).length : 0, fresh: [...pf.fresh] }; };
  function renderRoom(s) {
    const R = net.room; if (!R) return; const S = R.seats || [], me = R.you, H = roomH(), pl = oPl(), hs = hostMode(), host = me === 0 && hs, cd = !!net.count;
    if (s.pl !== pl) roomLayout(s, pl);
    s.classList.toggle('sheet', pl && og.zone === 'grid'); s.classList.toggle('cdn', cd); cdTick();
    s.headEl.textContent = String(R.title || '');
    s.cells.forEach((e, i) => {
      const o = owner(i), t = o >= 0; e.classList.toggle('taken', t); e.classList.toggle('mine', o === me); e.nm.textContent = cname(i);
      if (t) { const ro = orole(o, H); e.tag.textContent = ro[0]; cvar(e.tag, ro[1]); e.style.setProperty('--pc', 'var(--' + ro[1] + ')'); }
    });
    s.brk.style.display = og.zone === 'grid' ? '' : 'none'; abs(s.brk, s.g0[0] + 120 * (og.cur & 3) - 7, s.g0[1] + 131 * (og.cur >> 2) - 7); s.brk.style.setProperty('--g', 'var(--' + (OROLE[me] || OROLE[0])[1] + ')');
    s.seats.forEach((c, i) => {
      const x = S[i] || { kind: 'cpu', char: -1 }, id = x.char, hum = x.kind === 'human';
      c.w.classList.toggle('me', i === me); c.who.textContent = hum ? OROLE[i][0] : OCOM[0]; cvar(c.who, hum ? OROLE[i][1] : OCOM[1]); c.cut.classList.toggle('anon', !(id >= 0)); c.im.style.display = id >= 0 ? '' : 'none';
      if (id >= 0) { c.im.src = face(id); cvar(c.cut, 'sch' + (id >> 2)); } else c.cut.style.removeProperty('--c');
      c.nm.textContent = hum ? (x.name ? String(x.name) : '빈 자리') : 'CPU'; c.nm.classList.toggle('dim', hum && !x.name);
      c.ch.textContent = id >= 0 ? cname(id) : hum ? '—' : '자동';
      c.st.textContent = ''; // 하단 띠 = 상태 딱지 1개(방장 시작 방의 방장 = 「방장」, 끊김 > 방장 > 준비 완료/대기 · CPU = 컴퓨터 · 빈 자리)
      const st = hum && x.name ? (x.on === false ? ['끊김', 'hp-low'] : i === 0 && hs ? ['방장', 'focus'] : x.ready ? ['준비 완료', 'hp'] : ['대기', 'com', 1]) : hum ? (s.addB[i] && !oOff(s.addB[i]) ? null : ['빈 자리', 'com', 1]) : ['컴퓨터', 'com', 1];
      if (st) chip(c.st, st[0], st[1], !!st[2]);
      c.hb.style.display = i === 0 && hum && x.name && !hs ? '' : 'none'; // 자동 시작 방의 방장 = 초상 위 딱지
      s.addB[i].el.style.display = oOff(s.addB[i]) ? 'none' : ''; s.xB[i].el.style.display = oOff(s.xB[i]) ? 'none' : '';
      const rk = !!(R.opts && R.opts.ranked) && hum && !!x.name; c.rk.textContent = ''; c.rk.style.display = rk ? '' : 'none'; // 랭크·래더 방: 계정 = 티어(배치 n/5) + 레이팅, 손님 = 「손님」
      if (rk) { if (x.account) { tierChip(c.rk, x.tier, x.placement, x.placementLeft); el('b', '', c.rk, String(x.rating | 0)); } else chip(c.rk, '손님', 'com', true); }
    });
    const sg = R.opts.stage | 0, ru = R.opts.rule | 0;
    s.rowH.val.textContent = H + '인'; s.rowS.val.textContent = sg < 0 ? '랜덤' : 'STAGE ' + (sg + 1); s.rowR.val.textContent = ruleLab(ru); s.rowR.title = ru < 0 ? '' : RULES[ru] || '';
    s.rndS.el.classList.toggle('sel', sg < 0); s.rndR.el.classList.toggle('sel', ru < 0);
    s.sth.classList.toggle('rnd', sg < 0); s.sth.style.backgroundImage = sg >= 0 && sg < 7 ? 'url(/ui/stage_' + STAGE_ID[sg] + '.png)' : 'none'; s.sthB.textContent = sg >= 0 ? String(sg + 1) : ''; s.sthB.style.display = sg >= 0 ? '' : 'none';
    s.ruleT.textContent = ru < 0 ? '' : RULES[ru] || '';
    s.rowC.forEach((e, j) => { const x = H + j < 4 ? S[H + j] : null; e.style.display = x ? '' : 'none'; e.val.textContent = x && x.char >= 0 ? cname(x.char) : '자동'; }); // CPU 줄 수 = 4 − 사람 수
    const mi = s.list.indexOf(s.mainIt); if (og.zone !== 'grid' && (!s.list[idx.oroom] || s.list[idx.oroom].el.style.display === 'none' || oOff(s.list[idx.oroom]) && !s.list[idx.oroom].adj)) idx.oroom = mi; // 커서가 있던 줄·버튼이 없어짐 → 큰 버튼으로
    const mine = S[me], ok = canStart(S, H);
    s.ready.textContent = host ? (cd ? '취소' : '시작') : mine && mine.ready ? '준비 취소' : '준비'; s.ready.dataset.id = host ? 'start' : 'ready'; s.ready.classList.toggle('dim', host && !cd && !ok); s.ready.classList.toggle('nko-go', host && !cd && ok);
    roomTtl();
    s.hint.textContent = cd ? '' : mine && mine.char < 0 ? '캐릭터를 골라 주세요' : host ? (ok ? '' : '모두 준비하면 시작') : mine && !mine.ready ? '준비를 눌러 주세요' : '';
  }
  const oItemId = () => scr === 'oroom' && og.zone === 'grid' ? IDS[og.cur] : els[scr].list[idx[scr]] ? els[scr].list[idx[scr]].el.dataset.id : '';
  function onlineState() { const R = net.room; return { conn: !!(net.ws && net.ws.readyState === 1), url: net.url, name: net.name, rooms: net.rooms.map(r => ({ code: r.code, title: r.title, host: r.host, seats: r.seats, state: r.state, stage: r.stage, rule: r.rule })), room: R ? { code: R.code, you: R.you, title: R.title, seats: R.seats.map(x => ({ kind: x.kind, name: x.name, char: x.char, ready: x.ready, on: x.on })), opts: R.opts, hostStart: hostMode(), counting: !!net.count, cdText: els.oroom ? els.oroom.cdN.textContent : '' } : null, playing: net.playing, zone: og.zone, cursor: og.cur, end: oe.title, endSub: oe.sub, winner: oe.wn ? { who: oe.wn.role[0], name: oe.wn.name, ch: oe.wn.ch } : null, gone: net.gone.slice(), forfeit: ffEl ? (!ffEl.classList.contains('on') ? 'off' : ffEl.classList.contains('sent') ? 'sent' : ffEl.classList.contains('arm') ? 'arm' : 'on') : 'off', toast: btoast ? btoast.textContent : '', account: net.account, acctOff: net.acctOff, mode: oa.mode, tab: lobbyTab, ladder: net.ls ? { season: net.ls.season, me: net.ls.me } : null, queue: Object.assign({}, net.lq), matched: net.lm ? { code: net.lm.code, you: net.lm.you, counted: net.lm.counted, opp: net.lm.opp } : null, rr: net.rr ? Object.assign({}, net.rr) : null, board: net.board ? { total: net.board.total, top: net.board.top.length, me: net.board.me } : null, token: !!(net.url && aStore.tokens[net.url]), invite: net.invUrl || '', prof: pfState() }; }

  // o: { canvas, onPick(모드 'battle_full' | 'battle' | 'story', 설정 또는 null) }
  function init(o) {
    cv = o.canvas; onPick = o.onPick; onSettings = o.onSettings || onSettings; addPlan(); if (!root) build(); if (onSettings) onSettings(set); fetched = true;
    loadData();
  }
  function loadData() {
    return pfetch('/ui/characters.json').then(r => { if (!r.ok) throw new Error('characters.json ' + r.status); return r.json(); })
      .then(j => { if (!j.characters || j.characters.length !== 16) throw new Error('characters.json 형식'); data = j; dataErr = null; if (hud.on !== undefined) hud.sig = ''; })
      .catch(e => { dataErr = String(e && e.message || e); });
  }
  function open(k, over) { // 층을 띄운다. over = 전투 위 반투명 덮개(일시정지: 벽지 없음, HUD 유지)
    scr = k; ovl = !!over; busy = false; active = true; gpPrev = 255;
    els.toast.classList.remove('on'); root.classList.remove('busy'); root.classList.toggle('ov', ovl); root.classList.add('on'); ffSync(); render();
    if (!gpRaf) gpRaf = requestAnimationFrame(gpTick);
  }
  function show(k) { for (const n of Object.keys(idx)) idx[n] = 0; sel.picks = []; sel.cur = 0; sel.again = false; sel.ran = null; pt.driven = ''; pt.team = null; pt.run = ''; pt.partner = -1; lb.view = 'main'; lb.info = null; lb.wait = false; lb.pre = null; open(k || 'title'); if (scr === 'title') invRun(); } // invRun = 초대 링크로 들어왔으면 온라인 입장(1회) // show = 엔진을 처음부터 다시 만든 뒤(game.js openMenu)
  function driveFailed() { // 구동 실패(game.js): 사용자가 원작 화면에서 다시 고르므로 이 층의 선택을 버린다(결과 화면은 hud.ids 를 쓴다). 스토리 구동이면 덮개를 걷은 뒤 토스트
    sel.picks = []; sel.ran = null;
    if (pt.run) { pt.run = ''; pt.driven = ''; pt.team = null; setTimeout(() => toast('자동 진행 실패 · 원작 화면으로 이어 갑니다', 'hp-low', 3000), 0); }
  }
  function hide() { active = false; busy = false; ovl = false; shown = null; if (root) { root.classList.remove('on', 'busy', 'ov'); if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur(); } ffSync(); }
  // 일시정지 메뉴(game.js 가 전투 1:2 에서 Esc·START 로 부른다. 엔진은 game.js 가 프레임 허가를 멈춰 세운다). ev = 연 키 이벤트(같은 이벤트로 바로 닫히지 않게)
  function pause(ev) { if (!root || active) return false; skipKey = ev || null; idx.pause = 0; open('pause', true); return true; }
  // 결과 화면(game.js 가 전투 종료 1:5 → 모드 0 을 감지해 부른다). m = 1:5 진입 프레임의 RAM 사본. 띄웠으면 true
  // 승패(15 문서 8절, 판독 6건): 1:5 진입 프레임에 이긴 슬롯만 $04A2+s 의 bit2 가 꺼진다. 그런 슬롯이 없으면 HP($04C2+s) > 0 인 슬롯으로 본다
  // 사람/CPU: 승부가 나는 순간 이긴 슬롯의 $04A2 bit7 이 켜져(사람이어도) 1:5 프레임의 bit7 로는 가를 수 없다(15 문서 14절). 배틀은 앞 $0645 − 1 슬롯이 사람(2 → 슬롯 0, 3 → 0·1, 4 → 0·1·2, 5 → 전원)
  function result(m) {
    if (!root || !data || active) return false;
    // 캐릭터: 이 층이 구동한 판(sel.ran 이 남아 있음)이고 전투 시작 때 받아 둔 값(hud.ids)과 어긋나지 않으면 고른 4명, 아니면 hud.ids. 둘 다 없으면 띄우지 않는다(원작 화면 유지).
    //   끝난 뒤의 $0401+s 는 쓰러진 선수 칸이 바뀌어 있어 쓰지 않는다. 구동 실패(driveFailed) 뒤 원작 화면에서 고른 판은 sel.picks·sel.ran 이 비어 hud.ids 를 쓴다
    const ids = hud.ids.every(i => i >= 0) ? hud.ids : null, mine = sel.picks.length === 4 && sel.ran && (!ids || ids.every((v, i) => v === sel.picks[i]));
    const known = mine ? sel.picks : ids; if (!known) return false;
    const fs = [], humans = Math.min(4, m[0x645] - 1); /* 배틀의 사람 수 = $0645 − 1(2 → 1명 … 5 → 4명, 17 문서 1.2절) */ for (let s = 0; s < 4; s++) { const cpu = s >= humans; fs.push({ id: known[s], hp: m[0x4C2 + s], max: Math.max(m[0x5EB + s], m[0x4C2 + s], 1), cpu, won: !(m[0x4A2 + s] & 4), who: cpu ? OCOM : OROLE[s] }); }
    if (!fs.some(f => f.won)) fs.forEach(f => { f.won = f.hp > 0; });
    res.win = fs.filter(f => f.won); res.lose = fs.filter(f => !f.won); res.human = res.win.some(f => !f.cpu); res.sec = Math.floor(hud.t / 60.0988);
    sel.players = m[0x645] === 3 ? 2 : 1; sel.picks = fs.map(f => f.id); const r = sel.ran; sel.stage = r ? r.stage : STAGE_ID.indexOf(m[0x644]); sel.rule = r ? r.rule : hud.rule >= 0 ? hud.rule : m[0x647]; /* 룰: 구동한 값(없으면 전투 시작 때 받아 둔 값). 1:5 의 $0647 은 전투 중 줄어 있을 수 있다 */ sel.zone = 'stage'; sel.again = true; idx.result = 0;
    open('result'); return true;
  }
  const itemId = () => OSCR.has(scr) ? oItemId() : scr === 'lobby' ? (lb.view === 'quit' ? (lb.q ? 'quit_no' : 'quit_yes') : LB_IDS[idx.lobby]) : els[scr] && els[scr].btns ? els[scr].btns[idx[scr]].dataset.id : scr === 'settings' ? (setIdx < SET_BACK ? SET_ROWS[setIdx][0] : 'back') : scr === 'charsel' ? IDS[sel.cur] : scr === 'partner' ? IDS[pt.cur] : scr === 'steam' ? (idx.steam < 5 ? 'rule' + (idx.steam + 1) : idx.steam === 5 ? 'start' : 'back') : scr === 'stage' ? (sel.zone === 'rule' ? 'rule' + (sel.rule + 1) : sel.stageCur === 7 ? 'exit' : 'stage' + (sel.stageCur + 1)) : scr;

  // ── 전투 HUD(코어 캔버스 밖 게이지 패널). RAM 읽기 전용: HP $04C2+i, 최대 HP $05EB+s(전투 시작 때 $04C2 로 복사되는 값), 캐릭터 $0401+s·$0409+s,
  //    사람·CPU 배틀은 $0645(앞 $0645 − 1 슬롯이 사람: 2 = 슬롯 0, 3 = 0·1, 4 = 0·1·2, 5 = 전원), 스토리는 $04A2+s bit7, 필살기 보유 $0605+s(bit0~7 = id 0~7)·$0609+s(bit6 = id 8, bit7 = id 9), 스테이지 id $0644, 룰 $0647(전투 시작 때 한 번만 받는다 — 전투 중 줄어든다) ──
  const hud = { root: null, mirror: null, panels: [], f: [], cap: null, sig: '', ids: [-1, -1, -1, -1], es: [-1, -1, -1, -1], rule: -1, hp: [0, 0, 0, 0], on: false, wasBattle: false, t: 0, lastF: 0, k: 0 };
  function buildHud() {
    hud.root = el('div', '', document.body); hud.root.id = 'nkm-hud'; noBroken(hud.root);
    for (let t = 0; t < 2; t++) {
      const p = el('div', 'nkh-panel', hud.root); el('div', 'nkm-win', p).style.inset = '0'; el('div', 'nkh-div', p); hud.panels.push(p);
      for (let j = 0; j < 2; j++) {
        const f = el('div', 'nkh-f', p); f.style.top = 16 + 268 * j + 'px';
        f.cut = el('div', 'nkm-cut', f); f.im = el('img', '', f.cut); f.im.alt = '';
        const cs = el('div', 'nkh-chips', f); f.who = chip(cs, '', 'com'); f.sch = chip(cs, '', 'sch0', true); f.nm = el('div', 'nkh-name', f);
        f.g = gauge(f, 'hp', 1, 1); f.num = el('div', 'nkh-hp', f); f.out = el('div', 'nkh-out', f, '나감');
        f.sp = [0, 1, 2].map(i => { const r = el('div', 'nkh-sp', f); r.style.top = 144 + 28 * i + 'px'; return r; });
        hud.f.push(f);
      }
      p.tm = el('div', 'nkh-team', p); const lr = el('div', 'nkh-lvr', p.tm); p.lvT = el('b', 'nkh-lvt', lr); p.lv = el('div', 'nkh-lv', lr); p.lvC = []; for (let i = 0; i < 9; i++) p.lvC.push(el('i', '', p.lv)); p.lvP = el('s', '', p.lv); // 팀 레벨(스토리만, 19 문서): L = $0619+T + 1, 9칸 중 값 번째 = 빨간 칸, 아래 줄 = 레벨 + 진행($061B+T / 256)
      p.cbr = el('div', 'nkh-cbr', p.tm); el('b', 'nkh-lvt', p.cbr, '합체'); p.cb = el('div', 'nkh-cb', p.cbr); p.cbT = el('i', '', p.cb); // 팀 연결 합체 타이밍 게이지: 눈금 $0613+T(0~18), 빨간 구간 6~12, 연결 중 = $0611+T bit1
      p.foot = el('div', 'nkh-foot', p);
    }
    hud.cap = el('div', 'nkh-cap', hud.root); hud.capS = el('span', '', hud.cap); hud.capT = el('b', '', hud.cap); hud.capR = el('span', '', hud.cap);
    window.addEventListener('resize', placeHud); if (window.ResizeObserver) new ResizeObserver(placeHud).observe(cv);
  }
  function placeHud() { // 코어(256x240, 캔버스 가운데) 양옆 여백에 맞춘다. 패널 논리 266x640. 여백이 좁으면 k = 0(띄우지 않음). 전투 필드 확대(game.js fit) 중에는 보이는 코어 = 위 188라인(cv.dataset.fh)
    const r = window.NKCam ? window.NKCam.rect(cv) : cv.getBoundingClientRect(), s = r.width / 432, fr = 3 * s, coreL = r.left + 88 * s - fr, coreW = 256 * s + 2 * fr, coreH = (+cv.dataset.fh || 240) * s, margin = Math.min(coreL, window.innerWidth - coreL - coreW); // fr = 코어 둘레 창틀(index.html #stage::after, 3픽셀 × 배율). 패널은 창틀 밖에 둔다(coreL·coreW 는 창틀 포함)
    const k = Math.min(coreH / 640, (margin - 12) / 266); hud.k = k >= 0.6 && s > 0 && !document.documentElement.classList.contains('nk-mob') ? k : 0; if (!hud.k) return; // html.nk-mob(web/mobile.js) = 게이지 패널 끔(원작 하단 HUD 가 정보). mobile.js 는 그때 resize 를 보내 여기로 다시 온다
    const y = r.top + (coreH - 640 * k) / 2, gap = (margin - 266 * k) / 2;
    hud.panels[0].style.transform = 'translate(' + (coreL - gap - 266 * k) + 'px,' + y + 'px) scale(' + k + ')';
    hud.panels[1].style.transform = 'translate(' + (coreL + coreW + gap) + 'px,' + y + 'px) scale(' + k + ')';
    const capOk = r.top >= 30 * k + 10; hud.root.classList.toggle('nocap', !capOk);
    if (capOk) hud.cap.style.transform = 'translate(' + (coreL + coreW / 2 - 200 * k) + 'px,' + (r.top - 30 * k - 5) / 2 + 'px) scale(' + k + ')';
  }
  // HUD 예열: 첫 전투에서 덮개를 걷는 순간 HUD 를 처음 그리며 GPU 셰이더 프로그램을 링크하느라 약 100ms 화면이 멈췄다(추적: FillRectOp → Program::MainLinkLoadEvent::wait).
  //   타이틀 대기 중 HUD 를 거의 투명(.warm)하게 3화면만 띄워 미리 그려 둔다(보이지 않음, 입력 없음). 전투가 이미 시작됐으면 하지 않는다
  function warmHud() { // 전투와 같은 내용(초상·채운 게이지·글자·위험/KO 상태)으로 그려야 같은 셰이더가 링크된다(빈 HUD 예열은 약 절반만 줄었다: 실측). 끝나면 원래대로(첫 전투에서 hudTick 이 hud.sig = '' 로 다시 채운다)
    const r = hud.root; if (!r || hud.on || r.classList.contains('on') || !hud.f.length) return;
    const st = r.classList.contains('story'), sv = [], ims = [];
    hud.f.forEach((f, s) => { sv.push([f.im.getAttribute('src'), f.im.style.display, f.nm.textContent, f.num.textContent, f.g.fill.style.width, f.g.lag.style.width, f.className, f.sp[0].textContent]); f.im.src = face(s * 5 % 16); f.im.style.display = ''; ims.push(f.im.decode ? f.im.decode().catch(() => {}) : null); f.nm.textContent = '쿠니오'; f.num.textContent = '100'; f.g.fill.style.width = 60 + 10 * s + '%'; f.g.lag.style.width = '90%'; if (s === 2) f.classList.add('low'); if (s === 3) f.classList.add('ko'); f.sp[0].textContent = '마하 펀치'; });
    const done = () => { r.classList.remove('warm'); if (hud.on) return; r.classList.remove('on'); r.classList.toggle('story', st); hud.f.forEach((f, s) => { const v = sv[s]; if (v[0] === null) f.im.removeAttribute('src'); else f.im.setAttribute('src', v[0]); f.im.style.display = v[1]; f.nm.textContent = v[2]; f.num.textContent = v[3]; f.g.fill.style.width = v[4]; f.g.lag.style.width = v[5]; f.className = v[6]; f.sp[0].textContent = v[7]; f.spk = ''; }); hud.sig = ''; };
    Promise.all(ims).then(() => { if (hud.on || r.classList.contains('on')) return done(); r.classList.add('warm', 'on', 'story'); let n = 0; const f = () => { if (++n < 4) return requestAnimationFrame(f); done(); }; requestAnimationFrame(f); });
  }
  // 가운데 WINNER + 승자 초상(2026-11-22, 표시 전용): 전투 종료 연출 1:5 에 한 번. 원작이 왼쪽 아래에 찍는 「WINNER !!」는 game.js winCover 가 덮는다.
  //   승자 = result() 와 같은 식($04A2+s bit2 꺼짐, 아무도 없거나 전원이면 HP > 0). 스토리(팀전) = 승리 팀 2명, 배틀(개인전) = 승자 1명(여럿 = 무승부로 보고 띄우지 않음). 무승부 = 표시 없음.
  //   초상 = HUD·결과와 같은 원작 초상(face·eface), 이름 = HUD 와 같은 이름(에디트 = 기록 이름), 테 색 = 자리 색(1P~4P·COM). 동작 줄이기·타격 효과 끔 = 번쩍임·팝 없이 그대로 표시
  const wf = { el: null, on: false, n: 0, last: null };
  function winFx(m) {
    const v15 = !!data && m.length > 0x700 && m[0x641] === 1 && (m[0x642] & 0x7F) === 5 && (!active || ovl);
    if (!v15) { if (wf.on) { wf.on = false; wf.el.classList.remove('on'); } return; }
    if (wf.on) return; wf.on = true;
    const ffa = m[0x645] >= 2, humans = Math.min(4, m[0x645] - 1), S4 = [0, 1, 2, 3];
    let won = S4.filter(s => !(m[0x4A2 + s] & 4)); if (!won.length || won.length === 4) won = S4.filter(s => m[0x4C2 + s] > 0);
    if (!ffa && won.length) { const T = won[0] >> 1; won = won.every(s => s >> 1 === T) ? [2 * T, 2 * T + 1] : []; } else if (ffa && won.length !== 1) won = [];
    wf.last = { won, ffa }; if (!won.length) return;
    if (!wf.el) { const st = document.getElementById('stage') || document.body; wf.el = el('div', '', st); wf.el.id = 'nkw'; wf.t = el('div', 't', wf.el, 'WINNER'); wf.p = el('div', 'p', wf.el); }
    wf.p.textContent = '';
    for (const s of won) {
      const id = hud.ids[s], ch = id >= 0 ? data.characters[id] : null, es = ch ? -1 : hud.es[s], cpu = ffa ? s >= humans : !!(m[0x4A2 + s] & 0x80), who = cpu ? 'com' : s < 2 || ffa ? 'p' + (s + 1) : 'com';
      const f = el('figure', '', wf.p); cvar(f, who); const src = ch ? face(id) : es >= 0 ? eface(es) : '';
      if (src) { const im = el('img', '', f); im.alt = ''; im.src = src; } else el('i', '', f);
      el('b', '', f, ch ? ch.name_ko : editLabel(m.slice(0x5AD + 12 * s, 0x5B2 + 12 * s)));
    }
    const S = window.NKSettings; wf.el.classList.toggle('calm', !!(S && S.get('impact') === 0));
    wf.el.classList.remove('on'); void wf.el.offsetWidth; wf.el.classList.add('on'); wf.n++;
  }
  function hudTick() {
    requestAnimationFrame(hudTick);
    const m = hud.mirror.m, sub = m[0x642] & 0x7F, battle = (!active || ovl) && m.length > 0x700 && m[0x641] === 1 && (sub === 2 || sub === 4 || sub === 5);
    if (battle && !hud.wasBattle) { const r = sel.ran; if (r && (m[0x647] !== r.rule || m[0x644] !== STAGE_ID[r.stage])) sel.ran = null; /* 구동과 다른 판(구동 실패 뒤 원작 화면에서 고름 등)은 RAM 값을 쓴다 */ hud.rule = sel.ran ? sel.ran.rule : m[0x647]; if (m[0x645] <= 1) lb.pre = lobbySnap(m); /* 스토리: 대기실의 레벨업 증가분·직전 결과용(레벨은 시합 끝에 오른다) */ hud.t = 0; hud.ids = [-1, -1, -1, -1]; hud.es = [-1, -1, -1, -1]; hud.hp = [-1, -1, -1, -1]; hud.sig = ''; placeHud(); }
    hud.wasBattle = battle; winFx(m);
    const on = battle && hud.k > 0 && !!data && !!set.hud; if (on !== hud.on) { hud.on = on; hud.root.classList.toggle('on', on); }
    if (!battle) return;
    const fr = hud.mirror.frame, d = fr - hud.lastF; hud.lastF = fr; if (sub === 2 && d > 0 && d < 30) hud.t += d; // 경과 시간 = 전투(1:2) 중 진행한 프레임 수(원작에는 시계가 없다)
    for (let s = 0; s < 4; s++) { const r = m[0x401 + s], c = m[0x409 + s]; if (hud.ids[s] < 0 && hud.es[s] < 0 && r < 4 && c <= 4 && m[0x4C2 + s] > 0) { if (c < 4) hud.ids[s] = r * 4 + c; else hud.es[s] = r; } } /* 칸 4 = 에디트 캐릭터(줄 = 유파) */ /* 전투마다 처음 한 번만 받아 둔다: $0401+s 는 그 선수가 쓰러지면 바뀐다(관측: 1 → 9 → 0, 15 문서 10절 D5). 결과 화면도 쓰므로 HUD 를 끈 상태에서도 받는다 */
    if (!on) return;
    const sec = Math.floor(hud.t / 60.0988), ffa = m[0x645] >= 2, humans = Math.min(4, m[0x645] - 1); let sig = sec + '|' + m[0x644] + '|' + hud.rule + '|' + m[0x645] + '|' + (net.playing ? net.gone.join('') : ''); // 배틀($0645 ≥ 2): 사람 슬롯 = $0645(result() 와 같은 식). $04A2 bit7 은 이긴 슬롯에서 승부 순간 켜진다(15 문서 14·15절). 스토리(0·1)는 슬롯 배치를 확인하지 않아 종전대로 bit7
    for (let s = 0; s < 4; s++) if (!ffa) sig += ',' + (m[0x4A2 + s] & 0x80);
    for (let s = 0; s < 4; s++) { sig += '|' + hud.ids[s] + ',' + hud.es[s] + ',' + m[0x4C2 + s] + ',' + m[0x5EB + s] + ',' + m[0x605 + s] + ',' + m[0x609 + s]; }
    const story = m[0x645] < 2; if (story) for (let T = 0; T < 2; T++) sig += '|' + m[0x613 + T] + ',' + m[0x619 + T] + ',' + m[0x61B + T] + ',' + (m[0x611 + T] & 2); // 팀 레벨·합체 타이밍(스토리만 움직인다. 배틀은 원작 HUD 에도 없다)
    if (sig === hud.sig) return; hud.sig = sig;
    hud.root.classList.toggle('story', story);
    if (story) for (let T = 0; T < 2; T++) {
      const p = hud.panels[T], lv = Math.min(8, m[0x619 + T]), v = Math.min(18, m[0x613 + T]), act = !!(m[0x611 + T] & 2);
      p.lvT.textContent = '팀 L' + (lv + 1); p.lvC.forEach((c, i) => c.classList.toggle('on', i === lv)); p.lvP.style.width = (lv + m[0x61B + T] / 256) / 9 * 100 + '%';
      p.cbT.style.left = v / 18 * 100 + '%'; p.cbr.classList.toggle('act', act); p.cbr.classList.toggle('hit', act && v >= 6 && v <= 12);
    }
    for (let s = 0; s < 4; s++) {
      const f = hud.f[s], id = hud.ids[s], ch = id >= 0 ? data.characters[id] : null, hp = m[0x4C2 + s], max = Math.max(m[0x5EB + s], hp, 1), pct = hp / max * 100, cpu = ffa ? s >= humans : !!(m[0x4A2 + s] & 0x80);
      const who = cpu ? OCOM : s < 2 || ffa ? OROLE[s] : [(s + 1) + 'P', 'com'], col = pct > 50 ? 'hp' : pct > 25 ? 'hp-mid' : 'hp-low';
      const nm = ch ? ch.name_ko : editLabel(m.slice(0x5AD + 12 * s, 0x5B2 + 12 * s)); /* 캐릭터 표 밖(스토리의 에디트 캐릭터): 그 슬롯 기록의 이름 타일($05AD+12s, 14 문서 3.1절) → 보관한 한글 → 음역 → 「에디트」 */
      const es = ch ? -1 : hud.es[s], r = ch ? id >> 2 : es, has = r >= 0;
      if (f.id !== id || f.nmv !== nm || f.es !== es) { f.id = id; f.es = es; f.nmv = nm; f.im.style.display = has ? '' : 'none'; f.cut.classList.toggle('anon', !has); if (has) f.im.src = ch ? face(id) : eface(es); f.nm.textContent = nm; f.sch.textContent = has ? SCHOOLS[r] : ''; /* 에디트 캐릭터 = 유파 얼굴, 유파를 모르면 중립 그림 + 에디트 이름 */ f.sch.style.display = has ? '' : 'none'; cvar(f.sch, 'sch' + r); cvar(f.cut, has ? 'sch' + r : 'com'); }
      f.who.textContent = who[0]; cvar(f.who, who[1]); f.cut.style.setProperty('--pc', 'var(--' + who[1] + ')');
      f.g.fill.style.width = pct + '%'; cvar(f.g, col); cvar(f.num, col); f.num.textContent = hp;
      if (hp !== hud.hp[s]) { f.g.lag.style.transition = hud.hp[s] >= 0 && hp < hud.hp[s] ? '' : 'none'; f.g.lag.style.width = pct + '%'; hud.hp[s] = hp; } // 피해 직후 흰 잔상: 0.4초 남았다가 0.3초 동안 줄어든다(CSS). 회복·새 시합은 바로
      f.g.style.setProperty('--tick', 50 / max * 100 + '%'); // HP 눈금 50 단위
      f.classList.toggle('low', hp > 0 && pct <= 25); f.classList.toggle('ko', hp === 0); f.classList.toggle('gone', net.playing && net.gone.includes(s)); // gone = 온라인 3·4인 판에서 빠진 자리(흐림 + 「나감」. 캐릭터는 엔진에 그대로 서 있다)
      const own = []; for (let b = 0; b < 8; b++) if (m[0x605 + s] & (1 << b)) own.push(b); if (m[0x609 + s] & 0x40) own.push(8); if (m[0x609 + s] & 0x80) own.push(9);
      const kp = !net.playing && !cpu && s === 1 ? 1 : 0, spk = own.join() + '|' + kp + '|' + id; // 기술 입력 뱃지(web/skill_inputs.js): 모든 칸(CPU·파트너·원격·온라인 상대 포함, 2026-11-21 사용자 지시). 키 표기 = 1P 키, 로컬 2P 사람 칸만 2P 키
      if (f.spk !== spk) { f.spk = spk; // 기술·조작 주인이 바뀔 때만 다시 그린다(프레임마다 DOM 을 건드리지 않는다)
        f.sp.forEach((r, i) => { const mv = own[i] !== undefined ? data.special_moves[own[i]] : null; r.classList.toggle('none', !mv); r.textContent = mv ? mv.ko : '—'; cvar(r, 'sch' + (id >= 0 ? id >> 2 : 0)); });
        if (window.NKSkillInputs) window.NKSkillInputs.rows(f.sp, f.sp.map((r, i) => ({ name: r.textContent, id: own[i] !== undefined && data.special_moves[own[i]] ? own[i] : -1, p: kp })), { top: 144, step: 28, wtop: 138, wstep: 36, wnstep: 26 }); // 2단 줄이 둘이어도 스토리 팀 게이지(518) 위에서 끝나게
      }
    }
    const sn = STAGE_ID.indexOf(m[0x644]), stg = sn >= 0 ? 'STAGE ' + (sn + 1) : '', rule = hud.rule >= 0 && hud.rule < 5 ? ruleName(hud.rule) : '', tm = String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
    hud.capS.textContent = stg; hud.capT.textContent = tm; hud.capR.textContent = rule; hud.panels[0].foot.textContent = stg; hud.panels[1].foot.textContent = rule + (rule ? ' · ' : '') + tm;
  }
  // 선수 표시 층(web/unit_tags.js)용 읽기 전용 자료: 설정, 슬롯별 캐릭터 이름(표 밖 = 에디트 이름), 온라인 사람 자리의 대기실 이름, 온라인 내 자리
  function tagInfo() {
    const m = hud.mirror ? hud.mirror.m : null, R = net.playing ? net.room : null, H = R ? roomH() : 0, names = [], seats = [];
    for (let s = 0; s < 4; s++) { const id = hud.ids[s], ch = data && id >= 0 ? data.characters[id] : null, seat = R && s < H ? R.seats[s] : null; seats.push(seat && seat.name ? String(seat.name) : ''); names.push(ch ? ch.name_ko : m && m.length > 0x5C0 ? editLabel(m.slice(0x5AD + 12 * s, 0x5B2 + 12 * s)) : ''); }
    return { mode: set.tags, names, seats, nick: net.account && net.name ? String(net.name) : '', you: R ? R.you | 0 : -1, humans: H, active, overlay: ovl }; // nick = 로그인한 계정 닉네임(로컬 1P 표식 이름)
  }
  // o: { canvas, mirror }  mirror = game.js 의 최근 프레임 상태({ m: RAM 사본, frame }). 메뉴 층과 따로 켠다(?state= 주소에서도 HUD 는 뜬다)
  function initHud(o) {
    cv = cv || o.canvas; hud.mirror = o.mirror; onPick = onPick || o.onPick || null; onSettings = onSettings || o.onSettings || null;
    addPlan(); // ?state= 주소(init 없음)에서도 스토리 대진표의 「시합 시작」 구동(story_next)을 쓴다
    if (!root) { build(); if (onSettings) onSettings(set); } // ?state= 주소(메뉴 층 없이 시작)에서도 일시정지·설정 덮개는 쓴다
    buildHud(); placeHud(); requestAnimationFrame(hudTick); setTimeout(warmHud, 2000);
    if (!data && !dataErr && !fetched) pfetch('/ui/characters.json').then(r => r.ok ? r.json() : null).then(j => { if (j && j.characters && !data) data = j; }).catch(() => { /* 자료 없음 = HUD 없음(원작 HUD 만) */ });
  }
  window.NKManga = { enabled, relayout: () => { if (hud.root) placeHud(); }, get fieldOnly() { const m = hud.mirror && hud.mirror.m, sub = m ? m[0x642] & 0x7F : 0; return !!m && !!data && !!set.hud && (!active || ovl) && m.length > 0x700 && m[0x641] === 1 && (sub === 2 || sub === 4 || sub === 5); } /* 게이지 패널을 띄울 전투(hudTick 의 battle·on 과 같은 조건, 패널 배율은 game.js 가 본다) → 원작 하단 HUD 를 가리고 필드를 키운다 */, addPlans: addPlan /* 구동 계획만 등록(Node 검증용, DOM 없음) */, teamCards /* 팀·룰 카드 수치(Node 대조용, DOM 없음) */, lobbyInfo, lobbySnap /* 대기실 자료(Node 대조용, DOM 없음) */, init, show, hide, driveFailed, driveDone, toast, titleBg /* game.js: 타이틀 대기 중 원작 타이틀 프레임 */, lobbyBg /* game.js: 대기실 덮개 동안 원작 체육관 컷 */, get lobbyLive() { return { on: lg.on, frames: lg.frames }; }, get titleLive() { return { on: tl.on, frames: tl.frames, skip: tl.skip, tile: !!tl.tile }; }, initHud, pause, result, bracket, lobby, onlineEnd, forfeitTap, storyPoint /* game.js: 저장 지점 */, get storyState() { return storyState(); }, get online() { return (active && OSCR.has(scr)) || net.playing; }, get onlineState() { return onlineState(); }, get active() { return active; }, get overlay() { return active && ovl; }, get settings() { return Object.assign({}, set); }, get tagInfo() { return tagInfo(); }, get winFx() { return { on: wf.on, n: wf.n, last: wf.last }; },
    get state() { return { active, busy, overlay: ovl, screen: scr, index: scr in idx ? idx[scr] : scr === 'settings' ? setIdx : -1, settings: Object.assign({}, set), again: sel.again, result: { title: els.result ? els.result.ttl.textContent : '', win: res.win.map(f => IDS[f.id]), lose: res.lose.map(f => IDS[f.id]), sec: res.sec }, item: itemId(), toast: !!els.toast && els.toast.classList.contains('on'), data: !!data, dataErr, bracket: { round: brk.round, order: brk.order.slice(), teams: brk.order.map(t => ({ t, ids: brk.team[t].ids.slice(), w: brk.team[t].w, l: brk.team[t].l })), names: els.bracket ? els.bracket.rows.map(r => r.side.map(o => o.nm.textContent)) : [], me: els.bracket ? els.bracket.meNm.textContent : '' }, edit: { name: ed.name, month: ed.month, day: ed.day, blood: BLOOD[ed.blood], zodiac: ZOD[zodiacOf(ed.month, ed.day)], focus: els.edit ? (document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id || '' : '') : '' }, lobby: { view: lb.view, wait: lb.wait, q: lb.q, pre: !!lb.pre, info: lb.info ? { cards: lb.info.cards.map(c => ({ id: c.id >= 0 ? IDS[c.id] : null, name: c.name, lv: c.lv, up: c.up, stats: Object.assign({}, c.stats), prev: c.prev ? Object.assign({}, c.prev) : null, sp: c.sp.slice() })), w: lb.info.w, l: lb.info.l, last: lb.info.last, next: lb.info.next, team: lb.info.team, rule: lb.info.rule } : null }, story: { partner: IDS[pt.cur], picked: pt.partner >= 0 ? IDS[pt.partner] : null, rule: pt.rule, driven: !!pt.driven, run: pt.run, team: pt.team ? pt.team.map(t => ({ id: t.id >= 0 ? IDS[t.id] : null, name: t.name, lv: t.lv, month: t.month, day: t.day, blood: t.blood, zodiac: t.zodiac, stats: Object.assign({}, t.stats), sp: t.sp.slice() })) : null }, players: sel.players, picks: sel.picks.map(i => IDS[i]), cursor: IDS[sel.cur], zone: sel.zone, stage: sel.stage, rule: sel.rule }; },
    resultCard: () => { const sp = cardSpec(); return sp ? cardCanvas(sp).then(c => c.toDataURL('image/png')) : Promise.resolve(null); }, // 검증용: 지금 결과 화면의 카드 PNG(data URL)
    get chalState() { return { data: ch.data, wait: ch.wait, q: pf.q.slice() }; },
    get hudState() { const m = hud.mirror ? hud.mirror.m : null; return { on: hud.on, k: hud.k, sec: Math.floor(hud.t / 60.0988), slots: hud.f.map((f, s) => ({ id: f.id >= 0 ? IDS[f.id] : null, who: f.who.textContent, name: f.nm.textContent, hp: +f.num.textContent, ram: m ? m[0x4C2 + s] : null, max: m ? m[0x5EB + s] : null, fill: f.g.fill.style.width })), teams: hud.panels.map((p, T) => ({ shown: !!p.tm && getComputedStyle(p.tm).display !== 'none', lv: p.lvT.textContent, cell: p.lvC.findIndex(c => c.classList.contains('on')), prog: p.lvP.style.width, tick: p.cbT.style.left, act: p.cbr.classList.contains('act'), hit: p.cbr.classList.contains('hit'), ram: m ? { m645: m[0x645], lv: m[0x619 + T], prog: m[0x61B + T], tick: m[0x613 + T], act: m[0x611 + T] & 2 } : null })) }; } };
})();
