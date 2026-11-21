'use strict';
// 필살기 입력 뱃지(analysis/29_skill_inputs.md·json, 오라클 26/26). 기술 줄 = 왼쪽 기술 이름 + 오른쪽 키캡 뱃지 나열(2026-11-21 사용자 지시: 뱃지화·최소 표현, 글자 설명·순서 화살표 없음).
//   SEQ = 29 json moves[].seq 그대로(id = characters.json special_moves[].id). 버튼 토큰은 NKKeymap.keyName(p, 'a'|'b'|'jump') = 지금 리매핑 키 이름, 방향은 화살표 뱃지.
//   조건 토큰(2026-11-21 사용자 지시로 기호 정리): 낙하·착지·누운 적·연타 = 표시 없음(「_」「×」 제거) · 상대가 정면일 때(공격 순간) = 키캡 앞 「앞」 칩 · A 또는 B = 작은 글자 「or」 · 누른 채(+) = 두 키를 한 덩어리 묶음 뱃지(→S) · 대시(→→) = 화살표 둘 묶음 뱃지. 순서 구분자(>)는 간격만.
//   사용처 = 전투 HUD 좌우 패널만(2026-11-21 사용자 지시: 팀·룰·대결 확인·캐릭터/파트너 선택·대기실에서는 뱃지 없음, box() 는 호출처 없음). 2단 줄바꿈 없음(2026-11-21 사용자 「UI 깨짐」): 넘친 줄만 기술 이름 자간을 줄여 한 줄에 맞추고(LS_MIN 까지), 그래도 넘치면 뱃지 간격·키캡을 조금 줄인다(tight). 리매핑(NKKeymap.on)·글꼴 로드 뒤 다시 그린다. 전투 HUD 는 모든 칸(키 표기 = 1P 키, 로컬 2P 사람 칸만 2P 키, ui_manga.js hudTick)
//   키캡 폭 통일(2026-11-21 사용자 지시): 버튼·방향 뱃지는 모두 같은 폭. 긴 키 이름은 ABBR 로 줄이고(최대 3자, 한글 2자) 글자 수에 따라 글꼴만 줄인다(u2 · u3). 「앞」 칩은 키캡과 같은 폭, 묶음 뱃지는 칸 폭 고정(화살표 칸 · 키 칸)
(function () {
  const SEQ = [['FOE_DOWN', 'A'], ['JUMP', '>', 'FALL', 'B'], ['JUMP', '>', 'FALL', 'A'], ['FOE_ATK', 'AB'], ['JUMP', '>', 'LAND', 'A'], ['JUMP', '>', 'LAND', 'B'], ['B', 'MASH'], ['A', 'MASH'], ['DASH', '>', 'JUMP', '>', 'FWD', '+', 'B'], ['DASH', '>', 'JUMP', '>', 'DOWN']];
  const ABBR = { Enter: 'Ent', NumEnter: 'NEn', Space: 'Sp', Shift: 'Sh', LShift: 'LSh', RShift: 'RSh', LCtrl: 'LCt', RCtrl: 'RCt', LAlt: 'LAl', RAlt: 'RAl', BS: 'BS' }; // 키 이름 약칭(유일한 정의). 표에 없고 3자를 넘으면 Num+X = N+X, 그 밖은 앞 3자
  function abbr(n) { n = String(n).split('/')[0]; if (ABBR[n]) return ABBR[n]; const m = /^Num(.+)$/.exec(n); if (m) n = 'N' + m[1]; return n.length > 3 ? n.slice(0, 3) : n; }
  const units = t => { let u = 0; for (const c of t) u += /[ㄱ-힣]/.test(c) ? 2 : 1; return u; }; // 한글 = 2칸
  const touchOnly = () => !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
  function key(p, id) { // 지금 키 이름(터치 전용 기기 = 원작 버튼 이름)
    const K = window.NKKeymap, fb = { a: 'A', b: 'B', jump: '점프' }[id];
    if (!K || !K.keyName || touchOnly()) return fb;
    const n = K.keyName(p, id); return n && n !== '—' ? n : id === 'jump' ? null : fb;
  }
  function el(tag, cls, parent, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; parent.appendChild(e); return e; }
  function badges(parent, id, p, tag) { // id 의 뱃지 묶음(.nksi, 기본 span)을 parent 끝에 붙인다. 없는 id = null
    const seq = SEQ[id]; if (!seq) return null;
    const w = el(tag || 'span', 'nksi', parent), cap = t => { t = abbr(t); const u = units(t); return el('b', u > 2 ? 'u3' : u > 1 ? 'u2' : '', w, t); }, dir = t => el('b', 'd', w, t);
    const pill = (parts, cls) => { const b = el('b', 'cb' + (cls ? ' ' + cls : ''), w); for (const [t, k] of parts) { if (!k) { el('span', 'a', b, t); continue; } const a = abbr(t), u = units(a); el('span', 'k' + (u > 2 ? ' u3' : u > 1 ? ' u2' : ''), b, a); } return b; }; // 묶음 뱃지(둥근 한 덩어리): [화살표] = 노랑 칸, [키] = 흰 칸
    for (let k = 0; k < seq.length; k++) { // FOE_DOWN·LAND·FALL·MASH·'>' = 표시 없음
      const t = seq[k];
      if (t === 'A' || t === 'B') cap(key(p, t.toLowerCase()));
      else if (t === 'AB') { cap(key(p, 'a')); el('i', 'or', w, 'or'); cap(key(p, 'b')); }
      else if (t === 'FOE_ATK') el('b', 'f u2', w, '앞'); // 상대가 정면을 볼 때(공격 순간)
      else if (t === 'JUMP') { const j = key(p, 'jump'); if (j) cap(j); else pill([[key(p, 'a'), 1], [key(p, 'b'), 1]]); } // 점프 키 없음 = A+B 같이 누름
      else if (t === 'DASH') pill([['→'], ['→']], 'd');
      else if (t === 'FWD' && seq[k + 1] === '+' && (seq[k + 2] === 'A' || seq[k + 2] === 'B')) { pill([['→'], [key(p, seq[k + 2].toLowerCase()), 1]]); k += 2; } // → 누른 채 S = [→S]
      else if (t === 'FWD') dir('→'); else if (t === 'DOWN') dir('↓');
    }
    return w;
  }
  const groups = new Set(); // 다시 그릴 묶음: { rows, lay } (lay 없음 = 상자형)
  function paint(e) { const s = e._si; e.textContent = ''; el('span', 'nksi-nm', e, s.name); if (s.id >= 0) badges(e, s.id, s.p); }
  // 한 줄형(팀·대기실·대결 확인 카드 .nkh-sp). rows = 줄 3개, items = [{ name, id(-1 = 뱃지 없음), p }], lay = { top, step, wtop, wstep }
  const stat = { rows: 0 }; // 다시 그린 횟수(검증용: 전투 중 프레임마다 늘지 않아야 한다)
  function rows(rs, items, lay) {
    stat.rows++;
    rs.forEach((e, j) => { e._si = items[j] || { name: '', id: -1, p: 0 }; e.classList.add('nksi-row'); paint(e); });
    groups.add(rs); rs._lay = lay; fit(rs);
  }
  const LS_MIN = -3; // 기술 이름 자간 하한(px, 이름 글꼴 20px 기준): 이보다 줄이면 한글이 붙어 읽기 어렵다
  function fit(rs) { // 한 줄 고정(2단 없음). 넘친 줄만: 이름 칸 = 줄 폭 − 뱃지 폭 → 이름 자간을 (넘친 폭 ÷ 글자 수) 만큼 줄인다(LS_MIN 까지) → 그래도 넘치면 tight. 호출 = rows()(기술·키 주인이 바뀔 때)·refresh(리매핑·글꼴) 뿐이라 프레임마다 재계산 0
    const L = rs._lay, over = e => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1;
    rs.forEach(e => {
      e.classList.remove('wrap', 'tight'); e.classList.toggle('sm', !!L.sm); const nm = e.querySelector('.nksi-nm'); if (nm) nm.style.letterSpacing = '';
      if (!nm || !over(e)) return;
      const n = Math.max(1, [...nm.textContent].length), ls = Math.max(LS_MIN, -Math.ceil((e.scrollWidth - e.clientWidth) / n * 10) / 10);
      nm.style.letterSpacing = ls + 'px'; if (over(e)) e.classList.add('tight');
    });
    let t = L.top; rs.forEach(e => { e.style.top = t + 'px'; t += L.step; });
  }
  // 상자형(캐릭터 선택·파트너 .nkm-sp): 상자 안 이름 아래 둘째 줄 가운데
  function box(c, id, p) {
    if (c._sib) c._sib.remove(); c._sib = null; c._si = { id, p };
    c.classList.toggle('si', id >= 0); if (id >= 0) { c._sib = badges(c, id, p, 'div'); groups.add(c); }
  }
  function refresh() {
    for (const g of groups) {
      if (Array.isArray(g)) { if (!g[0] || !g[0].isConnected) { groups.delete(g); continue; } g.forEach(e => { if (e._si) paint(e); }); fit(g); }
      else if (!g.isConnected) groups.delete(g); else if (g._si && g._si.id >= 0) box(g, g._si.id, g._si.p);
    }
  }
  if (window.NKKeymap && window.NKKeymap.on) window.NKKeymap.on(refresh);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh, () => {});
  window.NKSkillInputs = { SEQ, rows, box, badges, refresh, abbr, stat };
})();
