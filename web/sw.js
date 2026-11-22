'use strict';
// 서비스 워커(PWA, 2026-11-22). 범위 = / . 등록 = pwa_register.js, 설치·새 버전 링크 = pwa_install.js.
// 게임은 서버가 주는 ROM·시작 상태·초상(/rom/ /state/ /ui/ /engine/gen/ = 보호 경로)이 있어야 돌므로 오프라인 플레이는 없다 → 오프라인은 offline.html(연결 필요)만.
// - 가로채지 않음: GET 아닌 요청·Range·다른 출처·/ws(웹소켓은 원래 SW 를 거치지 않음)·/online/·/api/·보호 경로·cache:no-store|reload 요청(buildPrint 지문 읽기)·
//   코드(js·css·json·webmanifest·html)·음원. 코드는 서버 no-cache + ETag 재검증 그대로 = SW 를 넣기 전과 같은 파일을 받는다(옛 엔진·락스텝 코드가 SW 캐시에서 나올 길이 없다).
// - 화면 이동: 네트워크 그대로, 네트워크 실패일 때만 캐시한 /offline.html. HTML 은 캐시에 넣지 않는다.
// - 그림·글꼴(png·webp·jpg·gif·svg·ico·ttf·woff2, 보호 경로 아님): stale-while-revalidate. 200·같은 출처·no-store/private 아님·4MB 이하만, 최대 MAX 개(넘으면 오래 넣은 것부터 지움).
// - 새 판: VERSION 을 올린다 → 새 SW 대기 → 타이틀의 「새 버전」을 누르면 적용 + 새로 고침(누르지 않으면 창을 모두 닫은 다음 실행부터). activate 에서 nk-pwa- 옛 캐시 삭제.
const VERSION = 'nk-pwa-v1';
const SHELL = VERSION + '-shell', RT = VERSION + '-rt';
const SHELL_FILES = ['/offline.html', '/icon-192.png'];
const MEDIA = /\.(png|webp|jpe?g|gif|svg|ico|ttf|woff2?)$/i;
const SKIP = /^\/+(ws|online|api|rom|state|ui|engine\/+gen)(\/|$)/i;
const MAX = 400, MAX_BYTES = 4 * 1024 * 1024;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('nk-pwa-') && k !== SHELL && k !== RT).map(k => caches.delete(k)))));
});

self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting(); });

const storable = r => r && r.status === 200 && r.type === 'basic' && !/no-store|private/i.test(r.headers.get('cache-control') || '') && !(+r.headers.get('content-length') > MAX_BYTES);

async function put(req, res) {
  if (!storable(res)) return;
  try {
    const c = await caches.open(RT);
    await c.put(req, res);
    const ks = await c.keys();
    for (let i = 0; i < ks.length - MAX; i++) await c.delete(ks[i]);
  } catch (er) { /* 용량 초과 등: 무시 */ }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range') || req.cache === 'no-store' || req.cache === 'reload') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || SKIP.test(url.pathname) || url.pathname === '/sw.js') return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(async () => (await caches.match('/offline.html')) || Response.error()));
    return;
  }
  if (!MEDIA.test(url.pathname)) return;
  const net = fetch(req), copy = net.then(r => r.clone()); // 복사본을 먼저 떠 둔다(본문을 화면이 읽기 전)
  e.waitUntil(copy.then(c => put(req, c)).catch(() => {}));
  e.respondWith(caches.match(req, { cacheName: RT }).then(hit => hit || net));
});
