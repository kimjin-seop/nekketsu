'use strict';
// 온라인 대전 중계 서버(1단계: 서버 중계 + 동기 검증). 설계: analysis/online_sync.md.
// 락스텝: 서버는 엔진을 돌리지 않는다. 두 클라이언트의 패드 값(프레임 번호 포함)을 모아 프레임 f 의 [1P, 2P] 가 다 모이면
//   확정 프레임으로 양쪽에 똑같이 보낸다. 각 클라이언트는 확정된 프레임만 자기 엔진에 넣는다(같은 ROM·시작 상태·입력열 → 같은 상태).
// 사용: node server_online.js [포트]   (기본 3500, 환경변수 PORT. HOST 기본 127.0.0.1)
//   환경변수: HOST(바인딩 주소), ALLOWED_HOSTS(추가 허용 Host 이름, 쉼표), ALLOW_ORIGINS(추가 허용 웹소켓 Origin, 쉼표),
//             GRACE_MS(끊김 뒤 재접속 대기, 기본 20000), PING_MS(웹소켓 핑 주기, 기본 30000. 한 주기 동안 응답 없으면 소켓을 끊는다),
//             STALL_MS(대전 중 확정 프레임이 이만큼 안 나가면 입력이 뒤처진 쪽을 끊김으로 처리, 기본 10000),
//             RESULT_WAIT_MS(한쪽만 결과를 낸 뒤 기다리는 시간, 기본 30000), IDLE_MS(방 없는 소켓 유휴 제한, 기본 60000), LOBBY_IDLE_MS(이름 등록한 소켓의 방 없는 유휴 제한, 기본 600000), PREFILL(자리 방 시작 때 입력 0 으로 미리 확정할 프레임 수, 기본 1100),
//             STALL_RATE(느린 진행 기준. STALL_MS 창 동안 확정 프레임이 1배속 기대치의 이 비율 미만이면 입력이 뒤처진 자리를 멈춤 처리, 기본 0.25, 0 = 끔),
//             MAX_DROPS(대전 중 한 자리의 끊김(멈춤 포함) 허용 횟수, 넘으면 재접속 대기 없이 기권, 기본 5), MATCH_MAX_MS(대전 방 실시간 상한, 기본 2400000 = 40분),
//             PROVISIONAL(1 = 결과가 한쪽만 왔거나 지문 불일치 속 결과일 때 보고된 승자를 임시 채택. 기본 끔 = 종전처럼 승자 없는 무효), LEGACY_ROOMS(1 = hello 없는 create 로 종전 방 허용. 기본 거절. 검증 도구용),
//             MAX_CONNS(전체 접속 수, 기본 400), MAX_CONNS_PER_IP(기본 8), MAX_ASSET_CONNS(에셋 세션 소켓 /ws?k=asset 전체, 기본 2000)·MAX_ASSET_CONNS_PER_IP(기본 32)·HELLO_PER_MIN(IP당 분당 이름 hello, 기본 120), MAX_ROOMS_PER_IP(기본 4), JOIN_FAILS_PER_MIN(IP당 분당 참가·재접속 실패 허용 수, 기본 10),
//             STATIC(정적 파일 서빙. 기본: HOST 가 루프백이고 ALLOWED_HOSTS 가 없으면 켬(STATIC=0 으로 끔), 그 밖에는 끔(STATIC=1 을 줄 때만 켬))
//   /ws          -> 웹소켓(JSON 문자 메시지, 아래 프로토콜)
//   그 밖의 경로 -> server_game.js 와 같은 규칙의 정적 파일(web/, /engine/, /state/, /fonts/, /logo/, /rom/nekketsu.nes). 8770 서버와 별개 프로세스.
//                   /ui/portraits_orig/{hud,body,cutin}/*.png·/ui/characters.json·/ui/stage_<id>.png 도 server_game.js 와 같은 규칙.
//                   /rom/·/state/·/ui/ 는 루프백 요청(상대 주소와 Host 가 모두 루프백)에만 준다(STATIC 과 무관, 그 밖은 403).
//                   NK_REMOTE_ASSETS=session(기본 off): 루프백이 아닌 요청도 HTTPS + 세션(쿠키 nk_sess 또는 헤더 X-NK-Session = 손님 sid 또는 계정 토큰)이면 /rom/·/state/·/ui/·/engine/gen/ 를 준다
//                   (server/asset_gate.js, analysis/27 M0). session 에서는 /engine/gen/ 도 보호 경로가 되고, 프록시 전달 헤더가 붙은 루프백 요청은 원격으로 본다. NK_ASSET_FAILS_PER_MIN(IP당 분당 거절 상한, 기본 30, 넘으면 429)
// 대기방 개편(PROTO 3, analysis/25_online_room_4p.md): 자리 방(래더 제외)은 자동 시작 없음 → 방장 start{build}|start{cancel} → count{ms}|count{cancel,why} → 핑 → start{cfg}.
//   대기 중 이탈 = 자리 당기기 + 방장 승계(room{moved,from} 재송신), 사람 0명 = 방 닫기. set·create 의 stage/rule -1 = 랜덤(시작 때 서버가 정함). peers.changes[{who,key,value}]. 환경변수 COUNT_MS(기본 3000)
// 프로토콜(클라 → 서버): create{name,opts} join{code,name} rejoin{code,token,have} ready{on,build} pong{id} in{f,p[]} hash{f,h} result{f,r} leave
// 프로토콜(서버 → 클라): room{code,slot,token,opts,players} peers{players} ping{id} start{cfg} f{f,p[]} desync{f,h} peer{ev,slot} end{reason,...} err{code,msg}
// O1(온라인 MVP, analysis/16_wide_hd_online_plan.md 6절 + 부록 A): hello{name,sid} → welcome{sid,name} / lobby{on} → rooms{list} / pick{char} / set{stage,rule,cpu[]}
//   hello 로 이름을 등록한 소켓이 만든 방 = 자리 4개 방(사람 H = 2 + CPU 2). start.cfg 에 plan(battle_full 구동 계획)·prefill·humans·chars 를 싣는다.
//   hello 없이 create{name} 으로 만든 방 = 종전 방(구동 계획 없음, 검증 도구 A~F 그대로). LEGACY_ROOMS=1 일 때만 만들 수 있고(기본 err noname) 로비 목록에는 나오지 않는다.
//   확정 프레임 f.p 의 한 프레임 폭 = 사람 수 H(cfg.humans, MVP 2 → 종전과 같은 [1P, 2P]).
// O3(사람 최대 4명, analysis/17_online_4p.md): create.opts.humans = 2|3|4(없으면 2 = 종전과 같다), 대기방에서 방장이 set{humans} 로 바꿀 수 있다. 자리 i = 엔진 슬롯 i = 패드 포트 i, 앞 H 자리가 사람·나머지 CPU.
//   H >= 3 이면 start.cfg.plan.opt 에 humans[H](사람 캐릭터 줄·칸)가 더 실리고 f.p 폭이 H 가 된다. 대전 중 한 명이 빠지면(기권·끊김 대기 초과·멈춤 3회·끊김 횟수 초과) 판을 끝내지 않고
//   그 자리 입력을 0 으로 확정하며 계속한다(peer{ev:'gone'}). 남은 사람이 1명 이하가 되면 end{reason:'forfeit', winner: 남은 자리 | -1}. H = 2 는 종전 그대로(상대 승으로 즉시 종료).
// 계정·2인 랭크(analysis/22_accounts_ranking_protocol.md): NK_DB_PATH(또는 createServer({ dbPath }))가 있을 때만 SQLite 를 열고 켠다(없으면 계정 메시지 = err acct_off, 종전 동작 그대로).
//   register{name,pw} login{name,pw} hello{token,sid?} logout{} ranking_list{top?} / create{opts{ranked:true}} → welcome{…,account,token} logged_out ranking_list{top,me} ranking_result{…}
//   환경변수: NK_DB_PATH(':memory:' = 시험용), RANK_GO_F(랭크 기권이 반영되는 최소 확정 프레임 = 미리 확정 + 이 값, 기본 600),
//             NK_RANK_ALLOW_SAME_IP(1 = 같은 IP 두 소켓 대전도 반영. 로컬 개발 시험용, 기본 끔 = SAME_IP 미반영),
//             NK_TRUST_PROXY(1 = 신뢰하는 역방향 프록시 뒤: X-Forwarded-For 의 오른쪽에서 NK_TRUST_PROXY_HOPS 번째 값을 접속 IP 로 쓴다. 기본 끔 = 소켓 상대 주소. 프록시 없이 켜면 IP 위조가 된다),
//             NK_TRUST_PROXY_HOPS(신뢰 프록시 단수, 기본 1 = 맨 오른쪽 값 = 맨 앞 프록시가 본 주소. 클라이언트가 보낸 왼쪽 값은 쓰지 않는다)
// 비경제 보상·프로필(analysis/27 P1·P2, 계정 + DB 있을 때만): profile_get{nick?} profile_set{title?,frame?,portrait_bg?,portrait_stamp?} tutorial_done{} → profile{…} profile_set{equipped} tutorial_done{unlocked}
// 일일·주간 도전(analysis/27 P4b): challenge_list{} challenge_claim{id,period?} → challenge_list{serverTime,claims,daily,weekly} challenge_claim{id,period,already,unlocked[]} / err challenge_bad{why}
//   새 획득 = welcome·ranking_result·story_saved 의 unlocked[] (있을 때만). 판정은 서버만(래더 반영 판·스토리 완주·로그인 일자·시즌 종료), 새 표 v4
// 래더·시즌(analysis/22 10절, 계정 + DB 있을 때만): ladder_join{} ladder_leave{} ladder_status{} ladder_board{top?} → ladder_queue{…} ladder_matched{code,you,counted,startBy,opp} ladder_status{…} ladder_board{season,total,masterQuota,top,me}
//   매칭되면 서버가 랭크 방(create{opts{ranked}} 와 같은 경로)을 만들어 두 사람을 앉힌다. 래더 방은 로비 목록에 없고 참가 불가, 한 판만
// 스토리 이어하기(analysis/21 13절, 계정 + DB 있을 때만): story_slots{} story_begin{slot,mode,eng,rec,overwrite?,name?} story_seg{slot,base,from,pads,pads2?,end{f,h},eng,rec,name?} story_delete{slot}
//   → story_slots{…,slots[3]} story_begun{…,state?} story_saved{saved,…} story_deleted{slot,deleted}. 서버가 worker_threads 로 입력을 재현해 저장 지점 스냅샷을 스스로 만든다
//   환경변수: NK_STORY_WORKERS(재현 스레드, 기본 2) NK_STORY_QUEUE(대기열, 8) NK_STORY_TIMEOUT_MS(180000) NK_STORY_SEG_PER_MIN(계정당, 10) NK_STORY_REAL_FRAC(실시간 비율 상한, 1.05, 0 = 끔) NK_STORY_SLACK_F(여유 프레임, 7200) NK_STORY_PACE_FRAC(계정 누적 비율 상한, 3, 0 = 끔)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), net = require('net');
const { WebSocketServer } = require('ws');
const SC = require('./server/static_compress'); // br/gzip 압축 전송 + 메모리 캐시(글자·글꼴, server_game.js 와 같다)
const AG = require('./server/asset_gate'); // 원격 ROM 파생물 제공 정책(NK_REMOTE_ASSETS, 기본 off = 종전 동작. analysis/27 M0)
const { RANK } = require('./server/ranking/elo'), PACE = require('./server/story_pace'), { passwordOk } = require('./server/store/accounts'), { LadderQueue } = require('./server/ranking/queue');
const R = __dirname;

// ---------- 정적 파일(server_game.js 와 같은 마운트·검사) ----------
const mounts = [['/engine/', path.join(R, 'server', 'engine')], ['/state/', path.join(R, 'data', 'rom_derived', 'states')], ['/fonts/', path.join(R, 'art', 'fonts', 'galmuri')], ['/logo/', path.join(R, 'art', 'logo')], ['/', path.join(R, 'web')]];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.ttf': 'font/ttf' };
function resolve(url, local) {
  let u;
  try { u = decodeURIComponent((url || '/').split('?')[0]); } catch (e) { return { code: 400 }; }
  if (u.includes('\0')) return { code: 400 };
  if (u.includes(':')) return { code: 404 };
  if (!local && /^\/+(rom|state)(\/|$)/i.test(u.replace(/\\/g, '/'))) return { code: 403 }; // ROM·시작 상태는 루프백 요청에만
  if (u === '/rom/nekketsu.nes') return { file: path.join(R, 'analysis', 'rom', 'nekketsu.nes') };
  // 신규 UI 층 v2(web/ui_manga.js) 자료: server_game.js resolve() 의 같은 세 규칙을 그대로 복제(정규식 동일, 고칠 때 양쪽 같이).
  //   원작 ROM 파생(초상·스테이지 프레임·캐릭터 자료)이라 server_game.js(전체 루프백 전용)와 같게 루프백 요청에만 준다(그 밖은 403)
  if (/^\/+ui(\/|$)/i.test(u.replace(/\\/g, '/')) && !local) return { code: 403 };
  if (u === '/ui/characters.json') return { file: path.join(R, 'analysis', 'ui_rework', 'characters.json') };
  { const s = /^\/ui\/stage_(\d{1,2})\.png$/.exec(u); if (s) return { file: path.join(R, 'analysis', 'hd_survey', 'out', 'stage_' + s[1] + '_frame_bg.png') }; }
  { const p = /^\/ui\/portraits_orig\/(hud|body|cutin)\/([a-z0-9_]+\.png)$/.exec(u); if (p) return { file: path.join(R, 'art', 'ui_manga', 'portraits_orig', p[1], p[2]) }; } // 원작 초상(ROM 파생, 루프백 전용)
  if (u === '/') u = '/index.html';
  for (const [pre, dir] of mounts) {
    if (!u.startsWith(pre)) continue;
    const c = path.normalize(path.join(dir, u.slice(pre.length)));
    return c.startsWith(dir + path.sep) ? { file: c } : { code: 404 };
  }
  return { code: 404 };
}
const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOP_HOST = /^(127(\.\d{1,3}){3}|localhost|::1|\[::1\])$/i, LOOP_ADDR = /^(::ffff:)?127(\.\d{1,3}){3}$|^::1$/i;
const list = v => (v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// ---------- 방 ----------
const PROTO = 3, LEAD = 2;           // LEAD: 엔진 워커가 허가 없이 도는 첫 2프레임(시작 프레임 조각 + 첫 온전한 프레임). 이 구간 패드는 서버가 0 으로 확정한다
// PROTO 3 = 자리 방 방장 시작·카운트다운·자리 당기기·랜덤(analysis/25). 2 → 3 은 대기방 규칙만 바뀌고 cfg·락스텝 형식은 같다(값 cfg.proto 만 3)          // LEAD: 엔진 워커가 허가 없이 도는 첫 2프레임(시작 프레임 조각 + 첫 온전한 프레임). 이 구간 패드는 서버가 0 으로 확정한다
const MAX_ROOMS = 200, MAX_AHEAD = 3600, MAX_FRAMES = 60 * 60 * 30, MAX_BATCH = 120, HASH_EVERY = 30, HASH_KEEP = 4096;
const HASH_BACK = 600; // 지문은 HASH_EVERY 의 배수이면서 [확정 - 지연 - HASH_BACK, 확정] 안(또는 미리 확정 구간)인 프레임만 받는다(정상 클라이언트의 실행 위치는 확정 - 지연 - 1 이상)
const MSG_MAX = 16 * 1024, MSG_MAX_STORY = 128 * 1024;
const LOBBY_TTL = 30 * 60 * 1000, FRAME_MS = 1000 / 60.0988, MAX_STALLS = 3; // MAX_STALLS: 같은 자리가 멈춤으로 이만큼 걸리면 재접속 대기 없이 바로 기권
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자(0 O 1 I) 제외
const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
const int = v => Number.isInteger(v) ? v : -1;
// 같은 호스트 비교용 IP 키(SAME_IP, analysis/22 4절): IPv4 사상(::ffff:a.b.c.d·::ffff:7f00:1) = IPv4, 루프백(127/8·::1) = 'loopback',
//   그 밖의 IPv6 = 앞 /64 접두(한 가입자가 보통 /64 이상을 받아 주소를 바꿔 가며 쓸 수 있다). 해석 못 하면 소문자 원문
function ipKey(ip) {
  let s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv4(s)) return /^127\./.test(s) ? 'loopback' : s;
  if (!net.isIPv6(s)) return s;
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/); // 끝이 IPv4 꼴이면 16비트 두 묶음으로
  if (v4) { const b = v4[2].split('.').map(Number); s = v4[1] + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16); }
  const [h, t] = s.split('::'), hs = h ? h.split(':') : [], ts = t ? t.split(':') : [];
  const g = s.includes('::') ? hs.concat(new Array(8 - hs.length - ts.length).fill('0'), ts) : hs;
  if (g.length !== 8) return s;
  const n = g.map(x => parseInt(x, 16) || 0);
  if (n.slice(0, 7).every(x => x === 0) && n[7] === 1) return 'loopback'; // ::1
  if (n.slice(0, 5).every(x => x === 0) && n[5] === 0xffff) return ipKey([n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join('.')); // ::ffff:a.b.c.d
  return n.slice(0, 4).map(x => x.toString(16)).join(':') + '::/64';
}
// 이름·모드 문자열: 한글·영숫자·공백·일부 기호만 남긴다(상대 화면에 그대로 전달되는 값. 화면 쪽은 textContent 로만 넣는다)
const clean = (v, n) => str(v, 64).replace(/[^가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9 _.!?-]/g, '').replace(/ +/g, ' ').trim().slice(0, n);
// O1 자리·구동 계획(analysis/16 6.3~6.5절). 자리 i = 엔진 슬롯 i = 패드 포트 i. 사람은 앞자리부터, 나머지는 CPU
const SEATS = 4, HUMANS = 2, HUMANS_MAX = 4, CHARS = 16, NAME_MIN = 2, NAME_MAX = 8, TITLE_MAX = 16, LOBBY_MIN_MS = 1000;
const nfc = v => typeof v === 'string' ? v.normalize('NFC') : '';
const cell = id => ({ row: id >> 2, col: id & 3 }); // 캐릭터 id = 줄*4 + 칸(web/ui_manga.js IDS 순서)
const charOk = v => Number.isInteger(v) && v >= 0 && v < CHARS;
const humansOk = v => Number.isInteger(v) && v >= HUMANS && v <= HUMANS_MAX; // 사람 자리 수 2·3·4(HUMANS = 기본값: 클라이언트가 humans 를 보내지 않을 때 + 종전 방)
const START_WHY = { seat_empty: '빈 자리가 있습니다', offline: '접속이 끊긴 사람이 있습니다', nochar: '캐릭터를 고르지 않은 사람이 있습니다', not_ready: '준비하지 않은 사람이 있습니다', build: '엔진·ROM·시작 상태 지문이 서로 다릅니다. 양쪽 모두 새로 고침하세요' }; // start 거절 이유(analysis/25)
const stageOk = v => Number.isInteger(v) && v >= -1 && v <= 6, ruleOk = v => v === -1 || (Number.isInteger(v) && v >= 1 && v <= 4); // -1 = 랜덤(analysis/25)

function createServer(opt) {
  opt = opt || {};
  const graceMs = opt.graceMs !== undefined ? opt.graceMs : (+process.env.GRACE_MS || 20000);
  const num = (k, e, d) => opt[k] !== undefined ? opt[k] : (+process.env[e] > 0 ? +process.env[e] : d);
  const pingMs = num('pingMs', 'PING_MS', 30000), stallMs = num('stallMs', 'STALL_MS', 10000), resultWaitMs = num('resultWaitMs', 'RESULT_WAIT_MS', 30000), idleMs = num('idleMs', 'IDLE_MS', 60000);
  // LOBBY_IDLE_MS: 이름을 등록한(hello) 소켓은 방 없이 로비에 머물 수 있어야 하므로 유휴 제한을 따로 둔다(기본 10분)
  // PREFILL: 자리 4개 방 시작 때 입력 0 으로 미리 확정해 보내는 앞 프레임 수(구동 계획을 망 지연 없이 최대 속도로 넘기기. env PREFILL=0 이면 끔)
  //   기본 1100 = 구동 계획(battle_full 2인+CPU2)이 끝나는 프레임의 실측 최소 1118 보다 작게(analysis/16 부록 C). 구동이 끝나기 전 프레임은 구동기 값이 덮어쓰므로 0 으로 확정해도 무해하고,
  //   구동이 끝난 뒤 프레임을 미리 확정하면 그만큼 사람 입력이 버려진다(종전 1500 = 전투 시작 뒤 2~3초 조작 불가). 남은 구동 프레임(1100 ~ 구동 끝)은 보통 중계로 확정된다(그 구간 입력도 구동기가 덮어쓴다)
  const lobbyIdleMs = num('lobbyIdleMs', 'LOBBY_IDLE_MS', 10 * 60 * 1000);
  // 분쟁·느린 진행 규칙(analysis/16 부록 D). 모두 되돌리기 쉬운 값: STALL_RATE=0 이면 느린 진행 감시 끔. 임시 채택은 PROVISIONAL=1 일 때만(기본 끔)
  const num0 = (k, e, d) => opt[k] !== undefined ? opt[k] : (process.env[e] !== undefined && process.env[e] !== '' && +process.env[e] >= 0 ? +process.env[e] : d);
  const countMs = num0('countMs', 'COUNT_MS', 3000); // 방장 시작 카운트다운(analysis/25, 기본 3초. 시험용으로 줄일 수 있다)
  const stallRate = Math.min(1, num0('stallRate', 'STALL_RATE', 0.25)), maxDrops = num('maxDrops', 'MAX_DROPS', 5), matchMaxMs = num('matchMaxMs', 'MATCH_MAX_MS', 40 * 60 * 1000);
  const provisional = opt.provisional !== undefined ? !!opt.provisional : process.env.PROVISIONAL === '1', legacyRooms = opt.legacyRooms !== undefined ? !!opt.legacyRooms : process.env.LEGACY_ROOMS === '1';
  const prefillN = opt.prefill !== undefined ? opt.prefill : (process.env.PREFILL !== undefined && +process.env.PREFILL >= 0 ? Math.min(MAX_AHEAD, +process.env.PREFILL | 0) : 1100);
  const maxConns = num('maxConns', 'MAX_CONNS', 400), maxConnsIp = num('maxConnsPerIp', 'MAX_CONNS_PER_IP', 8), maxRoomsIp = num('maxRoomsPerIp', 'MAX_ROOMS_PER_IP', 4), joinFails = num('joinFailsPerMin', 'JOIN_FAILS_PER_MIN', 10);
  // 에셋 세션 소켓(web/asset_session.js 가 /ws?k=asset 로 붙는 원격 방문자 1명당 1개, analysis/27 M0 후속): 온라인 플레이 소켓과 한도를 따로 센다(IP당 MAX_ASSET_CONNS_PER_IP 기본 32, 전체 MAX_ASSET_CONNS 기본 2000).
  //   한도를 넘으면 핸드셰이크 뒤 4029 로 닫는다(브라우저가 HTTP 429 는 구분하지 못하므로 = 클라이언트가 「접속 인원 초과」 토스트). 이 소켓은 손님 hello·lobby{on:false} 만 받는다.
  //   HELLO_PER_MIN = IP당 분당 이름 hello 상한(기본 120, 두 종류 소켓 공통, 넘으면 err rate)
  const maxAssetConns = num('maxAssetConns', 'MAX_ASSET_CONNS', 2000), maxAssetConnsIp = num('maxAssetConnsPerIp', 'MAX_ASSET_CONNS_PER_IP', 32), helloPerMin = num('helloPerMin', 'HELLO_PER_MIN', 120);
  const allowedHosts = opt.allowedHosts ? list(opt.allowedHosts.join(',')) : list(process.env.ALLOWED_HOSTS), allowOrigins = list(process.env.ALLOW_ORIGINS);
  // 정적 서빙 기본값: 루프백에만 묶이고 추가 허용 Host 가 없을 때만 켠다. 밖에 여는 설정이면 STATIC=1 을 명시해야 켜진다
  const bindHost = opt.host || process.env.HOST || '127.0.0.1', staticSet = opt.static !== undefined || process.env.STATIC === '0' || process.env.STATIC === '1';
  let serveStatic = opt.static !== undefined ? !!opt.static : (!LOOP_HOST.test(bindHost) || allowedHosts.length ? process.env.STATIC === '1' : process.env.STATIC !== '0');
  const conns = new Map(), fails = new Map(); // IP → 접속 수, IP → 참가·재접속 실패 시각들
  const aconns = new Map(), helloHits = new Map(); let nGame = 0, nAsset = 0; // 에셋 세션 소켓 IP → 수, IP → 최근 1분 hello 시각들, 종류별 전체 수
  const profIpHits = new Map(), profCache = new Map(), PROF_CACHE_MS = 8000; // 프로필 타인 조회: IP → 시각들, 계정 키 → { t, nick, body }
  const hostOk = h => LOCAL.test(h || '') || allowedHosts.includes(String(h || '').toLowerCase().replace(/:\d+$/, ''));
  const originOk = (o, host) => {
    if (!o) return true; // 브라우저가 아닌 클라이언트(검증 도구)
    let u; try { u = new URL(o); } catch (e) { return false; }
    return u.host.toLowerCase() === String(host || '').toLowerCase() || LOCAL.test(u.host) || allowOrigins.includes(o.toLowerCase());
  };
  const rooms = new Map(); const stats = { rooms: 0, started: 0, frames: 0, desync: 0 };
  // 이름표(가입 없음): 비교 키(NFC + 영문 소문자) → 세션 { sid, name, key, ws, timer }. sids: sid → 세션.
  //   접속 중이거나 끊긴 뒤 graceMs 안이면 그 이름은 잡혀 있다(같은 sid 만 되찾음). graceMs 가 지나면 풀린다
  const names = new Map(), sids = new Map(), lobbySubs = new Set(); let lobbyAt = 0, lobbyTm = null;
  const log = (...a) => { if (!opt.quiet) console.log(new Date().toISOString().slice(11, 19), ...a); };
  // 계정·랭킹 저장(analysis/22). 경로가 주어졌을 때만 연다(검증 도구·종전 실행은 DB 없이 그대로). 통키 DB 와 별개 파일
  const dbPath = opt.dbPath !== undefined ? opt.dbPath : (process.env.NK_DB_PATH || '');
  let db = null, accts = null, ranks = null, guard = null, stories = null, profile = null, RS = null, SN = null;
  if (dbPath) {
    const { openDb } = require('./server/store/db'), { AccountStore, LoginGuard } = require('./server/store/accounts'), { RankingStore } = require('./server/store/ranking');
    db = openDb(dbPath); accts = new AccountStore(db); ranks = new RankingStore(db, { seasonMs: opt.ladderSeasonMs }); guard = new LoginGuard(opt.loginGuard);
    stories = new (require('./server/store/story').StoryStore)(db); RS = require('./server/engine/replay_save'); SN = require('./server/engine/snapshot'); // 이어하기(analysis/21 13절)
    // 비경제 보상·프로필(analysis/27 P1·P2, 스키마 v4). 시즌이 넘어가면(기동 때 포함) 시즌 종료 일괄 지급을 멱등으로 다시 돈다
    profile = new (require('./server/store/profile').ProfileStore)(db, { ranks });
    ranks.onRoll = () => profile.settleSeasons();
    try { profile.settleSeasons(); } catch (e) { if (!opt.quiet) console.log('시즌 보상 정산 오류', e && e.message); }
  }
  // 이어하기 재현 스레드·한도(analysis/21 13.4절). storyRealFrac 0 = 실시간 검사 끔(시험용)
  const storyWorkers = num('storyWorkers', 'NK_STORY_WORKERS', 2), storyQueueMax = num('storyQueueMax', 'NK_STORY_QUEUE', 8), storyTimeoutMs = num('storyTimeoutMs', 'NK_STORY_TIMEOUT_MS', 180000);
  const storySegPerMin = num('storySegPerMin', 'NK_STORY_SEG_PER_MIN', 10), storyRealFrac = num0('storyRealFrac', 'NK_STORY_REAL_FRAC', 1.05), storySlackF = num0('storySlackFrames', 'NK_STORY_SLACK_F', 7200);
  const storyPaceFrac = num0('storyPaceFrac', 'NK_STORY_PACE_FRAC', 3), storyPaceCfg = { realFrac: storyRealFrac, paceFrac: storyPaceFrac, slackF: storySlackF };
  const rankGoF = opt.rankGoFrames !== undefined ? opt.rankGoFrames : (process.env.RANK_GO_F !== undefined && +process.env.RANK_GO_F >= 0 ? +process.env.RANK_GO_F | 0 : 600);
  // 랭크 반영 조건(analysis/22 4절): 같은 IP 두 자리 = SAME_IP, 실시간 경과 < max(rankMinRealMs, 전투 확정 프레임 실시간 × rankRealFrac) = TOO_FAST
  const rankAllowSameIp = opt.rankAllowSameIp !== undefined ? !!opt.rankAllowSameIp : process.env.NK_RANK_ALLOW_SAME_IP === '1';
  const rankMinRealMs = opt.rankMinRealMs !== undefined ? opt.rankMinRealMs : RANK.minRealMs, rankRealFrac = opt.rankRealFrac !== undefined ? opt.rankRealFrac : RANK.realFrac;
  const trustProxy = opt.trustProxy !== undefined ? !!opt.trustProxy : process.env.NK_TRUST_PROXY === '1';
  const proxyHops = Math.max(1, (opt.trustProxyHops !== undefined ? +opt.trustProxyHops : +(process.env.NK_TRUST_PROXY_HOPS || 1)) | 0 || 1);
  // 접속 IP: 기본 = 소켓 상대 주소. 신뢰 프록시(NK_TRUST_PROXY=1)일 때만 X-Forwarded-For 의 오른쪽에서 proxyHops 번째 값(analysis/22 2절).
  //   왼쪽 값은 클라이언트가 마음대로 쓸 수 있으므로(프록시는 뒤에 덧붙인다) 쓰지 않는다. 값이 모자라거나 IP 형식(net.isIP)이 아니면 상대 주소
  const clientIp = req => {
    const ra = req.socket.remoteAddress || '';
    if (!trustProxy) return ra;
    const xs = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean);
    const x = xs.length >= proxyHops ? xs[xs.length - proxyHops] : '';
    return net.isIP(x) ? x : ra;
  };
  // 원격 ROM 파생물 제공(analysis/27 M0): NK_REMOTE_ASSETS=session(또는 createServer({ remoteAssets: 'session' }))일 때만 HTTPS + 세션(손님 sid 또는 계정 토큰) 요청에 보호 경로를 준다. 기본 off = 종전 그대로
  const gate = AG.createGate({ mode: opt.remoteAssets, trustProxy, trustProxyHops: proxyHops, failsPerMin: opt.assetFailsPerMin,
    validate: c => /^[0-9a-f]{32}$/.test(c) ? sids.has(c) : !!(accts && accts.tokenAccount(c)) }); // sid 는 접속 중이거나 끊긴 뒤 graceMs 안일 때만 sids 에 있다
  const authHits = new Map(), pendingReg = new Set(); // IP → 최근 1분 register·login·hello{token} 시각들 / 가입 해시 계산 중인 이름 키

  const srv = http.createServer((req, res) => {
    if (!hostOk(req.headers.host)) { res.writeHead(403); return res.end('forbidden host'); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end('method not allowed'); }
    if ((req.url || '').split('?')[0] === '/online/status') { // 운영 확인용(방 수·누계만, 입력·이름 없음)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ proto: PROTO, rooms: rooms.size, names: names.size, started: stats.started, frames: stats.frames, desync: stats.desync }));
    }
    if (!serveStatic) { res.writeHead(404); return res.end('not found'); }
    const g = gate.check(req, LOOP_ADDR.test(req.socket.remoteAddress || '') && LOCAL.test(req.headers.host || '')); // off = 종전 local 판정 그대로
    const r = g.code ? { code: g.code } : resolve(req.url, g.local);
    let st = null; try { if (r.file) st = fs.statSync(r.file); } catch (e) { /* 없음 */ }
    if (!r.file || !st || !st.isFile()) { const code = r.code || 404; res.writeHead(code, g.priv ? { 'Cache-Control': 'no-store' } : {}); return res.end(code === 400 ? 'bad request' : code === 403 ? 'forbidden' : code === 429 ? 'too many requests' : 'not found'); }
    // 캐시: server_game.js 와 같다(no-cache + ETag/Last-Modified → 안 바뀐 파일은 304, 고치면 다음 요청에 바로 반영)
    const tag = 'W/"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"', lm = st.mtime.toUTCString();
    const hd = { 'Cache-Control': 'no-cache', ETag: tag, 'Last-Modified': lm, 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
    const inm = req.headers['if-none-match'], ims = Date.parse(req.headers['if-modified-since'] || '');
    Object.assign(hd, SC.vary(r.file, st.size)); if (g.priv) AG.privateHeaders(hd); const hit = inm && inm.split(',').find(v => SC.sameTag(v, tag)); // 압축본 태그(…-br")도 같은 파일로 본다. 보호 경로(session 모드) = private
    if (inm ? hit : ims >= Math.floor(st.mtimeMs / 1000) * 1000) { res.writeHead(304, Object.assign({}, hd, hit ? { ETag: hit.trim() } : {})); return res.end(); }
    SC.send(req, res, r.file, st, hd, types[path.extname(r.file)] || 'application/octet-stream'); // Accept-Encoding 이 br/gzip 이고 글자·글꼴이면 압축본, 아니면 원본 그대로
  });

  // 메시지 상한: 종전 16KB. story_seg(입력 기록 pads)만 MSG_MAX_STORY 까지 받는다(웹소켓 상한은 큰 쪽, 나머지는 메시지 처리에서 16KB 로 거른다)
  const wss = new WebSocketServer({ noServer: true, maxPayload: stories ? MSG_MAX_STORY : MSG_MAX }); // DB 없음(검증 도구) = 종전 그대로 16KB
  srv.on('upgrade', (req, sock, head) => {
    const ok = (req.url || '').split('?')[0] === '/ws' && hostOk(req.headers.host) && originOk(req.headers.origin, req.headers.host);
    if (!ok) { sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return sock.destroy(); }
    const ip = clientIp(req);
    if (/[?&]k=asset(&|$)/.test(req.url || '')) { // 에셋 세션 소켓(위 maxAssetConns): 따로 센다. 한도 초과 = 업그레이드 뒤 4029(클라이언트가 이유를 안다)
      if (nAsset >= maxAssetConns || (aconns.get(ip) || 0) >= maxAssetConnsIp) return wss.handleUpgrade(req, sock, head, ws => { ws.on('error', () => { /* 무시 */ }); try { ws.close(4029, 'full'); } catch (e) { ws.terminate(); } setTimeout(() => ws.terminate(), 2000).unref(); });
      aconns.set(ip, (aconns.get(ip) || 0) + 1); nAsset++;
      sock.once('close', () => { nAsset--; const c = (aconns.get(ip) || 1) - 1; if (c > 0) aconns.set(ip, c); else aconns.delete(ip); });
      return wss.handleUpgrade(req, sock, head, ws => { ws.ip = ip; ws.asset = true; wss.emit('connection', ws, req); });
    }
    if (nGame >= maxConns) { sock.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return sock.destroy(); }
    if ((conns.get(ip) || 0) >= maxConnsIp) { sock.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return sock.destroy(); }
    conns.set(ip, (conns.get(ip) || 0) + 1); nGame++; // 소켓이 닫힐 때(핸드셰이크 실패 포함) 한 번만 되돌린다
    sock.once('close', () => { nGame--; const c = (conns.get(ip) || 1) - 1; if (c > 0) conns.set(ip, c); else conns.delete(ip); });
    wss.handleUpgrade(req, sock, head, ws => { ws.ip = ip; wss.emit('connection', ws, req); });
  });

  const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const cast = (room, m) => { for (const p of room.players) if (p) send(p.ws, m); };
  const err = (ws, code, msg) => send(ws, { t: 'err', code, msg });
  const pub = room => room.players.map(p => p ? { name: p.name, ready: p.ready, on: !!p.ws } : null);
  // 자리 4개 공개 상태(자리 방만). 사람 자리 = 빈자리면 name null. CPU 자리 = char -1 이면 「자동」(시작 때 서버가 정해 start.cfg.chars 로 알림)
  const seatsOf = room => {
    const out = [];
    for (let i = 0; i < SEATS; i++) {
      if (i < room.H) {
        const p = room.players[i], c = p ? { kind: 'human', name: p.name, char: p.char, ready: p.ready, on: !!p.ws } : { kind: 'human', name: null, char: -1, ready: false, on: false };
        if (p && room.opts.ranked && p.acct && ranks) { const v = ranks.view(ranks.get(p.acct.key, p.acct.nick)); Object.assign(c, { account: true, rating: v.rating, placement: v.placement, placementLeft: v.placementLeft, tier: v.tier }); } // 랭크 방 계정 자리만(손님 자리·일반 방은 종전 그대로)
        out.push(c);
      }
      else out.push({ kind: 'cpu', name: null, char: room.cpu[i - room.H], ready: true, on: true });
    }
    return out;
  };
  const hostName = room => room.players[0] ? room.players[0].name : '';
  const roomView = room => room.seats ? { title: room.title, host: hostName(room), humans: room.H, seats: seatsOf(room), opts: room.opts } : {};
  // changes = 무엇이 바뀌었는지 [{ who: 바꾼 사람 이름, key, value }](analysis/25. 클라이언트 토스트용, 없으면 필드 없음)
  const peers = (room, changes) => cast(room, Object.assign({ t: 'peers', players: pub(room) }, roomView(room), changes && changes.length ? { changes } : null));
  const newCode = () => { for (let k = 0; k < 50; k++) { let c = ''; for (let i = 0; i < 4; i++) c += ALPHA[crypto.randomInt(ALPHA.length)]; if (!rooms.has(c)) return c; } return null; };
  const mkPlayer = (ws, name) => ({ ws, name: clean(name, 16), acct: ws.sess && ws.sess.acct ? ws.sess.acct : null, key: ws.sess ? ws.sess.key : clean(name, 16).toLowerCase(), char: -1, token: crypto.randomBytes(12).toString('hex'), ips: new Set([ipKey(ws.ip)]), ready: false, build: '', rtt: [], pings: new Map(), ins: [], nin: 0, dropTimer: null, stalls: 0, drops: 0, wait: 0 });
  const cleanOpts = (o, seats) => { // 방 설정(모두 통일). 모르는 값은 버린다. 자리 방은 humans(2·3·4, 없거나 범위 밖이면 2)·stage(커서 0~6)·rule(1~4 = 룰2~룰5)을 더한다
    o = o && typeof o === 'object' ? o : {};
    const d = int(o.delay);
    const r = { view: o.view === 'wide' ? 'wide' : 'classic', state: typeof o.state === 'string' && /^[a-z0-9_]{1,32}$/.test(o.state) ? o.state : 'boot_title', mode: clean(o.mode, 16) || 'battle2p', delay: d >= 1 && d <= 60 ? d : 0 };
    if (seats) { const st = int(o.stage), ru = int(o.rule); Object.assign(r, { mode: 'battle_full', humans: humansOk(o.humans) ? o.humans : HUMANS, stage: stageOk(st) ? st : 0, rule: ruleOk(ru) ? ru : 1 }); } // -1 = 랜덤(시작 때 서버가 정한다)
    return r;
  };
  // 방 없는 소켓은 idleMs 뒤 끊는다(접속만 해 두고 자리를 차지하는 것 방지). 이름을 등록한 소켓(로비)은 lobbyIdleMs. 방에 들어가면 멈추고, 방에서 나오면 다시 잰다
  function armIdle(ws) {
    clearTimeout(ws.idle); ws.idle = null;
    if (ws.readyState === 1 && !ws.room) ws.idle = setTimeout(() => { if (!ws.room) { try { ws.close(4001, 'idle'); } catch (e) { /* 무시 */ } setTimeout(() => ws.terminate(), 2000).unref(); } }, ws.sess ? lobbyIdleMs : idleMs);
  }
  function detach(ws) { ws.room = null; ws.slot = -1; armIdle(ws); }

  // ---------- 로비 목록(구독한 소켓에만, 바뀔 때 최대 초당 1회 전체 목록) ----------
  const roomsList = () => [...rooms.values()].filter(r => r.seats && r.state !== 'ended' && !r.ladder).map(r => Object.assign({ code: r.code, title: r.title || hostName(r) + '의 방', host: hostName(r), humans: r.H, seats: r.players.filter(Boolean).length, state: r.state, stage: r.opts.stage, rule: r.opts.rule }, r.opts.ranked ? { ranked: true } : null));
  function lobbyFlush() { lobbyTm = null; lobbyAt = Date.now(); if (!lobbySubs.size) return; const m = { t: 'rooms', list: roomsList() }; for (const ws of lobbySubs) send(ws, m); }
  function lobbyDirty() {
    if (lobbyTm || !lobbySubs.size) return;
    const w = LOBBY_MIN_MS - (Date.now() - lobbyAt);
    if (w <= 0) lobbyFlush(); else { lobbyTm = setTimeout(lobbyFlush, w); lobbyTm.unref(); }
  }

  // ---------- 이름표 ----------
  function releaseSess(s) { clearTimeout(s.timer); s.timer = null; if (names.get(s.key) === s) names.delete(s.key); if (sids.get(s.sid) === s) sids.delete(s.sid); }
  function sessGone(ws) { // 소켓 끊김: 이름은 graceMs 동안 잡아 둔다(새로 고침한 본인이 같은 sid 로 되찾음). 그 뒤 풀린다
    const s = ws.sess; ws.sess = null; if (!s || s.ws !== ws) return;
    s.ws = null; clearTimeout(s.timer); s.timer = setTimeout(() => { if (!s.ws) releaseSess(s); }, graceMs); s.timer.unref();
  }

  function closeRoom(room, why) {
    if (!rooms.has(room.code)) return;
    rooms.delete(room.code); clearTimeout(room.ttl); clearTimeout(room.count); room.count = null;
    for (const p of room.players) if (p) { clearTimeout(p.dropTimer); if (p.ws) detach(p.ws); }
    log('방 닫음', room.code, why); lobbyDirty();
  }
  function endRoom(room, m) {
    if (room.state === 'ended') return;
    room.state = 'ended'; cast(room, Object.assign({ t: 'end', frames: room.conf, desync: room.desync }, m));
    log('대전 종료', room.code, m.reason, '프레임', room.conf);
    rankSettle(room, m);
    closeRoom(room, '대전 종료'); // 끝난 방은 바로 닫아 소켓의 방 소속을 푼다(같은 소켓으로 곧바로 새 방을 만들 수 있다)
  }
  // 랭크 판 정산(analysis/22 4절). 반영 = (가) 결과 인정(agree: 남은 사람 전원 보고 일치 + 지문 불일치 없음, 임시 채택 아님)이고 승자가 사람 자리 0·1,
  //   (나) 서버가 판정한 기권(2인 = 상대 승)이고 확정 프레임이 미리 확정 + rankGoF 이상(구동 계획 중 = 전투 전 이탈은 무효).
  //   반영 후보라도 같은 IP 두 자리(SAME_IP, NK_RANK_ALLOW_SAME_IP=1 이면 허용)·실시간 경과 부족(TOO_FAST)이면 미반영으로 기록한다(ranks.record voidWhy).
  //   결과 분쟁(one_sided·desync·mismatch)은 rank_games 에 기록(ranks.dispute). 계정 대 계정이면 두 자리 모두 분쟁 1회(결과를 안 낸 쪽 탓으로 정하지 않는다),
  //   손님 상대면 기록만(잠금 계산 제외). 잠금 = 최근 10판 중 분쟁 상대(계정) 서로 다른 3명 → 30분.
  //   그 밖(CPU 승·무승부·멈춤 종료·시간 초과·전투 전 이탈)은 VOID(변동·기록 없음). 계정 자리에만 ranking_result 를 보낸다(end 바로 뒤)
  const DISPUTES = new Set(['one_sided', 'desync', 'mismatch']);
  function rankSettle(room, m) {
    if (!room.opts.ranked || !ranks || !room.startAt || !room.cfg) return;
    const ps = room.players; if (ps.length !== 2 || !ps[0] || !ps[1]) return;
    let winner = null, ff = null, dispute = null, voidWhy = null;
    if (m.reason === 'result' && m.agree === true && !m.provisional && room.desync < 0 && (m.winner === 0 || m.winner === 1)) winner = m.winner;
    else if (m.reason === 'forfeit' && (m.winner === 0 || m.winner === 1) && room.conf >= (room.cfg.prefill || 0) + rankGoF) { winner = m.winner; ff = m.loser; }
    else if (m.reason === 'result' && m.agree === false && DISPUTES.has(m.why)) dispute = m.why;
    if (winner !== null) {
      const real = Date.now() - room.startAt, need = Math.max(rankMinRealMs, Math.max(0, room.conf - (room.cfg.prefill || 0)) * FRAME_MS * rankRealFrac); // 미리 확정 구간은 최대 속도로 도므로 뺀다
      if (!rankAllowSameIp && [...ps[0].ips].some(ip => ps[1].ips.has(ip))) voidWhy = 'SAME_IP';
      else if (real < need) voidWhy = 'TOO_FAST';
    }
    const match = room.code + '-' + room.startAt, who = ps.map(p => ({ key: p.acct ? p.acct.key : p.key, nick: p.acct ? p.acct.nick : p.name, account: !!p.acct }));
    let res;
    try {
      const ladder = !!room.ladder;
      if (dispute) res = ranks.dispute({ matchId: match, players: who, kind: dispute, ladder });
      else if (winner === null) {
        const vs = ps.map(p => p.acct ? ranks.view(ranks.get(p.acct.key, p.acct.nick)) : null), b = vs.map(v => v ? v.rating : RANK.init), pk = k => vs.map(v => v ? v[k] : null);
        res = { counted: false, why: 'VOID', season: ranks.season().n, before: b, after: b, delta: [0, 0], lockUntil: [0, 0], tierBefore: pk('tier'), tier: pk('tier'), placement: pk('placement'), placementLeft: pk('placementLeft') };
      } else res = ranks.record({ matchId: match, players: who, winner, forfeit: ff, voidWhy, ladder });
    } catch (e) { log('랭크 정산 오류', room.code, e && e.message); return; }
    const unl = ps.map(p => { // 반영된 판만 보상 판정(서버 판정, 멱등). 오류는 정산 응답을 막지 않는다
      if (!res.counted || !p.acct || !profile) return null;
      try { const u = profile.onGame(p.acct.key); return u.length ? u : null; } catch (e) { log('보상 판정 오류', e && e.message); return null; }
    });
    ps.forEach((p, i) => { if (p.acct && p.ws) send(p.ws, Object.assign({ t: 'ranking_result', match, slot: i, ladder: !!room.ladder, season: res.season, counted: res.counted }, res.why ? { why: res.why } : null, res.kind ? { dispute: res.kind } : null, unl[i] ? { unlocked: unl[i] } : null, { before: res.before[i], after: res.after[i], delta: res.delta[i], oppBefore: res.before[1 - i], opp: ps[1 - i].name, oppAccount: !!ps[1 - i].acct,
      tierBefore: res.tierBefore[i], tier: res.tier[i], placement: res.placement[i], placementLeft: res.placementLeft[i] }, res.lockUntil && res.lockUntil[i] > Date.now() ? { lockUntil: res.lockUntil[i] } : null)); });
    log('랭크 정산', room.code, res.counted ? '반영' : res.why, res.delta.join('/'));
  }
  // 결과 판정(부록 D.1). 모두 보고 + 같은 프레임·같은 값 + 지문 불일치 없음 = 인정(agree). 그 밖에는 agree: false 와 함께 why·by(결과를 낸 자리)를 싣는다:
  //   one_sided(한쪽만 보고) · desync(값은 같지만 지문 불일치가 있었음) · mismatch(양쪽 값이 다름). 기본은 모두 승자 없는 무효.
  //   PROVISIONAL=1 일 때만 one_sided·desync 에서 보고된 승자를 임시 채택(provisional: true, winner)한다. 서버는 엔진을 돌리지 않아 거짓 result 와 정직한 진행을 가리지 못하므로 기본은 끈다.
  //   전적 기록(O2) 전에 확정 입력 기록(room.log) 재생 검증으로 바꿔야 한다
  function endResult(room) {
    const rs = room.results, by = []; rs.forEach((x, i) => { if (x) by.push(i); });
    const a = rs[by[0]], all = reported(room), same = all && by.every(i => rs[i].f === a.f && rs[i].r === a.r); // 빠진 자리(gone)는 보고하지 않아도 된다
    const m = { reason: 'result', agree: same && room.desync < 0, r: rs.map(x => x ? x.r : null), f: rs.map(x => x ? x.f : -1) };
    if (m.agree) { if (a.w !== null) m.winner = a.w; return endRoom(room, m); }
    m.why = !all ? 'one_sided' : same ? 'desync' : 'mismatch'; m.by = by;
    if (provisional && m.why !== 'mismatch' && a.w !== null) { m.winner = a.w; m.provisional = true; }
    endRoom(room, m);
  }
  // 멈춤·느린 진행 감시 창: at 부터 다시 잰다(자리별 「확정을 막고 있던 시간」 wait 도 0 으로)
  function resetWin(room, at) { room.winAt = at; room.winConf = room.conf; room.blameAt = at; for (const p of room.players) if (p) p.wait = 0; }
  // 지난 계산 뒤 지금까지, 다음 확정 프레임의 입력을 안 낸 자리에 그 시간을 더한다(입력이 도착하기 직전과 감시 때 부른다 → 그 사이 상태는 변하지 않으므로 정확하다)
  function blame(room, now) { const dt = now - room.blameAt; if (dt <= 0) return; room.blameAt = now; for (const p of room.players) if (p && !p.gone && p.ins[room.conf] === undefined) p.wait += dt; }
  // 기권: 사람 2명이면 상대 승(winner = 엔진 슬롯)으로 판을 끝낸다(종전 그대로)
  const forfeit = (room, slot, why) => ({ reason: 'forfeit', winner: room.H === 2 ? 1 - slot : -1, loser: slot, why });
  const activeSlots = room => { const a = []; room.players.forEach((p, i) => { if (p && !p.gone) a.push(i); }); return a; };
  const goneSlots = room => { const a = []; room.players.forEach((p, i) => { if (p && p.gone) a.push(i); }); return a; };
  const reported = room => room.players.every((p, i) => p.gone || room.results[i]); // 남아 있는 사람이 모두 결과를 냈는지
  // 한 자리가 판에서 빠진다(기권 leave · 끊김 대기 초과 disconnect · 멈춤/느린 진행 3회 stall/slow · 끊김 횟수 초과 drops).
  //   H = 2: 종전 그대로 상대 승으로 종료. H >= 3: 그 자리를 gone 으로 두고 입력 0 으로 확정하며 계속한다(그 캐릭터는 패드를 놓은 상태로 남는다. 재접속 불가).
  //   남은 사람이 1명 이하가 되면 종료. left = 빠진 자리 목록(자리 번호순).
  //   끊겨서 재접속을 기다리는 자리(ws 없음, 아직 gone 아님)는 「남은 사람」으로 센다(돌아올 수 있으므로 그 자리 때문에 판을 끝내지 않는다. 대기 시간이 지나면 그때 gone).
  //   다만 마지막 1명 승자는 접속 중인 사람만: 남은 1명이 끊긴 채 대기 중이면 winner = -1(접속해 있지 않은 사람을 승자로 올리지 않는다).
  //   빠진 자리가 이미 낸 결과(result)는 지운다 — 판을 떠난 사람의 보고가 남아 one_sided 타이머·합의·임시 채택(PROVISIONAL)에 끼어들지 않게. 남은 보고가 없으면 결과 대기 시각도 되돌린다
  function giveUp(room, slot, why) {
    if (room.state !== 'playing') return;
    if (room.H === 2) return endRoom(room, forfeit(room, slot, why));
    const p = room.players[slot]; if (!p || p.gone) return;
    p.gone = true; clearTimeout(p.dropTimer); p.dropTimer = null;
    room.results[slot] = null; if (!room.results.some(Boolean)) room.resultAt = 0;
    const left = activeSlots(room), gone = goneSlots(room);
    if (left.length <= 1) return endRoom(room, { reason: 'forfeit', winner: left.length && room.players[left[0]].ws ? left[0] : -1, loser: slot, why, left: gone });
    const ws = p.ws; p.ws = null;
    if (ws) { send(ws, { t: 'end', reason: 'forfeit', winner: -1, loser: slot, why, left: gone, frames: room.conf, desync: room.desync }); detach(ws); } // 빠진 본인에게만 종료를 알린다(방은 계속된다)
    cast(room, { t: 'peer', ev: 'gone', slot, why, left: gone });
    log('자리 빠짐', room.code, '자리', slot, why, '남은 사람', left.length);
    room.adv = Date.now(); resetWin(room, room.adv); confirm(room); // 그 자리 입력을 기다리던 프레임을 0 으로 확정해 흘려보낸다
    if (room.state === 'playing' && room.results.some(Boolean) && reported(room)) endResult(room); // 남은 사람은 이미 다 결과를 낸 경우
  }
  function attach(ws, room, slot) { ws.room = room; ws.slot = slot; clearTimeout(ws.idle); ws.idle = null; lobbySubs.delete(ws); } // 방에 들어가면 로비 구독은 끝난다(로비로 돌아오면 다시 lobby{on})
  // 참가·재접속 실패 횟수(IP당 최근 1분). 방 번호·토큰 대입 시도를 늦춘다. 세는 것 = 없는 방 번호(noroom)·틀린 재접속(norejoin)뿐.
  //   대전 중·가득 찬 방(busy)은 세지 않고, 맞는 토큰의 rejoin 은 제한에 걸려 있어도 받는다(같은 IP 의 다른 사람 실패로 재접속이 막히지 않게. 토큰 = 96비트 난수)
  const limited = ws => { const a = (fails.get(ws.ip) || []).filter(t => Date.now() - t < 60000); if (a.length) fails.set(ws.ip, a); else fails.delete(ws.ip); return a.length >= joinFails; };
  const failed = ws => { const a = fails.get(ws.ip) || []; a.push(Date.now()); fails.set(ws.ip, a); };
  const roomsOf = ip => { let n = 0; for (const r of rooms.values()) if (r.ip === ip) n++; return n; };
  function sendRoom(ws, room, slot, extra) { send(ws, Object.assign({ t: 'room', proto: PROTO, code: room.code, slot, you: slot, token: room.players[slot].token, opts: room.opts, players: pub(room) }, roomView(room), extra)); }
  // 캐릭터 c 를 자리 except 밖에서 이미 쓰는지(사람 자리 + 고정 CPU 자리)
  const usedBy = (room, c, except) => room.players.some((p, i) => p && i !== except && p.char === c) || room.cpu.some((v, j) => room.H + j !== except && v === c);
  function resolveChars(room) { // 사람 자리 캐릭터 + CPU(자동 = 남은 캐릭터 중 서버 무작위. 양쪽 무작위가 달라지지 않게 서버가 정해 보낸다)
    const chars = room.players.map(p => p.char).concat(room.cpu);
    for (let i = 0; i < chars.length; i++) if (chars[i] < 0) { const free = []; for (let c = 0; c < CHARS; c++) if (!chars.includes(c)) free.push(c); chars[i] = free[crypto.randomInt(free.length)]; }
    return chars;
  }

  // 핑 3회 → 지연 프레임 결정 → 시작
  const sameBuild = room => { const b = room.players[0].build; return !!b && room.players.every(p => p.build === b); };
  function buildBad(room) { cast(room, { t: 'err', code: 'build', msg: '양쪽 엔진·ROM·시작 상태 지문이 다릅니다' }); for (const p of room.players) if (p) p.ready = false; peers(room); }
  // 방장 시작 방(analysis/25) = 일반 자리 방(래더 제외). 자동 시작 없음: 방장 start{build} → count → 핑 → start{cfg}. 래더 방·종전 방은 자동 시작(종전 그대로)
  //   NK_ROOM_HOST_START=0(또는 createServer({ roomHostStart: false })) = 종전 자동 시작으로 되돌림(시작 버튼 없는 구 클라이언트용 임시 스위치. count 를 보내지 않고 start{build} 는 err state).
  //   스위치 0 에서도 대기 중 이탈은 자리 당기기·방장 승계 그대로(구 클라이언트 web/ui_manga.js 'room' 처리가 net.room 을 새 you 로 바꿔 다시 그린다)
  const roomHostStart = opt.roomHostStart !== undefined ? !!opt.roomHostStart : process.env.NK_ROOM_HOST_START !== '0';
  const hostStart = room => roomHostStart && !!room.seats && !room.ladder;
  const counting = room => !!(room.count || room.starting);
  // 시작 조건 미충족 이유(null = 시작 가능). 방장 시작 방은 방장 ready 불필요(지문은 start.build). seats = 해당 자리 번호들
  function notStartable(room) {
    const ps = room.players, hs = hostStart(room), bad = f => { const a = []; ps.forEach((p, i) => { if (f(p, i)) a.push(i); }); return a; };
    let s;
    if ((s = bad(p => !p)).length) return { why: 'seat_empty', seats: s };
    if ((s = bad(p => !p.ws)).length) return { why: 'offline', seats: s };
    if (room.seats && (s = bad(p => p.char < 0)).length) return { why: 'nochar', seats: s };
    if ((s = bad((p, i) => !(hs && i === 0) && !p.ready)).length) return { why: 'not_ready', seats: s };
    if (!sameBuild(room)) return { why: 'build', seats: bad(p => p.build !== ps[0].build) };
    return null;
  }
  // 카운트다운·핑 단계 취소 → 전원 count{cancel, why}. 취소했으면 true
  function cancelCount(room, why) {
    if (!counting(room)) return false;
    clearTimeout(room.count); room.count = null;
    if (room.startIv) { clearInterval(room.startIv); room.startIv = null; } room.starting = false;
    if (hostStart(room)) cast(room, { t: 'count', cancel: true, why }); log('시작 취소', room.code, why); // 자동 시작 방(스위치 0)은 count 를 보내지 않는다(종전처럼 조용히 중단)
    return true;
  }
  function tryStart(room) {
    if (room.state !== 'lobby' || room.starting || hostStart(room)) return; // 방장 시작 방은 start 메시지로만 시작한다
    if (!room.players.every(p => p && p.ready && p.ws)) return;
    if (room.seats && room.players.some(p => p.char < 0)) return;
    if (!sameBuild(room)) return buildBad(room);
    launch(room);
  }
  function launch(room) { // 핑 3회 → 지연 결정 → start{cfg}(자동 시작·방장 시작 공통)
    room.starting = true;
    for (const p of room.players) { p.rtt = []; p.pings.clear(); }
    let n = 0;
    const shot = () => { for (const p of room.players) { const id = crypto.randomInt(1 << 30); p.pings.set(id, process.hrtime.bigint()); send(p.ws, { t: 'ping', id }); } };
    const hs = hostStart(room);
    const iv = room.startIv = setInterval(() => {
      if (!rooms.has(room.code) || room.state !== 'lobby' || room.players.some((p, i) => !p || !p.ws || (!p.ready && !(hs && i === 0)))) { clearInterval(iv); room.startIv = null; room.starting = false; if (hs && rooms.has(room.code) && room.state === 'lobby') cast(room, { t: 'count', cancel: true, why: 'unready' }); return; }
      const done = room.players.every(p => p.rtt.length >= 3);
      if (!done && n < 3) { n++; return shot(); }
      if (!done && ++n < 3 + 20) return; // 응답 대기(최대 1초)
      clearInterval(iv); room.startIv = null; room.starting = false;
      if (!sameBuild(room)) { if (hs) cast(room, { t: 'count', cancel: true, why: 'build' }); return buildBad(room); } // 핑을 재는 동안 지문이 바뀌었으면 시작하지 않는다
      const med = p => { const s = p.rtt.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 150; }; // 응답 없으면 150ms 로 가정
      const rtt = room.players.map(med), top = rtt.slice().sort((x, y) => y - x);
      // 내 입력이 상대에게 닿는 시간 = (내 왕복 + 상대 왕복) / 2 → 가장 느린 두 자리로 잰다(H = 2 면 종전 식과 같다). 여유 2프레임(표본화 1 + 흔들림 1). 모두 같은 값(공정성)
      const auto = Math.max(2, Math.min(12, Math.ceil((top[0] + (top.length > 1 ? top[1] : top[0])) / 2 / FRAME_MS) + 2));
      room.cfg = { proto: PROTO, delay: room.opts.delay || auto, lead: LEAD, hashEvery: HASH_EVERY, view: room.opts.view, state: room.opts.state, mode: room.opts.mode, rtt: rtt.map(v => Math.round(v)), humans: room.H };
      let prefill = 0;
      if (room.seats) { // 대기방에서 고른 값 → 양쪽이 똑같이 돌릴 구동 계획(battle_full, 형식 = web/ui_manga.js addPlan 의 설정)
        const chars = resolveChars(room); prefill = prefillN;
        // 랜덤(-1) 스테이지·룰은 여기서 서버가 한 번만 정한다(모든 클라이언트가 같은 cfg 를 받는다. analysis/25). cfg.stage 0~6·rule 1~4 정수 형식은 그대로
        const stage = room.opts.stage < 0 ? crypto.randomInt(7) : room.opts.stage, rule = room.opts.rule < 0 ? 1 + crypto.randomInt(4) : room.opts.rule;
        Object.assign(room.cfg, { prefill, chars, stage, rule,
          plan: { mode: 'battle_full', opt: { players: room.H, edit: false, p1: cell(chars[0]), p2: cell(chars[1]), enemies: chars.slice(room.H).map(cell), stage, rule, fast: true } } });
        // 사람 3·4명: 사람 캐릭터 전부를 자리 순서로 싣는다(humans[H]). 2인은 종전 형식 그대로(p1·p2 만). 원작 흐름·구동 단계 = analysis/17 2절(시제품 analysis/ui_rework/plan_proto4.js)
        if (room.H > 2) room.cfg.plan.opt.humans = chars.slice(0, room.H).map(cell);
      }
      room.state = 'playing'; room.conf = 0; room.log = []; room.adv = room.startAt = Date.now(); resetWin(room, room.adv); stats.started++;
      clearTimeout(room.ttl);
      cast(room, { t: 'start', cfg: room.cfg });
      if (prefill) { // 앞 prefill 프레임은 입력 0 으로 한 번에 확정(구동 계획 구간 = 구동기 값이 덮어쓴다). 멈춤 감시는 1배속으로 돌아도 끝날 시간만큼 미룬다
        for (let f = 0; f < prefill; f += MAX_BATCH) cast(room, { t: 'f', f, p: new Array(Math.min(MAX_BATCH, prefill - f) * room.H).fill(0) });
        room.log = new Array(prefill * room.H).fill(0); room.conf = prefill; stats.frames += prefill; room.adv = Date.now() + prefill * FRAME_MS; resetWin(room, room.adv);
      }
      lobbyDirty();
      log('대전 시작', room.code, '지연', room.cfg.delay, 'rtt', room.cfg.rtt.join('/'), prefill ? '미리 확정 ' + prefill : '');
    }, 50);
    n = 1; shot();
  }
  // 사람 H 명의 입력이 모인 프레임을 차례로 확정해 보낸다(f.p = 프레임마다 자리 0..H-1 순서)
  function confirm(room) {
    const ps = room.players, H = room.H, start = room.conf, out = [];
    while (room.conf < MAX_FRAMES && ps.every(p => p.gone || p.ins[room.conf] !== undefined)) { // 빠진 자리(gone, H >= 3)는 기다리지 않고 0
      const f = room.conf;
      for (const p of ps) { const v = f < LEAD || p.gone ? 0 : p.ins[f]; room.log.push(v); out.push(v); p.ins[f] = 0; } // 확정 뒤 원본은 필요 없다(중복 판정용으로 값만 남김)
      room.conf++;
      if (out.length >= MAX_BATCH * H) cast(room, { t: 'f', f: room.conf - out.length / H, p: out.splice(0) });
    }
    if (out.length) cast(room, { t: 'f', f: room.conf - out.length / H, p: out });
    stats.frames += room.conf - start; if (room.conf > start) room.adv = Date.now();
    if (room.conf >= MAX_FRAMES) endRoom(room, { reason: 'timeout' });
  }
  // 자리 방 대기 중 이탈(analysis/25): 카운트다운 취소 → 뒤 사람을 앞자리로 당긴다(방장 = 항상 자리 0, 사람은 앞자리부터). 자리가 바뀐 사람에게 room{moved, from} 재송신(토큰·캐릭터·준비는 사람을 따라간다).
  //   사람 0명 = 방 닫기. 방장이 나가면 다음 사람이 방장(전원 준비 해제). 대전 중(playing) 규칙은 giveUp/gone 그대로
  function seatLeave(room, slot, p, why) {
    cancelCount(room, why);
    const rest = room.players.filter((x, i) => x && i !== slot);
    if (!rest.length) return closeRoom(room, '사람 없음');
    // 랭크 방은 계정만 연다(create 불변식): 승계할 사람이 손님이면 대기 중 방을 닫는다(구 클라이언트도 아는 host_left + why)
    if (slot === 0 && room.opts.ranked && !rest[0].acct) { cast(room, { t: 'end', reason: 'host_left', why: 'ranked_guest' }); return closeRoom(room, '랭크 방 방장 나감(승계 대상 손님)'); }
    const ps = rest.slice(); while (ps.length < room.H) ps.push(null);
    room.players = ps;
    const changes = [{ who: p.name, key: 'left', value: slot }];
    if (slot === 0) { for (const x of rest) x.ready = false; room.ip = rest[0].ws ? rest[0].ws.ip : room.ip; changes.push({ who: rest[0].name, key: 'host', value: 0 }); log('방장 승계', room.code); }
    ps.forEach((x, i) => { if (x && x.ws && x.ws.slot !== i) { const from = x.ws.slot; x.ws.slot = i; sendRoom(x.ws, room, i, { moved: true, from }); } });
    peers(room, changes); lobbyDirty();
  }
  function onDrop(ws, why) {
    const room = ws.room, slot = ws.slot; if (!room) return;
    const p = room.players[slot]; detach(ws);
    if (!p || p.ws !== ws) return; // 이미 재접속으로 교체됨
    p.ws = null;
    if (room.state === 'lobby') {
      if (room.ladder) { ladderCancelHit(p); cast(room, { t: 'end', reason: 'ladder_cancel' }); return closeRoom(room, '래더 방 취소'); } // 래더 방: 시작 전 한 사람이 나가면 해산(레이팅 벌점 없음, 다시 ladder_join. 나간 쪽은 취소 횟수 셈 → ladderCancelHit)
      if (room.seats) return seatLeave(room, slot, p, why === 'leave' ? 'leave' : 'drop'); // 자리 방: 방장 승계 + 자리 당기기(analysis/25)
      if (slot === 0) { cast(room, { t: 'end', reason: 'host_left' }); return closeRoom(room, '방장 나감'); } // 종전 방(seats 없음)은 종전 그대로
      room.players[slot] = null; room.players[0].ready = false; peers(room); return lobbyDirty();
    }
    if (room.state === 'playing') {
      if (++p.drops > maxDrops) return giveUp(room, slot, 'drops'); // 끊고 대기 시간 끝에 돌아오기를 되풀이해 판을 끄는 것 방지
      cast(room, Object.assign({ t: 'peer', ev: 'drop', slot, grace: graceMs }, why ? { why } : null));
      p.dropTimer = setTimeout(() => giveUp(room, slot, 'disconnect'), graceMs);
    }
  }
  // 감시(주기 실행, 부록 D.2). 한쪽이 끊겨 재접속을 기다리는 동안은 grace 타이머가 맡는다(결과 대기 중이어도 이탈 판정이 먼저). 결과 대기 중에도 멈춤 감시는 돈다.
  //   (가) 정지: 확정 프레임이 stallMs 동안 안 나가면 그 프레임의 입력을 안 낸 쪽을 끊김으로 처리한다(소켓은 살아 있지만 멈춘 상대).
  //   (나) 느린 진행: stallMs 창 동안 확정 프레임 수가 1배속 기대치 × stallRate 미만이면, 그 창의 절반 이상 확정을 막고 있던 자리를 같은 방식으로 처리한다(조금씩만 보내 판을 끄는 것 방지).
  //   모두가 막고 있었으면 승자 없이 종료. 같은 자리 MAX_STALLS 번째는 바로 기권. 실시간 상한(matchMaxMs)을 넘으면 timeout.
  //   한쪽만 결과를 낸 채 resultWaitMs 가 지나면 endResult(임시 채택 규칙)
  function watch() {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      if (room.state !== 'playing') continue;
      if (now - room.startAt >= matchMaxMs) { endRoom(room, { reason: 'timeout', why: 'time' }); continue; }
      if (room.players.some(p => !p.gone && !p.ws)) continue;
      blame(room, now);
      const late = []; let why = 'stall';
      if (now - room.adv >= stallMs) { room.players.forEach((p, i) => { if (!p.gone && p.ins[room.conf] === undefined) late.push(i); }); if (!late.length) room.adv = now; }
      else if (stallRate > 0 && now - room.winAt >= stallMs) {
        const el = now - room.winAt;
        if (room.conf - room.winConf < el / FRAME_MS * stallRate) { why = 'slow'; room.players.forEach((p, i) => { if (!p.gone && p.wait >= el / 2) late.push(i); }); }
        resetWin(room, now);
      }
      if (!late.length) { if (room.results.some(Boolean) && now - room.resultAt >= resultWaitMs) endResult(room); continue; } // 멈춤 판정이 먼저, 없으면 한쪽 결과 대기 끝
      if (late.length === activeSlots(room).length) { endRoom(room, { reason: 'stall', why }); continue; } // (남은 사람) 모두 멈춤 = 승자 없이 종료
      const slot = late[0], p = room.players[slot], ws = p.ws;
      if (++p.stalls >= MAX_STALLS) { if (room.H > 2) err(ws, 'stall', '입력이 오지 않아 판에서 빠집니다'); giveUp(room, slot, why); continue; } // why = 'stall'(멈춤) | 'slow'(느린 진행)
      err(ws, 'stall', '입력이 오지 않아 연결을 끊습니다'); onDrop(ws, why); ws.terminate(); log(why === 'slow' ? '느린 진행 감지' : '멈춤 감지', room.code, '자리', slot);
    }
    for (const [ip, a] of fails) if (now - a[a.length - 1] >= 60000) fails.delete(ip);
    for (const [ip, a] of authHits) if (now - a[a.length - 1] >= 60000) authHits.delete(ip);
    for (const [k, a] of storyHits) if (now - a[a.length - 1] >= 60000) storyHits.delete(k);
    for (const [ip, a] of profIpHits) if (now - a[a.length - 1] >= 60000) profIpHits.delete(ip);
    for (const [k, c] of profCache) if (now - c.t >= PROF_CACHE_MS) profCache.delete(k);
  }
  const watchIv = setInterval(watch, Math.max(50, Math.min(1000, Math.min(stallMs, resultWaitMs) / 4))); watchIv.unref();
  // 웹소켓 핑: 한 주기 동안 pong 이 없으면 끊는다(FIN 없이 사라진 상대). close 이벤트 → onDrop → grace → 기권
  const pingIv = setInterval(() => { for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) { /* 닫히는 중 */ } } }, pingMs); pingIv.unref();
  // 자리 방에서 대기 중(시작 단계 아님)인지 확인
  const lobbyRoom = ws => { const room = ws.room; if (!room || room.state !== 'lobby' || !room.seats) { err(ws, 'state', '대기 중인 방이 아닙니다'); return null; } if (counting(room)) { err(ws, 'state', '시작하는 중에는 바꿀 수 없습니다'); return null; } return room; }; // 카운트다운·핑 단계 = state 거절

  // ---------- 계정(analysis/22 2절) ----------
  // 이름 규칙 = hello 와 같다(2~8자, NFC, 한글·영숫자·공백·_ . ! ? -, 다른 글자가 있으면 거절). 반환 { name, key } | null
  const nameOf = v => { const raw = nfc(str(v, 64)).replace(/ +/g, ' ').trim(), name = clean(raw, 64); return name === raw && name.length >= NAME_MIN && name.length <= NAME_MAX ? { name, key: name.toLowerCase() } : null; };
  const authLimited = ws => { const a = (authHits.get(ws.ip) || []).filter(t => Date.now() - t < 60000); a.push(Date.now()); authHits.set(ws.ip, a); return a.length > authPerMin; };
  const authPerMin = num('authPerMin', 'MAX_AUTH_PER_MIN', 10);
  const helloLimited = ws => { // IP당 분당 이름 hello. 표가 커지면 지난 기록을 한 번 쓸어 낸다
    const t = Date.now(), a = (helloHits.get(ws.ip) || []).filter(x => t - x < 60000); a.push(t); helloHits.set(ws.ip, a);
    if (helloHits.size > 10000) for (const [k, v] of helloHits) if (!v.length || t - v[v.length - 1] >= 60000) helloHits.delete(k);
    return a.length > helloPerMin;
  };
  const dropSess = ws => { const o = ws.sess; ws.sess = null; if (o && o.ws === ws) { o.ws = null; releaseSess(o); } };
  // 소켓 ws 를 계정 세션으로 묶는다. 같은 계정 세션이 있으면 그것을 넘겨받는다(앞 소켓 = err replaced + 4002. 방 소속은 종전 hello 처럼 방 토큰 rejoin 으로 되찾는다)
  function bindAcct(ws, acct, token) {
    const key = acct.key, name = acct.nick;
    if (ws.sess && ws.sess.key !== key) dropSess(ws);
    let s = names.get(key);
    if (s && !s.acct && s !== ws.sess) { const gw = s.ws; releaseSess(s); if (gw) { gw.sess = null; err(gw, 'name_registered', '가입된 이름이라 손님으로 쓸 수 없습니다'); } s = null; } // 경합으로 손님이 잡고 있던 이름
    if (!s) { s = { sid: crypto.randomBytes(16).toString('hex'), name, key, ws: null, timer: null }; sids.set(s.sid, s); }
    s.acct = { key, nick: name }; s.name = name; s.key = key; s.tok = token; names.set(key, s); clearTimeout(s.timer); s.timer = null;
    const old = s.ws; s.ws = ws; ws.sess = s;
    if (old && old !== ws) { old.sess = null; err(old, 'replaced', '다른 창에서 같은 계정으로 접속했습니다'); try { old.close(4002, 'replaced'); } catch (e) { /* 무시 */ } }
    armIdle(ws);
    let unl = null; // 로그인 일자 기록·보상 판정(서버 시각). 오류는 로그인을 막지 않는다
    if (profile) { try { const u = profile.onLogin(key); if (u.length) unl = u; } catch (e) { log('보상 판정 오류', e && e.message); } }
    send(ws, Object.assign({ t: 'welcome', proto: PROTO, sid: s.sid, name, account: true, token }, unl ? { unlocked: unl } : null));
  }
  const acctOff = ws => { if (accts) return false; err(ws, 'acct_off', '계정 기능이 꺼져 있습니다'); return true; };
  const pre = (ws, m) => { // register·login 공통 앞 검사. 통과하면 { name, key, pw }
    if (acctOff(ws)) return null;
    if (ws.room) { err(ws, 'state', '방 안에서는 할 수 없습니다'); return null; }
    if (authLimited(ws)) { err(ws, 'rate', '잠시 뒤에 다시 시도하세요'); return null; }
    const n = nameOf(m.name); if (!n) { err(ws, 'name_bad', '이름은 2~8자(한글·영문·숫자)로 정해 주세요'); return null; }
    return n;
  };

  // ---------- 스토리 이어하기(analysis/21 13절) ----------
  // 계정 세션만. 잠금 = 계정 키 → { slot, base(서버가 기대하는 base 문자열 'boot'|snap_hash), gz(재현 기준 스냅샷, boot 면 null), from(기준 절대 프레임),
  //   expect(이 슬롯의 지금 DB snap_hash. 저장 때 비교 후 교체), anchorF/anchorAt(구간 실시간 검사 기준, begin·저장 성공 때 다시 잡음), segAt(보낸 구간 받은 시각), busy(재현 중), name(한글 이름, 표시용) }.
  //   잠금은 연결이 아니라 계정에 묶는다(끊겼다 다시 붙은 같은 계정이 같은 base 로 이어 보낼 수 있다. 같은 계정 연결은 하나뿐 = 세션 넘겨받기).
  const storyLocks = new Map(), storyQ = [], storyHits = new Map(), storyPace = new Map(); let storyRun = 0; // storyPace = 계정 키 → { d, t }(누적 검사 빚, server/story_pace.js. 잠금이 바뀌어도 남음)
  const storyAcct = ws => {
    if (acctOff(ws)) return null;
    if (!ws.sess || !ws.sess.acct) { err(ws, 'acct_required', '로그인해야 저장할 수 있습니다'); return null; }
    if (ws.room) { err(ws, 'state', '방 안에서는 할 수 없습니다'); return null; }
    return ws.sess.acct;
  };
  const storySlotOk = (ws, v) => { if (Number.isInteger(v) && v >= 0 && v <= 2) return true; err(ws, 'save_bad', '슬롯 번호 오류(0~2)'); return false; };
  const storyBuildOk = (ws, m) => { const I = RS.ids(); if (m.eng === I.eng && m.rec === RS.REC) return true; send(ws, { t: 'err', code: 'save_build', msg: '버전이 달라 저장할 수 없습니다. 새로 고침하세요', eng: I.eng, rec: RS.REC }); return false; };
  const nameKo = v => clean(nfc(str(v, 32)), 8);
  function slotView(r, I) {
    let kana = []; try { kana = JSON.parse(r.name_kana); } catch (e) { /* 빈 값 */ }
    const usable = r.fmt === SN.FMT && r.rom === I.rom;
    return Object.assign({ slot: r.slot, empty: false, seq: r.seq, kind: r.kind, done: !!r.done, players: r.players, match: r.match, wins: r.wins, losses: r.losses, rule: r.rule, level: r.level,
      name: r.name_ko, nameKana: kana, frame: r.frame, updatedAt: r.updated_at, usable, engMatch: r.eng === I.eng }, usable ? null : { why: r.fmt !== SN.FMT ? 'save_old' : 'save_rom' });
  }
  function storyPump() {
    while (storyRun < storyWorkers && storyQ.length) {
      const it = storyQ.shift(); storyRun++;
      RS.runInWorker(it.job, { timeoutMs: storyTimeoutMs }).catch(e => ({ ok: false, code: 'save_desync', why: 'worker: ' + (e && e.message) }))
        .then(r => { storyRun--; try { it.done(r); } catch (e) { log('이어하기 처리 오류', e && e.message); } storyPump(); });
    }
  }
  // 재현 결과 반영. 저장 지점이 있으면 슬롯 갱신(비교 후 교체) + 잠금의 base 를 새 스냅샷으로 옮긴다
  function storyDone(ws, key, lock, m, r) {
    lock.busy = false;
    if (storyLocks.get(key) !== lock) return; // 그 사이 삭제됨
    if (!r.ok) { log('이어하기 거절', r.code, r.why); return send(ws, Object.assign({ t: 'err', code: r.code, msg: r.code === 'save_desync' ? '저장 실패 — 진행 기록이 서버 재현과 다릅니다' : r.code === 'replay_timeout' ? '저장 실패 — 서버가 바쁩니다' : '저장 실패' }, r.code === 'save_desync' ? { why: String(r.why || '').slice(0, 40) } : null)); }
    if (!r.checkpoint) return send(ws, { t: 'story_saved', slot: lock.slot, saved: false, base: lock.base, from: lock.from, frames: r.frames });
    const c = r.checkpoint, I = RS.ids();
    const seq = stories.put(key, lock.slot, lock.expect, { fmt: SN.FMT, rom: I.rom, eng: I.eng, snap: c.gz, snapHash: c.snapHash, frame: c.frame, kind: c.kind, meta: c.meta, nameKo: lock.name, done: c.done });
    if (seq === null) { storyLocks.delete(key); return send(ws, { t: 'err', code: 'save_stale', msg: '다른 기기에서 슬롯이 바뀌었습니다' }); }
    PACE.paceCommit(lock, storyPace.get(key), c.frame, lock.segAt, storyPaceCfg); // 구간 기준 다시 잡기 + 누적 빚 반영(21 문서 13.8)
    Object.assign(lock, { base: c.snapHash, gz: c.gz, from: c.frame, expect: c.snapHash });
    const mt = c.meta; let unl = null; // 보상 판정(스토리 첫 승·우승). 오류는 저장 응답을 막지 않는다
    if (profile) { try { const u = profile.onStory(key, { done: !!c.done, wins: mt.wins, snapHash: c.snapHash }); if (u.length) unl = u; } catch (e) { log('보상 판정 오류', e && e.message); } }
    send(ws, Object.assign({ t: 'story_saved', slot: lock.slot, saved: true, seq, base: c.snapHash, from: c.frame, kind: c.kind, done: c.done, frames: r.frames,
      players: mt.players, match: mt.match, wins: mt.wins, losses: mt.losses, rule: mt.rule, level: mt.level }, unl ? { unlocked: unl } : null));
  }

  // ---------- 방 열기(create·래더 공통) ----------
  // 방을 만들고 ws 를 자리 0 에 앉힌다. ranked = 랭크 방(사람 2 + CPU 자동 2, 스테이지·룰 고정 RANK.rules). ladder = { startBy } 이면 래더 방(목록 제외·참가 불가·한 판)
  function openRoom(ws, code, rawOpts, seats, ranked, name, title, ladder) {
    const opts = cleanOpts(rawOpts, seats); // 사람 자리 수: 자리 방 = opts.humans(2·3·4, 기본 2), 종전 방 = 2
    if (ranked) Object.assign(opts, RANK.rules, { ranked: true }, ladder ? { ladder: true } : null);
    const nH = seats ? opts.humans : HUMANS;
    const players = new Array(nH).fill(null); players[0] = mkPlayer(ws, name);
    const room = { code, ip: ws.ip, adv: 0, startAt: 0, winAt: 0, winConf: 0, blameAt: 0, resultAt: 0, state: 'lobby', opts, H: nH, players, cfg: null, conf: 0, log: [], hashes: new Map(), results: new Array(nH).fill(null), desync: -1, starting: false, ttl: null,
      seats, title, cpu: new Array(SEATS - nH).fill(-1), ladder };
    // 대기방 시간 제한: 일반 = LOBBY_TTL(30분) idle, 래더 = startBy(매칭 뒤 120초) ladder_timeout(벌점 없음). 시작하면 tryStart 가 지운다
    room.ttl = ladder ? setTimeout(() => { cast(room, { t: 'end', reason: 'ladder_timeout' }); closeRoom(room, '래더 시작 시간 초과'); }, Math.max(0, ladder.startBy - Date.now()))
      : setTimeout(() => { cast(room, { t: 'end', reason: 'idle' }); closeRoom(room, '대기 시간 초과'); }, LOBBY_TTL);
    rooms.set(code, room); stats.rooms++; attach(ws, room, 0); sendRoom(ws, room, 0); log(ladder ? '래더 방 생성' : '방 생성', code); lobbyDirty();
    return room;
  }
  function seatIn(ws, room, slot, name) { room.players[slot] = mkPlayer(ws, name); attach(ws, room, slot); sendRoom(ws, room, slot); peers(room); lobbyDirty(); }

  // ---------- 래더 대기열(analysis/22 10.3절) ----------
  // 줄 = 계정 키 → { key, nick, rating, at, ws, last(마지막으로 보낸 window·waiting) }. 짝 찾기 = 줄 설 때 1회 + tickMs 마다.
  //   hard(절대 안 짝지음) = 같은 IP(ipKey. rankAllowSameIp 면 허용 — 짝지어도 SAME_IP 미반영이라 의미 없음).
  //   soft(다른 후보가 없고 먼저 선 쪽이 60초 넘게 기다렸을 때만) = 같은 상대 24시간 반영 3판(PAIR_LIMIT)·바로 앞 래더 상대(연속 매칭 방지)
  const ladderQ = new LadderQueue(), ladderLast = new Map(); // 계정 키 → { opp: 바로 앞 래더 상대 키, at }(메모리, 재시작 때 비움. LADDER_LAST_MS 지나면 틱에서 정리)
  const LADDER_LAST_MS = 24 * 3600 * 1000;
  const ladderCancels = new Map(); // 계정 키 → { hits: [시작 전 이탈 시각], until: 래더 참가 잠금 끝 }(메모리). RANK.ladderCancel 기준
  const ladderStartMs = opt.ladderStartMs !== undefined ? opt.ladderStartMs : RANK.ladderStartSec * 1000;
  const ladderLimited = ws => { const now = Date.now(); ws.ladHits = (ws.ladHits || []).filter(t => now - t < 60000); ws.ladHits.push(now); return ws.ladHits.length > 30; };
  // 래더 방 시작 전 이탈(ladder_cancel) 기록: 상대를 본 뒤 공짜로 피하는 것 방지. windowMs 안 max 회째 = lockMs 동안 ladder_join 거절(ranked_locked)
  function ladderCancelHit(p) {
    if (!p || !p.acct) return;
    const C = RANK.ladderCancel, now = Date.now(), c = ladderCancels.get(p.acct.key) || { hits: [], until: 0 };
    c.hits = c.hits.filter(t => now - t < C.windowMs); c.hits.push(now);
    if (c.hits.length >= C.max) { c.until = now + C.lockMs; c.hits = []; log('래더 취소 잠금', p.acct.key); }
    ladderCancels.set(p.acct.key, c);
  }
  const ladderCancelUntil = key => { const c = ladderCancels.get(key); return c && c.until > Date.now() ? c.until : 0; };
  // 표시용 배치 판수(placementGames) = 순위표·티어 기준 boardMinGames(5). K 48 구간(RANK.placementGames 10)은 kBoostGames 로 따로 보낸다
  const ladderConfig = () => ({ tierBounds: RANK.tierBounds, tierDemoteBuffer: RANK.tierDemoteBuffer, placementGames: RANK.boardMinGames, kBoostGames: RANK.placementGames, master: RANK.master, queue: RANK.queue, rules: RANK.rules,
    pairLimit: RANK.pairLimit, inactiveDays: RANK.inactiveDays, seasonDays: RANK.seasonDays, seasonResetFactor: RANK.seasonResetFactor, startSec: Math.round(ladderStartMs / 1000) });
  const ladderQueueMsg = (e, now) => { const w = ladderQ.window(e, now); return { queued: true, since: e.at, waitSec: Math.floor((now - e.at) / 1000), window: Number.isFinite(w) ? w : null, rating: e.rating, waiting: ladderQ.size, serverTime: now }; };
  function ladderPush(e, now, force) { // 상태(허용 차·줄 인원)가 바뀌었을 때만 다시 보낸다
    const m = ladderQueueMsg(e, now), sig = m.window + '/' + m.waiting;
    if (!force && e.last === sig) return; e.last = sig; send(e.ws, Object.assign({ t: 'ladder_queue' }, m));
  }
  // ws 의 줄 빼기. reason: cancel·logout·room = 알림, disconnect = 알림 없음. 빠졌으면 true
  function ladderDrop(ws, reason) {
    const key = ws.sess && ws.sess.acct ? ws.sess.acct.key : null; let e = key ? ladderQ.get(key) : null;
    if (!e || e.ws !== ws) { e = ladderQ.values().find(x => x.ws === ws) || null; if (!e) return false; }
    ladderQ.leave(e.key);
    if (reason !== 'disconnect') send(ws, { t: 'ladder_queue', queued: false, reason });
    return true;
  }
  const liveQ = e => e.ws && e.ws.readyState === 1 && !e.ws.room && e.ws.sess && e.ws.sess.acct && e.ws.sess.acct.key === e.key;
  let ladderSweepAt = 0;
  function ladderSweep(now) { // 메모리 표 정리(1분마다): 24시간 지난 바로 앞 상대·창이 지난 취소 기록
    if (now - ladderSweepAt < 60000) return; ladderSweepAt = now;
    for (const [k, v] of ladderLast) if (now - v.at > LADDER_LAST_MS) ladderLast.delete(k);
    for (const [k, c] of ladderCancels) if (c.until <= now && !c.hits.some(t => now - t < RANK.ladderCancel.windowMs)) ladderCancels.delete(k);
  }
  const lastOpp = k => { const v = ladderLast.get(k); return v ? v.opp : null; };
  // 주기 실행(setInterval)이라 예외가 밖으로 나가면 프로세스가 죽는다 → 전체를 감싸 로그만 남긴다
  function ladderTick() {
    try {
      if (!ranks) return;
      const now = Date.now(); ladderSweep(now);
      if (!ladderQ.size) return;
      for (const e of ladderQ.values()) if (!liveQ(e)) ladderQ.leave(e.key); // 끊김·세션 바뀜 정리(알림 없음)
      const hard = (a, b) => !rankAllowSameIp && ipKey(a.ws.ip) === ipKey(b.ws.ip);
      const soft = (a, b) => lastOpp(a.key) === b.key || lastOpp(b.key) === a.key || ranks.pairCount(a.key, b.key, now) >= RANK.pairLimit;
      const pairs = ladderQ.match(now, hard, soft);
      for (const { a, b } of pairs) ladderMatch(a, b, now);
      for (const e of ladderQ.values()) ladderPush(e, now, false);
    } catch (e) { log('래더 틱 오류', e && e.message); }
  }
  // 짝 → 랭크 방(먼저 선 사람 = 자리 0 = 방장). 방 번호가 없으면(방 가득) 둘 다 원래 대기 시각으로 되돌린다.
  //   그 밖 오류(DB 등)는 만든 방을 닫고 두 사람에게 ladder_queue{queued:false, reason:'error'}(되풀이 실패 방지로 줄에 다시 넣지 않음). ladder_matched 는 방을 다 만든 뒤에만
  function ladderMatch(a, b, now) {
    const code = rooms.size < MAX_ROOMS ? newCode() : null;
    if (!code) { ladderQ.join(Object.assign(a, { last: null })); ladderQ.join(Object.assign(b, { last: null })); return; }
    let room = null, ma, mb, counted;
    try {
      counted = ranks.pairCount(a.key, b.key, now) < RANK.pairLimit; const startBy = now + ladderStartMs;
      const oppOf = e => { const v = ranks.view(ranks.get(e.key, e.nick), now); return { name: e.nick, rating: v.rating, placement: v.placement, placementLeft: v.placementLeft, tier: v.tier }; };
      ma = { t: 'ladder_matched', code, you: 0, counted, startBy, opp: oppOf(b) }; mb = { t: 'ladder_matched', code, you: 1, counted, startBy, opp: oppOf(a) };
      room = openRoom(a.ws, code, {}, true, true, a.ws.sess.name, '래더 대전', { startBy });
      seatIn(b.ws, room, 1, b.ws.sess.name);
    } catch (e) {
      log('래더 매칭 오류', code, e && e.message);
      if (room) { cast(room, { t: 'end', reason: 'ladder_cancel' }); closeRoom(room, '래더 매칭 오류'); }
      for (const x of [a, b]) send(x.ws, { t: 'ladder_queue', queued: false, reason: 'error' });
      return;
    }
    send(a.ws, ma); send(b.ws, mb);
    ladderLast.set(a.key, { opp: b.key, at: now }); ladderLast.set(b.key, { opp: a.key, at: now });
    log('래더 매칭', code, '차', Math.abs(a.rating - b.rating), counted ? '' : '(PAIR_LIMIT)');
  }
  const ladderIv = setInterval(ladderTick, RANK.queue.tickMs); ladderIv.unref();
  // 시즌 경계 = 서버 시각. 기동 때(RankingStore 생성자) + 60초마다 + 판 기록·조회 때 넘김 검사
  const seasonIv = setInterval(() => { if (!ranks) return; try { const n = ranks.rollSeason(); if (n) log('래더 시즌 넘김', n, '→ 시즌', ranks.season().n); } catch (e) { log('시즌 검사 오류', e && e.message); } }, 60000); seasonIv.unref();
  // 순위표 응답(ladder_board·ranking_list 공통). top 또는 limit(1~50, 생략 50). 손님도 가능(me = null), 소켓당 분당 30회
  function boardReply(ws, m, t) {
    if (acctOff(ws)) return;
    const now = Date.now(); ws.rankHits = (ws.rankHits || []).filter(x => now - x < 60000); ws.rankHits.push(now);
    if (ws.rankHits.length > 30) return err(ws, 'rate', '잠시 뒤에 다시 시도하세요');
    const v = m.top !== undefined ? m.top : m.limit, top = Number.isInteger(v) && v >= 1 && v <= RANK.boardTop ? v : RANK.boardTop, a = ws.sess && ws.sess.acct;
    const b = ranks.board(top, a ? a.key : null, a ? a.nick : null, now);
    send(ws, { t, season: b.season, total: b.total, masterQuota: b.masterQuota, top: b.top, me: b.me });
  }

  const profWriteLimited = (ws, max, k) => { const now = Date.now(), f = 'profW_' + k; ws[f] = (ws[f] || []).filter(x => now - x < 60000); ws[f].push(now); return ws[f].length > max; }; // profile_set·tutorial_done 소켓당 분당 한도(k 별로 따로 센다)
  // 타인 닉네임 조회 방어(analysis/27 P2): IP 당 분당 한도 + 짧은 응답 캐시(TTL 만으로 갱신, 획득·장착 반영은 최대 PROF_CACHE_MS 늦을 수 있다. 쓰기 때는 비운다)
  const profIpMax = (int(opt.profileIpPerMin) > 0 ? int(opt.profileIpPerMin) : 60);
  const profIpLimited = ws => { const now = Date.now(), a = (profIpHits.get(ws.ip) || []).filter(t => now - t < 60000); a.push(now); profIpHits.set(ws.ip, a); return a.length > profIpMax; };
  // 타인에게는 획득 시각(at)·로그인 일수를 숨긴다(활동 패턴 노출 최소화)
  const profPublic = v => { const o = Object.assign({}, v); for (const k of Object.keys(o)) if (Array.isArray(o[k])) o[k] = o[k].map(i => { const c = Object.assign({}, i); delete c.at; return c; }); if (o.stats) { o.stats = Object.assign({}, o.stats); delete o.stats.loginDays; } return o; };

  const H = {
    story_slots(ws) { // 슬롯 3칸 목록 + 서버 지문(클라이언트가 자기 eng 와 미리 비교해 「새로 고침」 안내를 띄울 수 있게)
      const a = storyAcct(ws); if (!a) return;
      const I = RS.ids(), rows = stories.list(a.key);
      const slots = [0, 1, 2].map(i => { const r = rows.find(x => x.slot === i); return r ? slotView(r, I) : { slot: i, empty: true }; });
      send(ws, { t: 'story_slots', fmt: SN.FMT, rom: I.rom, eng: I.eng, rec: RS.REC, maxFrames: RS.MAX_FRAMES, slots });
    },
    story_begin(ws, m) { // 새 게임(new: base = 서버 boot_title) / 이어하기(cont: base = 슬롯 스냅샷, state 를 내려준다). 계정당 잠금 하나(앞 잠금은 교체)
      const a = storyAcct(ws); if (!a) return;
      if (!storySlotOk(ws, m.slot) || !storyBuildOk(ws, m)) return;
      const old = storyLocks.get(a.key); if (old && old.busy) return err(ws, 'save_busy', '저장 처리 중입니다');
      const now = Date.now(), name = nameKo(m.name);
      if (m.mode === 'new') {
        const cur = stories.hashOf(a.key, m.slot);
        if (cur && m.overwrite !== true) return err(ws, 'save_exists', '이미 저장된 슬롯입니다');
        const from = RS.bootState().frameNo;
        storyLocks.set(a.key, { slot: m.slot, base: 'boot', gz: null, from, expect: cur, anchorF: from, anchorAt: now, busy: false, name });
        return send(ws, { t: 'story_begun', slot: m.slot, mode: 'new', base: 'boot', from });
      }
      if (m.mode !== 'cont') return err(ws, 'save_bad', 'mode 는 new|cont');
      const row = stories.get(a.key, m.slot); if (!row) return err(ws, 'save_empty', '빈 슬롯입니다');
      const I = RS.ids(), raw = Buffer.from(row.snap);
      let d; try { d = SN.decode(raw, I); } catch (e) { return err(ws, e.code || 'save_bad', e.code === 'save_old' ? '이전 버전 저장이라 불러올 수 없습니다' : '저장 데이터를 쓸 수 없습니다'); }
      // 다른 엔진 지문으로 만든 스냅샷: 하드웨어 상태라 그대로 불러오되(21 문서 1.4), 재현 기준은 지금 지문으로 다시 묶는다(replay_save 는 base eng 가 다르면 거절)
      let gz = new Uint8Array(raw), base = row.snap_hash;
      if (!d.engMatch) { const g = SN.encode(d.state, I); gz = new Uint8Array(g.buffer, g.byteOffset, g.byteLength); base = SN.sha1(g); }
      const st = d.state; if (!st.wram.some(x => x)) delete st.wram; // 0 뿐이면 빼고 보낸다(엔진이 0 으로 채움)
      storyLocks.set(a.key, { slot: m.slot, base, gz, from: st.frameNo, expect: row.snap_hash, anchorF: st.frameNo, anchorAt: now, busy: false, name: name || row.name_ko });
      let kana = []; try { kana = JSON.parse(row.name_kana); } catch (e) { /* 빈 값 */ }
      send(ws, { t: 'story_begun', slot: m.slot, mode: 'cont', base, from: st.frameNo, state: st, name: row.name_ko, nameKana: kana, slotInfo: slotView(row, I) });
    },
    story_seg(ws, m) { // 구간: base 부터 end.f 까지의 프레임별 패드(rec 1). 서버가 재현해 지문 대조 + 구간 안 마지막 저장 지점을 슬롯에 저장
      const a = storyAcct(ws); if (!a) return;
      const lock = storyLocks.get(a.key);
      if (!lock || lock.slot !== m.slot) return err(ws, 'save_stale', 'story_begin 을 먼저 보내세요');
      if (!storyBuildOk(ws, m)) return;
      if (lock.busy) return err(ws, 'save_busy', '저장 처리 중입니다');
      if (m.base !== lock.base || m.from !== lock.from) return send(ws, { t: 'err', code: 'save_stale', msg: '저장 기준이 바뀌었습니다', base: lock.base, from: lock.from });
      const now = Date.now(), hits = (storyHits.get(a.key) || []).filter(t => now - t < 60000); hits.push(now); storyHits.set(a.key, hits);
      if (hits.length > storySegPerMin) return err(ws, 'rate', '잠시 뒤에 다시 시도하세요');
      let pads, pads2 = null;
      try { pads = RS.decodePads(m.pads); if (m.pads2 != null) pads2 = RS.decodePads(m.pads2); } catch (e) { return err(ws, e.code || 'save_bad', e.code === 'save_too_long' ? '구간이 너무 깁니다' : '입력 기록 형식 오류'); }
      const end = m.end && typeof m.end === 'object' ? { f: int(m.end.f), h: str(m.end.h, 16) } : null;
      if (!end || end.f < 0) return err(ws, 'save_bad', 'end 형식 오류');
      // 실시간 검사(21 문서 5.5·13.8): 구간(기준 = begin·마지막 저장) 경과보다 많이 진행 또는 계정 누적 빚 초과 = 빨리 만든 입력. 여유(storySlackF) = 덮개 아래 빨리 감기 몫
      if (!storyPace.has(a.key)) { if (storyPace.size > 10000) for (const [k, v] of storyPace) if (v.d === 0 || now - v.t > 3600000) storyPace.delete(k); storyPace.set(a.key, { d: 0, t: 0 }); }
      const why = PACE.paceCheck(lock, storyPace.get(a.key), end.f, now, storyPaceCfg);
      if (why) { log('이어하기 거절 save_fast', why, a.key); return err(ws, 'save_fast', '진행 속도가 실시간보다 빠릅니다'); }
      if (storyRun >= storyWorkers && storyQ.length >= storyQueueMax) return err(ws, 'save_busy', '서버가 바쁩니다. 잠시 뒤 다시 시도하세요');
      if (typeof m.name === 'string') lock.name = nameKo(m.name);
      lock.busy = true; lock.segAt = now;
      storyQ.push({ job: { base: lock.gz ? { gz: lock.gz } : { boot: true }, from: lock.from, pads, pads2, end, eng: m.eng, rec: m.rec }, done: r => storyDone(ws, a.key, lock, m, r) });
      storyPump();
    },
    story_delete(ws, m) {
      const a = storyAcct(ws); if (!a) return;
      if (!storySlotOk(ws, m.slot)) return;
      const lock = storyLocks.get(a.key);
      if (lock && lock.slot === m.slot) { if (lock.busy) return err(ws, 'save_busy', '저장 처리 중입니다'); storyLocks.delete(a.key); }
      const n = stories.del(a.key, m.slot);
      send(ws, { t: 'story_deleted', slot: m.slot, deleted: n === 1 });
    },
    async register(ws, m) { // 가입 + 바로 로그인 → welcome{account:true, token}. 같은 이름의 손님 세션(이 소켓)이면 그 세션을 계정으로 올린다
      const n = pre(ws, m); if (!n) return;
      if (!passwordOk(m.pw)) return err(ws, 'pw_bad', '비밀번호는 6~64자로 정해 주세요');
      if (ws.sess && ws.sess.acct) return err(ws, 'state', '이미 로그인했습니다');
      const held = names.get(n.key);
      if ((held && held !== ws.sess) || pendingReg.has(n.key)) return err(ws, 'name_taken', '이미 접속 중인 이름입니다');
      if (accts.has(n.key)) return err(ws, 'acct_exists', '이미 가입된 이름입니다');
      pendingReg.add(n.key); let a;
      try { a = await accts.create(n.key, n.name, m.pw); } finally { pendingReg.delete(n.key); }
      if (!a) return err(ws, 'acct_exists', '이미 가입된 이름입니다');
      log('가입', '(이름 생략)');
      if (ws.readyState !== 1) return;
      if (ws.room) return err(ws, 'state', '가입했습니다. 방에서 나온 뒤 로그인하세요');
      bindAcct(ws, a, accts.issueToken(a.key));
    },
    async login(ws, m) { // 로그인 → welcome{account:true, token}. 틀림·없는 이름 모두 login_failed(구분하지 않음)
      const n = pre(ws, m); if (!n) return;
      if (typeof m.pw !== 'string' || m.pw.length > 256) return err(ws, 'login_failed', '이름 또는 비밀번호가 맞지 않습니다');
      if (guard.locked(n.key, ws.ip)) return err(ws, 'login_locked', '로그인 실패가 많아 잠시 막혔습니다');
      const d = guard.delayMs(n.key); if (d) await new Promise(r => setTimeout(r, d));
      const a = await accts.verify(n.key, m.pw);
      if (!a) { guard.fail(n.key, ws.ip); return err(ws, 'login_failed', '이름 또는 비밀번호가 맞지 않습니다'); }
      guard.success(n.key, ws.ip);
      if (ws.readyState !== 1) return;
      if (ws.room) return err(ws, 'state', '방 안에서는 할 수 없습니다');
      bindAcct(ws, a, accts.issueToken(a.key));
    },
    logout(ws, m) { // 로그인 토큰 폐기 + 세션 종료 → logged_out(연결은 유지, 다시 hello·login 가능). 방 안에서는 거절
      if (!ws.sess || !ws.sess.acct) return err(ws, 'state', '로그인하지 않았습니다');
      if (ws.room) return err(ws, 'state', '방 안에서는 할 수 없습니다');
      ladderDrop(ws, 'logout');
      if (accts) { accts.revokeToken(ws.sess.tok); if (typeof m.token === 'string') accts.revokeToken(m.token); }
      lobbySubs.delete(ws); dropSess(ws); armIdle(ws);
      send(ws, { t: 'logged_out' });
    },
    profile_get(ws, m) { // 프로필(통산 전적·획득·장착·전체 카탈로그). nick 없음 = 나(손님이면 기록 없음·전부 잠금), nick = 그 계정(소켓당 분당 20회). 로그인 필요 없음(analysis/27 P2)
      if (acctOff(ws)) return;
      const a = ws.sess && ws.sess.acct, now = Date.now(); let key = a ? a.key : null, nick = a ? a.nick : null, self = true;
      const hits = ws.profHits = (ws.profHits || []).filter(x => now - x.t < 60000); hits.push({ t: now, o: m.nick !== undefined });
      if (hits.length > 60 || hits.filter(x => x.o).length > 20) return err(ws, 'rate', '잠시 뒤에 다시 시도하세요');
      let body = null;
      if (m.nick !== undefined) {
        const n = nameOf(m.nick); if (!n) return err(ws, 'name_bad', '이름은 2~8자(한글·영문·숫자)로 정해 주세요');
        if (!(a && a.key === n.key)) {
          if (profIpLimited(ws)) return err(ws, 'rate', '잠시 뒤에 다시 시도하세요');
          if (!accts.has(n.key)) return err(ws, 'profile_none', '그런 계정이 없습니다'); key = n.key; self = false;
          const c = profCache.get(key);
          if (c && now - c.t < PROF_CACHE_MS) { nick = c.nick; body = c.body; }
          else { nick = profile.nickOf(key); body = profPublic(profile.view(key)); if (profCache.size >= 500) profCache.clear(); profCache.set(key, { t: now, nick, body }); }
        }
      }
      send(ws, Object.assign({ t: 'profile', self, guest: self && !a, nick, serverTime: now }, body || profile.view(key)));
    },
    profile_set(ws, m) { // 장착 변경: { title?, frame?, portrait_bg?, portrait_stamp? } 값 = 획득한 항목 id | null(해제). 알 수 없는 id·미획득 = profile_bad(아무것도 안 바뀜)
      if (acctOff(ws)) return;
      if (!ws.sess || !ws.sess.acct) return err(ws, 'acct_required', '로그인해야 바꿀 수 있습니다');
      if (profWriteLimited(ws, 20, 'set')) return err(ws, 'rate', '잠시 뒤에 다시 시도하세요');
      const r = profile.setEquipped(ws.sess.acct.key, m); profCache.delete(ws.sess.acct.key);
      if (r.bad) return send(ws, { t: 'err', code: 'profile_bad', why: r.bad, field: r.field, msg: r.bad === 'locked' ? '아직 얻지 못한 항목입니다' : '알 수 없는 항목입니다' });
      send(ws, { t: 'profile_set', equipped: r.equipped });
    },
    tutorial_done(ws) { // 튜토리얼 완료 보고(클라이언트 판정 = src self, 계정당 한 번 「신입 열혈」). 랭킹 표에는 칭호를 노출하지 않는다
      if (acctOff(ws)) return;
      if (!ws.sess || !ws.sess.acct) return err(ws, 'acct_required', '로그인해야 기록할 수 있습니다');
      if (profWriteLimited(ws, 5, 'tut')) return err(ws, 'rate', '잠시 뒤에 다시 시도하세요');
      const un = profile.tutorialDone(ws.sess.acct.key); profCache.delete(ws.sess.acct.key);
      send(ws, { t: 'tutorial_done', unlocked: un });
    },
    challenge_list(ws) { // 일일·주간 도전 목록·진행도(조회 때 서버가 계산, analysis/27 P4b). 로그인 필요
      if (acctOff(ws)) return;
      if (!ws.sess || !ws.sess.acct) return err(ws, 'acct_required', '로그인해야 볼 수 있습니다');
      if (profWriteLimited(ws, 30, 'chl')) return err(ws, 'rate', '잠시 뒤에 다시 시도하세요');
      send(ws, Object.assign({ t: 'challenge_list' }, profile.challenges(ws.sess.acct.key)));
    },
    challenge_claim(ws, m) { // 도전 보상 수령 { id, period? }: 서버가 기간·진행도를 다시 계산. 이미 받았으면 already:true(멱등). 거부 = challenge_bad{why:'unknown'|'expired'|'notyet'}
      if (acctOff(ws)) return;
      if (!ws.sess || !ws.sess.acct) return err(ws, 'acct_required', '로그인해야 받을 수 있습니다');
      if (profWriteLimited(ws, 20, 'chc')) return err(ws, 'rate', '잠시 뒤에 다시 시도하세요');
      const a = ws.sess.acct, r = profile.claim(a.key, m.id, typeof m.period === 'string' ? m.period : undefined); profCache.delete(a.key);
      if (r.bad) return send(ws, { t: 'err', code: 'challenge_bad', why: r.bad, id: typeof m.id === 'string' ? m.id.slice(0, 32) : null, period: r.period || null,
        msg: r.bad === 'notyet' ? '아직 달성하지 못했습니다' : r.bad === 'expired' ? '기간이 지난 도전입니다' : '알 수 없는 도전입니다' });
      send(ws, { t: 'challenge_claim', id: r.id, period: r.period, already: r.already, unlocked: r.unlocked });
    },
    ranking_list(ws, m) { boardReply(ws, m, 'ranking_list'); }, // 종전 이름(내용은 ladder_board 와 같다. 하위 호환 = top·me 필드 유지 + 추가 필드)
    hello(ws, m) { // 이름 등록(가입 없음) / 같은 sid 로 되찾기 / token = 계정 자동 로그인
      if (ws.room) return err(ws, 'state', '방 안에서는 이름을 바꿀 수 없습니다');
      if (m.token !== undefined) { // 계정 로그인 토큰(30일)
        if (acctOff(ws)) return;
        if (authLimited(ws)) return err(ws, 'rate', '잠시 뒤에 다시 시도하세요');
        const a = accts.tokenAccount(m.token); if (!a) return err(ws, 'token_bad', '로그인이 만료되었습니다');
        return bindAcct(ws, a, m.token);
      }
      if (helloLimited(ws)) return err(ws, 'rate', '잠시 뒤에 다시 시도하세요'); // IP당 분당 이름 hello(helloPerMin)
      const raw = nfc(str(m.name, 64)).replace(/ +/g, ' ').trim(), name = clean(raw, 64);
      if (name !== raw || name.length < NAME_MIN || name.length > NAME_MAX) return err(ws, 'name_bad', '이름은 2~8자(한글·영문·숫자)로 정해 주세요');
      const key = name.toLowerCase(), sid = /^[0-9a-f]{32}$/.test(str(m.sid, 64)) ? m.sid : '', held = names.get(key);
      if (held && held.sid !== sid) return err(ws, 'name_taken', '이미 접속 중인 이름입니다');
      if (pendingReg.has(key)) return err(ws, 'name_taken', '이미 접속 중인 이름입니다');
      const own = sid ? sids.get(sid) : null; // 계정 세션의 sid 로 같은 이름 hello = 그 계정 세션 되찾기(대기 시간 안). 그 밖에 가입된 이름은 손님으로 못 쓴다
      if (accts && !(own && own.acct && own.key === key) && accts.has(key)) return err(ws, 'name_registered', '가입된 이름입니다. 로그인하세요');
      if (own && own.acct && own.key !== key) return err(ws, 'state', '로그인한 세션입니다. 로그아웃한 뒤 손님 이름을 쓰세요');
      if (ws.sess && ws.sess.sid !== sid) { const o = ws.sess; ws.sess = null; if (o.ws === ws) { o.ws = null; releaseSess(o); } } // 같은 소켓이 다른 세션 이름으로 바꾸면 앞 세션은 바로 푼다
      let s = sid ? sids.get(sid) : null;
      if (!s) { s = { sid: crypto.randomBytes(16).toString('hex'), name, key, ws: null, timer: null }; sids.set(s.sid, s); } // 모르는 sid(서버 재시작 등)는 새로 만든다
      else if (s.key !== key && names.get(s.key) === s) names.delete(s.key); // 이름 바꿈: 앞 이름은 바로 푼다
      s.name = name; s.key = key; names.set(key, s); clearTimeout(s.timer); s.timer = null;
      const old = s.ws; s.ws = ws; ws.sess = s;
      if (old && old !== ws) { old.sess = null; err(old, 'replaced', '다른 창에서 같은 이름으로 접속했습니다'); try { old.close(4002, 'replaced'); } catch (e) { /* 무시 */ } }
      armIdle(ws);
      send(ws, { t: 'welcome', proto: PROTO, sid: s.sid, name, account: !!s.acct });
    },
    lobby(ws, m) { // 로비 목록 구독(on) / 끊기(on: false)
      if (m.on === false) { lobbySubs.delete(ws); return; }
      if (!ws.sess) return err(ws, 'noname', '이름을 먼저 정해 주세요');
      if (ws.room) return err(ws, 'state', '이미 방에 있습니다');
      lobbySubs.add(ws); // 즉시 응답은 소켓당 LOBBY_MIN_MS 에 1통. 그 안에 다시 오면 남은 시간 뒤 1통으로 미룬다(목록은 빠짐없이 받는다)
      const w = LOBBY_MIN_MS - (Date.now() - (ws.lobAt || 0)), shot = () => { ws.lobTm = null; if (lobbySubs.has(ws)) { ws.lobAt = Date.now(); send(ws, { t: 'rooms', list: roomsList() }); } };
      if (w <= 0) shot(); else if (!ws.lobTm) { ws.lobTm = setTimeout(shot, w); ws.lobTm.unref(); }
    },
    create(ws, m) {
      if (ws.room) return err(ws, 'state', '이미 방에 있습니다');
      if (!ws.sess && !legacyRooms) return err(ws, 'noname', '이름을 먼저 정해 주세요'); // 종전 방(hello 없음)은 LEGACY_ROOMS=1 일 때만
      if (rooms.size >= MAX_ROOMS) return err(ws, 'full', '방이 가득 찼습니다');
      if (roomsOf(ws.ip) >= maxRoomsIp) return err(ws, 'full', '만들 수 있는 방 수를 넘었습니다');
      const code = newCode(); if (!code) return err(ws, 'full', '방 번호를 만들 수 없습니다');
      const seats = !!ws.sess, name = seats ? ws.sess.name : m.name; // 이름을 등록한 소켓 = 자리 4개 방, 아니면 종전 방
      const ranked = !!(m.opts && typeof m.opts === 'object' && m.opts.ranked === true);
      if (ranked) { // 랭크 방(analysis/22 3절): 계정만 만든다. 사람 2 + CPU 자동 2, 스테이지·룰 고정(RANK.rules)
        if (acctOff(ws)) return;
        if (!ws.sess || !ws.sess.acct) return err(ws, 'acct_required', '랭크 방은 로그인해야 만들 수 있습니다');
        const until = ranks.lockedUntil(ws.sess.acct.key); if (until) return send(ws, { t: 'err', code: 'ranked_locked', msg: '기권·분쟁이 많아 잠시 랭크 대전을 할 수 없습니다', until });
      }
      ladderDrop(ws, 'room');
      openRoom(ws, code, m.opts, seats, ranked, name, seats ? (clean(nfc(str(m.title, 64)), TITLE_MAX) || name + '의 방') : '', null);
    },
    // ---------- 래더(analysis/22 10절) ----------
    ladder_join(ws) { // 대기열에 선다(이미 서 있으면 상태만 다시). 계정만
      if (acctOff(ws)) return;
      if (!ws.sess || !ws.sess.acct) return send(ws, { t: 'err', code: 'acct_required', need: 'account', msg: '래더는 가입한 계정만 참가할 수 있습니다' });
      if (ws.room) return err(ws, 'state', '이미 방에 있습니다');
      if (ladderLimited(ws)) return err(ws, 'rate', '잠시 뒤에 다시 시도하세요');
      const a = ws.sess.acct, until = ranks.lockedUntil(a.key);
      if (until) return send(ws, { t: 'err', code: 'ranked_locked', msg: '기권·분쟁이 많아 잠시 랭크 대전을 할 수 없습니다', until });
      const cu = ladderCancelUntil(a.key);
      if (cu) return send(ws, { t: 'err', code: 'ranked_locked', why: 'ladder_cancel', msg: '시작 전 취소가 많아 잠시 래더에 참가할 수 없습니다', until: cu });
      // 같은 계정이 진행 중인 판(다른 창·재접속 대기)에 앉아 있으면 거절(판 도중 줄 서기 방지)
      for (const r of rooms.values()) if (r.state === 'playing' && r.players.some(p => p && !p.gone && p.acct && p.acct.key === a.key)) return err(ws, 'state', '진행 중인 대전이 있습니다');
      const cur = ladderQ.get(a.key);
      if (cur) { cur.ws = ws; return ladderPush(cur, Date.now(), true); }
      const now = Date.now();
      ladderQ.join({ key: a.key, nick: a.nick, rating: ranks.get(a.key, a.nick).rating, at: now, ws, last: null });
      ladderPush(ladderQ.get(a.key), now, true); log('래더 대기', ladderQ.size + '명');
      ladderTick();
    },
    ladder_leave(ws) {
      if (!ladderDrop(ws, 'cancel')) send(ws, { t: 'ladder_queue', queued: false, reason: 'none' });
    },
    ladder_status(ws) { // 시즌·규칙 값·내 상태·대기 상태(손님도 가능, me = null)
      if (acctOff(ws)) return;
      if (ladderLimited(ws)) return err(ws, 'rate', '잠시 뒤에 다시 시도하세요');
      const now = Date.now(), a = ws.sess && ws.sess.acct, b = a ? ranks.board(1, a.key, a.nick, now) : null, e = a ? ladderQ.get(a.key) : null;
      send(ws, { t: 'ladder_status', serverTime: now, season: ranks.season(now), config: ladderConfig(), me: b ? b.me : null, queue: e && e.ws === ws ? ladderQueueMsg(e, now) : { queued: false } });
    },
    ladder_board(ws, m) { boardReply(ws, m, 'ladder_board'); },
    join(ws, m) {
      if (ws.room) return err(ws, 'state', '이미 방에 있습니다');
      if (limited(ws)) return err(ws, 'rate', '잠시 뒤에 다시 시도하세요');
      const room = rooms.get(str(m.code, 8).toUpperCase());
      if (!room) { failed(ws); return err(ws, 'noroom', '없는 방입니다'); }
      if (room.seats && !ws.sess) return err(ws, 'noname', '이름을 먼저 정해 주세요');
      const slot = room.players.findIndex((p, i) => i > 0 && !p);
      if (room.state !== 'lobby' || slot < 0 || room.ladder) return err(ws, 'busy', '들어갈 수 없는 방입니다'); // 래더 방은 서버가 앉힌 두 사람만
      if (room.opts.ranked && ws.sess && ws.sess.acct && ranks) { const until = ranks.lockedUntil(ws.sess.acct.key); if (until) return send(ws, { t: 'err', code: 'ranked_locked', msg: '기권·분쟁이 많아 잠시 랭크 대전을 할 수 없습니다', until }); } // 손님은 입장 가능(레이팅 반영 없음)
      ladderDrop(ws, 'room'); seatIn(ws, room, slot, ws.sess ? ws.sess.name : m.name);
    },
    rejoin(ws, m) {
      if (ws.room) return err(ws, 'state', '이미 방에 있습니다');
      const room = rooms.get(str(m.code, 8).toUpperCase()); const tok = Buffer.from(str(m.token, 64));
      // 바이트 길이가 같을 때만 비교한다(길이가 다르면 timingSafeEqual 이 예외를 낸다)
      const slot = room ? room.players.findIndex(p => { if (!p || p.gone) return false; const pt = Buffer.from(p.token); return tok.length === pt.length && crypto.timingSafeEqual(tok, pt); }) : -1;
      if (slot < 0 || room.state !== 'playing') { if (limited(ws)) return err(ws, 'rate', '잠시 뒤에 다시 시도하세요'); failed(ws); return err(ws, 'norejoin', '재접속할 수 없습니다'); }
      ladderDrop(ws, 'room'); // 토큰이 맞을 때만 줄에서 뺀다(틀린 rejoin 으로 대기가 풀리지 않게)
      const p = room.players[slot], old = p.ws;
      clearTimeout(p.dropTimer); p.dropTimer = null; p.ws = ws; p.ips.add(ipKey(ws.ip)); attach(ws, room, slot); room.adv = Date.now(); resetWin(room, room.adv);
      if (old && old !== ws) { old.room = null; try { old.close(4000, 'replaced'); } catch (e) { /* 무시 */ } }
      // next = 서버가 이 자리에서 끊김 없이 받은 입력 수(클라이언트는 여기부터 다시 보낸다)
      let next = room.conf; while (p.ins[next] !== undefined) next++;
      const lf = room.H > 2 ? { left: goneSlots(room) } : null; // 3·4인 판: 재접속한 사람도 그동안 빠진 자리를 알 수 있게(2인 판 메시지는 종전 그대로)
      sendRoom(ws, room, slot, Object.assign({ resume: true }, lf)); send(ws, Object.assign({ t: 'start', cfg: room.cfg, resume: true, next, conf: room.conf }, lf));
      const have = Math.max(0, Math.min(room.conf, int(m.have)));
      for (let f = have; f < room.conf; f += MAX_BATCH) send(ws, { t: 'f', f, p: room.log.slice(f * room.H, Math.min(room.conf, f + MAX_BATCH) * room.H) });
      cast(room, { t: 'peer', ev: 'back', slot }); log('재접속', room.code, '자리', slot, '재전송', room.conf - have);
    },
    pick(ws, m) { // 내 자리 캐릭터(0~15, -1 = 고르기 취소). 다른 자리(사람·고정 CPU)와 겹치면 거절. 바꾸면 내 준비가 풀린다
      const room = lobbyRoom(ws); if (!room) return;
      const c = m.char === -1 ? -1 : charOk(m.char) ? m.char : null;
      if (c === null) return err(ws, 'bad', '캐릭터 번호 오류');
      if (c >= 0 && usedBy(room, c, ws.slot)) return err(ws, 'char_taken', '이미 고른 캐릭터입니다');
      const p = room.players[ws.slot]; p.char = c; p.ready = false; peers(room);
    },
    set(ws, m) { // 방장: 사람 자리 수(humans 2~4)·스테이지(0~6)·룰(1~4)·CPU 자리 캐릭터(cpu[4 - 사람 수], -1 = 자동). 준 항목만 바꾼다. 바꾸면 모두의 준비가 풀린다
      const room = lobbyRoom(ws); if (!room) return;
      if (ws.slot !== 0) return err(ws, 'host', '방장만 바꿀 수 있습니다');
      if (room.opts.ranked) return err(ws, 'ranked_fixed', '랭크 방은 설정을 바꿀 수 없습니다');
      let { stage, rule } = room.opts, cpu = room.cpu.slice(), nH = room.H;
      if (m.humans !== undefined) { // 자리를 사람 ↔ CPU 로 바꾼다(앞자리부터 사람). 줄일 때 그 자리에 사람이 앉아 있으면 거절. CPU 캐릭터는 자리 번호 기준으로 유지하고 새로 CPU 가 된 자리는 자동(-1)
        if (!humansOk(m.humans)) return err(ws, 'bad', '사람 수 오류');
        if (room.players.some((p, i) => p && i >= m.humans)) return err(ws, 'seat_taken', '그 자리에 사람이 있습니다');
        nH = m.humans; cpu = []; for (let i = nH; i < SEATS; i++) cpu.push(i >= room.H ? room.cpu[i - room.H] : -1);
      }
      if (m.stage !== undefined) { if (!stageOk(m.stage)) return err(ws, 'bad', '스테이지 번호 오류'); stage = m.stage; } // -1 = 랜덤
      if (m.rule !== undefined) { if (!ruleOk(m.rule)) return err(ws, 'bad', '룰 번호 오류'); rule = m.rule; } // -1 = 랜덤
      if (m.cpu !== undefined) { if (!Array.isArray(m.cpu) || m.cpu.length !== SEATS - nH || !m.cpu.every(v => v === -1 || charOk(v))) return err(ws, 'bad', 'CPU 캐릭터 오류'); cpu = m.cpu.slice(); }
      const fixed = cpu.filter(v => v >= 0);
      if (new Set(fixed).size !== fixed.length || fixed.some(v => room.players.some(p => p && p.char === v))) return err(ws, 'char_taken', '이미 고른 캐릭터입니다');
      const who = room.players[0].name, changes = []; // 바뀐 항목(analysis/25): 클라이언트가 「스테이지 5로 변경」 토스트를 띄운다
      if (nH !== room.H) changes.push({ who, key: 'humans', value: nH });
      if (stage !== room.opts.stage) changes.push({ who, key: 'stage', value: stage });
      if (rule !== room.opts.rule) changes.push({ who, key: 'rule', value: rule });
      if (cpu.join() !== room.cpu.join()) changes.push({ who, key: 'cpu', value: cpu.slice() });
      room.opts.stage = stage; room.opts.rule = rule; room.cpu = cpu;
      if (nH !== room.H) { const ps = room.players.slice(0, nH); while (ps.length < nH) ps.push(null); room.players = ps; room.results = new Array(nH).fill(null); room.H = room.opts.humans = nH; }
      if (changes.length) lobbyDirty();
      for (const p of room.players) if (p) p.ready = false;
      peers(room, changes);
    },
    ready(ws, m) {
      const room = ws.room; if (!room || room.state !== 'lobby') return err(ws, 'state', '대기 중인 방이 아닙니다');
      const p = room.players[ws.slot], build = str(m.build, 80), on = m.on !== false;
      if (room.starting && build !== p.build) return err(ws, 'build', '시작하는 중에는 지문을 바꿀 수 없습니다'); // 지문 검사 뒤 바꿔치기 방지
      if (on && room.seats && p.char < 0) return err(ws, 'nochar', '캐릭터를 먼저 고르세요');
      const was = p.ready, wasB = p.build;
      p.ready = on; p.build = build;
      if (hostStart(room) && counting(room) && (wasB !== build || (ws.slot !== 0 && was !== on))) cancelCount(room, 'unready'); // 카운트다운 중 준비 해제·지문 바뀜 = 취소(방장 준비는 시작 조건이 아니다)
      peers(room); tryStart(room);
    },
    start(ws, m) { // 방장 시작(analysis/25, 자리 방만): start{build} → 조건 확인 → 전원 count{ms} → 끝나면 핑 → start{cfg}. start{cancel:true} = 방장 취소
      const room = ws.room;
      if (room && room.state === 'lobby' && room.seats && !room.ladder && !roomHostStart) return err(ws, 'host_start_off', '대기 중인 방이 아닙니다'); // 스위치 0(자동 시작) = 별도 코드(클라이언트가 state 와 구분해 시작 버튼을 숨긴다)
      if (!room || room.state !== 'lobby' || !hostStart(room)) return err(ws, 'state', '대기 중인 방이 아닙니다');
      if (ws.slot !== 0) return err(ws, 'host', '방장만 시작할 수 있습니다');
      if (m.cancel === true) { cancelCount(room, 'host_cancel'); return; } // 카운트다운이 이미 끝났거나 취소된 뒤 늦게 온 취소 = 조용히 무시
      if (counting(room)) return err(ws, 'state', '이미 시작하는 중입니다');
      room.players[0].build = str(m.build, 80);
      const no = notStartable(room);
      if (no) {
        if (no.why === 'build') { for (const i of no.seats) { const q = room.players[i]; q.ready = false; err(q.ws, 'build', START_WHY.build); } peers(room); } // 누가 낡았는지 서버는 모른다 → 방장·상대 모두 같은 중립 문구(방장은 아래 err start 의 msg)
        return send(ws, { t: 'err', code: 'start', why: no.why, seats: no.seats, msg: START_WHY[no.why] });
      }
      room.count = setTimeout(() => {
        room.count = null; if (!rooms.has(room.code) || room.state !== 'lobby') return;
        const no2 = notStartable(room);
        if (no2) { cast(room, { t: 'count', cancel: true, why: no2.why }); return log('시작 취소', room.code, no2.why); }
        launch(room);
      }, countMs);
      cast(room, { t: 'count', ms: countMs }); log('카운트다운', room.code);
    },
    pong(ws, m) {
      const room = ws.room; if (!room) return; const p = room.players[ws.slot], t0 = p.pings.get(m.id);
      if (t0 === undefined) return; p.pings.delete(m.id); p.rtt.push(Number(process.hrtime.bigint() - t0) / 1e6);
    },
    in(ws, m) { // 입력: 프레임 f 부터 연속한 패드 값들. 순서가 뒤섞여 와도 된다(프레임 번호로 정렬), 같은 프레임은 먼저 온 값만 쓴다
      const room = ws.room; if (!room || room.state !== 'playing') return;
      const p = room.players[ws.slot], f0 = int(m.f), a = m.p;
      if (f0 < 0 || !Array.isArray(a) || a.length < 1 || a.length > MAX_BATCH) return err(ws, 'bad', '입력 형식 오류');
      if (f0 + a.length > room.conf + MAX_AHEAD) return err(ws, 'ahead', '입력이 너무 앞서 있습니다');
      blame(room, Date.now());
      for (let i = 0; i < a.length; i++) {
        const f = f0 + i, v = a[i];
        if (!Number.isInteger(v) || v < 0 || v > 255) return err(ws, 'bad', '패드 값 오류');
        if (f < room.conf || p.ins[f] !== undefined) continue;
        p.ins[f] = v;
      }
      if (room.players.every(Boolean)) confirm(room);
    },
    hash(ws, m) { // RAM 지문 비교(부정·어긋남 감지). 서버는 값이 같은지만 본다. 같은 프레임의 지문을 사람 자리마다 모아 하나라도 다르면 경고
      const room = ws.room; if (!room || room.state !== 'playing') return;
      const f = int(m.f), h = str(m.h, 64); if (f < 0 || !h || f > room.conf || f % HASH_EVERY) return;
      if (f < room.conf - room.cfg.delay - HASH_BACK && f >= (room.cfg.prefill || 0)) return; // 한참 지난 프레임(대기열 채우기)은 버린다
      let e = room.hashes.get(f);
      if (!e) { e = { hs: new Array(room.H).fill(null), n: 0 }; room.hashes.set(f, e); if (room.hashes.size > HASH_KEEP) room.hashes.delete(room.hashes.keys().next().value); }
      if (e.hs[ws.slot] !== null) return; // 같은 프레임 두 번째 보고는 무시
      e.hs[ws.slot] = h; e.n++;
      if (room.desync < 0 && e.hs.some(x => x !== null && x !== h)) { room.desync = f; stats.desync++; cast(room, { t: 'desync', f, h: e.hs.slice() }); log('불일치', room.code, '프레임', f); }
      if (e.n >= room.H) room.hashes.delete(f);
    },
    result(ws, m) { // 승패 보고: 사람 자리 모두의 결과가 같아야 인정. r = 문자열 또는 { winner: 이긴 엔진 슬롯(0~3, -1 = 없음) } → 인정되면 end.winner 로 알린다
      const room = ws.room; if (!room || room.state !== 'playing') return;
      if (room.results[ws.slot]) return; // 자리마다 첫 보고만(나중에 바꿔 내지 못한다)
      // f = 결과를 읽은 프레임: 이미 확정된 프레임 이하이고 전투 구간(미리 확정한 구동 구간 뒤)이어야 한다. 아니면 버린다(가짜 결과로 판을 일찍 끝내지 못하게)
      const f = int(m.f); if (f < Math.max(LEAD, room.cfg.prefill || 0) || f > room.conf) return err(ws, 'result', '결과 프레임이 맞지 않습니다');
      const w = m.r && typeof m.r === 'object' && Number.isInteger(m.r.winner) && m.r.winner >= -1 && m.r.winner < SEATS ? m.r.winner : null;
      room.results[ws.slot] = { f, r: str(typeof m.r === 'string' ? m.r : JSON.stringify(m.r || null), 256), w };
      if (!reported(room)) { if (!room.resultAt) room.resultAt = Date.now(); return; } // 한쪽만 냈으면 watch 가 resultWaitMs 뒤 끝낸다
      endResult(room);
    },
    leave(ws) {
      const room = ws.room; if (!room) return;
      if (room.state === 'playing') giveUp(room, ws.slot, 'leave');
      else onDrop(ws, 'leave'); // 대기 중 why 는 카운트다운 취소 이유로만 쓴다(leave | drop)
    },
  };

  wss.on('connection', ws => {
    ws.room = null; ws.slot = -1; ws.sess = null; ws.isAlive = true; ws.idle = null; armIdle(ws);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return err(ws, 'bad', '문자 메시지만 받습니다');
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return err(ws, 'bad', 'JSON 오류'); }
      if (data.length > MSG_MAX && !(m && m.t === 'story_seg')) { try { ws.close(1009, 'too big'); } catch (e) { /* 무시 */ } return; } // 종전 웹소켓 상한과 같은 결과(1009)
      const h = m && typeof m === 'object' && typeof m.t === 'string' && Object.prototype.hasOwnProperty.call(H, m.t) ? H[m.t] : null;
      if (!h) return err(ws, 'bad', '알 수 없는 메시지');
      if (ws.asset && !(m.t === 'hello' && m.token === undefined) && !(m.t === 'lobby' && m.on === false)) return err(ws, 'asset_only', '에셋 세션 연결입니다'); // 에셋 세션 소켓 = 손님 hello·로비 유휴 방지만(방·계정·대전은 온라인 소켓으로)
      const oops = e => { log('처리 오류', m.t, e && e.message); err(ws, 'server', '서버 오류'); };
      try { const r = h(ws, m); if (r && typeof r.then === 'function') r.catch(oops); } catch (e) { oops(e); } // register·login 은 비동기(scrypt)
      if (!ws.room && ws.sess) armIdle(ws); // 로비 유휴(lobbyIdleMs)는 마지막 메시지부터 잰다(이름 없는 소켓의 idleMs 는 접속 시각 기준 그대로)
    });
    ws.on('close', () => { clearTimeout(ws.idle); ws.idle = null; clearTimeout(ws.lobTm); ws.lobTm = null; lobbySubs.delete(ws); ladderDrop(ws, 'disconnect'); onDrop(ws); sessGone(ws); });
    ws.on('error', () => { /* close 로 이어진다 */ });
  });

  return {
    srv, wss, rooms, stats, names,
    get serveStatic() { return serveStatic; },
    listen(port, host) {
      host = host || bindHost; if (!LOOP_HOST.test(host) && !staticSet) serveStatic = false; // 밖에 묶으면 명시 없이는 정적 서빙을 하지 않는다
      return new Promise((res, rej) => { srv.once('error', rej); srv.listen(port, host, () => res(srv.address().port)); });
    },
    close() { clearInterval(watchIv); clearInterval(pingIv); clearInterval(ladderIv); clearInterval(seasonIv); clearTimeout(lobbyTm); for (const s of sids.values()) clearTimeout(s.timer); for (const c of wss.clients) { clearTimeout(c.idle); clearTimeout(c.lobTm); } for (const r of [...rooms.values()]) closeRoom(r, '서버 종료'); for (const c of wss.clients) c.terminate(); wss.close(); return new Promise(res => srv.close(() => { if (db) db.close(); res(); })); },
    get db() { return db; },
  };
}
module.exports = { createServer, PROTO, LEAD, HUMANS_MAX, ipKey };

if (require.main === module) {
  const port = +process.argv[2] || +process.env.PORT || 3500, host = process.env.HOST || '127.0.0.1';
  let s; try { s = createServer(); } catch (e) { console.error('시작 실패: ' + e.message); process.exit(1); }
  s.listen(port, host).then(p => console.log('http://' + host + ':' + p + '/  (웹소켓 /ws, 정적 서빙 ' + (s.serveStatic ? '켬' : '끔') + ', 계정·랭킹 ' + (s.db ? 'DB ' + s.db.file : '끔(NK_DB_PATH 없음)') + ')')).catch(e => { console.error('시작 실패: ' + e.message); process.exit(1); });
}
