'use strict';
// 팀전(2:2, 4패드) 엔진. core.js·gen/code.js 는 건드리지 않고, 변형 코드(gen/code_team.js)로 갈아 끼운 하위 클래스.
// opts.cpu[4] = 슬롯별 CPU 표시(1 = CPU). 확장 패드(3P·4P)는 항상 켠다. 일반 모드는 core.js 의 Engine 을 그대로 쓴다.
const { Engine, MAIN_LOOP } = require('./core.js');
const makeTeam = require('./gen/code_team.js');
class TeamEngine extends Engine {
  constructor(init, opts) {
    super(init); opts = opts || {};
    this.env.team = true; this.env.teamCfg = { cpu: (opts.cpu || [0, 0, 0, 0]).map(v => v ? 1 : 0) };
    this.code = makeTeam(this.env); this.code.st = init; this.extPads = true;
  }
}
module.exports = { TeamEngine, Engine, MAIN_LOOP };
