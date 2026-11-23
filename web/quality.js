'use strict';
// 품질 단계(M5, analysis/27_mobile_rewards_zoom_tutorial.md M5절). 렌더 층만 바꾼다: 엔진·워커·락스텝·입력·소리·한글 층은 그대로(온라인 결정성 무관).
//   단계: 높음 = 설정 그대로 · 보통 = HD 배경 끔 · 낮음 = HD 배경 + 타격 이펙트 끔. 설정에서 끈 것을 켜지는 않는다(설정 값 위의 상한).
//   설정 NKSettings.quality: 'auto'(기본) · 'high' · 'mid' · 'low'. 자동일 때만 전투(1:2) 화면 주기 간격을 재서, 3초 창 두 번 연속 느리면(25% 이상이 1.5프레임 초과) 한 단계 낮추고 토스트 한 줄.
//   자동이 정한 단계는 localStorage nk_quality_auto 에 둔다(다음 방문도 그 단계부터, NKQuality.reset() = 높음부터 다시). 고정 단계·낮음 도달·?classic=1 = 측정 루프 없음(화면 주기 비용 0).
//   훅: game.js hdWant(설정 경로에서 NKQuality.off('hd')), 타격 이펙트 = html.nk-q-nofx 로 덮개 숨김(아래). ?q=high|mid|low = 설정과 무관하게 고정(검증용)
(function () {
  const S = window.NKSettings || null, KEY = 'nk_quality_auto', LV = ['high', 'mid', 'low'], NAME = { high: '높음', mid: '보통', low: '낮음' };
  const CLASSIC = /[?&]classic=1(&|$)/.test(location.search), Q = (/[?&]q=(high|mid|low)(&|$)/.exec(location.search) || [])[1];
  let autoLv = 0; try { const v = +localStorage.getItem(KEY); if (v === 1 || v === 2) autoLv = v; } catch (e) { /* 저장소 없음 = 높음부터 */ }
  const setting = () => { const v = S ? S.get('quality') : 'auto'; return LV.indexOf(v) >= 0 ? v : 'auto'; };
  let capLv = 0; // 이번 판만의 상한(web/game.js 틱 예산 감시: 온라인 전투에서 틱 처리가 예산을 넘으면 2 = 낮음, 판이 끝나면 0). 저장하지 않고, 품질 설정이 자동일 때만 적용한다
  const level = () => Q ? LV.indexOf(Q) : setting() === 'auto' ? Math.max(autoLv, capLv) : LV.indexOf(setting());
  const off = k => k === 'hd' ? level() >= 1 : k === 'fx' ? level() >= 2 : false;
  const SLOW = 1000 / 60 * 1.5, WIN = 180, NEED = 2, FRAC = 0.25, COOL = 8000; // 느린 화면 주기 기준(ms), 창 길이(주기), 연속 창 수, 느린 비율, 낮춘 뒤 쉬는 시간(ms)
  const st = { windows: 0, frac: 0, drops: 0, running: false };
  const subs = [];
  const GAP = 3000, WMS = 3000, WMIN = 6; // 이보다 긴 간격 = 탭 복귀·멈춤(세지 않음) · 창 시간 상한(ms, 아주 느린 기기도 3초마다 판정) · 시간으로 닫는 창의 최소 주기 수
  let raf = 0, last = 0, n = 0, slowN = 0, bad = 0, coolUntil = 0, w0 = 0;
  document.addEventListener('visibilitychange', () => { last = 0; }); // 탭 복귀 첫 간격은 세지 않는다
  const want = () => !CLASSIC && !Q && setting() === 'auto' && autoLv < 2;
  const live = () => { // 잴 구간 = 보이는 탭의 진행 중인 전투(일시정지·빨리 감기 제외)
    const g = window.__game; if (!g || document.hidden || g.paused || g.turbo) return false;
    const m = g.mirror && g.mirror.m; return !!m && m[0x641] === 1 && (m[0x642] & 0x7F) === 2;
  };
  function tick(t) {
    if (!want()) { raf = 0; st.running = false; return; } raf = requestAnimationFrame(tick);
    const dt = last ? t - last : 0; last = t;
    if (!dt || dt > GAP || t < coolUntil || !live()) return; // 탭 복귀·긴 멈춤(3초 초과)만 빼고, 250ms 넘는 아주 느린 주기도 느린 주기로 센다
    if (!n) w0 = t - dt;
    n++; if (dt > SLOW) slowN++;
    if (n < WIN && !(t - w0 >= WMS && n >= WMIN)) return; // 창 = 180주기 또는 3초(느린 기기에서 창이 끝없이 길어지지 않게)
    const f = slowN / n; st.windows++; st.frac = Math.round(f * 1000) / 1000; n = 0; slowN = 0;
    bad = f >= FRAC ? bad + 1 : 0;
    if (bad >= NEED) { bad = 0; drop(); }
  }
  function drop() {
    autoLv = Math.min(2, autoLv + 1); st.drops++; coolUntil = performance.now() + COOL;
    try { localStorage.setItem(KEY, String(autoLv)); } catch (e) { /* 이 방문만 */ }
    const M = window.NKManga; if (M && M.toast) M.toast('화질 자동 조정: ' + NAME[LV[autoLv]], 'hp');
    emit();
  }
  // 타격 이펙트 끔(낮음) = 덮개 캔버스(#nk-hitfx)를 숨긴다(hit_fx.js 무수정. 그 파일 enabled() 에 off('fx') 훅이 들어가면 그리기 비용도 0)
  const css = document.createElement('style'); css.textContent = 'html.nk-q-nofx #nk-hitfx{visibility:hidden!important}'; document.head.appendChild(css);
  const mark = () => document.documentElement.classList.toggle('nk-q-nofx', off('fx'));
  function emit() { mark(); for (const f of subs) try { f(LV[level()]); } catch (e) { console.warn('품질 구독 오류: ' + (e && e.message || e)); } }
  function sync() { if (want() && !raf) { last = 0; n = 0; slowN = 0; bad = 0; st.running = true; raf = requestAnimationFrame(tick); } }
  if (S && S.on) S.on(() => { sync(); emit(); });
  sync(); mark();
  window.NKQuality = {
    LEVELS: LV, NAMES: NAME, off,
    cap(v) { v = v === 1 || v === 2 ? v : 0; if (v !== capLv) { capLv = v; emit(); } }, get capped() { return capLv; },
    get level() { return LV[level()]; }, get setting() { return setting(); }, get auto() { return LV[autoLv]; },
    reset() { autoLv = 0; try { localStorage.removeItem(KEY); } catch (e) { /* 무시 */ } sync(); emit(); },
    on(f) { if (typeof f === 'function') subs.push(f); },
    get stats() { return Object.assign({ level: LV[level()], auto: LV[autoLv], setting: setting() }, st); },
  };
})();
