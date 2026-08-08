const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname + '/public'));

const ROWS = 18;
const COLS = 26;
const TARGET_SCORE = 200;

const rooms = {};

io.on('connection', (socket) => {
  console.log(`[접속] 플레이어 연결됨: ${socket.id}`);

  socket.on('joinRoom', ({ roomId, colorCount, timeLimit, nickname }) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        initialBoard: generateBoard(colorCount),
        players: {},
        timeRemaining: timeLimit || 180,
        timerInterval: null
      };
      startRoomTimer(roomId);
    }

    // 플레이어 정보 등록 (닉네임 포함)
    rooms[roomId].players[socket.id] = {
      board: JSON.parse(JSON.stringify(rooms[roomId].initialBoard)),
      score: 0,
      nickname: nickname || '익명'
    };

    socket.emit('initMyBoard', {
      board: rooms[roomId].players[socket.id].board,
      timeRemaining: rooms[roomId].timeRemaining
    });

    // 닉네임 및 점수 현황 방 전체에 전송
    sendScoresUpdate(roomId);
  });

  socket.on('clickTile', ({ roomId, r, c }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id] || room.timeRemaining <= 0) return;

    const player = room.players[socket.id];
    const board = player.board;

    if (board[r][c] !== -1) return;

    const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    const foundTiles = [];

    directions.forEach(([dr, dc]) => {
      let nr = r + dr, nc = c + dc;
      while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
        if (board[nr][nc] !== -1) {
          foundTiles.push({ r: nr, c: nc, color: board[nr][nc] });
          break;
        }
        nr += dr;
        nc += dc;
      }
    });

    const colorCounts = {};
    foundTiles.forEach(t => {
      colorCounts[t.color] = (colorCounts[t.color] || 0) + 1;
    });

    let destroyedCount = 0;
    foundTiles.forEach(t => {
      if (colorCounts[t.color] >= 2) {
        board[t.r][t.c] = -1;
        destroyedCount++;
      }
    });

    if (destroyedCount > 0) {
      player.score += destroyedCount;
    } else {
      player.score = Math.max(0, player.score - 1);
    }

    socket.emit('updateMyBoard', {
      board: player.board,
      hit: destroyedCount > 0
    });

    sendScoresUpdate(roomId);

    if (player.score >= TARGET_SCORE) {
      io.to(roomId).emit('gameOver', { winnerId: socket.id, reason: '200점 먼저 달성!' });
      clearInterval(room.timerInterval);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[해제] 플레이어 연결 종료: ${socket.id}`);
    Object.keys(rooms).forEach(roomId => {
      if (rooms[roomId].players[socket.id]) {
        delete rooms[roomId].players[socket.id];
        if (Object.keys(rooms[roomId].players).length === 0) {
          clearInterval(rooms[roomId].timerInterval);
          delete rooms[roomId];
        } else {
          sendScoresUpdate(roomId);
        }
      }
    });
  });
});

function startRoomTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.timerInterval = setInterval(() => {
    room.timeRemaining--;
    io.to(roomId).emit('updateTime', { timeRemaining: room.timeRemaining });

    if (room.timeRemaining <= 0) {
      clearInterval(room.timerInterval);
      io.to(roomId).emit('gameOver', { winnerId: null, reason: '시간 초과!' });
    }
  }, 1000);
}

function sendScoresUpdate(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const scoreData = {};
  Object.keys(room.players).forEach(id => {
    scoreData[id] = {
      score: room.players[id].score,
      nickname: room.players[id].nickname
    };
  });

  io.to(roomId).emit('updateScores', scoreData);
}

function generateBoard(colorCount) {
  const board = [];
  for (let r = 0; r < ROWS; r++) {
    board[r] = [];
    for (let c = 0; c < COLS; c++) {
      const isEmpty = Math.random() < 0.15;
      board[r][c] = isEmpty ? -1 : Math.floor(Math.random() * colorCount);
    }
  }
  return board;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 서버가 실행되었습니다: http://localhost:${PORT}`);
});
