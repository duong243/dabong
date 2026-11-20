// Tìm và thay thế toàn bộ file server.js bằng code này:

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const FIELD_W = 120; 
const FIELD_H = 180;
const BALL_RADIUS = 1.0;
const TICK_RATE = 30;

const state = {
  ball: { x: 0, y: BALL_RADIUS, z: 0, vx: 0, vy: 0, vz: 0 },
  players: {}, 
  scores: { red: 0, blue: 0 },
  scoreCooldown: 0,
};

const COLORS = [0x3498db, 0xe74c3c, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0x1abc9c];
let colorIdx = 0;

io.on('connection', (socket) => {
  const team = Math.random() < 0.5 ? 'red' : 'blue';
  state.players[socket.id] = {
    x: (Math.random() - 0.5) * 20,
    y: 0,
    z: team === 'red' ? -60 : 60,
    ry: 0,
    color: COLORS[colorIdx++ % COLORS.length],
    team: team,
    name: 'Player ' + socket.id.slice(0, 4),
    kickAnim: 0,
    isRunning: false,
    isCharging: false // Trạng thái đang lấy đà
  };

  socket.emit('init', { id: socket.id, state, fieldW: FIELD_W, fieldH: FIELD_H, ballRadius: BALL_RADIUS });
  socket.broadcast.emit('playerJoined', { id: socket.id, player: state.players[socket.id] });

  socket.on('input', (data) => {
    const p = state.players[socket.id];
    if (!p) return;
    p.input = { mx: data.mx || 0, mz: data.mz || 0, kick: !!data.kick, sprint: !!data.sprint, charging: !!data.charging };
  });

  socket.on('disconnect', () => {
    delete state.players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

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
  const PLAYER_SPEED = 15;
  const SPRINT_MUL = 1.5;
  const DRIBBLE_DIST = 3.5;

  for (const id in state.players) {
    const p = state.players[id];
    if (!p.input) continue;
    
    const { mx, mz, sprint, charging } = p.input;
    const mag = Math.hypot(mx, mz);
    let nx = mx, nz = mz;
    if (mag > 1) { nx /= mag; nz /= mag; }
    
    // Nếu đang lấy đà thì đi chậm lại
    let speed = PLAYER_SPEED * (sprint ? SPRINT_MUL : 1);
    if (charging) speed *= 0.3;

    p.x += nx * speed * dt;
    p.z += nz * speed * dt;
    p.isRunning = mag > 0.1;
    
    p.x = clamp(p.x, -FIELD_W/2 + 2, FIELD_W/2 - 2);
    p.z = clamp(p.z, -FIELD_H/2 + 2, FIELD_H/2 - 2);
    
    if (p.isRunning) p.ry = Math.atan2(nx, nz);
    
    // Bóng dính chân
    const dx = state.ball.x - p.x;
    const dz = state.ball.z - p.z;
    const distToBall = Math.hypot(dx, dz);
    
    if (distToBall < DRIBBLE_DIST && state.ball.y < 2) {
      const targetX = p.x + Math.sin(p.ry) * 1.8;
      const targetZ = p.z + Math.cos(p.ry) * 1.8;
      state.ball.x += (targetX - state.ball.x) * 10 * dt;
      state.ball.z += (targetZ - state.ball.z) * 10 * dt;
      state.ball.vx *= 0.5;
      state.ball.vz *= 0.5;
    }
    
    // Xử lý sút
    if (p.input.kick && distToBall < DRIBBLE_DIST + 1.5) {
      const kx = Math.sin(p.ry);
      const kz = Math.cos(p.ry);
      
      // Lấy lực từ client (mặc định 1 nếu không có)
      const power = p.input.power || 1; 
      
      state.ball.vx = kx * 20 * power; 
      state.ball.vz = kz * 20 * power;
      state.ball.vy = 5 + (power * 3);
      
      p.kickAnim = 0.3;
      p.input.kick = false;
    }
    
    if (p.kickAnim > 0) p.kickAnim -= dt;
  }
}

// ... (Giữ nguyên các hàm updateBall, checkGoals, resetBall, broadcastState, clamp như cũ)
function updateBall(dt) {
  const b = state.ball;
  b.vy -= 25 * dt;
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
  
  if (b.y <= BALL_RADIUS) {
    b.y = BALL_RADIUS;
    if (b.vy < -2) b.vy *= -0.6; else b.vy = 0;
    b.vx *= 0.98; b.vz *= 0.98;
  }
  
  const bx = FIELD_W/2 - BALL_RADIUS;
  const bz = FIELD_H/2 - BALL_RADIUS;
  if (b.x > bx) { b.x = bx; b.vx *= -0.7; }
  if (b.x < -bx) { b.x = -bx; b.vx *= -0.7; }
  if (b.z > bz) { b.z = bz; b.vz *= -0.7; }
  if (b.z < -bz) { b.z = -bz; b.vz *= -0.7; }
}

function checkGoals() {
  if (state.scoreCooldown > 0) { state.scoreCooldown -= 1/TICK_RATE; return; }
  const b = state.ball;
  const GOAL_W = 20, GOAL_H = 6;
  
  if (b.z < -FIELD_H/2 + 3 && Math.abs(b.x) < GOAL_W/2 && b.y < GOAL_H) {
    state.scores.blue++; resetBall(); state.scoreCooldown = 2;
    io.emit('goal', { team: 'blue', scores: state.scores });
  } else if (b.z > FIELD_H/2 - 3 && Math.abs(b.x) < GOAL_W/2 && b.y < GOAL_H) {
    state.scores.red++; resetBall(); state.scoreCooldown = 2;
    io.emit('goal', { team: 'red', scores: state.scores });
  }
}

function resetBall() {
  state.ball.x = 0; state.ball.y = BALL_RADIUS + 5; state.ball.z = 0;
  state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
}

function broadcastState() {
  io.emit('state', { ball: state.ball, players: state.players, scores: state.scores });
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`⚽ Server running on port ${PORT}`));
