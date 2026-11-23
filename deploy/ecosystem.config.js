// pm2 설정 초안: pm2 start deploy/ecosystem.config.js   (배포 폴더 루트에서)
// 값 중 「확정 필요」 표시는 DEPLOY.md 「사용자에게 받을 정보」 참고. 시크릿은 이 파일에 쓰지 않는다(열혈은 시크릿 환경변수 없음).
module.exports = {
  apps: [{
    name: 'nekketsu',
    script: 'server_online.js',
    cwd: __dirname + '/..',
    instances: 1,            // 방·세션·락스텝 상태를 메모리에 두므로 반드시 1개(재시작하면 진행 중 대전·방이 사라진다)
    exec_mode: 'fork',
    // 주의: node:sqlite 때문에 서버 Node 는 22.13 이상(22.5~22.12 는 node_args: '--experimental-sqlite' 필요). 로컬 개발은 v25.7.0.
    env: {
      NODE_ENV: 'production',
      PORT: 3600,                                  // 확정 필요: 서버 포트 사용 현황(liero 3000, tank 3200 이 쓰는 것을 확인함)
      HOST: '127.0.0.1',                           // nginx 뒤. 밖에 직접 열지 않는다
      ALLOWED_HOSTS: 'nekketsu.oddplay.kr',        // Host 검사(없으면 정적 서빙이 꺼지고 Host 403)
      STATIC: '1',                                 // 위 설정에서는 명시해야 정적 서빙이 켜진다
      NK_REMOTE_ASSETS: 'session',                 // 원격 ROM·파생물 제공 정책 M0: HTTPS + 세션만. off 면 원격에는 ROM 이 안 나가 게임이 뜨지 않는다
      NK_TRUST_PROXY: '1',                         // nginx 뒤 필수: 없으면 모든 접속자가 IP 127.0.0.1 하나로 계산돼 MAX_CONNS_PER_IP(8)에 걸리고 랭크 SAME_IP 가 오판된다
      NK_TRUST_PROXY_HOPS: '1',                    // nginx 1단. Cloudflare 등 프록시가 더 앞에 있으면 2
      NK_DB_PATH: __dirname + '/../data/nekketsu.db', // 빈 DB 로 시작(스키마는 기동 때 자동 생성). 개발 DB 는 옮기지 않는 것을 권고
      // WebRTC DataChannel 전송(DEPLOY.md 13절, 승인 뒤에만 주석 해제. 서버에서 npm ci --omit=dev + UDP 포트 개방 필요):
      // NK_RTC: '1', NK_RTC_PORT: 3600, NK_RTC_IP: '<서버 공인 IPv4>',
      // NK_RANK_ALLOW_SAME_IP 는 넣지 않는다(개발 시험용). ADMIN_ACCOUNTS 같은 관리자 변수는 열혈에 없다.
    },
    max_memory_restart: '600M', // 스토리 재현 워커(NK_STORY_WORKERS 기본 2)와 압축 캐시를 감안. 운영 중 실측해 조정
    time: true,
  }],
};
