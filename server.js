// 티카투카 온라인 - 팬메이드 서버 (랜덤 매칭 / 초대코드 / AI 대전)
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rollDie = () => 1 + Math.floor(Math.random() * 6);

// 줄 점수: 합계 + 같은 눈 보너스 (2개 = 3배, 3개 = 5배)
function scoreLine(dice) {
  const counts = {};
  for (const d of dice) counts[d.v] = (counts[d.v] || 0) + 1;
  let s = 0;
  for (const [v, c] of Object.entries(counts)) {
    const val = Number(v);
    s += c === 1 ? val : c === 2 ? val * 3 : val * 5;
  }
  return s;
}

class Game {
  // sendFn(playerIdx, msgObj) — 봇 자리는 무시됨
  constructor(sendFn, names, botIdx = -1) {
    this.sendFn = sendFn;
    this.names = names;
    this.botIdx = botIdx;
    this.rematchVotes = [false, false];
    this.reset();
  }
  reset() {
    this.boards = [[[], [], []], [[], [], []]]; // [player][line] = [{v, shield}]
    this.rerolls = [1, 1];
    this.turn = Math.floor(Math.random() * 2);
    this.firstMove = true; // 규칙 9: 최초 시작 주사위는 실드, 자기 보드 전용
    this.pending = null;   // {v, shield, ownOnly, bonus, offer:{old,nu}|null}
    this.over = false;
    this.result = null;
    this.rematchVotes = [false, false];
  }
  start() {
    this.beginTurn();
  }
  boardFull(i) { return this.boards[i].every(l => l.length >= 3); }
  scores() { return this.boards.map(b => b.map(scoreLine)); }

  beginTurn(evt) {
    if (this.over) return;
    if (this.boardFull(0) && this.boardFull(1)) return this.finish(evt);
    if (this.boardFull(this.turn)) this.turn = 1 - this.turn; // 규칙 19: 꽉 찬 보드는 턴 스킵
    this.pending = {
      v: rollDie(),
      shield: this.firstMove,
      ownOnly: this.firstMove,
      bonus: false,
      offer: null
    };
    this.firstMove = false;
    this.broadcast('state', evt);
    this.maybeBot();
  }

  legalMoves(idx) {
    // [{board:'own'|'opp', line}]
    if (!this.pending || this.turn !== idx) return [];
    const p = this.pending;
    const moves = [];
    for (let l = 0; l < 3; l++) {
      if (this.boards[idx][l].length < 3) moves.push({ board: 'own', line: l });
      if (p.shield && !p.ownOnly && this.boards[1 - idx][l].length < 3)
        moves.push({ board: 'opp', line: l });
    }
    return moves;
  }

  place(idx, boardSel, line) {
    if (this.over || this.turn !== idx || !this.pending) return { err: '지금은 놓을 수 없습니다.' };
    const p = this.pending;
    if (p.offer) return { err: '리롤 결과를 먼저 선택하세요.' };
    if (line < 0 || line > 2) return { err: '잘못된 줄입니다.' };
    if (boardSel !== 'own' && !p.shield) return { err: '일반 주사위는 내 보드에만 놓을 수 있습니다.' };
    if (boardSel !== 'own' && p.ownOnly) return { err: '시작 실드 주사위는 내 보드에만 놓을 수 있습니다.' };
    const targetIdx = boardSel === 'own' ? idx : 1 - idx;
    if (this.boards[targetIdx][line].length >= 3) return { err: '그 줄은 가득 찼습니다.' };

    // 알까기: 성공 시 상대의 같은 눈 일반 주사위와 함께 알깐 내 주사위도 소멸 (배치되지 않음)
    if (!p.shield && boardSel === 'own') {
      const oppLine = this.boards[1 - idx][line];
      const hit = oppLine.filter(d => d.v === p.v && !d.shield);
      if (hit.length) {
        this.boards[1 - idx][line] = oppLine.filter(d => !(d.v === p.v && !d.shield));
        // 보너스: 실드 주사위를 굴려 아무 보드에나 배치
        this.pending = { v: rollDie(), shield: true, ownOnly: false, bonus: true, offer: null };
        this.broadcast('state', { kind: 'knock', by: idx, line, removed: hit.length, dieV: p.v });
        this.maybeBot();
        return {};
      }
    }

    // 원작 재현: 같은 눈이 이미 있으면(사이에 다른 주사위가 있어도) 그 옆으로 끼어들며 그룹핑
    const lineArr = this.boards[targetIdx][line];
    let insertAt = lineArr.length, regrouped = false;
    const lastSame = lineArr.map(d => d.v).lastIndexOf(p.v);
    if (lastSame >= 0 && lastSame < lineArr.length - 1) { insertAt = lastSame + 1; regrouped = true; }
    lineArr.splice(insertAt, 0, { v: p.v, shield: p.shield });

    const dieV = p.v, shield = p.shield;
    this.pending = null;
    this.turn = 1 - this.turn;
    this.beginTurn({ kind: 'placed', by: idx, board: targetIdx, line, dieV, shield, insertAt, regrouped });
    return {};
  }

  reroll(idx) {
    if (this.over || this.turn !== idx || !this.pending) return { err: '지금은 리롤할 수 없습니다.' };
    if (this.pending.offer) return { err: '이미 리롤했습니다.' };
    if (this.rerolls[idx] <= 0) return { err: '리롤권을 이미 사용했습니다.' };
    this.rerolls[idx]--;
    this.pending.offer = { old: this.pending.v, nu: rollDie() };
    this.broadcast('state', { kind: 'reroll', by: idx });
    this.maybeBot();
    return {};
  }

  choose(idx, pick) {
    if (this.over || this.turn !== idx || !this.pending || !this.pending.offer)
      return { err: '선택할 리롤이 없습니다.' };
    this.pending.v = pick === 'new' ? this.pending.offer.nu : this.pending.offer.old;
    this.pending.offer = null;
    this.broadcast('state', { kind: 'chose', by: idx });
    this.maybeBot();
    return {};
  }

  finish(evt) {
    this.over = true;
    this.pending = null;
    const sc = this.scores();
    let wins = [0, 0];
    const lineResults = [];
    for (let l = 0; l < 3; l++) {
      if (sc[0][l] > sc[1][l]) { wins[0]++; lineResults.push(0); }
      else if (sc[1][l] > sc[0][l]) { wins[1]++; lineResults.push(1); }
      else lineResults.push(-1);
    }
    let winner;
    if (wins[0] >= 2) winner = 0;
    else if (wins[1] >= 2) winner = 1;
    else {
      // 규칙 5: 줄 승수가 같으면 총점으로
      const t0 = sc[0].reduce((a, b) => a + b, 0);
      const t1 = sc[1].reduce((a, b) => a + b, 0);
      winner = t0 > t1 ? 0 : t1 > t0 ? 1 : -1;
    }
    this.result = { winner, wins, lineResults, totals: [sc[0].reduce((a,b)=>a+b,0), sc[1].reduce((a,b)=>a+b,0)] };
    this.broadcast('state', Object.assign({}, evt, { kind: 'game_over' }));
  }

  stateFor(i) {
    return {
      type: 'state',
      me: i,
      names: this.names,
      boards: this.boards,
      scores: this.scores(),
      rerolls: this.rerolls,
      turn: this.turn,
      pending: this.pending,
      legal: this.pending ? this.legalMoves(this.turn) : [],
      over: this.over,
      result: this.result
    };
  }
  broadcast(_, evt) {
    for (const i of [0, 1]) {
      if (i === this.botIdx) continue;
      this.sendFn(i, Object.assign({ evt: evt || null }, this.stateFor(i)));
    }
  }

  // ---------- AI ----------
  maybeBot() {
    if (this.over || this.botIdx < 0 || this.turn !== this.botIdx || !this.pending) return;
    setTimeout(() => this.botAct(), 900 + Math.random() * 700);
  }
  evalPlace(idx, v, shield, boardSel, line) {
    const meB = this.boards[idx], opB = this.boards[1 - idx];
    if (boardSel === 'own') {
      if (!shield) {
        const hit = opB[line].filter(d => d.v === v && !d.shield);
        if (hit.length) {
          // 알까기: 내 주사위는 배치되지 않으므로 상대 감점 + 실드 보너스 기대값만
          const after = opB[line].filter(d => !(d.v === v && !d.shield));
          const removedGain = scoreLine(opB[line]) - scoreLine(after);
          return removedGain * 1.1 + 4;
        }
      }
      return scoreLine([...meB[line], { v }]) - scoreLine(meB[line]);
    } else {
      // 상대 보드에 실드 배치: 상대 점수 이득은 최소로, 슬롯 잠식 가치 반영
      const theirGain = scoreLine([...opB[line], { v }]) - scoreLine(opB[line]);
      const slotValue = 4.5;
      // 상대가 같은 눈 2개를 모아둔 줄 차단 보너스
      const counts = {};
      for (const d of opB[line]) counts[d.v] = (counts[d.v] || 0) + 1;
      const blockBonus = Object.values(counts).some(c => c >= 2) && opB[line].length === 2 ? 6 : 0;
      return slotValue - theirGain + blockBonus;
    }
  }
  bestMove(v, shield) {
    const moves = this.legalMoves(this.botIdx);
    let best = null, bestS = -Infinity;
    for (const m of moves) {
      const s = this.evalPlace(this.botIdx, v, shield, m.board, m.line) + Math.random() * 0.3;
      if (s > bestS) { bestS = s; best = m; }
    }
    return { move: best, score: bestS };
  }
  botAct() {
    if (this.over || this.turn !== this.botIdx || !this.pending) return;
    const p = this.pending;
    if (p.offer) {
      // 리롤 결과 선택
      const oldS = this.bestMoveFor(p.offer.old, p.shield);
      const newS = this.bestMoveFor(p.offer.nu, p.shield);
      this.choose(this.botIdx, newS >= oldS ? 'new' : 'old');
      return;
    }
    const { move, score } = this.bestMove(p.v, p.shield);
    if (!move) return; // 발생하지 않아야 함
    if (!p.bonus && this.rerolls[this.botIdx] > 0 && score < 4.5 && p.v <= 3) {
      this.reroll(this.botIdx);
      return;
    }
    this.place(this.botIdx, move.board, move.line);
  }
  bestMoveFor(v, shield) { return this.bestMove(v, shield).score; }
}

// ---------- 접속/매칭 관리 ----------
let queue = [];               // 랜덤 매칭 대기열 (ws)
const rooms = new Map();      // code -> ws(host)
const NAMES_MAX = 12;

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function roomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
function cleanName(n) {
  n = String(n || '').trim().slice(0, NAMES_MAX);
  return n || '플레이어';
}

function startGame(ws0, ws1, botIdx = -1) {
  const players = [ws0, ws1];
  const names = players.map((w, i) => (i === botIdx ? 'AI 도전자' : w.meta.name));
  const game = new Game((i, msg) => send(players[i], msg), names, botIdx);
  players.forEach((w, i) => {
    if (!w) return;
    w.meta.game = game;
    w.meta.idx = i;
    w.meta.players = players;
    send(w, { type: 'matched', me: i, names });
  });
  game.start();
}

function leaveEverything(ws) {
  queue = queue.filter(w => w !== ws);
  for (const [code, host] of rooms) if (host === ws) rooms.delete(code);
  const g = ws.meta && ws.meta.game;
  if (g && !g.abandoned) {
    const oppIdx = 1 - ws.meta.idx;
    const opp = ws.meta.players[oppIdx];
    if (opp && opp !== ws && oppIdx !== g.botIdx) {
      send(opp, { type: 'opponent_left' });
      if (opp.meta) opp.meta.game = null;
    }
    g.abandoned = true;
    g.over = true;
  }
  if (ws.meta) ws.meta.game = null;
}

wss.on('connection', ws => {
  ws.meta = { name: '플레이어', game: null, idx: -1, players: null };
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const g = ws.meta.game;
    switch (m.type) {
      case 'set_name':
        ws.meta.name = cleanName(m.name);
        break;
      case 'join_queue': {
        ws.meta.name = cleanName(m.name);
        leaveEverything(ws);
        queue.push(ws);
        send(ws, { type: 'queued' });
        if (queue.length >= 2) {
          const a = queue.shift(), b = queue.shift();
          startGame(a, b);
        }
        break;
      }
      case 'create_room': {
        ws.meta.name = cleanName(m.name);
        leaveEverything(ws);
        const code = roomCode();
        rooms.set(code, ws);
        send(ws, { type: 'room_created', code });
        break;
      }
      case 'join_room': {
        ws.meta.name = cleanName(m.name);
        const code = String(m.code || '').toUpperCase().trim();
        const host = rooms.get(code);
        if (!host || host.readyState !== 1) { send(ws, { type: 'error', msg: '존재하지 않는 방 코드입니다.' }); break; }
        if (host === ws) { send(ws, { type: 'error', msg: '자기 방에는 입장할 수 없습니다.' }); break; }
        rooms.delete(code);
        leaveEverything(ws);
        startGame(host, ws);
        break;
      }
      case 'play_ai': {
        ws.meta.name = cleanName(m.name);
        leaveEverything(ws);
        startGame(ws, null, 1);
        break;
      }
      case 'place': {
        if (!g) break;
        const r = g.place(ws.meta.idx, m.board, m.line);
        if (r.err) send(ws, { type: 'error', msg: r.err });
        break;
      }
      case 'reroll': {
        if (!g) break;
        const r = g.reroll(ws.meta.idx);
        if (r.err) send(ws, { type: 'error', msg: r.err });
        break;
      }
      case 'choose': {
        if (!g) break;
        const r = g.choose(ws.meta.idx, m.pick);
        if (r.err) send(ws, { type: 'error', msg: r.err });
        break;
      }
      case 'rematch': {
        if (!g || !g.over || g.abandoned) break;
        g.rematchVotes[ws.meta.idx] = true;
        if (g.botIdx >= 0) g.rematchVotes[g.botIdx] = true;
        const oppIdx = 1 - ws.meta.idx;
        if (!g.rematchVotes[oppIdx]) send(ws.meta.players[oppIdx], { type: 'rematch_request' });
        if (g.rematchVotes[0] && g.rematchVotes[1]) {
          g.reset();
          g.start();
        }
        break;
      }
      case 'leave': {
        leaveEverything(ws);
        send(ws, { type: 'left' });
        break;
      }
    }
  });
  ws.on('close', () => leaveEverything(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`티카투카 서버 실행 중: http://localhost:${PORT}`));
