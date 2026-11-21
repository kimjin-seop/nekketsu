'use strict';
// 신규 타이틀 + 모드 선택 + 배틀 설정(인원·캐릭터 에디트 여부) 층(캔버스 위 DOM/CSS). 설계: analysis/13_korean_ui.md 10절·12절.
// 기본 주소(쿼리 없음)에서만 game.js 가 켠다(?classic=1 = 원작 메뉴 경로에서는 만들지 않는다). 엔진·워커·캔버스 그리기와는 무관하다.
// 432x240 논리 좌표로 배치하고 캔버스의 화면 위치·배율을 그대로 따라간다(캔버스가 정수배 + 16:9 여백 규칙을 이미 적용하고 있다).
// 조작: 마우스(올리면 커서 이동, 클릭 = 확정)·키보드(↑↓, 1P A 키(기본 A)·Enter = 확정, 1P B 키(기본 S)·Esc = 뒤로, 키 표에 없는 Z·X 도 종전대로)·터치(탭 = 확정)·게임패드(↑↓, A = 확정, B = 뒤로) 모두 같은 함수(move/confirm/back)를 탄다.
// 타이틀 배경 띠는 이 파일이 NES 팔레트 색 값으로 직접 찍어 만든다(원작 타일·픽셀 미사용). 그 밖의 화면 배경은 CSS(ui_menu.css .nk-wall, 전투 화면 배경과 같은 모양). 로고는 한글 로고 시안 A(/logo/logo_ko_1x.png).
(function () {
  const W = 432;
  // 화면 정의. go = 화면 이동, toast = 알림만, pick = 선택 결과를 game.js 로 넘김, back = 뒤로, set = 고른 설정(sel 에 모아 pick 때 같이 넘긴다)
  // 배틀 설정은 측정한 분기만 선택지로 둔다(13 문서 12절): 인원 1인·2인(3P·4P 없음), 에디트 '안 한다' = 캐릭터 선택까지 구동, '한다' = 원작 에디트 여부 질문에서 덮개를 걷어 원작 화면에서 진행
  const DEF = {
    title: { win: [160, 130, 112], items: [{ id: 'solo', t: '혼자 하기', go: 'mode' }, { id: 'online', t: '온라인 대전', toast: '준비 중' }] },
    mode: { win: [156, 130, 120], head: '모드 선택', back: 'title', items: [{ id: 'battle', t: '배틀 모드', go: 'players' }, { id: 'story', t: '스토리 모드', pick: 'story' }, { id: 'back', t: '뒤로', back: true, sep: true }] },
    players: { win: [156, 130, 120], head: '인원', back: 'mode', items: [{ id: 'p1', t: '1인', go: 'edit', set: { players: 1 } }, { id: 'p2', t: '2인', go: 'edit', set: { players: 2 } }, { id: 'back', t: '뒤로', back: true, sep: true }] },
    edit: { win: [156, 130, 120], head: '캐릭터 에디트', back: 'players', items: [{ id: 'edit_no', t: '안 한다', pick: 'battle', set: { edit: false } }, { id: 'edit_ask', t: '한다', pick: 'battle', set: { edit: 'ask' } }, { id: 'back', t: '뒤로', back: true, sep: true }] },
  };
  const C = { sky2: '#4c9aec', sky: '#38b4cc', grass: '#087c00', tuft: '#4cd020', dark: '#004000' };
  const abgr = h => (0xFF000000 | (parseInt(h.slice(5, 7), 16) << 16) | (parseInt(h.slice(3, 5), 16) << 8) | parseInt(h.slice(1, 3), 16)) >>> 0;
  function tile(w, h, fn) { // 픽셀 함수 → CSS 배경 그림
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'), im = x.createImageData(w, h), d = new Uint32Array(im.data.buffer);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) d[j * w + i] = abgr(fn(i, j));
    x.putImageData(im, 0, 0); return 'url(' + c.toDataURL('image/png') + ')';
  }
  // 타이틀 배경(16x240 세로 띠를 가로로 반복): 하늘 두 단(경계는 체커 디더) + 풀밭
  const titleBg = () => tile(16, 240, (i, j) => {
    if (j < 44) return C.sky2; if (j < 52) return (i + j) & 1 ? C.sky2 : C.sky; if (j < 174) return C.sky; if (j < 176) return C.dark;
    if (j >= 228) return C.dark; if (j >= 222) return (i + j) & 1 ? C.grass : C.dark;
    const r = j & 15; return ((i === 3 || i === 5) && r === 4) || (i === 4 && r === 3) || ((i === 11 || i === 13) && r === 12) || (i === 12 && r === 11) ? C.tuft : C.grass;
  });

  let root = null, cv = null, onPick = null, scr = 'title', active = false, busy = false, toastTm = 0, gpRaf = 0, gpPrev = 15, ptX = null, ptY = null, ptMoved = false;
  const idx = {}, els = {}, opts = {}, sel = {}; for (const k of Object.keys(DEF)) idx[k] = 0;
  const el = (tag, cls, parent, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; if (parent) parent.appendChild(e); return e; };

  function build() {
    root = el('div', '', document.body); root.id = 'nk-ui';
    for (const k of Object.keys(DEF)) {
      const d = DEF[k], s = els[k] = el('div', 'nk-scr', root), bg = k === 'title' ? titleBg() : ''; if (bg) s.style.backgroundImage = bg;
      // 창 여백까지 잇는 배경(13 문서 13절): 타이틀은 세로 띠를 가로로만 반복하고 위는 하늘색·아래는 풀밭 끝색으로 잇는다. 그 밖의 화면은 CSS 배경(.nk-wall) 한 장
      const bl = el('div', 'nk-bleed' + (bg ? '' : ' nk-wall'), s); if (bg) bl.style.background = bg + ' 0 480px repeat-x,linear-gradient(' + C.sky2 + ' 50%,' + C.dark + ' 50%)';
      if (k === 'title') { const im = el('img', 'nk-logo', s); im.alt = '열혈격투전설'; im.draggable = false; im.src = '/logo/logo_ko_1x.png'; }
      if (d.head) el('div', 'nk-win nk-head', s, d.head);
      const w = el('div', 'nk-win nk-menu', s); w.style.left = d.win[0] + 'px'; w.style.top = d.win[1] + 'px'; w.style.width = d.win[2] + 'px'; w.setAttribute('role', 'menu');
      opts[k] = d.items.map((it, i) => {
        const o = el('div', 'nk-opt' + (it.sep ? ' sep' : ''), w, it.t); o.setAttribute('role', 'menuitem'); o.dataset.id = it.id;
        // 마우스를 올리면 키보드 커서와 같은 강조. 단 포인터가 실제로 움직였을 때만(화면이 바뀌어 멈춰 있는 포인터 아래에 새 항목이 놓이면 브라우저가 pointerenter 를 내는데, 그때는 커서를 끌고 가지 않는다)
        const hover = e => { if (e.pointerType !== 'mouse' || !(e.type === 'pointermove' ? ptMoved : e.clientX !== ptX || e.clientY !== ptY)) return; if (active && !busy && scr === k && idx[k] !== i) { idx[k] = i; render(); } };
        o.addEventListener('pointerenter', hover); o.addEventListener('pointermove', hover);
        o.addEventListener('click', () => { if (!active || busy || scr !== k) return; idx[k] = i; render(); confirm(); }); // 마우스 클릭·터치 탭
        return o;
      });
    }
    els.toast = el('div', 'nk-win nk-toast', root); els.toast.setAttribute('role', 'status');
    window.addEventListener('pointermove', e => { if (e.pointerType !== 'mouse') return; ptMoved = e.clientX !== ptX || e.clientY !== ptY; ptX = e.clientX; ptY = e.clientY; }, true); // 마지막 마우스 좌표(항목의 hover 보다 먼저 = 캡처 단계). 좌표가 바뀐 이동만 hover 로 친다
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    if (window.ResizeObserver) new ResizeObserver(place).observe(cv); // game.js fit() 이 캔버스 크기를 바꿀 때
  }
  function place() { // 캔버스와 같은 자리·같은 배율
    if (!root || !active) return; const r = window.NKCam ? window.NKCam.rect(cv) : cv.getBoundingClientRect(); if (!r.width) return; // 변환 전 배치 rect(카메라 줌 web/cam_fx.js)
    root.style.transform = 'translate(' + r.left + 'px,' + r.top + 'px) scale(' + r.width / W + ')';
  }
  function render() {
    for (const k of Object.keys(DEF)) { els[k].classList.toggle('on', k === scr); opts[k].forEach((o, i) => o.classList.toggle('cur', i === idx[k])); }
  }
  function toast(text) { els.toast.textContent = text; els.toast.classList.add('on'); clearTimeout(toastTm); toastTm = setTimeout(() => els.toast.classList.remove('on'), 1600); }
  function go(k) { scr = k; els.toast.classList.remove('on'); render(); }
  function move(d) { const n = DEF[scr].items.length; idx[scr] = (idx[scr] + d + n) % n; render(); }
  function back() { if (DEF[scr].back) go(DEF[scr].back); }
  function confirm() {
    const it = DEF[scr].items[idx[scr]];
    if (it.set) Object.assign(sel, it.set);
    if (it.go) { idx[it.go] = 0; go(it.go); } /* 들어갈 때마다 커서는 첫 항목('뒤로'에 남지 않게) */ else if (it.toast) toast(it.toast); else if (it.back) back();
    else if (it.pick) { busy = true; root.classList.add('busy'); onPick(it.pick, it.set ? Object.assign({}, sel) : null); } // 원작 메뉴로 넘어갈 때까지(구동 중) 입력을 받지 않고 고른 항목을 깜빡인다(game.js 가 hide() 를 부른다)
  }
  function onKey(e) {
    if (!active) return;
    const c = e.code, n = window.NKKeymap ? window.NKKeymap.nav(c) : null, dir = n ? n.dy : c === 'ArrowUp' ? -1 : c === 'ArrowDown' ? 1 : 0, ok = n ? n.ok : c === 'KeyZ' || c === 'Enter' || c === 'NumpadEnter', bk = n ? n.bk : c === 'KeyX' || c === 'Escape'; // 키 표(web/keymap.js nav)를 따른다
    if (!dir && !ok && !bk) return;
    e.preventDefault(); if (busy) return;
    if (dir) move(dir); else if (!e.repeat) { if (ok) confirm(); else back(); }
  }
  function gpTick() { // 게임패드는 이벤트가 없어 층이 떠 있는 동안만 화면 주기로 읽는다(누른 순간만 반응)
    if (!active) { gpRaf = 0; return; }
    gpRaf = requestAnimationFrame(gpTick);
    let v = 0; const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const g of gps) {
      if (!g) continue; const p = i => !!(g.buttons[i] && g.buttons[i].pressed);
      if (p(12) || g.axes[1] < -0.5) v |= 1; if (p(13) || g.axes[1] > 0.5) v |= 2; if (p(0)) v |= 4; if (p(1) || p(2)) v |= 8;
    }
    const hit = v & ~gpPrev; gpPrev = v; if (busy) return;
    if (hit & 1) move(-1); else if (hit & 2) move(1); else if (hit & 4) confirm(); else if (hit & 8) back();
  }
  // o: { canvas, onPick(모드 'battle' | 'story', 설정 { players, edit } 또는 null) }
  function init(o) { cv = o.canvas; onPick = o.onPick; build(); }
  function show(k) {
    scr = k || 'title'; for (const n of Object.keys(idx)) idx[n] = 0; for (const n of Object.keys(sel)) delete sel[n]; busy = false; active = true; gpPrev = 15; // 이미 눌려 있던 패드 버튼은 뗐다가 다시 눌러야 반응
    els.toast.classList.remove('on'); root.classList.remove('busy'); root.classList.add('on'); render(); place();
    if (!gpRaf) gpRaf = requestAnimationFrame(gpTick);
  }
  function hide() { active = false; busy = false; root.classList.remove('on', 'busy'); } // 숨긴 뒤에는 화면 주기 작업도 멈춘다(전투 중 비용 0)
  window.NKMenu = { init, show, hide, toast, get active() { return active; }, get state() { return { active, busy, screen: scr, index: idx[scr], item: DEF[scr].items[idx[scr]].id, toast: !!els.toast && els.toast.classList.contains('on') }; } };
})();
