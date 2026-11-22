'use strict';
// 설정 모듈(analysis/15_ui_manga_impl.md 21절, 현대화 S0). 저장소 키 nk_manga_settings(종전 키·값 그대로) 하나를 여기서 읽고 쓴다.
//   data = 살아 있는 설정 객체(ui_manga.js 의 set 이 이 객체를 그대로 쓴다). save() = 저장 + 구독자 알림, 저장소 실패는 false(호출한 쪽이 토스트).
//   칸: vol 0~10(호스트 믹스 음량) · mute 0/1 · scale · hud · nf · speed · tags · fxlv 0 끔 1 약 2 보통 3 강(이펙트 강도) · hitfx 0/1(= fxlv > 0, 종전 칸 호환) · op · hd 0/1(전투 HD 배경, 기본 켬·모바일 폭 끔, ?hd=0·1 = 강제).
//   엔진·소리 합성은 건드리지 않는다(BGM·SE 개별 음량 없음: 엔진 지문이 바뀐다). 클래식 화면 = ?classic=1&ko=1 로 다시 열기(저장 안 함, 세션 표식으로 돌아오기 단추)
(function () {
  const KEY = 'nk_manga_settings', SPEEDS = [1, 1.15, 1.3, 1.5], NSCALE = 5;
  const DEF = { vol: 8, scale: 0, hud: 1, nf: 1, speed: 1.3, tags: 2, hitfx: 1, op: 1, fxlv: 2, mute: 0, hd: 1, touch: 0, tdash: 1, tvib: 1 }; // touch 0 자동 · 1 켬 · 2 끔(터치 패드 web/touch_pad.js), tdash = 달리기 보조, tvib = 진동
  const small = () => { try { const w = screen.width || innerWidth, h = screen.height || innerHeight; return Math.min(w, h) < 600; } catch (e) { return false; } }; // 모바일 폭(짧은 변 < 600px) = HD 배경 기본 끔(품질 단계 자동 감지는 후속)
  DEF.hd = small() ? 0 : 1;
  DEF.cam = 1; // cam = 카메라 연출(web/cam_fx.js, analysis/27 Z1): 0 끔(transform 없음 = 픽셀 동일) · 1 약(기본) · 2 보통. 온라인은 약 이하, 동작 줄이기 = 끔
  DEF.tut = 0; DEF.tutok = 0; // 튜토리얼(web/tutorial.js, analysis/27 T2): tut 0 아직(배틀 → 1인 첫 진입 때 자동) · 1 봤음(완료·건너뜀·도중 종료), tutok 1 = 단계를 모두 성립한 적 있음(칭호 지급 근거, P1 이후)
  DEF.quality = 'auto'; // 품질 단계(web/quality.js, analysis/27 M5): 'auto' 자동(프레임 시간으로 한 단계씩 낮춤) · 'high' 높음 · 'mid' 보통(HD 배경 끔) · 'low' 낮음(HD 배경·타격 이펙트 끔). 렌더 층만
  DEF.impact = 2; // 타격감(web/impact_fx.js): 0 끔(픽셀·RAM 지문 동일) · 1 약 · 2 보통(기본) · 3 강. 히트스톱은 오프라인만
  DEF.colorblind = 0; DEF.fontscale = 0; // 접근성(web/a11y.js, A2): colorblind 0 끔 · 1 색약 팔레트(표시 층만), fontscale 0 1.0 · 1 1.15 · 2 1.3(DOM 글자만). 0 = 종전 그대로
  const data = Object.assign({}, DEF), subs = [];
  function load() {
    let j = null; try { j = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { j = null; } // 저장소를 못 쓰면 기본값
    if (!j || typeof j !== 'object') return data;
    if (j.vol >= 0 && j.vol <= 10) data.vol = j.vol | 0; if (j.scale >= 0 && j.scale < NSCALE) data.scale = j.scale | 0; data.hud = j.hud === 0 ? 0 : 1; data.nf = j.nf === 0 ? 0 : 1;
    if (SPEEDS.indexOf(+j.speed) >= 0) data.speed = +j.speed; if (j.tags === 0 || j.tags === 1) data.tags = j.tags; data.op = j.op === 0 ? 0 : 1; data.mute = j.mute === 1 ? 1 : 0; if (j.hd === 0 || j.hd === 1) data.hd = j.hd;
    if (j.touch === 0 || j.touch === 1 || j.touch === 2) data.touch = j.touch; data.tdash = j.tdash === 0 ? 0 : 1; data.tvib = j.tvib === 0 ? 0 : 1;
    if (j.cam === 0 || j.cam === 1 || j.cam === 2) data.cam = j.cam; // 카메라 연출(없으면 기본 약)
    try { if (j.tut === 0 || j.tut === 1) data.tut = j.tut; data.tutok = j.tutok === 1 ? 1 : 0; } catch (e) { /* 튜토리얼 칸만 기본값 */ }
    if (['auto', 'high', 'mid', 'low'].indexOf(j.quality) >= 0) data.quality = j.quality; // 품질 단계(없으면 자동)
    if (j.impact === 0 || j.impact === 1 || j.impact === 2 || j.impact === 3) data.impact = j.impact; // 타격감(없으면 보통)
    if (j.colorblind === 1) data.colorblind = 1; if (j.fontscale === 1 || j.fontscale === 2) data.fontscale = j.fontscale; // 접근성(없으면 끔·1.0)
    data.fxlv = Number.isInteger(j.fxlv) && j.fxlv >= 0 && j.fxlv <= 3 ? j.fxlv : j.hitfx === 0 ? 0 : 2; data.hitfx = data.fxlv ? 1 : 0; // 옛 저장(hitfx 만) = 끔·보통
    return data;
  }
  function save() {
    data.hitfx = data.fxlv ? 1 : 0;
    let ok = true; try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { ok = false; }
    for (const f of subs) try { f(data); } catch (e) { console.warn('설정 구독 오류: ' + (e && e.message || e)); }
    return ok;
  }
  const CLASSIC = /[?&]classic=1(&|$)/.test(location.search), BACK = 'nk_classic_back';
  function toClassic() { try { sessionStorage.setItem(BACK, '1'); } catch (e) { /* 돌아오기 단추 없음 = 주소에서 ?classic=1 을 지우면 된다 */ } location.href = location.pathname + '?classic=1&ko=1'; }
  load();
  window.NKSettings = { KEY, DEF, data, load, save, get: k => data[k], set(k, v) { data[k] = v; return save(); }, on(f) { if (typeof f === 'function') subs.push(f); }, toClassic, classic: CLASSIC };
  // 클래식 화면에서 돌아오기: 설정에서 클래식으로 들어온 탭에만 작은 단추(그 밖의 ?classic=1 주소는 원작 그대로)
  let back = false; try { back = CLASSIC && sessionStorage.getItem(BACK) === '1'; } catch (e) { back = false; }
  if (back && document.body) {
    const b = document.createElement('button'); b.id = 'nk-modern'; b.textContent = '현대 화면'; b.tabIndex = -1;
    b.style.cssText = 'position:fixed;right:8px;top:8px;z-index:9;font:12px Galmuri11,monospace;color:#fff;background:rgba(0,0,0,.6);border:1px solid #888;border-radius:4px;padding:3px 8px;cursor:pointer';
    b.addEventListener('click', () => { try { sessionStorage.removeItem(BACK); } catch (e) { /* 무시 */ } location.href = location.pathname; });
    document.body.appendChild(b);
  }
})();
