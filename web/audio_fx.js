'use strict';
// 타격음 레이어(2026-11-22, 표시 층과 같은 급의 별도 출력). 원작 엔진 효과음(APU → 워커 → 워클릿)은 그대로 두고 자기 AudioContext 의 전용 버스(fxBus)로만 낸다.
//   엔진·워커·RAM·입력·락스텝·워클릿·소리 시계와 연결 없음. 신호 = web/impact_fx.js fire(화면 표시 시점, 타격 연출과 같은 프레임) · web/combo_fx.js 콤보 표시.
//   규칙 = web/audio_fx/manifest.json playback_rules: fxBus 0.8 × 마스터 음량(설정 vol/10, 음소거 mute = 0), 파일별 gain, impact 그룹 동시 1개(새 priority ≥ 재생 중 = 15ms 내려 끄고 교체, 낮으면 생략),
//   floor(down_thud) = 같은 대상 120ms 안 1회, combo = 단계 1→2→3(3 이상 반복, 완화 중 기본 무음), 같은 키 다시 울림 ≥ 130ms, 동시 최대 2보이스(넘으면 가장 오래된 것을 15ms 내려 끔), 재생 속도 고정(아래 완화 플래그).
//   무음 조건: 설정 impact 0 · 품질 낮음(NKQuality.off('fx')) · ?classic=1 · 음소거. 설정 「약」 = 0.7배.
//   준비: 첫 사용자 입력(pointerdown·keydown·touchend) 직후 AudioContext 를 만들고 manifest + wav 를 fetch → decodeAudioData(합계 약 60 KB). 준비 전 이벤트는 버린다.
// API: NKAudioFx.play(key, { s }) → 참 = 울림 · NKAudioFx.combo(n) · NKAudioFx.stats(재생 수·생략 수·소스 노드 생성 수·최근 기록)
(function (root) {
  const BASE = 'audio_fx/', BUS = 0.8, FADE = 0.015, RETRIG = 130, FLOOR_MS = 120, MAXV = 2; // 2026-11-22 「때릴 때 띵띵띵」 완화: 같은 키 50 → 130ms, 동시 4 → 2보이스
  // 완화 플래그(manifest 키·파일 그대로, 교체음이 오면 아래 값만 되돌린다): COMBO_ON = 콤보 단계음(combo_1~3, 음정 있는 C5·E5·G5) 켬 · RATE_VAR = hit_light·hit_heavy 재생 속도 무작위 폭(0 = 고정, 종전 0.1)
  //   IMPACT_MS = impact 그룹(키가 달라도) 다시 울림 최소 간격(더 높은 priority 는 예외) · TRIM = 키별 페이드아웃 끝(ms, 시작 기준. 저음 사인 꼬리가 연타에서 음정처럼 이어지는 것을 자른다)
  //   ?afx_combo=1 = 콤보음 켜서 들어 보기(검증용)
  const COMBO_ON = /[?&]afx_combo=1(&|$)/.test(location.search), RATE_VAR = 0, IMPACT_MS = 110, TRIM = { hit_light: 50, hit_heavy: 60, guard_clank: 60 };
  const CLASSIC = /[?&]classic=1(&|$)/.test(location.search);
  const st = { ready: false, err: null, decoded: 0, played: {}, skipped: { off: 0, notready: 0, prio: 0, retrig: 0, floor: 0, combo: 0, group: 0, disabled: 0 }, sources: 0, steals: 0, replaced: 0, log: [] };
  let ac = null, bus = null, man = null, loadP = null;
  const buf = {}, meta = {}, lastAt = {}, floorAt = {}, voices = []; let impAt = -1e9, impPrio = 0; // voices = [{ key, group, prio, src, g, end }]
  const S = () => root.NKSettings || null;
  const master = () => { const s = S(); if (!s) return 1; if (s.get('mute') === 1) return 0; const v = s.get('vol'); return v >= 0 && v <= 10 ? v / 10 : 0.8; };
  const level = () => { if (CLASSIC || (root.NKQuality && root.NKQuality.off('fx'))) return 0; const s = S(), v = s ? s.get('impact') : 2; return v === 0 || v === 1 || v === 2 || v === 3 ? v : 2; };
  const setBus = () => { if (bus && ac) try { bus.gain.setTargetAtTime(BUS * master(), ac.currentTime, 0.01); } catch (e) { bus.gain.value = BUS * master(); } };

  function init() { // 첫 사용자 입력 안에서(자동 재생 정책). 터치 기기는 web/mobile.js 가 만든 컨텍스트를 활성화 이벤트마다 resume 한다
    if (ac || CLASSIC) { if (ac && ac.state === 'suspended') try { ac.resume(); } catch (e) { /* 무시 */ } return; }
    const AC = root.AudioContext || root.webkitAudioContext; if (!AC) { st.err = 'AudioContext 없음'; return; }
    try { ac = new AC(); } catch (e) { st.err = String(e && e.message || e); return; }
    if (ac.state === 'suspended') try { ac.resume(); } catch (e) { /* 다음 입력 */ }
    bus = ac.createGain(); bus.gain.value = BUS * master(); bus.connect(ac.destination);
    loadP = fetch(BASE + 'manifest.json').then(r => { if (!r.ok) throw new Error('manifest ' + r.status); return r.json(); }).then(j => {
      man = j; const files = (Array.isArray(j.files) ? j.files : []).filter(f => { if (f.enabled === false) { meta[f.key] = { off: true }; return false; } return true; }); // manifest 키별 enabled:false = 그 소리 끔(받지도 않음, 코드 수정 없이 제거 후보를 끈다)
      return Promise.all(files.map(f => fetch(f.path).then(r => { if (!r.ok) throw new Error(f.key + ' ' + r.status); return r.arrayBuffer(); })
        .then(b => new Promise((res, rej) => { const p = ac.decodeAudioData(b, res, rej); if (p && p.then) p.then(res, rej); }))
        .then(d => { buf[f.key] = d; meta[f.key] = { gain: +f.gain || 0.5, prio: +f.priority || 1, group: f.group || 'impact' }; st.decoded++; })));
    }).then(() => { st.ready = true; }).catch(e => { st.err = String(e && e.message || e); console.warn('타격음 준비 실패(무음): ' + st.err); });
  }
  for (const ev of ['pointerdown', 'keydown', 'touchend']) root.addEventListener(ev, init, { capture: true, passive: true });
  if (S() && S().on) S().on(setBus);

  function kill(v, now) { // 15ms 내려 끄기
    try { v.g.gain.cancelScheduledValues(now); v.g.gain.setValueAtTime(v.g.gain.value, now); v.g.gain.linearRampToValueAtTime(0, now + FADE); v.src.stop(now + FADE + 0.005); } catch (e) { /* 이미 끝남 */ }
    v.end = now;
  }
  function play(key, o) {
    const lv = level(); if (!lv || !master()) { st.skipped.off++; return false; }
    if (meta[key] && meta[key].off) { st.skipped.disabled++; return false; }
    if (!st.ready || !ac || !buf[key]) { st.skipped.notready++; return false; }
    if (ac.state !== 'running') { st.skipped.notready++; return false; }
    const t = performance.now(), now = ac.currentTime, m = meta[key];
    if (lastAt[key] !== undefined && t - lastAt[key] < RETRIG) { st.skipped.retrig++; return false; }
    if (m.group === 'floor') { const k = key + ':' + (o && o.s !== undefined ? o.s : '-'); if (floorAt[k] !== undefined && t - floorAt[k] < FLOOR_MS) { st.skipped.floor++; return false; } floorAt[k] = t; }
    for (let i = voices.length - 1; i >= 0; i--) if (voices[i].end <= now) voices.splice(i, 1);
    if (m.group === 'impact') {
      if (t - impAt < IMPACT_MS && m.prio <= impPrio) { st.skipped.group++; return false; } // 연타: 다른 키라도 110ms 안 같은·낮은 급은 생략
      const cur = voices.find(v => v.group === 'impact');
      if (cur) { if (m.prio < cur.prio) { st.skipped.prio++; return false; } kill(cur, now); voices.splice(voices.indexOf(cur), 1); st.replaced++; }
    }
    while (voices.length >= MAXV) { const v = voices.shift(); kill(v, now); st.steals++; }
    const src = ac.createBufferSource(), g = ac.createGain(); st.sources++;
    src.buffer = buf[key];
    if (RATE_VAR && (key === 'hit_light' || key === 'hit_heavy')) src.playbackRate.value = 1 - RATE_VAR / 2 + Math.random() * RATE_VAR; // 반복 피로 줄이기(표시 전용 난수, 엔진과 무관). 완화 중 = 0(음정 흔들림 없음)
    const gv = m.gain * (lv === 1 ? 0.7 : 1), tr = TRIM[key]; g.gain.value = gv;
    src.connect(g); g.connect(bus); src.start(0);
    let dur = src.buffer.duration / src.playbackRate.value;
    if (tr && tr / 1000 < dur) { const a = Math.min(0.02, tr / 2000); try { g.gain.setValueAtTime(gv, now + a); g.gain.linearRampToValueAtTime(0, now + tr / 1000); src.stop(now + tr / 1000 + 0.005); } catch (e) { /* 무시 */ } dur = tr / 1000; } // 꼬리 자르기
    const v = { key, group: m.group, prio: m.prio, src, g, end: now + dur };
    voices.push(v); src.onended = () => { const i = voices.indexOf(v); if (i >= 0) voices.splice(i, 1); try { g.disconnect(); } catch (e) { /* 무시 */ } };
    lastAt[key] = t; if (m.group === 'impact') { impAt = t; impPrio = m.prio; } st.played[key] = (st.played[key] || 0) + 1;
    st.log.push({ key, t: Math.round(t), s: o && o.s }); if (st.log.length > 200) st.log.shift();
    return true;
  }
  root.NKAudioFx = {
    play,
    combo(n) { if (n >= 2 && !COMBO_ON) { st.skipped.combo++; return false; } return n >= 2 ? play(n === 2 ? 'combo_1' : n === 3 ? 'combo_2' : 'combo_3') : false; }, // 표시 콤보 2·3·4+ = 단계 1·2·3(4 이상은 3 반복)
    init,
    get ready() { return st.ready; }, get level() { return level(); }, get ctx() { return ac; }, get voices() { return voices.length; }, get rules() { return { comboOn: COMBO_ON, retrig: RETRIG, maxVoices: MAXV, rateVar: RATE_VAR, impactMs: IMPACT_MS, trim: Object.assign({}, TRIM) }; },
    get stats() { return st; },
  };
})(window);
