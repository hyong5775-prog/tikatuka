// 티카투카 온라인 - 팬메이드 서버 (랜덤 매칭 / 초대코드 / AI 대전)
// v3: 아이템 카드(방어/저격/섞기), 리롤(기존/새로 선택), 연승 기록, 모드별 재대결 제한
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rollDie = () => 1 + Math.floor(Math.random() * 6);
const ITEM_TYPES = ['defense', 'snipe', 'shuffle'];

// 줄 점수: 합계 + 같은 눈 보너스 (더블 = 3배, 트리플 = 5배)
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
  constructor(sendFn, names, botIdx = -1) {
    this.sendFn = sendFn;
    this.names = names;
    this.botIdx = botIdx;
    this.botStreak = 0;
    this.hooks = null;
    this.mode = 'queue';
    this.reset();
  }
  reset() {
    this.boards = [[[], [], []], [[], [], []]];
    this.rerolls = [1, 1];
    this.turn = Math.floor(Math.random() * 2);
    this.firstMove = true;
    this.pending = null;
    this.over = false;
    this.result = null;
    this.rematchVotes = [false, false];
    this.phase = 'cards';
    this.items = [null, null];
    this.defendedEvt = false;
  }
  start() {
    this.broadcast(null);
    if (this.botIdx >= 0 && !this.items[this.botIdx]) {
      setTimeout(() => this.pickItem(this.botIdx, ITEM_TYPES[Math.floor(Math.random() * 3)]), 700);
    }
  }
  boardFull(i) { return this.boards[i].every(l => l.length >= 3); }
  scores() { return this.boards.map(b => b.map(scoreLine)); }

  pickItem(idx, type) {
    if (this.over || this.phase !== 'cards') return { err: '지금은 카드를 고를 수 없습니다.' };
    if (this.items[idx]) return { err: '이미 선택했습니다.' };
    if (!ITEM_TYPES.includes(type)) return { err: '잘못된 카드입니다.' };
    this.items[idx] = { type, used: false };
    if (this.items[0] && this.items[1]) {
      this.phase = 'play';
      this.beginTurn({ kind: 'cards_done' });
    } else {
      this.broadcast(null);
    }
    return {};
  }

  beginTurn(evt) {
    if (this.over) return;
    if (this.boardFull(0) && this.boardFull(1)) return this.finish(evt);
    if (this.boardFull(this.turn)) this.turn = 1 - this.turn;
    this.pending = {
      v: rollDie(),
      shield: this.firstMove,
      ownOnly: this.firstMove,
      bonus: false,
      offer: null
    };
    this.firstMove = false;
    this.broadcast(evt);
    this.maybeBot();
  }

  legalMoves(idx) {
    if (!this.pending || this.turn !== idx || this.over) return [];
    const p = this.pending;
    const moves = [];
    for (let l = 0; l < 3; l++) {
      if (this.boards[idx][l].length < 3) moves.push({ board: 'own', line: l });
      if (p.shield && !p.ownOnly && this.boards[1 - idx][l].length < 3)
        moves.push({ board: 'opp', line: l });
    }
    return moves;
  }

  reroll(idx) {
    if (this.over || this.turn !== idx || !this.pending) return { err: '지금은 리롤할 수 없습니다.' };
    if (this.pending.offer) return { err: '이미 리롤했습니다.' };
    if (this.pending.bonus) return { err: '보너스 주사위는 리롤할 수 없습니다.' };
    if (this.rerolls[idx] <= 0) return { err: '리롤권을 이미 사용했습니다.' };
    this.rerolls[idx]--;
    this.pending.offer = { old: this.pending.v, nu: rollDie() };
    this.broadcast({ kind: 'reroll', by: idx });
    this.maybeBot();
    return {};
  }

  choose(idx, pick) {
    if (this.over || this.turn !== idx || !this.pending || !this.pending.offer)
      return { err: '선택할 리롤이 없습니다.' };
    this.pending.v = pick === 'new' ? this.pending.offer.nu : this.pending.offer.old;
    this.pending.offer = null;
    this.broadcast({ kind: 'chose', by: idx });
    this.maybeBot();
    return {};
  }

  useSnipe(idx, line, dieIdx) {
    const it = this.items[idx];
    if (this.over || !it || it.type !== 'snipe' || it.used) return { err: '저격 카드를 사용할 수 없습니다.' };
    if (this.turn !== idx || !this.pending) return { err: '내 턴에만 사용할 수 있습니다.' };
    const tgtLine = this.boards[1 - idx][line];
    if (!tgtLine || !tgtLine[dieIdx]) return { err: '대상이 없습니다.' };
    if (tgtLine[dieIdx].shield) return { err: '실드 주사위는 저격할 수 없습니다.' };
    it.used = true;
    const def = this.items[1 - idx];
    if (def && def.type === 'defense' && !def.used) {
      def.used = true;
      this.broadcast({ kind: 'snipe_blocked', by: idx, line, dieIdx });
    } else {
      const tgt = tgtLine[dieIdx];
      this.boards[1 - idx][line] = tgtLine.filter((_, i) => i !== dieIdx);
      this.broadcast({ kind: 'snipe', by: idx, line, dieIdx, dieV: tgt.v, shield: tgt.shield });
    }
    this.maybeBot();
    return {};
  }

  useShuffle(idx) {
    const it = this.items[idx];
    if (this.over || !it || it.type !== 'shuffle' || it.used) return { err: '섞기 카드를 사용할 수 없습니다.' };
    if (this.turn !== idx || !this.pending) return { err: '내 턴에만 사용할 수 있습니다.' };
    const b = this.boards[idx];
    let perm;
    do {
      perm = [0, 1, 2].sort(() => Math.random() - .5);
    } while (perm[0] === 0 && perm[1] === 1 && perm[2] === 2);
    this.boards[idx] = [b[perm[0]], b[perm[1]], b[perm[2]]];
    it.used = true;
    this.broadcast({ kind: 'shuffle', by: idx });
    this.maybeBot();
    return {};
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

    // 알까기: 성공 시 상대 주사위와 알깐 내 주사위 모두 소멸 + 실드 보너스
    // 상대가 방어 카드를 보유하면 자동 발동되어 무효화(일반 배치로 전환)
    if (!p.shield && boardSel === 'own') {
      const oppLine = this.boards[1 - idx][line];
      const hit = oppLine.filter(d => d.v === p.v && !d.shield);
      if (hit.length) {
        const def = this.items[1 - idx];
        if (def && def.type === 'defense' && !def.used) {
          def.used = true;
          this.defendedEvt = true;
        } else {
          this.boards[1 - idx][line] = oppLine.filter(d => !(d.v === p.v && !d.shield));
          this.pending = { v: rollDie(), shield: true, ownOnly: false, bonus: true, offer: null };
          this.broadcast({ kind: 'knock', by: idx, line, removed: hit.length, dieV: p.v });
          this.maybeBot();
          return {};
        }
      }
    }

    // 같은 눈 그룹핑 삽입
    const lineArr = this.boards[targetIdx][line];
    let insertAt = lineArr.length, regrouped = false;
    const lastSame = lineArr.map(d => d.v).lastIndexOf(p.v);
    if (lastSame >= 0 && lastSame < lineArr.length - 1) { insertAt = lastSame + 1; regrouped = true; }
    lineArr.splice(insertAt, 0, { v: p.v, shield: p.shield });

    const dieV = p.v, shield = p.shield;
    const defended = this.defendedEvt;
    this.defendedEvt = false;
    this.pending = null;
    this.turn = 1 - this.turn;
    this.beginTurn({ kind: 'placed', by: idx, board: targetIdx, line, dieV, shield, insertAt, regrouped, defended });
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
      const t0 = sc[0].reduce((a, b) => a + b, 0);
      const t1 = sc[1].reduce((a, b) => a + b, 0);
      winner = t0 > t1 ? 0 : t1 > t0 ? 1 : -1;
    }
    const streaks = this.hooks && this.hooks.onFinish ? this.hooks.onFinish(winner) : [0, 0];
    this.result = {
      winner, wins, lineResults, streaks,
      totals: [sc[0].reduce((a,b)=>a+b,0), sc[1].reduce((a,b)=>a+b,0)]
    };
    this.broadcast(Object.assign({}, evt, { kind: 'game_over' }));
  }

  stateFor(i) {
    const oppIt = this.items[1 - i];
    return {
      type: 'state',
      me: i,
      names: this.names,
      mode: this.mode,
      boards: this.boards,
      scores: this.scores(),
      rerolls: this.rerolls,
      turn: this.turn,
      phase: this.phase,
      myItem: this.items[i],
      oppPicked: !!oppIt,
      oppItem: oppIt && oppIt.used ? oppIt : null,
      pending: this.pending,
      legal: this.pending ? this.legalMoves(this.turn) : [],
      over: this.over,
      result: this.result
    };
  }
  broadcast(evt) {
    for (const i of [0, 1]) {
      if (i === this.botIdx) continue;
      this.sendFn(i, Object.assign({ evt: evt || null }, this.stateFor(i)));
    }
  }

  // ---------- AI ----------
  evalPlace(idx, v, shield, boardSel, line) {
    const meB = this.boards[idx], opB = this.boards[1 - idx];
    if (boardSel === 'own') {
      if (!shield) {
        const hit = opB[line].filter(d => d.v === v && !d.shield);
        if (hit.length) {
          const after = opB[line].filter(d => !(d.v === v && !d.shield));
          const removedGain = scoreLine(opB[line]) - scoreLine(after);
          return removedGain * 1.1 + 4;
        }
      }
      return scoreLine([...meB[line], { v }]) - scoreLine(meB[line]);
    } else {
      const theirGain = scoreLine([...opB[line], { v }]) - scoreLine(opB[line]);
      const counts = {};
      for (const d of opB[line]) counts[d.v] = (counts[d.v] || 0) + 1;
      const blockBonus = Object.values(counts).some(c => c >= 2) && opB[line].length === 2 ? 6 : 0;
      return 4.5 - theirGain + blockBonus;
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
  bestMoveFor(v, shield) { return this.bestMove(v, shield).score; }
  maybeBot() {
    if (this.over || this.botIdx < 0 || this.turn !== this.botIdx || !this.pending) return;
    setTimeout(() => this.botAct(), 900 + Math.random() * 700);
  }
  botAct() {
    if (this.over || this.turn !== this.botIdx || !this.pending) return;
    const p = this.pending;
    const b = this.botIdx;
    if (p.offer) {
      const oldS = this.bestMoveFor(p.offer.old, p.shield);
      const newS = this.bestMoveFor(p.offer.nu, p.shield);
      this.choose(b, newS >= oldS ? 'new' : 'old');
      return;
    }
    const it = this.items[b];
    if (it && !it.used && it.type === 'snipe') {
      let best = null, bestGain = 0;
      for (let l = 0; l < 3; l++) {
        const line = this.boards[1 - b][l];
        line.forEach((d, i) => {
          if (d.shield) return;
          const after = line.filter((_, j) => j !== i);
          const gain = scoreLine(line) - scoreLine(after);
          if (gain > bestGain) { bestGain = gain; best = { line: l, dieIdx: i }; }
        });
      }
      if (best && bestGain >= 12) { this.useSnipe(b, best.line, best.dieIdx); return; }
    }
    if (it && !it.used && it.type === 'shuffle') {
      const sc = this.scores();
      const losing = [0,1,2].filter(l => sc[1-b][l] > sc[b][l]).length;
      const myDice = this.boards[b].reduce((a, l) => a + l.length, 0);
      if (losing >= 2 && myDice >= 6) { this.useShuffle(b); return; }
    }
    const { move, score } = this.bestMove(p.v, p.shield);
    if (!move) return;
    if (!p.bonus && this.rerolls[b] > 0 && score < 4.5 && p.v <= 3) { this.reroll(b); return; }
    this.place(b, move.board, move.line);
  }
}

// ---------- 접속/매칭 관리 ----------
let queue = [];
const rooms = new Map();
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

function startGame(ws0, ws1, botIdx = -1, mode = 'queue') {
  const players = [ws0, ws1];
  const names = players.map((w, i) => (i === botIdx ? 'AI 도전자' : w.meta.name));
  const game = new Game((i, msg) => send(players[i], msg), names, botIdx);
  game.mode = mode;
  game.hooks = {
    onFinish(winner) {
      const streaks = [0, 0];
      players.forEach((w, i) => {
        if (i === botIdx) {
          if (winner === i) game.botStreak++; else if (winner === 1 - i) game.botStreak = 0;
          streaks[i] = game.botStreak;
        } else if (w && w.meta) {
          if (winner === i) w.meta.streak = (w.meta.streak || 0) + 1;
          else if (winner === 1 - i) w.meta.streak = 0;
          streaks[i] = w.meta.streak || 0;
        }
      });
      return streaks;
    }
  };
  players.forEach((w, i) => {
    if (!w) return;
    w.meta.game = game;
    w.meta.idx = i;
    w.meta.players = players;
    send(w, { type: 'matched', me: i, names, mode });
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
  ws.meta = { name: '플레이어', game: null, idx: -1, players: null, streak: 0 };
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const g = ws.meta.game;
    const reply = r => { if (r && r.err) send(ws, { type: 'error', msg: r.err }); };
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
          startGame(a, b, -1, 'queue');
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
        startGame(host, ws, -1, 'room');
        break;
      }
      case 'play_ai': {
        ws.meta.name = cleanName(m.name);
        leaveEverything(ws);
        startGame(ws, null, 1, 'ai');
        break;
      }
      case 'pick_item': if (g) reply(g.pickItem(ws.meta.idx, m.card)); break;
      case 'snipe': if (g) reply(g.useSnipe(ws.meta.idx, m.line, m.dieIdx)); break;
      case 'shuffle': if (g) reply(g.useShuffle(ws.meta.idx)); break;
      case 'place': if (g) reply(g.place(ws.meta.idx, m.board, m.line)); break;
      case 'reroll': if (g) reply(g.reroll(ws.meta.idx)); break;
      case 'choose': if (g) reply(g.choose(ws.meta.idx, m.pick)); break;
      case 'rematch': {
        if (!g || !g.over || g.abandoned) break;
        if (g.mode === 'queue') { send(ws, { type: 'error', msg: '랜덤 매칭에서는 재대결할 수 없습니다.' }); break; }
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
