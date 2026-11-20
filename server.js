const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ============ GAME CONSTANTS ============
const FIELD_W = 44;
const FIELD_H = 60;
const BALL_RADIUS = 0.6;
const TICK_RATE = 30; // server updates per second

// ============ GAME STATE ============
const state = {
  ball: { x: 0, y: BALL_RADIUS, z: 0, vx: 0, vy: 0, vz: 0 },
  players: {}, // id -> {x,y,z,ry,color,name,team}
  scores: { red: 0, blue: 0 },
  scoreCooldown: 0,
  lastGoalBy: null
};

const COLORS = [
  0x3366ff, 0xff6633, 0x33cc66, 0xffcc00, 0xcc33ff,
  0x00cccc, 0xff3399, 0x99ff33, 0xff9933, 0x9933ff
];
let colorIdx = 0;

// ============ SOCKET IO ============
io.on('connection', (socket) => {
  console.log('[+] Player connected:', socket.id);

  // Tạo player mới (team random)
  const team = Math.random() < 0.5 ? 'red' : 'blue';
  state.players[socket.id] = {
    x: (Math.random() - 0.5) * 10,
    y: 0,
    z: team === 'red' ? -20 : 20,
    ry: 0,
    color: COLORS[colorIdx++ % COLORS.length],
    team: team,
    name: 'Player ' + socket.id.slice(0, 4),
    kickAnim: 0
  };

  // Gửi full state cho client mới
  socket.emit('init', {
    id: socket.id,
    state: state,
    fieldW: FIELD_W,
    fieldH: FIELD_H,
    ballRadius: BALL_RADIUS
  });

  // Broadcast player mới cho mọi người
  socket.broadcast.emit('playerJoined', { id: socket.id, player: state.players[socket.id] });

  // Nhận input từ client
  socket.on('input', (data) => {
    const p = state.players[socket.id];
    if (!p) return;
    // Lưu hướng di chuyển & hành động
    p.input = {
      mx: data.mx || 0,
      mz: data.mz || 0,
      kick: !!data.kick,
      sprint: !!data.sprint
    };
  });

  socket.on('disconnect', () => {
    console.log('[-] Player disconnected:', socket.id);
    delete state.players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

// ============ GAME LOOP ============
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;

  updatePlayers(dt);
  updateBall(dt);
  checkGoals();
  broadcastState();
}, 1000 / TICK_RATE);

function updatePlayers(dt) {
  const PLAYER_SPEED = 10;
  const SPRINT_MUL = 1.7;
  const TOUCH_DIST = 1.4;

  for (const id in state.players) {
    const p = state.players[id];
    if (!p.input) continue;
    
    const { mx, mz, sprint } = p.input;
    const mag = Math.hypot(mx, mz);
    let nx = mx, nz = mz;
    if (mag > 1) { nx /= mag; nz /= mag; }
    
    const speed = PLAYER_SPEED * (sprint ? SPRINT_MUL : 1);
    p.x += nx * speed * dt;
    p.z += nz * speed * dt;
    
    // giới hạn
    p.x = clamp(p.x, -FIELD_W/2 + 1, FIELD_W/2 - 1);
    p.z = clamp(p.z, -FIELD_H/2 + 1, FIELD_H/2 - 1);
    
    // xoay
    if (mag > 0.1) p.ry = Math.atan2(nx, nz);
    
    // tương tác bóng
    const dx = state.ball.x - p.x;
    const dz = state.ball.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < TOUCH_DIST && d > 0.01) {
      const ux = dx/d, uz = dz/d;
      state.ball.vx += ux * 6 * dt * 60 * 0.3;
      state.ball.vz += uz * 6 * dt * 60 * 0.3;
    }
    
    // kick
    if (p.input.kick && d < 2.5) {
      const kx = Math.sin(p.ry);
      const kz = Math.cos(p.ry);
      state.ball.vx += kx * 18;
      state.ball.vz += kz * 18;
      state.ball.vy += 3;
      p.kickAnim = 0.3;
      p.input.kick = false;
    }
    
    if (p.kickAnim > 0) p.kickAnim -= dt;
  }
}

function updateBall(dt) {
  const b = state.ball;
  b.vy -= 20 * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;
  
  // nảy sàn
  if (b.y <= BALL_RADIUS) {
    b.y = BALL_RADIUS;
    if (b.vy < -1) b.vy *= -0.5;
    else b.vy = 0;
    b.vx *= 0.985;
    b.vz *= 0.985;
  }
  
  // tường
  const bx = FIELD_W/2 - BALL_RADIUS;
  const bz = FIELD_H/2 - BALL_RADIUS;
  if (b.x > bx) { b.x = bx; b.vx *= -0.7; }
  if (b.x < -bx) { b.x = -bx; b.vx *= -0.7; }
  if (b.z > bz) { b.z = bz; b.vz *= -0.7; }
  if (b.z < -bz) { b.z = -bz; b.vz *= -0.7; }
}

function checkGoals() {
  if (state.scoreCooldown > 0) {
    state.scoreCooldown -= 1/TICK_RATE;
    return;
  }
  const b = state.ball;
  // Khung trên (z âm) → blue ghi bàn (team blue tấn công lên)
  if (b.z < -FIELD_H/2 + 1.5 && Math.abs(b.x) < 5 && b.y < 3.2) {
    state.scores.blue++;
    state.lastGoalBy = 'blue';
    resetBall();
    state.scoreCooldown = 2;
    io.emit('goal', { team: 'blue', scores: state.scores });
  }
  // Khung dưới (z dương) → red ghi bàn
  else if (b.z > FIELD_H/2 - 1.5 && Math.abs(b.x) < 5 && b.y < 3.2) {
    state.scores.red++;
    state.lastGoalBy = 'red';
    resetBall();
    state.scoreCooldown = 2;
    io.emit('goal', { team: 'red', scores: state.scores });
  }
}

function resetBall() {
  state.ball.x = 0;
  state.ball.y = BALL_RADIUS;
  state.ball.z = 0;
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.vz = 0;
}

function broadcastState() {
  io.emit('state', {
    ball: state.ball,
    players: state.players,
    scores: state.scores
  });
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⚽ Server running on port ${PORT}`);
});