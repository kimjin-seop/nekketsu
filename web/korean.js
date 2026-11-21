'use strict';
// 한글 덧그리기 층(시범). 설계: analysis/13_korean_ui.md
// 엔진·렌더러(256x240 원작 출력)는 건드리지 않는다. 워커가 보내 주는 PPU 상태(라인 239 시점의 네임테이블·팔레트 + 라인별 스크롤·뱅크 표)에서
// 원작 글자 타일을 읽어 표(web/ko_table.json)와 대조하고, 맞은 자리만 배경색으로 가린 뒤 Galmuri 도트 글자를 그 위에 그린다.
// 캐릭터 선택·상대 선택의 이름 칸(그림 타일 가나)은 표의 plates 로 따로 읽어 같은 방식으로 덮는다(13 문서 13절). 같은 화면의 유파 라벨(큰 그림 글자)은 표의 labels 로 상자 안쪽을 다시 조판한다(13.7절).
// 스테이지 선택 제목처럼 폰트 뱅크가 아닌 뱅크에 든 가나는 표의 screens[키].alt(그 화면에서만 인정하는 뱅크 + 타일표)로 읽는다(13.7절).
// 룰 선택(5:8)처럼 이름 줄과 설명 줄이 8px 간격으로 붙어 있는 화면은 표 문구의 x(시작 x)·dy(잉크 위끝, 그 줄 첫 라인 기준)로 설명을 이름 줄 옆으로 옮겨 한 줄로 조판한다(13.8절).
// 스토리 대화 창(6:2·6:3 등 screens[키].script)은 메시지 루틴의 스크립트 id(RAM $068C)로 표의 scripts 줄과 대조해 맞는 줄만 덮는다(analysis/20_story_korean_plan.md 10절).
// 승패표(9:2)·원작 대진표(9:4)의 팀 이름 줄(screens[키].names)은 「이름&이름」 낱말을 이름표·음역으로 옮긴다(20 문서 11절).
// 표에 없는 글자는 손대지 않는다(원작 그대로 보임. 예외: 안내문·선택지 줄의 가나는 찍히는 도중에 일본어가 비치지 않게 가린다).
// ?ko=1 또는 K 키로 켰을 때만 game.js 가 이 파일을 불러온다.
// 그리기: 화면 상태가 바뀔 때만 256x240 투명 층(픽셀 버퍼)을 다시 만들고, 프레임마다 그 층을 코어 화면 위에 한 번 얹는다.
(function () {
  // fam = 실제 글꼴 이름(CSS @font-face 와 같은 이름을 써서 같은 파일을 두 번 받지 않는다: Galmuri9 = ui_manga.css 의 NKM9, Galmuri11Bold = Galmuri11 700). name = 캐시·통계 키(종전 값 유지)
  const FONT_L = { css: '12px Galmuri11', name: 'Galmuri11', px: 12 }, FONT_S = { css: '10px NKM9', name: 'Galmuri9', fam: 'NKM9', url: '/fonts/Galmuri9.ttf', px: 10 };
  const FONT_B = { css: 'bold 12px Galmuri11', name: 'Galmuri11Bold', fam: 'Galmuri11', wt: '700', url: '/fonts/Galmuri11-Bold.ttf', px: 12 }; let boldOk = false; // 유파 라벨용(없으면 라벨만 원작 그대로)
  const FONT_T = { css: '8px Galmuri7', name: 'Galmuri7', px: 8 }; let tinyOk = false; // 에디트 입력 칸(5:2 5행)의 작은 가나용(없으면 Galmuri9 로 대신: 큰·작은 가나 크기 구분만 사라진다)
  // 가나 입력표(5:2 10~20행)의 작은 가나 줄용 손 도트(잉크 높이 5px, ㅅ 3px). Galmuri7(가장 작은 Galmuri, 잉크 7px)은 큰 가나 칸에 쓰므로 작은 가나는 이것으로 칸 아래쪽에 붙여 그려 크기로 구분한다(13 문서 17.7절).
  //   ㅇ = 3x3 마름모. 글자 폭 7px 이하(칸 8px 안). 없는 글자(ゎ 등)는 Galmuri7 로 대신
  const FONT_M = { name: 'mini5', mini: true, px: 5 };
  const MINI_SRC = {
    아: ['....#.', '.#..#.', '#.#.##', '.#..#.', '....#.'], 이: ['....#', '.#..#', '#.#.#', '.#..#', '....#'], 야: ['....#.', '.#..##', '#.#.#.', '.#..##', '....#.'],
    에: ['....#.#', '.#..#.#', '#.###.#', '.#..#.#', '....#.#'], 우: ['..#..', '.#.#.', '..#..', '#####', '..#..'], 유: ['..#..', '.#.#.', '..#..', '#####', '.#.#.'],
    오: ['..#..', '.#.#.', '..#..', '..#..', '#####'], 요: ['..#..', '.#.#.', '..#..', '.#.#.', '#####'], ㅅ: ['..#..', '.#.#.', '#...#'] };
  const MINI = {}; for (const ch of Object.keys(MINI_SRC)) { const r = MINI_SRC[ch], w = r[0].length, h = r.length, bits = new Uint8Array(w * h); r.forEach((l, j) => { for (let i = 0; i < w; i++) bits[j * w + i] = l[i] === '#' ? 1 : 0; }); MINI[ch] = { w, h, bits }; }
  const NO_GLYPH = { w: 0, h: 0, bits: new Uint8Array(0) };
  const GAP = 3;                       // 밀려난 낱말 사이 최소 간격(px)
  // 타이틀 로고: 네임테이블 0 의 3~15행 5~27열. anchor = [열, 타일…]. split = 로고 그림에서 아랫단(팔레트 1)이 시작하는 행(원작은 화면 y=80 에서 팔레트 0 → 1)
  const LOGO = { row: 3, col: 5, cols: 23, rows: 13, anchor: [8, 2, 3, 4, 5, 6, 7, 8], dx: -1, dy: 2, split: 52 };
  const LOGO_REF = [[0x30, 1], [0x15, 2], [0x0F, 3], [0x27, 6]]; // 로고 그림의 색(NES 색 번호) → 팔레트 칸(윗단 = 팔레트 0, 주황 = 팔레트 1 의 2번)
  // 가나 → 한글(에디트로 지은 이름처럼 표에 없는 이름용 초안). 규칙: 가타카나는 히라가나로, ん = 앞 글자 받침 ㄴ, っ = 앞 글자 받침 ㅅ, ゃゅょ = 앞 글자(ㅣ 단)와 합침, ー 는 버림
  const KANA = { あ: '아', い: '이', う: '우', え: '에', お: '오', か: '카', き: '키', く: '쿠', け: '케', こ: '코', さ: '사', し: '시', す: '스', せ: '세', そ: '소', た: '타', ち: '치', つ: '츠', て: '테', と: '토',
    な: '나', に: '니', ぬ: '누', ね: '네', の: '노', は: '하', ひ: '히', ふ: '후', へ: '헤', ほ: '호', ま: '마', み: '미', む: '무', め: '메', も: '모', や: '야', ゆ: '유', よ: '요', ら: '라', り: '리', る: '루', れ: '레', ろ: '로', わ: '와', を: '오',
    が: '가', ぎ: '기', ぐ: '구', げ: '게', ご: '고', ざ: '자', じ: '지', ず: '즈', ぜ: '제', ぞ: '조', だ: '다', ぢ: '지', づ: '즈', で: '데', ど: '도', ば: '바', び: '비', ぶ: '부', べ: '베', ぼ: '보', ぱ: '파', ぴ: '피', ぷ: '푸', ぺ: '페', ぽ: '포',
    ぁ: '아', ぃ: '이', ぅ: '우', ぇ: '에', ぉ: '오', ゎ: '와', ゔ: '부' };
  const isKana = s => /^[ぁ-ゖァ-ヺー]+$/.test(s), hasKana = s => /[ぁ-ゖァ-ヺ]/.test(s);
  function translit(s) {
    let o = '';
    for (let ch of s) {
      const c = ch.charCodeAt(0);
      if (c >= 0x30A1 && c <= 0x30F6) ch = String.fromCharCode(c - 0x60); // 가타카나 → 히라가나
      const last = o.charCodeAt(o.length - 1), syl = last >= 0xAC00 && last <= 0xD7A3 ? last - 0xAC00 : -1, open = syl >= 0 && syl % 28 === 0; // open = 앞 글자가 받침 없는 한글
      if (ch === 'ー') continue;
      if (ch === 'ん') { o = open ? o.slice(0, -1) + String.fromCharCode(last + 4) : o + '응'; continue; }
      if (ch === 'っ') { if (open) o = o.slice(0, -1) + String.fromCharCode(last + 19); continue; }
      const y = 'ゃゅょ'.indexOf(ch);
      if (y >= 0) {
        const cho = (syl / 588) | 0, jung = ((syl / 28) | 0) % 21;
        if (open && jung === 20) { const plain = cho === 12 || cho === 14; o = o.slice(0, -1) + String.fromCharCode(0xAC00 + (cho * 21 + (plain ? [0, 13, 8] : [2, 17, 12])[y]) * 28); } // ㅈ·ㅊ 은 자·주·조
        else o += '야유요'[y];
        continue;
      }
      o += KANA[ch] || ch;
    }
    return o;
  }
  // 가나 칸 1:1 한글(13 문서 17절): 가나 입력표·입력 중인 이름/패스워드·스테이터스 PASSWORD 줄은 한 칸 = 한 글자로 옮긴다(음역 translit 과 달리 글자를 합치지 않는다).
  //   패스워드를 한글로 옮겨 적은 사람이 같은 표에서 같은 글자를 골라 넣을 수 있게 서로 다른 가나는 서로 다른 한글이어야 한다:
  //   を → 워(お = 오), ぢ → 디(じ = 지), づ → 두(ず = 즈), ん → ㄴ·っ → ㅅ(이름 음역에서 받침이 되는 글자). 작은 가나(ぁぃぅぇぉゃゅょゎ, っ)는 큰 가나와 같은 한글을 작은 글꼴로
  const CELL_FIX = { を: '워', ぢ: '디', づ: '두', ん: 'ㄴ' }, SMALL_KANA = 'ぁぃぅぇぉゃゅょゎ';
  function cellKo(ch) { // → { s, small } | null(가나가 아님)
    if (!ch) return null;
    const c = ch.charCodeAt(0); if (c >= 0x30A1 && c <= 0x30F6) ch = String.fromCharCode(c - 0x60);
    if (ch === 'っ') return { s: 'ㅅ', small: true };
    if (SMALL_KANA.includes(ch)) return { s: KANA[String.fromCharCode(ch.charCodeAt(0) + 1)], small: true };
    const s = CELL_FIX[ch] || KANA[ch]; return s ? { s, small: false } : null;
  }
  let T = null, chr = null, pal32 = null, logoMap = null, ready = false;
  let uiMap = null, rules = null, msgPat = null, scripts = null, choices = null, screens = null, alt = null, xt = null; // alt = 지금 화면의 대체 글자 뱅크(screens[키].alt) 또는 null, xt = 지금 화면에서만 글자로 읽는 폰트 뱅크 타일(screens[키].tiles) 또는 null
  let pin = null; // 지금 화면의 고정 라벨(screens[키].pin: 한자 한 칸 → 그 칸 x 에 더할 px) 또는 null. 에디트 화면(5:2)의 月·日·型(13.10절 후속)
  const stats = { frames: 0, scans: 0, drawn: 0, small: 0, clipped: 0, hidden: 0, unmatched: [], runs: [], grid: [], screen: '', key: '', held: false, cache: { glyphs: 0, rasters: 0, evicted: 0 } }; // grid = 가나 입력표 칸마다 { row, s, small, font, x, y, w, h }(잉크 상자, 검사 도구용)
  const metrics = {};

  // ---- 글자 그림 ----
  // 브라우저의 글자 다듬기(안티앨리어싱)를 피하려고 원래 크기의 4배로 그린 뒤 칸 가운데 픽셀만 뽑는다(도트 폰트의 한 점 = 4x4 칸이라 원본 비트맵이 그대로 나온다).
  // 비트맵은 (글꼴, 글자) 단위로 한 번만 만든다(색은 층에 찍을 때 입힌다). 문자열·색이 바뀌어도 다시 래스터하지 않는다. 캐시는 LRU 상한(GLYPH_MAX).
  const SC = 4, PADT = 3, RW = 24, GLYPH_MAX = 1536;
  const glyphs = new Map(); let rcv = null, rctx = null; const mctx = {};
  function rasterChar(ch, f) { // → { w(글자 나아감 폭), h, bits } (h = px + 6, 기준선 = PADT + px 행)
    if (!rcv) { rcv = document.createElement('canvas'); rcv.width = RW * SC; rcv.height = (FONT_L.px + 6) * SC; rctx = rcv.getContext('2d', { willReadFrequently: true }); }
    if (!mctx[f.name]) { mctx[f.name] = document.createElement('canvas').getContext('2d'); mctx[f.name].font = f.css; }
    const w = Math.min(RW, Math.max(0, Math.round(mctx[f.name].measureText(ch).width))), h = f.px + 6, bits = new Uint8Array(w * h);
    if (w) {
      rctx.clearRect(0, 0, rcv.width, rcv.height);
      rctx.font = (f.wt ? 'bold ' : '') + (f.px * SC) + 'px ' + (f.fam || f.name); rctx.textBaseline = 'alphabetic'; rctx.fillStyle = '#fff'; rctx.fillText(ch, 0, (PADT + f.px) * SC);
      const d = rctx.getImageData(0, 0, w * SC, h * SC).data;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) bits[j * w + i] = d[((j * SC + 2) * w * SC + i * SC + 2) * 4 + 3] >= 128 ? 1 : 0;
    }
    stats.cache.rasters++;
    return { w, h, bits };
  }
  function glyphOf(ch, f) {
    if (f.mini) return MINI[ch] || NO_GLYPH;
    const key = f.name + ch; let g = glyphs.get(key);
    if (g) { glyphs.delete(key); glyphs.set(key, g); return g; } // 최근 쓴 것을 뒤로
    g = rasterChar(ch, f); glyphs.set(key, g);
    if (glyphs.size > GLYPH_MAX) { glyphs.delete(glyphs.keys().next().value); stats.cache.evicted++; }
    stats.cache.glyphs = glyphs.size;
    return g;
  }
  function fontMetrics(f) { // 한글 잉크의 위·아래 행(글자 비트맵 좌표)
    if (metrics[f.name]) return metrics[f.name];
    let top = 99, bot = 0;
    for (const ch of '한글열혈쿠') { const r = glyphOf(ch, f); for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w; i++) if (r.bits[j * r.w + i]) { if (j < top) top = j; if (j > bot) bot = j; } }
    return metrics[f.name] = { top, ink: bot - top + 1 };
  }
  function width(text, f) { let w = 0; for (const ch of text) w += glyphOf(ch, f).w; return w; }
  function inkSpan(text, f) { // 문자열 잉크의 왼쪽 끝(l)과 폭(w)
    let x = 0, l = 1e9, r = -1;
    for (const ch of text) { const g = glyphOf(ch, f); for (let i = 0; i < g.w; i++) for (let j = 0; j < g.h; j++) if (g.bits[j * g.w + i]) { if (x + i < l) l = x + i; if (x + i > r) r = x + i; break; } x += g.w; }
    return r < 0 ? { l: 0, w: 0 } : { l, w: r - l + 1 };
  }

  // ---- 표 준비 ----
  function compile(tb) {
    T = tb; uiMap = new Map(); choices = [];
    for (const u of tb.ui) { uiMap.set(u.ja, u); if (u.choice) choices.push(u); }
    rules = tb.rules.map(r => ({ re: new RegExp(r.re), ko: r.ko }));
    screens = Object.keys(tb.screens).map(k => { const c = tb.screens[k]; return { key: k, rows: c.rows, alt: c.alt || null, tiles: c.tiles || null, cols: c.cols || null, pin: c.pin || null, choice: c.choice || null, script: !!c.script, names: c.names || null, small: c.small || null, grid: c.grid || null, field: c.field || null }; });
    // 안내문 무늬: 글자 배열. 'N' = 이름 칸(가나·빈칸), 'D' = 번호 칸(숫자)
    const pattern = m => {
      const pat = [], slots = []; let i = 0;
      while (i < m.ja.length) {
        if (m.ja.startsWith('{N}', i)) { slots.push({ k: 'N', at: pat.length, len: tb.name_cells }); for (let k = 0; k < tb.name_cells; k++) pat.push(WN); i += 3; }
        else if (m.ja.startsWith('{D}', i)) { slots.push({ k: 'D', at: pat.length, len: 1 }); pat.push(WD); i += 3; }
        else pat.push(m.ja[i++]);
      }
      return { pat, slots, ko: m.ko, scr: m.scr || null };
    };
    msgPat = tb.msg.map(pattern);
    // 스크립트 대사(20 문서 4.1절·10절): 스크립트 id($068C) → 줄 무늬. pre = 원작 타일 그대로 두는 화자 접두(「 앞)
    scripts = {}; for (const id of Object.keys(tb.scripts || {})) scripts[id] = tb.scripts[id].map(l => Object.assign(pattern(l), { pre: l.pre || '' }));
  }
  const WN = { re: /[ぁ-ゖァ-ヺー ]/ }, WD = { re: /[0-9]/ };
  const PIN_PRE = /^[0-9A-Z?]*$/; // 고정 라벨 앞에 붙는 값(숫자·혈액형 영문·「?」, 빈 것 포함)
  // 이름: 이름표 → 없으면 가나 음역. 머리줄(이름 칸)과 안내문({N})이 같은 함수를 쓴다(같은 이름은 같게 보인다).
  // 에디트 이름(15 문서 17절): 신규 에디트 폼에서 지은 이름은 web/ui_manga.js 의 NKEditNames(엔진에 넣은 가나 → 사용자가 쓴 한글)를 먼저 본다(대진표·신규 HUD 와 같은 이름). 고정 캐릭터 이름표가 우선이다(에디트 가나는 그 이름과 겹치지 않게 고른다)
  const editKo = s => { const E = window.NKEditNames; return E && E.get ? E.get(s) : null; };
  const koName = s => { s = s.trim(); return T.names[s] || editKo(s) || translit(s); };
  // 런 s 가 무늬 p 의 앞부분과 맞는가(2 = 끝까지 같음, 1 = 앞부분). wild = 이름·번호 칸만 찍힌 상태도 인정
  function patMatch(p, s, wild) {
    if (s.length > p.pat.length) return 0;
    let lit = 0;
    for (let i = 0; i < s.length; i++) { const c = p.pat[i]; if (typeof c === 'string') { if (c !== s[i]) return 0; lit++; } else if (!c.re.test(s[i])) return 0; }
    if (!lit && !wild) return 0;
    return s.length === p.pat.length ? 2 : 1;
  }
  // 팀 이름 줄의 낱말(승패표 9:2·원작 대진표 9:4, 20 문서 11절): 「りき」「&ましば」, 5칸을 다 채운 에디트 이름은 빈칸 없이 「あああああ&くにお」로 붙어 찍힌다.
  // 각 이름(5칸 이하 가나) → koName(이름표 → 에디트 이름 → 음역), & 는 그대로. 이름이 하나도 없거나 가나가 아닌 것이 섞이면 null(원작 그대로)
  function teamName(s) {
    const m = /^([ぁ-ゖァ-ヺー]*)(&?)([ぁ-ゖァ-ヺー]*)$/.exec(s);
    if (!m || (!m[1] && !m[3]) || (m[3] && !m[2]) || m[1].length > T.name_cells || m[3].length > T.name_cells) return null;
    return (m[1] ? koName(m[1]) : '') + m[2] + (m[3] ? koName(m[3]) : '');
  }
  const slotKo = (sl, s) => { const raw = s.substr(sl.at, sl.len); return sl.k === 'N' ? koName(raw) : raw.trim(); };
  function patText(p, s) {
    let ko = p.ko;
    for (const sl of p.slots) ko = ko.replace('{' + sl.k + '}', slotKo(sl, s));
    return ko;
  }
  // 찍히는 도중의 문구: 후보들의 완성 한글에서 공통인 앞부분까지만, 진행 비율만큼 보인다 → { text, fits(글꼴을 정할 완성 문구들) }
  function typed(cands, s) {
    const fulls = cands.map(c => c.full(s)); let n = Infinity, l = fulls[0].length;
    cands.forEach((c, i) => { n = Math.min(n, Math.ceil(fulls[i].length * s.length / c.len)); });
    for (let i = 1; i < fulls.length; i++) { let k = 0; while (k < l && fulls[i][k] === fulls[0][k]) k++; l = k; }
    const head = cands[0].head ? cands[0].head(s) : null; // 맨 앞 이름·번호 칸: 찍힌 만큼 그대로, 다 찍힌 뒤에는 줄어들지 않게
    if (head !== null) n = head.done ? Math.max(n, head.len) : head.len;
    return { text: fulls[0].slice(0, Math.min(n, l)), fits: cands.map((c, i) => c.fit ? c.fit(s) : fulls[i]) };
  }
  const msgCand = p => { const s0 = p.slots.length && p.slots[0].at === 0 ? p.slots[0] : null; return { len: p.pat.length, full: s => patText(p, s.padEnd(p.pat.length, ' ')),
    head: s0 ? s => ({ len: slotKo(s0, s).length, done: s.length > s0.len }) : null,
    // 글꼴을 정할 완성 문구: 이름이 찍히는 도중이면 그 글자로 시작하는 이름표의 이름으로 어림한다(없으면 찍힌 만큼)
    fit: s0 && s0.k === 'N' ? s => { let t = s; if (s.length <= s0.len) { const n = Object.keys(T.names).filter(k => k.length <= s0.len && k.startsWith(s.trim())).sort((x, y) => y.length - x.length)[0]; if (n) t = n; } return patText(p, t.padEnd(p.pat.length, ' ')); } : null }; };
  // 스크립트 줄 대조: 런 s → { off(화자 접두 칸 수), text, fits } | 0(화자 접두만 찍힘: 덮을 것 없음) | null(이 스크립트의 줄이 아님)
  //   다 찍힌 줄 = 그 번역, 찍히는 도중 = 맞는 후보들의 공통 앞부분을 진행 비율만큼(typed). 글꼴은 완성 문구 폭으로 정한다(다 찍힌 순간에 바뀌지 않게)
  function scriptLine(lines, s) {
    let speaker = false; const by = new Map();
    for (const l of lines) {
      if (l.pre) { const pt = l.pre.trimEnd(); if (s.length <= pt.length) { if (pt.startsWith(s)) speaker = true; continue; } if (!s.startsWith(l.pre)) continue; }
      const body = s.slice(l.pre.length), m = patMatch(l, body, true); if (!m) continue;
      if (m === 2) return { off: l.pre.length, text: patText(l, body), fits: null };
      const g = by.get(l.pre.length) || []; g.push(l); by.set(l.pre.length, g);
    }
    for (const [off, g] of by) { const t = typed(g.map(msgCand), s.slice(off)); return { off, text: t.text, fits: t.fits }; }
    return speaker ? 0 : null;
  }
  const choiceHere = (c, ctx) => !c.scr || ctx.key.startsWith(c.scr); // 화면 전용 선택지(표의 scr: 대기실 10:2 의 「しあいをやる」 등)는 그 화면에서만
  const uiOk = (u, ctx) => !!u && (u.choice ? ctx.choice && choiceHere(u, ctx) : !u.rows || u.rows.includes(ctx.row)); // 선택지 낱말은 그 화면의 선택지 줄에서만
  function word(tok, next, ctx) { // 낱말 하나 → 한글(없으면 null). 조회는 문맥으로 제한: 선택지는 선택지 줄, 별자리는 「座」 앞에서만
    const u = uiMap.get(tok); if (uiOk(u, ctx)) return u.ko;
    if (T.names[tok]) return T.names[tok];
    if (T.moves[tok]) return T.moves[tok];
    if (T.zodiac[tok] && next && next[0] === '座') return T.zodiac[tok];
    if (tok === '(' && next && T.zodiac[next]) return ''; // 별자리 앞에 따로 찍힌 여는 괄호(원작 8x8 타일): 칸만 가리고, 괄호는 별자리 낱말 앞에 같은 글꼴로 붙여 그린다(run() 의 낱말 단위) → 닫는 괄호(「자리)」)와 짝이 맞는다
    if (tok[0] === '(' && T.zodiac[tok.slice(1)] && next && next[0] === '座') return '(' + T.zodiac[tok.slice(1)]; // 다섯 글자 별자리(おひつじ)는 괄호에 붙어 찍힌다
    // 에디트 화면(5:2) 생일 줄: 별자리가 「座)」에 붙어 찍힌다(「(おひつじ座)」「(  やぎ座)」). 한글은 여는 괄호 칸에서 시작해 한 덩어리로 그리고(「(염소 자리)」), 괄호와 떨어진 별자리 낱말은 칸만 가린다
    const za = uiMap.get('座)'), zt = s => { const m = /^(.+)座\)$/.exec(s); return za && m && T.zodiac[m[1]] ? '(' + T.zodiac[m[1]] + ' ' + za.ko : null; };
    if (tok[0] === '(' && zt(tok.slice(1) || (next || ''))) return zt(tok.slice(1) || next);
    if (zt(tok)) return '';
    if (tok === '(' && next === '座)') return '('; // 별자리가 아직 없는 빈 괄호: 닫는 괄호(「자리)」)와 같은 글꼴로
    for (const r of rules) if (r.re.test(tok)) return tok.replace(r.re, r.ko);
    return null;
  }

  // ---- PPU 상태 읽기 ----
  // lt: 라인별 [v, fx | ctrl<<8, R0 | R1<<8, mask | bsel7<<8 | mirrorV<<9]
  function bands(lt) {
    const out = []; let cur = null;
    for (let y = 0; y < 240; y++) {
      const o = y * 4, v = lt[o], fx = lt[o + 1] & 7, ctrl = lt[o + 1] >> 8, bk = lt[o + 2], fl = lt[o + 3];
      if (!(fl & 8)) { cur = null; continue; } // 배경 꺼진 라인
      const cy = (v >> 5) & 31, fy = (v >> 12) & 7, nt = (v >> 10) & 3, cx = v & 31;
      if (cur && cur.cy === cy && cur.nt === nt && cur.cx === cx && cur.fx === fx && cur.bk === bk && cur.fl === fl && cur.ctrl === ctrl && fy === cur.fy0 + (y - cur.y0)) { cur.h++; continue; }
      cur = { y0: y, fy0: fy, h: 1, cy, nt, cx, fx, bk, fl, ctrl }; out.push(cur);
    }
    return out;
  }
  const lineOf = (lt, y) => { const o = y * 4, v = lt[o]; return { cy: (v >> 5) & 31, nt: (v >> 10) & 3, cx: v & 31, fx: lt[o + 1] & 7, ctrl: lt[o + 1] >> 8, bk: lt[o + 2], fl: lt[o + 3] }; };
  const bankIs = (b, bank) => (b.bk & 0xFE) === bank[0] && ((b.bk >> 8) & 0xFE) === bank[1] && !(b.ctrl & 0x10) && !(b.fl & 0x100);
  const isAlt = b => !!alt && bankIs(b, alt.bank);
  const isFont = b => bankIs(b, T.font_bank) || isAlt(b);
  // 타일 → 글자. 대체 뱅크 줄: $80 미만은 폰트 앞 절반 그대로, $80 이상은 그 화면의 타일표만
  const glyph = (t, b) => isAlt(b) ? (t < 0x80 ? T.tiles[t] : alt.tiles[t]) : xt && xt[t] !== undefined ? xt[t] : T.tiles[t];
  // 이웃 줄: 화면 라인 y 가 같은 네임테이블의 cy 행을 같은 가로 스크롤·폰트 뱅크로 보여 주는가
  const sameCol = (u, b, cy) => !!(u.fl & 8) && u.cy === cy && u.nt === b.nt && u.cx === b.cx && u.fx === b.fx && isFont(u);
  // 캐릭터 선택·상대 선택의 이름 칸 줄(그림 뱅크, 가로 스크롤 없음)
  const gfxRow = (b, bank) => bankIs(b, bank) && b.cx === 0 && b.fx === 0 && !(b.nt & 1);
  const isPlate = b => !!T.plates && gfxRow(b, T.plates.bank);
  // 바로 윗줄(탁점 줄) → { cells, top }. top = 윗줄이 실제로 보이는 첫 화면 라인(분할 때문에 8라인이 다 안 보일 수 있다: 안내문 창은 6라인만 보인다)
  function upper(b, lt, vram) {
    if (b.y0 < 1 || b.cy < 1) return null;
    const u = lineOf(lt, b.y0 - 1); if (!sameCol(u, b, b.cy - 1)) return null;
    let top = b.y0 - 1; while (top > 0 && top > b.y0 - 8 && sameCol(lineOf(lt, top - 1), b, b.cy - 1)) top--;
    return { cells: cells(u, vram), top };
  }
  // 바로 아랫줄(창 테두리가 붙어 있는지 보는 용도)
  function lower(b, lt, vram) {
    if (b.y0 + 8 > 239 || b.cy >= 29) return null;
    const u = lineOf(lt, b.y0 + 8); return sameCol(u, b, b.cy + 1) ? cells(u, vram) : null;
  }
  function cells(b, vram) { // 화면 왼쪽부터 33칸: { t 타일, pa 팔레트, x }
    const out = [], mv = b.fl & 0x200, nty = (b.nt >> 1) & 1; let ntx = b.nt & 1, cx = b.cx;
    for (let k = 0; k < 33; k++) {
      const phys = (mv ? ntx : nty) * 0x400, t = vram[phys + (b.cy << 5) + cx], at = vram[phys + 0x3C0 + ((b.cy >> 2) << 3) + (cx >> 2)];
      out.push({ t, pa: (at >> (((b.cy & 2) << 1) | (cx & 2))) & 3, x: k * 8 - b.fx });
      if (++cx === 32) { cx = 0; ntx ^= 1; }
    }
    return out;
  }
  // 글자 타일의 바탕색·글자색(타일 64픽셀에서 가장 많은 색 = 바탕, 그다음 = 글자)
  function tileBase(t, b) {
    const bank = t < 0x40 ? (b.bk & 0xFE) : t < 0x80 ? (b.bk & 0xFE) + 1 : t < 0xC0 ? ((b.bk >> 8) & 0xFE) : ((b.bk >> 8) & 0xFE) + 1;
    return (bank % (chr.length >> 10)) * 0x400 + (t & 0x3F) * 16;
  }
  function tilePix(t, b) { // 타일 8x8 의 색 번호(행 우선, 왼쪽부터)
    const base = tileBase(t, b), px = new Uint8Array(64);
    for (let r = 0; r < 8; r++) { const lo = chr[base + r], hi = chr[base + r + 8]; for (let i = 0; i < 8; i++) px[r * 8 + i] = ((lo >> (7 - i)) & 1) | (((hi >> (7 - i)) & 1) << 1); }
    return px;
  }
  function tileCount(t, b, n) { // 타일 64픽셀의 색 번호별 개수를 n 에 더한다
    const base = tileBase(t, b);
    for (let r = 0; r < 8; r++) { const lo = chr[base + r], hi = chr[base + r + 8]; for (let i = 0; i < 8; i++) n[((lo >> i) & 1) | (((hi >> i) & 1) << 1)]++; }
    return n;
  }
  function tileColors(ts, pa, b, pal) { // ts = 그 런의 글자 타일들. 한 타일만 보면 「♥」처럼 획이 칸의 절반을 넘는 글자에서 바탕·글자색이 뒤집힌다(룰 선택 제목) → 런 전체로 센다
    const n = [0, 0, 0, 0]; for (const t of ts) tileCount(t, b, n);
    let bg = 0; for (let i = 1; i < 4; i++) if (n[i] > n[bg]) bg = i;
    let fg = -1; for (let i = 0; i < 4; i++) if (i !== bg && n[i] && (fg < 0 || n[i] > n[fg])) fg = i;
    const col = i => pal32[pal[i ? pa * 4 + i : 0] & 0x3F];
    return { bg: col(bg), fg: col(fg < 0 ? 1 : fg) };
  }

  // ---- 화면 → 그리기 목록 ----
  // 허용 상태 유지: 화면 키(RAM)는 페이드아웃이 시작될 때 이미 다음 화면으로 바뀌지만 네임테이블은 아직 이전 화면이다.
  // 화면 키로 본 판정(허용 화면·타이틀 여부)이 직전 판정과 달라졌는데 배경 팔레트가 전부 $0F(검정)가 아니고 네임테이블이 판정이 같던 마지막 때와
  // 거의 같으면(HOLD_DIFF 바이트 이하: 화면 전환이 아니라 낱칸 몇 개만 바뀜) 직전 판정을 그대로 쓴다. 화면이 실제로 바뀌는 것은 검정일 때다.
  const HOLD_DIFF = 96; let hold = null; const holdVram = new Uint8Array(0x800);
  function scan(snap, ram) {
    const ops = { fill: [], text: [], top: [], runs: [], grid: [] }, vram = snap.vram, bs = bands(snap.lt);
    const unmatched = [], key = ram[0x641] + ':' + (ram[0x642] & 0x7F) + ':';
    let black = true; for (let i = 0; i < 16; i++) if ((snap.pal[i] & 0x3F) !== 0x0F) { black = false; break; }
    let st = { key, scr: screens.find(p => key.startsWith(p.key)) || null, title: ram[0x641] === 3 }; // scr = 글자 덧그리기를 하는 화면(검토를 마친 화면만. 그 밖은 원작 그대로)
    if (st.scr && st.scr.alt && st.scr.alt.need && !bs.some(b => bankIs(b, st.scr.alt.bank))) st.scr = null; // 그 화면의 그림 뱅크가 보일 때만 그 화면으로 본다
    let keep = false;
    if (hold && !black && (hold.scr !== st.scr || hold.title !== st.title)) { let d = 0; for (let i = 0; i < 0x800 && d <= HOLD_DIFF; i++) if (holdVram[i] !== vram[i]) d++; keep = d <= HOLD_DIFF; }
    if (keep) st = hold; else { hold = st; holdVram.set(vram); }
    alt = st.scr && st.scr.alt || null; xt = st.scr && st.scr.tiles || null; pin = st.scr && st.scr.pin || null;
    stats.key = key; stats.held = keep; stats.hidden = 0; stats.script = st.scr && st.scr.script ? ram[0x68C] : -1;
    // 스크립트 화면(대화 창): 지금 출력 중인(또는 마지막으로 출력한) 스크립트 id 의 줄 목록. 값은 출력이 끝나도 남으므로 줄 대조가 맞을 때만 쓴다.
    // 스크립트 화면에서는 그 스크립트의 줄과 맞는 런만 덮는다(표에 없는 id = 빈 목록). 장면 전환(6:2) 중 25·27행에 비치는 그림 타일을 글자로 읽어 덧그리지 않게(관측: 6:2 첫 프레임들)
    const sl = st.scr && st.scr.script ? scripts[ram[0x68C]] || [] : null;
    for (const b of bs) {
      if (!st.scr) break;
      if (b.fy0 !== 0 || b.h !== 8 || b.cy > 29 || !isFont(b) || !st.scr.rows.includes(b.cy)) continue; // 화면마다 글자가 있는 행만 읽는다(테두리·그림 타일을 글자로 읽지 않게)
      const cs = cells(b, vram), up = upper(b, snap.lt, vram), upc = up && up.cells, colr = st.scr.cols && st.scr.cols[b.cy] || null;
      // 글자 해독(윗줄 탁점 합침)
      const ch = cs.map((c, k) => {
        let s = c.x < 256 ? glyph(c.t, b) : undefined; if (s === undefined) return null; // 화면 밖(33번째 칸, 가로 스크롤이 없을 때)은 읽지 않는다
        if (colr) { const col = (b.cx + k) & 31; if (col < colr[0] || col > colr[1]) return null; } // 그 행에서 읽는 열 범위 밖(입력 중인 이름·가나 입력표)
        if (upc && s !== ' ') { const d = upc[k].t; if (d === 0x0C || d === 0x0D) { const v = (s + (d === 0x0C ? '゙' : '゚')).normalize('NFC'); if (v.length === 1) s = v; } }
        return s;
      });
      const ctx = { row: b.cy, key: st.key, msg: T.msg_rows.includes(b.cy), choice: (st.scr.choice || T.choice_rows).includes(b.cy), lo: lower(b, snap.lt, vram), pal: snap.pal, lines: sl, team: !!st.scr.names && st.scr.names.includes(b.cy), small: !!st.scr.small && st.scr.small.includes(b.cy) };
      let k = 0;
      while (k < 33) {
        if (ch[k] === null) { k++; continue; }
        let e = k; while (e < 33 && ch[e] !== null) e++;
        let a = k, z = e; while (a < z && ch[a] === ' ') a++; while (z > a && ch[z - 1] === ' ') z--;
        if (z > a) run(b, cs, up, ch, a, z, e, ops, unmatched, ctx);
        k = e;
      }
    }
    if (st.scr && T.plates && T.plates.screens.includes(st.scr.key)) for (const b of bs) if (b.fy0 === 0 && b.h === 8 && isPlate(b) && T.plates.rows.includes(b.cy)) plates(b, cells(b, vram), ops, unmatched, snap.pal);
    if (st.scr && (st.scr.grid || st.scr.field)) for (const b of bs) { // 가나 칸 1:1 한글(가나 입력표·입력 칸·PASSWORD 줄)
      if (b.fy0 !== 0 || b.h !== 8 || b.cy > 29 || !isFont(b)) continue;
      if (st.scr.grid && st.scr.grid.rows.includes(b.cy)) kanaGrid(b, snap, ops, st.scr.grid);
      if (st.scr.field && st.scr.field.row === b.cy) kanaField(b, snap, ops, st.scr.field);
    }
    if (st.scr && T.labels && boldOk && T.labels.screens.includes(st.scr.key)) for (const b of bs) if (b.fy0 === 0 && b.h === 8 && gfxRow(b, T.labels.bank)) labels(b, snap, ops);
    if (ram[0x641] === 1) for (const b of bs) if (b.fy0 === 0 && b.h === 8 && b.cy === HUD.row && gfxRow(b, HUD.bank)) hudNames(b, snap, ops, unmatched); // 전투 입장(1:4)·대치·전투(1:2)·끝(1:5) 공통
    stats.screen = '';
    if (st.title) title(snap, bs, ops.top);
    stats.unmatched = unmatched; stats.runs = ops.runs; stats.grid = ops.grid; stats.scans++;
    return ops.fill.concat(ops.text, ops.top); // 가리기 전부 → 글자 전부(글자가 아래·윗줄 가리기에 잘리지 않게) → 로고
  }
  // 런 [a, z) 처리. rawEnd = 뒤쪽 빈칸을 포함한 런의 끝(넘침 한계)
  function run(b, cs, up, ch, a, z, rawEnd, ops, unmatched, ctx) {
    const s = ch.slice(a, z).join(''), limit = cs[rawEnd - 1].x + 8, upc = up && up.cells;
    const toks = []; { let i = a; while (i < z) { if (ch[i] === ' ') { i++; continue; } let j = i; while (j < z && ch[j] !== ' ') j++; toks.push({ a: i, z: j, s: ch.slice(i, j).join('') }); i = j; } }
    // 고정 라벨 화면: 「12月31日」「月31日」처럼 붙어 찍힌 낱말을 라벨 칸 뒤에서 끊는다(앞쪽이 숫자·영문이거나 비었을 때만. 「誕生日」는 그대로) → 값이 깜빡여도 낱말 구성이 같다
    if (pin) for (let i = 0; i < toks.length; i++) { const t = toks[i];
      for (let q = t.a; q < t.z - 1; q++) if (pin[ch[q]] !== undefined && PIN_PRE.test(ch.slice(t.a, q).join(''))) { toks.splice(i, 1, { a: t.a, z: q + 1, s: ch.slice(t.a, q + 1).join('') }, { a: q + 1, z: t.z, s: ch.slice(q + 1, t.z).join('') }); break; } }
    const choiceLine = ctx.choice && toks.every(t => choices.some(c => choiceHere(c, ctx) && c.ja.startsWith(t.s))); // 선택지 줄(찍히는 도중 포함)
    let items = null;
    // 0) 스크립트 대사 줄(대화 창): 지금 스크립트의 줄과 대조(화자 접두는 원작 그대로 두고 「 부터 덮는다). 맞지 않거나 화자만 찍힌 상태면 덮지 않는다(원작 그대로)
    if (ctx.lines) {
      const r = ctx.msg ? scriptLine(ctx.lines, s) : null;
      if (!r) return;
      items = [{ a: a + r.off, z, text: r.text, fits: r.fits }];
    }
    // 1) 런 전체가 UI 문구 / 안내문(이름 칸 포함) / 찍히는 도중의 안내문(앞부분 일치)
    const wholeUi = items ? null : uiMap.get(s);
    if (items) { /* 0) 에서 정함 */ }
    else if (uiOk(wholeUi, ctx)) items = [{ a, z, text: wholeUi.ko, align: wholeUi.align, x: wholeUi.x, dy: wholeUi.dy, small: wholeUi.small }];
    else if (ctx.msg && !choiceLine) {
      const full = msgPat.find(p => patMatch(p, s, true) === 2);
      if (full) items = [{ a, z, text: patText(full, s) }];
      else {
        let cand = msgPat.filter(p => patMatch(p, s, false) === 1);
        if (!cand.length && !ctx.choice) cand = msgPat.filter(p => patMatch(p, s, true) === 1); // 이름·번호 칸만 찍힌 상태(글자가 맞는 후보가 없을 때만)
        const here = cand.filter(p => p.scr && ctx.key.startsWith(p.scr)); if (here.length) cand = here; // 이 화면에서 나오는 것으로 확인된 안내문이 있으면 그것만
        if (cand.length) { const t = typed(cand.map(msgCand), s); items = [{ a, z, text: t.text, fits: t.fits }]; }
      }
    }
    // 2) 낱말 단위
    if (!items) {
      items = []; let any = false;
      for (let i = 0; i < toks.length; i++) {
        const tk = toks[i]; let hit = null;
        for (let j = Math.min(toks.length - 1, i + 2); j > i && !hit; j--) { // 한 칸 띄어 쓴 여러 낱말 문구
          let ok = true; for (let q = i; q < j; q++) if (toks[q + 1].a - toks[q].z !== 1) ok = false;
          if (!ok) continue;
          const u = uiMap.get(toks.slice(i, j + 1).map(t => t.s).join(' ')); if (uiOk(u, ctx)) { hit = { a: tk.a, z: toks[j].z, text: u.ko, align: u.align, small: u.small }; i = j; }
        }
        if (!hit && i > 0 && /^([1-4]P|CPU)$/.test(toks[i - 1].s) && isKana(tk.s) && tk.s.length <= T.name_cells) hit = { a: tk.a, z: tk.z, text: koName(tk.s) }; // 이름 칸(「1P 〈이름〉」): 이름표 → 음역만
        if (!hit && ctx.team) { const t = teamName(tk.s); if (t !== null) hit = { a: tk.a, z: tk.z, text: t }; } // 팀 이름 줄(승패표·원작 대진표): 「이름」「&이름」「이름&이름」
        if (!hit) { let w = word(tk.s, toks[i + 1] && toks[i + 1].s, ctx); if (w !== null) { if (i > 0 && toks[i - 1].s === '(' && T.zodiac[tk.s]) w = '(' + w; hit = { a: tk.a, z: tk.z, text: w }; } }
        if (!hit && ctx.choice && isKana(tk.s)) { // 찍히는 도중의 선택지
          const cand = choices.filter(c => choiceHere(c, ctx) && c.ja.startsWith(tk.s));
          if (cand.length) { const t = typed(cand.map(c => ({ len: c.ja.length, full: () => c.ko })), tk.s); hit = { a: tk.a, z: tk.z, text: t.text }; }
        }
        if (!hit && (ctx.msg || ctx.choice) && hasKana(tk.s)) { hit = { a: tk.a, z: tk.z, text: '' }; stats.hidden++; } // 안내문·선택지 줄의 표에 없는 가나: 가리기만
        if (hit) { any = true; items.push(hit); }
        else { items.push({ a: tk.a, z: tk.z, keep: tk.s }); if (/[^\x00-\x7F♥・…、。「」ー]/.test(tk.s)) unmatched.push(tk.s); }
      }
      if (!any) return;
    }
    // 고정 라벨(「4月」「AB型」, 값이 빈 「月」): 한글 라벨을 그 한자 칸의 x(+ 표의 값)에 고정하고 값은 라벨 왼쪽에 오른쪽 맞춤으로 붙인다(3) 배치에서 앞 낱말에 밀리지 않는다)
    if (pin) for (const it of items) {
      if (!it.text || it.x !== undefined) continue;
      const c = ch[it.z - 1], lab = pin[c] !== undefined && uiMap.get(c), pre = ch.slice(it.a, it.z - 1).join('');
      if (lab && PIN_PRE.test(pre) && it.text === pre + lab.ko) { it.pin = cs[it.z - 1].x + pin[c]; it.pre = pre; }
    }
    // 3) 배치: 원래 낱말 자리에서 시작하되 앞 낱말이 넘치면 뒤로 민다. 한계를 넘으면 작은 글꼴, 그래도 넘으면 한계에서 자른다.
    //    찍히는 도중의 안내문은 완성 문구의 폭으로 글꼴을 정한다(다 찍힌 순간에 글자 크기가 바뀌지 않게).
    const inked = cs.slice(a, z).filter(c => glyph(c.t, b) !== ' '), first = inked[0] || cs[a], cts = inked.length ? inked.map(c => c.t) : [first.t];
    if (cts.length === 1) { const bl = cs.slice(a, rawEnd).find(c => glyph(c.t, b) === ' '); if (bl) cts.push(bl.t); } // 한 글자짜리 런(에디트 화면의 「型」): 획이 칸의 절반을 넘는 한자는 바탕·글자색이 뒤집힌다 → 그 런의 빈칸 타일도 같이 센다
    const col = tileColors(cts, first.pa, b, ctx.pal);
    const edge = q => q > 0 && ch[q - 1] === null; // 왼쪽 칸이 창 테두리(글자 타일이 아님)면 1px 띄운다
    let f = FONT_L, placed = null;
    // small = 작은 글꼴 고정: 그 화면의 줄(screens[키].small: 승패표 이름 줄. 칸마다 글꼴이 갈리지 않게) 또는 런의 문구가 전부 표에서 small 인 것(스테이터스 「필살기」 머리줄: 아랫줄과 붙지 않게)
    const smallRun = ctx.small || items.every(it => it.small);
    for (const cand of smallRun ? [FONT_S] : [FONT_L, FONT_S]) {
      f = cand; placed = []; let cur = -1e9, end = -1e9;
      for (const it of items) {
        const x0 = it.x !== undefined ? it.x : cs[it.a].x + (edge(it.a) ? 1 : 0), w0 = (it.z - it.a) * 8;
        if (it.keep !== undefined) { if (x0 >= cur) { cur = x0 + w0 + GAP; end = Math.max(end, x0 + w0); continue; } placed.push({ it, x: cur, text: it.keep }); cur += width(it.keep, f) + GAP; end = cur - GAP; continue; }
        if (!it.text && !it.fits) { placed.push({ it, x: x0, text: '' }); continue; }
        const w = width(it.text, f); let wf = w; if (it.fits) for (const t of it.fits) wf = Math.max(wf, width(t, f));
        let x = it.pin !== undefined ? it.pin - width(it.pre, f) : it.align === 'center' && items.length === 1 ? Math.round(x0 + w0 / 2 - w / 2) : x0;
        if (x < cur && it.pin === undefined) x = cur;
        placed.push({ it, x, text: it.text, w }); cur = x + w + GAP; end = Math.max(end, x + wf);
      }
      if (end <= limit) break;
    }
    // 세로: 한글 잉크(11px/9px)의 가운데를 8px 줄의 가운데에(위로 2px, 아래로 1px 넘침).
    //  · 아랫줄에 창 테두리가 붙어 있으면 테두리와 1px 띄우도록 올린다.
    //  · 윗줄에 창 테두리 같은 것이 있으면(빈칸·탁점이 아니면) 그 아래로 1px 띄워 내리고, 윗줄이 화면에 일부만 보이면 보이는 범위 위로 올라가지 않는다.
    const m = fontMetrics(f); let inkTop = b.y0 + 4 - Math.round(m.ink / 2), minTop = up ? up.top : b.y0;
    const blankUp = q => glyph(upc[q].t, b) === ' ' || upc[q].t === 0x0C || upc[q].t === 0x0D;
    const borderLo = q => !ctx.team && !!ctx.lo && glyph(ctx.lo[q].t, b) === undefined /* 팀 이름 줄 아래의 성적 괄호 [ ] 는 창 테두리가 아니다 */ && ctx.lo[q].t !== 0x0C && ctx.lo[q].t !== 0x0D;
    for (const p of placed) for (let q = p.it.a; q < p.it.z; q++) { if (borderLo(q)) inkTop = Math.min(inkTop, b.y0 + 7 - m.ink); if (upc && !blankUp(q)) minTop = Math.max(minTop, b.y0 + 1); }
    inkTop = Math.max(inkTop, minTop);
    if (items.length === 1 && items[0].dy !== undefined) inkTop = b.y0 + items[0].dy; // 표가 세로 위치를 정한 문구(이름 줄 옆으로 옮기는 설명 줄)
    if (f === FONT_S) stats.small++;
    ops.runs.push({ row: b.cy, ja: s, ko: placed.map(p => p.text).join(' '), font: f.name });
    for (const p of placed) {
      // 가리기: 낱말 칸 + 윗줄의 탁점 칸(윗줄이 실제로 보이는 라인만: 그 위는 다른 줄 = 구분선)
      ops.fill.push({ k: 'fill', x: cs[p.it.a].x, y: b.y0, w: (p.it.z - p.it.a) * 8, h: 8, c: col.bg });
      if (upc) for (let q = p.it.a; q < p.it.z; q++) if (upc[q].t === 0x0C || upc[q].t === 0x0D) ops.fill.push({ k: 'fill', x: upc[q].x, y: up.top, w: 8, h: b.y0 - up.top, c: col.bg });
    }
    for (const p of placed) {
      if (!p.text) continue;
      const w = p.w !== undefined ? p.w : width(p.text, f), over = p.x + w > limit;
      if (over) stats.clipped++;
      ops.text.push({ k: 'text', s: p.text, f, x: p.x, y: inkTop - m.top, c: col.fg, x1: over ? limit : 256 });
    }
  }
  // ---- 가나 칸 1:1 한글(13 문서 17절) ----
  // 칸 k 의 가나 → { s, merged(윗줄 탁점을 글자에 합침), dak(합치지 않은 윗줄 탁점 타일 또는 0) } 또는 null. 열 범위 [c0, c1] 밖·화면 밖·빈칸은 null
  //   합치지 않는 탁점: NFC 로 한 글자가 되지 않는 조합(あ+゛ 등)과 ゔ(う+゛ → 「부」면 ぶ 와 같아진다 → 「우」 + 원작 탁점 그대로, 17.7절)
  function kanaAt(b, cs, upc, k, c0, c1) {
    const col = (b.cx + k) & 31; if (col < c0 || col > c1 || cs[k].x < 0 || cs[k].x >= 256) return null;
    let s = glyph(cs[k].t, b), merged = false, dak = 0; if (s === undefined || s === ' ') return null;
    if (upc) { const d = upc[k].t; if (d === 0x0C || d === 0x0D) { const v = (s + (d === 0x0C ? '゙' : '゚')).normalize('NFC'); if (v.length === 1 && v !== 'ゔ') { s = v; merged = true; } else dak = d; } }
    return { s, merged, dak };
  }
  const kfont = c => c === 'M' ? FONT_M : c === 'T' ? (tinyOk ? FONT_T : FONT_S) : c === 'S' ? FONT_S : FONT_L;
  // 글자 하나의 그리기(잉크 아래끝 = bot, 작은 가나도 같은 아래끝: 원작 작은 가나처럼 낮게 앉는다)
  const kanaText = (s, f, x, bot, c, x1) => { const m = fontMetrics(f); return { k: 'text', s, f, x, y: bot - m.ink + 1 - m.top, c, x1 }; };
  // 가나 입력표(5:2 10~20행): 칸마다 가리고 그 칸(8x8) 안에 한글 한 글자(G.font, 기본 Galmuri7: 잉크 폭 7px 이하).
  //   칸 사이 빈칸(8px)에는 커서 ▶(스프라이트, 칸 왼쪽 8px 전부)가 오가고 한글 층은 스프라이트 위에 그려지므로, 칸 밖으로 넘치는 글꼴(Galmuri9 잉크 9px·Galmuri11 11px)은 커서와 겹친다(실측) → 칸 안에만 그린다.
  //   작은 가나(G.small, 기본 M = 손 도트 잉크 5px)는 큰 가나 잉크와 같은 아래끝에 붙인다(PASSWORD 줄처럼 크기로 구분). 손 도트에 없는 글자는 Galmuri7.
  //   합치지 않은 탁점(kanaAt dak)은 가리지 않는다(원작 그대로 보임). ゛゜ー·다음/이전/END 는 열 범위 밖(그대로/기존 표)
  function kanaGrid(b, snap, ops, G) {
    const cs = cells(b, snap.vram), up = upper(b, snap.lt, snap.vram), upc = up && up.cells, its = [];
    for (let k = 0; k < 33; k++) { const a = kanaAt(b, cs, upc, k, G.cols[0], G.cols[1]), ko = a && cellKo(a.s); if (ko) its.push({ k, a, ch: a.s, ko }); }
    if (!its.length) return;
    const col = tileColors(its.map(i => cs[i.k].t), cs[its[0].k].pa, b, snap.pal);
    const fb = kfont(G.font), mb = fontMetrics(fb), bigTop = b.y0 + Math.floor((8 - mb.ink) / 2), bigBot = bigTop + mb.ink - 1;
    for (const i of its) {
      let f = kfont(i.ko.small ? G.small : G.font); if (f.mini && !MINI[i.ko.s]) f = kfont('T');
      const sp = inkSpan(i.ko.s, f), x = cs[i.k].x + Math.floor((8 - sp.w) / 2) - sp.l;
      ops.fill.push({ k: 'fill', x: cs[i.k].x, y: b.y0, w: 8, h: 8, c: col.bg });
      if (upc && i.a.merged) ops.fill.push({ k: 'fill', x: upc[i.k].x, y: up.top, w: 8, h: b.y0 - up.top, c: col.bg });
      let y, top, h;
      if (f.mini) { h = MINI[i.ko.s].h; y = top = bigBot - h + 1; }
      else { const m = f === fb ? mb : fontMetrics(f); h = m.ink; top = f === fb ? bigTop : bigBot - m.ink + 1; y = top - m.top; }
      ops.text.push({ k: 'text', s: i.ko.s, f, x, y, c: col.fg, x1: cs[i.k].x + 8 });
      ops.grid.push({ row: b.cy, s: i.ko.s, small: i.ko.small, font: f.name, x: x + sp.l, y: top, w: sp.w, h, cx: cs[i.k].x, cy: b.y0 });
    }
    ops.runs.push({ row: b.cy, ja: its.map(i => i.ch).join(''), ko: its.map(i => i.ko.s).join(' '), font: 'grid' });
  }
  // 한 줄 칸 열(입력 중인 이름·패스워드, PASSWORD 줄): 칸 i 를 x0 + i*pitch 에 한 글자씩 다시 놓는다. 원래 칸 열(+ 늘어난 폭)과 윗줄 탁점 칸을 가리고,
  //   밑줄 줄(F.under: 에디트 입력 칸의 $84, 커서 칸이 깜빡임)은 같은 간격으로 다시 그린다(칸 i 에 밑줄 타일이 있을 때만 → 깜빡임 그대로)
  //   합치지 않은 탁점(ゔ 의 ゛, あ+゛ 등)은 원작 탁점 타일을 새 칸 위(같은 간격)에 다시 그린다. ー 는 「ー」 그대로(한글 줄 유지, 17.7절)
  function kanaField(b, snap, ops, F) {
    const cs = cells(b, snap.vram), up = upper(b, snap.lt, snap.vram), upc = up && up.cells, P = F.pitch, ks = [];
    for (let k = 0; k < 33; k++) { const col = (b.cx + k) & 31; if (col >= F.cols[0] && col <= F.cols[1] && cs[k].x >= 0 && cs[k].x < 256) ks.push(k); }
    if (!ks.length) return;
    const n = ks.length, kos = ks.map(k => { const a = kanaAt(b, cs, upc, k, F.cols[0], F.cols[1]), ch = a && a.s; return { ch, dak: a ? a.dak : 0, ko: ch === 'ー' ? { s: 'ー', small: false } : cellKo(ch) }; });
    const uc = F.under ? lower(b, snap.lt, snap.vram) : null, und = uc ? ks.map(k => uc[k].t === F.under.tile) : [];
    if (!kos.some(o => o.ko && o.ch !== 'ー') && !und.some(Boolean)) return;
    if (kos.some(o => o.ch && !o.ko)) return; // 가나가 아닌 글자가 섞이면 원작 그대로(모르는 화면 상태)
    const xa0 = cs[ks[0]].x, xz0 = cs[ks[n - 1]].x + 8, x0 = (F.center ? Math.round((xa0 + xz0) / 2 - n * P / 2) : xa0) + (F.dx || 0), xa = Math.min(xa0, x0), xz = Math.max(xz0, x0 + n * P);
    const kt = ks.filter((k, i) => kos[i].ko && kos[i].ch !== 'ー').map(k => cs[k].t), col = kt.length ? tileColors(kt, cs[ks[0]].pa, b, snap.pal) : null;
    if (col) {
      ops.fill.push({ k: 'fill', x: xa, y: b.y0, w: xz - xa, h: 8, c: col.bg });
      if (upc) for (const k of ks) if (upc[k].t === 0x0C || upc[k].t === 0x0D) ops.fill.push({ k: 'fill', x: upc[k].x, y: up.top, w: 8, h: b.y0 - up.top, c: col.bg });
      if (upc) kos.forEach((o, i) => { if (!o.dak) return; const pa = upc[ks[i]].pa, pc = j => pal32[snap.pal[j ? pa * 4 + j : 0] & 0x3F];
        ops.fill.push({ k: 'pat', x: x0 + i * P + Math.floor((P - 8) / 2), y: b.y0 - 8, ya: up.top, w: 8, px: tilePix(o.dak, b), cols: [pc(0), pc(1), pc(2), pc(3)], y1: b.y0 }); });
      const bot = b.y0 + 6;
      kos.forEach((o, i) => { if (!o.ko) return; const f = kfont(o.ko.small ? F.small : F.font), w = width(o.ko.s, f); ops.text.push(kanaText(o.ko.s, f, x0 + i * P + Math.floor((P - w) / 2), bot, col.fg, 256)); });
    }
    if (uc && und.some(Boolean) || uc && col) { // 밑줄 줄 다시 그리기: 바탕으로 가린 뒤, 밑줄 타일의 그림 줄(색 번호 ≠ 0 인 행)을 칸마다 pitch - 1 폭으로
      const uk = ks.find((k, i) => und[i]), ut = F.under.tile, ucol = tileColors([ut], uc[uk !== undefined ? uk : ks[0]].pa, b, snap.pal), px = tilePix(ut, b), y8 = b.y0 + 8;
      ops.fill.push({ k: 'fill', x: xa, y: y8, w: xz - xa, h: 8, c: ucol.bg });
      for (let j = 0; j < 8; j++) { if (!px.subarray(j * 8, j * 8 + 8).some(v => v)) continue; und.forEach((u, i) => { if (u) ops.fill.push({ k: 'fill', x: x0 + i * P, y: y8 + j, w: P - 1, h: 1, c: ucol.fg }); }); }
    }
    ops.runs.push({ row: b.cy, ja: kos.map(o => o.ch || ' ').join('').trimEnd(), ko: kos.map(o => o.ko ? o.ko.s + (o.dak ? (o.dak === 0x0C ? '゛' : '゜') : '') : '').join('').trim(), font: 'field' });
  }
  // 캐릭터 선택·상대 선택의 이름 칸(그림 타일 가나): 이름표에 있는 이름만 한글로 덮는다(없는 이름·모르는 타일이 섞인 이름은 원작 그대로).
  // 한글 이름은 Galmuri9 한 가지 크기로, 그 이름이 속한 칸(48px) 안에서 초상 가운데에 맞춘다(칸을 넘지 않는다. 4자 = 40px).
  // 글자가 걸치는 타일 칸은 단색이 아니라 빈 이름 칸 타일의 그림(바탕 + 흰 밑줄 두 줄)으로 덮는다 → 밑줄이 원작처럼 줄 끝까지 이어지고 한글이 그 위에 얹힌다(원작 가나도 밑줄 위에 얹혀 있다).
  function plates(b, cs, ops, unmatched, pal) {
    const P = T.plates, f = FONT_S, m = fontMetrics(f);
    for (let k = 0; k < 32;) {
      if (P.tiles[cs[k].t] === undefined) { k++; continue; }
      const a = k; let s = ''; while (k < 32 && P.tiles[cs[k].t] !== undefined) s += P.tiles[cs[k++].t];
      const ko = T.names[s], x0 = cs[a].x, sx = P.x0 + Math.floor((x0 - P.x0) / P.slot) * P.slot, w = ko ? width(ko, f) : 0;
      if (!ko || x0 < P.x0 || cs[k - 1].x + 8 > sx + P.slot || w > P.slot) { unmatched.push(s); continue; }
      const x = Math.max(sx, Math.min(sx + P.slot - w - (w < P.slot ? 1 : 0), sx + P.cx - Math.round(w / 2))); // 칸 오른쪽 끝과 1px 띄운다
      // 색: 바탕 = 빈 이름 칸에서 가장 많은 색, 밑줄 = 그다음 색. 글자색 = 이름 타일들에서 바탕·밑줄을 뺀 가장 많은 색
      const nb = tileCount(P.blank, b, [0, 0, 0, 0]), nn = [0, 0, 0, 0]; for (let q = a; q < k; q++) tileCount(cs[q].t, b, nn);
      let bgi = 0, li = -1, fgi = -1; for (let i = 1; i < 4; i++) if (nb[i] > nb[bgi]) bgi = i;
      for (let i = 0; i < 4; i++) if (i !== bgi && nb[i] && (li < 0 || nb[i] > nb[li])) li = i;
      for (let i = 0; i < 4; i++) if (i !== bgi && i !== li && nn[i] && (fgi < 0 || nn[i] > nn[fgi])) fgi = i;
      if (fgi < 0) { unmatched.push(s); continue; }
      const pc = i => pal32[pal[i ? cs[a].pa * 4 + i : 0] & 0x3F], col = { bg: pc(bgi), fg: pc(fgi) };
      const fa = Math.min(x0, x & ~7), fz = Math.max(cs[k - 1].x + 8, (x + w + 7) & ~7);
      ops.fill.push({ k: 'pat', x: fa, y: b.y0, w: fz - fa, px: tilePix(P.blank, b), cols: [pc(0), pc(1), pc(2), pc(3)] });
      ops.text.push({ k: 'text', s: ko, f, x, y: b.y0 + 8 - m.ink - m.top, c: col.fg, x1: sx + P.slot }); // 잉크 아래끝 = 줄 아래끝(9px 잉크면 위로 1px: 초상 발밑의 빈 줄)
      ops.runs.push({ row: b.cy, ja: s, ko, font: f.name });
    }
  }
  // 전투 HUD 이름 칸(13 문서 7절 2번): 분할선 아래 25행, BG 뱅크 R0 $68(그림)·R1 $64(폰트). 글자 = $80 + 폰트 글자 코드, ん 만 그림 타일 $7F.
  //   탁점·반탁점은 바로 윗줄(24행, 상자 위 테두리) 같은 열의 테두리 타일 $7D(゛)·$7E(゜)에 찍힌다(맨 테두리 = $78) [판독: 배틀 입장 1:4·전투 1:2·fight0, 「しばた」「いしづき」「じんない」].
  //   이름 칸은 라벨 그림 타일(1P·2P·CPU, 2칸) 바로 뒤 5칸. 한글 이름(이름표 → 없으면 음역)을 Galmuri9 로 그 5칸(40px) 안에 그리고, 윗줄 탁점 테두리는 맨 테두리 그림으로 덮는다.
  const HUD = { bank: [0x68, 0x64], row: 25, cells: 5, nn: 0x7F, dak: { 0x7D: '゙', 0x7E: '゚' }, edge: 0x78 };
  const hudCh = t => t === HUD.nn ? 'ん' : t >= 0x80 ? T.tiles[t - 0x80] : undefined;
  function hudNames(b, snap, ops, unmatched) {
    const cs = cells(b, snap.vram), f = FONT_S, m = fontMetrics(f), pal = snap.pal;
    const u = b.y0 >= 1 ? lineOf(snap.lt, b.y0 - 1) : null, upOk = !!u && (u.fl & 8) && u.cy === b.cy - 1 && gfxRow(u, HUD.bank);
    let top = b.y0; if (upOk) while (top > 0 && top > b.y0 - 8) { const v = lineOf(snap.lt, top - 1); if (!((v.fl & 8) && v.cy === b.cy - 1 && gfxRow(v, HUD.bank))) break; top--; }
    const upc = upOk ? cells(u, snap.vram) : null;
    for (let k = 1; k < 32; k++) {
      if (hudCh(cs[k - 1].t) !== undefined || hudCh(cs[k].t) === undefined || hudCh(cs[k].t) === ' ') continue; // 라벨(그림) 바로 뒤의 글자로 시작하는 칸만
      let z = k; while (z < Math.min(32, k + HUD.cells) && hudCh(cs[z].t) !== undefined) z++;
      let s = '';
      for (let q = k; q < z; q++) { let c = hudCh(cs[q].t); const d = upc && HUD.dak[upc[q].t]; if (d && c !== ' ') { const v = (c + d).normalize('NFC'); if (v.length === 1) c = v; } s += c; }
      const raw = s.trim(); if (!raw || !isKana(raw)) { if (raw) unmatched.push(raw); k = z; continue; }
      const ko = koName(raw), x0 = cs[k].x, x1 = x0 + HUD.cells * 8, nts = []; for (let q = k; q < z; q++) if (hudCh(cs[q].t) !== ' ') nts.push(cs[q].t);
      const col = tileColors(nts, cs[k].pa, b, pal);
      ops.fill.push({ k: 'fill', x: x0, y: b.y0, w: (z - k) * 8, h: 8, c: col.bg });
      if (upc) for (let q = k; q < z; q++) if (HUD.dak[upc[q].t]) { const pa = upc[q].pa, pc = i => pal32[pal[i ? pa * 4 + i : 0] & 0x3F]; ops.fill.push({ k: 'pat', x: upc[q].x, y: b.y0 - 8, ya: top, w: 8, px: tilePix(HUD.edge, u), cols: [pc(0), pc(1), pc(2), pc(3)], y1: b.y0 }); }
      ops.text.push({ k: 'text', s: ko, f, x: x0, y: b.y0 + 8 - m.ink - m.top, c: col.fg, x1 }); // 잉크 아래끝 = 줄 아래끝(캐릭터 선택 이름 칸과 같은 방식). 5칸을 넘는 이름(에디트 5자 음역)은 칸 끝에서 자른다
      if (x0 + width(ko, f) > x1) stats.clipped++;
      ops.runs.push({ row: b.cy, ja: raw, ko, font: f.name });
      k = z;
    }
  }
  // 캐릭터 선택·상대 선택의 유파 라벨(큰 그림 글자, 5x3 타일): 첫 줄 1열 타일로 라벨을 알아보고, 상자 안쪽(w x h)을 줄마다 "그 줄에서 글자색을 뺀 가장 많은 색"으로 다시 칠한 뒤
  // (= 글자 없는 원래 상자: 흰 바탕 + 아래 분홍 줄. 테두리 그림자는 건드리지 않는다) 분홍 줄 위쪽(th) 가운데에 Galmuri11 Bold 로 한글을 조판한다.
  function labels(b, snap, ops) {
    const L = T.labels, cs = cells(b, snap.vram), it = L.items[cs[L.col].t]; if (!it || b.y0 + 24 > 240) return;
    const rows = [cs];
    for (let r = 1; r < 3; r++) { // 아래 두 줄도 온전히 보이고 같은 라벨의 타일인가
      const u = lineOf(snap.lt, b.y0 + r * 8), e = lineOf(snap.lt, b.y0 + r * 8 + 7); if (!(u.fl & 8) || u.cy !== b.cy + r || e.cy !== u.cy || !gfxRow(u, L.bank) || !gfxRow(e, L.bank)) return;
      const c = cells(u, snap.vram); if (c[L.col].t !== cs[L.col].t + r * 16) return; rows.push(c);
    }
    const W = L.cols * 8, img = new Uint8Array(W * 24);
    rows.forEach((c, r) => { for (let q = 0; q < L.cols; q++) { const px = tilePix(c[L.col + q].t, b); for (let j = 0; j < 8; j++) img.set(px.subarray(j * 8, j * 8 + 8), (r * 8 + j) * W + q * 8); } });
    const ink = img[W - 1], paper = img[0]; if (ink === paper) return; // 오른쪽 그림자 = 글자색, 왼쪽 위 = 바탕색
    const f = FONT_B, m = fontMetrics(f), sp = inkSpan(it.ko, f); if (!sp.w || sp.w > L.w || m.ink > L.th) return;
    const x0 = cs[L.col].x, pa = cs[L.col].pa, pc = i => pal32[snap.pal[i ? pa * 4 + i : 0] & 0x3F];
    for (let j = 0; j < L.h; j++) {
      const n = [0, 0, 0, 0]; for (let i = 0; i < L.w; i++) n[img[j * W + i]]++;
      let best = -1; for (let i = 0; i < 4; i++) if (i !== ink && n[i] && (best < 0 || n[i] > n[best])) best = i;
      ops.fill.push({ k: 'fill', x: x0, y: b.y0 + j, w: L.w, h: 1, c: pc(best < 0 ? paper : best) });
    }
    ops.text.push({ k: 'text', s: it.ko, f, x: x0 + Math.floor((L.w - sp.w) / 2) - sp.l, y: b.y0 + Math.round((L.th - m.ink) / 2) - m.top, c: pc(ink), x1: x0 + L.w });
    ops.runs.push({ row: b.cy, ja: it.ja, ko: it.ko, font: f.name });
  }
  // 타이틀 로고(그림 타일): 모드 3 + BG 뱅크 $60/$62 + 네임테이블 0 의 로고 첫 줄 타일로 인식. 로고 칸을 하늘색(배경색)으로 가리고 한글 로고를 같은 중심에 그린다.
  // 로고는 색 번호 그림이라 그 프레임의 팔레트로 색을 입힌다(페이드·반짝임이 원작 로고와 같이 간다).
  function title(snap, bs, ops) {
    if (!logoMap || !bs.length) return;
    const b = bs[0]; if (b.y0 !== 0 || (b.bk & 0xFF) !== 0x60 || (b.bk >> 8) !== 0x62 || (b.nt & 2) || (b.fl & 0x200)) return;
    for (let i = 1; i < LOGO.anchor.length; i++) if (snap.vram[LOGO.row * 32 + LOGO.anchor[0] + i - 1] !== LOGO.anchor[i]) return;
    let split = 240; for (const q of bs) if (q.bk !== b.bk || (q.nt & 2)) { split = q.y0; break; } // 로고가 보이는 구간(분할선 위)
    const x = LOGO.col * 8 - (b.cx * 8 + b.fx), w = LOGO.cols * 8, h = LOGO.rows * 8;
    let y = (LOGO.row - b.cy) * 8 - b.fy0; while (y > 0) y -= 240;
    for (; y < split; y += 240) {
      if (y + h <= 0) continue;
      ops.push({ k: 'fill', x, y, w, h, c: pal32[snap.pal[0] & 0x3F], y1: split });
      ops.push({ k: 'logo', x: x + Math.round((w - logoMap.w) / 2) + LOGO.dx, y: y + Math.round((h - logoMap.h) / 2) + LOGO.dy, y1: split, pal: snap.pal });
    }
    stats.screen = 'title';
  }

  // ---- 그리기 ----
  // 층: 256x240 픽셀 버퍼(투명 = 0). 가리기·글자·로고를 색 값으로 직접 찍는다(캔버스 글자 그리기·클립 상태를 쓰지 않는다).
  const LW = 256, LH = 240; let layer = null, lctx = null, lim = null, l32 = null, lastSig = -1, has = false;
  function compose(ops) {
    if (!layer) { layer = document.createElement('canvas'); layer.width = LW; layer.height = LH; lctx = layer.getContext('2d'); lim = lctx.createImageData(LW, LH); l32 = new Uint32Array(lim.data.buffer); }
    l32.fill(0);
    for (const o of ops) {
      const y1 = Math.min(LH, o.y1 === undefined ? LH : o.y1);
      if (o.k === 'fill') { const xa = Math.max(0, o.x), xb = Math.min(LW, o.x + o.w); if (xb > xa) for (let y = Math.max(0, o.y); y < Math.min(y1, o.y + o.h); y++) l32.fill(o.c, y * LW + xa, y * LW + xb); }
      else if (o.k === 'pat') { // 8x8 타일 그림을 가로로 되풀이
        const xa = Math.max(0, o.x), xb = Math.min(LW, o.x + o.w);
        for (let j = 0; j < 8; j++) { const py = o.y + j; if (py < Math.max(0, o.ya || 0) || py >= y1) continue; /* ya = 그 줄이 화면에 실제로 보이는 첫 라인(분할로 일부만 보이는 줄) */ for (let px = xa; px < xb; px++) l32[py * LW + px] = o.cols[o.px[j * 8 + ((px - o.x) & 7)]]; }
      } else if (o.k === 'text') {
        let x = o.x; const xb = Math.min(LW, o.x1);
        for (const ch of o.s) { const g = glyphOf(ch, o.f);
          for (let j = 0; j < g.h; j++) { const py = o.y + j; if (py < 0 || py >= LH) continue; for (let i = 0; i < g.w; i++) if (g.bits[j * g.w + i]) { const px = x + i; if (px >= 0 && px < xb) l32[py * LW + px] = o.c; } }
          x += g.w; }
      } else if (o.k === 'logo') {
        for (let j = 0; j < logoMap.h; j++) { const py = o.y + j; if (py < 0 || py >= y1) continue;
          for (let i = 0; i < logoMap.w; i++) { const v = logoMap.idx[j * logoMap.w + i]; if (v === 255) continue; const px = o.x + i; if (px >= 0 && px < LW) l32[py * LW + px] = pal32[o.pal[v & 3 ? v : 0] & 0x3F]; } }
      }
    }
    lctx.putImageData(lim, 0, 0);
    has = ops.length > 0; stats.drawn = ops.length;
  }
  const fnv = (h, a) => { for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 16777619); } return h; };
  function draw(ctx, ox, snap, ram) {
    if (!ready || !snap) return;
    stats.frames++;
    const vh = fnv(2166136261, snap.vram) >>> 0, s = fnv(fnv(vh ^ ram[0x641] ^ (ram[0x642] << 8), snap.lt), snap.pal) >>> 0;
    if (s !== lastSig) { compose(scan(snap, ram)); lastSig = s; } // 네임테이블·라인표·팔레트·화면 키가 그대로면 층을 다시 쓴다
    if (has) ctx.drawImage(layer, ox, 0); // 층이 256x240 이라 코어 영역 밖으로 나가지 않는다
  }
  // 로고 그림 → 색 번호 그림(255 = 투명, 그 밖 = 팔레트 칸 번호). 흰색·검정은 행(split)으로 윗단(팔레트 0)·아랫단(팔레트 1)을 가른다.
  function indexLogo(img) {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data, idx = new Uint8Array(img.width * img.height);
    for (let i = 0; i < idx.length; i++) {
      if (d[i * 4 + 3] < 128) { idx[i] = 255; continue; }
      let best = 0, bd = Infinity;
      for (const [nes, slot] of LOGO_REF) { const p = pal32[nes], e = (d[i * 4] - (p & 255)) ** 2 + (d[i * 4 + 1] - ((p >> 8) & 255)) ** 2 + (d[i * 4 + 2] - ((p >> 16) & 255)) ** 2; if (e < bd) { bd = e; best = slot; } }
      idx[i] = (best === 1 || best === 3) && ((i / img.width) | 0) >= LOGO.split ? best + 4 : best;
    }
    return { w: img.width, h: img.height, idx };
  }
  const wtOf = w => w === 'bold' || w === '700' ? '700' : '400';
  const faceOf = F => { const fam = F.fam || F.name, w = wtOf(F.wt || 'normal'); for (const f of document.fonts) if (f.family.replace(/["']/g, '') === fam && wtOf(f.weight) === w) return f; return null; };
  const fontLoaded = F => { const f = faceOf(F); return !!f && f.status === 'loaded'; };
  // 글꼴 올리기: 같은 이름·굵기의 @font-face(ui_manga.css)가 있으면 그것을 불러 쓰고(파일 한 번), 없으면(CSS 없는 쪽) 종전처럼 FontFace 를 만든다
  const loadFace = F => faceOf(F) ? document.fonts.load(F.css, '한').then(() => { if (!fontLoaded(F)) throw new Error('not loaded'); }) : new FontFace(F.fam || F.name, 'url(' + F.url + ')', F.wt ? { weight: F.wt } : {}).load().then(f => { document.fonts.add(f); });
  const tick = () => new Promise(r => setTimeout(r, 0));
  // 표의 한글·숫자·영문 글자를 미리 그려 둔다(첫 화면에서 한꺼번에 래스터하느라 프레임이 밀리지 않게). 메인 스레드를 오래 잡지 않도록 나눠서 한다.
  async function prewarm() {
    const set = new Set('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ?!.()♥ ');
    const add = s => { for (const ch of s) set.add(ch); };
    for (const k of ['names', 'moves', 'zodiac']) for (const j of Object.keys(T[k])) add(T[k][j]);
    for (const u of T.ui) add(u.ko); for (const m of T.msg) add(m.ko.replace(/\{.\}/g, '')); for (const k of Object.keys(KANA)) add(KANA[k]);
    for (const r of T.rules) add(r.ko.replace(/\$\d/g, '')); add('&'); // 규칙 문구(승·패 등)·팀 이름 줄의 &
    for (const id of Object.keys(scripts)) for (const l of scripts[id]) add(l.ko.replace(/\{.\}/g, ''));
    for (const ch of 'ㄴㅅ워디두ー') set.add(ch); // 가나 칸 1:1 한글(cellKo)의 KANA 밖 글자
    let n = 0; for (const f of [FONT_L, FONT_S]) for (const ch of set) { glyphOf(ch, f); if (++n % 48 === 0) await tick(); }
    if (tinyOk) { for (const k of Object.keys(KANA)) glyphOf(KANA[k], FONT_T); glyphOf('ㅅ', FONT_T); fontMetrics(FONT_T); }
    fontMetrics(FONT_L); fontMetrics(FONT_S);
    if (boldOk && T.labels) { for (const k of Object.keys(T.labels.items)) for (const ch of T.labels.items[k].ko) glyphOf(ch, FONT_B); fontMetrics(FONT_B); }
  }
  // opts: { chr: Uint8Array(CHR ROM), pal32: Uint32Array(64) }
  let tabP = null;
  function init(opts) {
    chr = opts.chr; pal32 = opts.pal32;
    const img = new Image(), pLogo = new Promise(r => { img.onload = () => { try { logoMap = indexLogo(img); } catch (e) { console.error('한글 로고 준비 실패: ' + e.message); } r(); }; img.onerror = () => { console.error('한글 로고 불러오기 실패(/logo/logo_ko_1x.png): 타이틀 로고는 원작 그대로 둔다'); r(); }; img.src = '/logo/logo_ko_1x.png'; });
    const pBold = loadFace(FONT_B).then(() => { boldOk = true; }, () => { boldOk = false; console.error(FONT_B.name + ' 글꼴 불러오기 실패(/fonts/Galmuri11-Bold.ttf): 유파 라벨은 원작 그대로 둔다'); });
    const tiny = new FontFace(FONT_T.name, 'url(/fonts/Galmuri7.ttf)'), pTiny = tiny.load().then(f => { document.fonts.add(f); tinyOk = true; }, () => { tinyOk = false; console.warn(FONT_T.name + ' 글꼴 불러오기 실패(/fonts/Galmuri7.ttf): 에디트 입력 칸의 작은 가나는 Galmuri9 로 그린다'); });
    return Promise.all([
      (tabP = fetch('ko_table.json').then(r => { if (!r.ok) throw new Error('한글 표 불러오기 실패 ' + r.status + ' (node tools/ko_build_table.js 필요)'); return r.json(); })).then(compile),
      document.fonts.load(FONT_L.css, '한').catch(e => { throw new Error(FONT_L.name + ' 글꼴 불러오기 실패: ' + (e && e.message || e)); }),
      loadFace(FONT_S).catch(e => { throw new Error(FONT_S.name + ' 글꼴 불러오기 실패: ' + (e && e.message || e)); }), pLogo, pBold, pTiny,
    ]).then(() => { // 글꼴이 실제로 올라왔는지 확인(없으면 대체 글꼴로 그려져 도트가 뭉개진다)
      for (const f of [FONT_L, FONT_S]) if (!fontLoaded(f) || !document.fonts.check(f.css, '한')) throw new Error(f.name + ' 글꼴 불러오기 실패');
      if (boldOk && !fontLoaded(FONT_B)) boldOk = false;
      if (tinyOk && !fontLoaded(FONT_T)) tinyOk = false;
      return prewarm();
    }).then(() => { ready = true; lastSig = -1; hold = null; });
  }
  // 검사 도구(tools/ko_overlay_shots.js)용 읽기 전용 도우미. kana(snap, rows) = 화면 판정과 무관하게, 폰트 뱅크로 보이는 그 행들의 가나·한자 칸 [x, y] 목록
  const debug = { color: i => pal32[i & 0x3F], ink: (s, c) => inkSpan(s, kfont(c)),
    kana(snap, rows) { const out = []; for (const b of bands(snap.lt)) { if (b.fy0 !== 0 || b.h !== 8 || !isFont(b) || !rows.includes(b.cy)) continue; for (const c of cells(b, snap.vram)) { const t = T.tiles[c.t]; if (t !== undefined && c.x >= 0 && c.x < 256 && /[^\x00-\x7F♥・…、。「」ー]/.test(t)) out.push([c.x, b.y0]); } } return out; } };
  window.NKKorean = { init, draw, stats, translit, debug, get ready() { return ready; }, get table() { return tabP; } /* ko_table.json 받기(Promise, 신규 층이 같은 표를 다시 받지 않게) */ };
})();
