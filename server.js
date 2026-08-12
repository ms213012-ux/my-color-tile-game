const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const ROWS = 22;
const COLS = 36;

const rooms = {};

// 맞출 수 있는 위치(힌트) 탐색
function findValidMove(board) {
  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c] !== -1) continue;

      const colorCounts = {};
      for (const [dr, dc] of directions) {
        let nr = r + dr;
        let nc = c + dc;
        while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
          if (board[nr][nc] !== -1) {
            const col = board[nr][nc];
            colorCounts[col] = (colorCounts[col] || 0) + 1;
            break;
          }
          nr += dr;
          nc += dc;
        }
      }

      for (const col in colorCounts) {
        if (colorCounts[col] >= 2) {
          return { r, c };
        }
      }
    }
  }
  return null;
}

// 더 이상 움직일 수 없으면 타일 셔플
function ensureValidBoard(board) {
  let attempts = 0;
  while (!findValidMove(board) && attempts < 100) {
    const tiles = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (board[r][c] !== -1) tiles.push(board[r][c]);
      }
    }

    for (let i = tiles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
    }

    let idx = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (board[r][c] !== -1) board[r][c] = tiles[idx++];
      }
    }
    attempts++;
  }
}

// 시작 시 약 28%의 빈 공간(-1) 생성으로 플레이 여유 확보
function generateBoard(colorCount) {
  const board = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      if (Math.random() < 0.28) {
        row.push(-1);
      } else {
        row.push(Math.floor(Math.random() * colorCount));
      }
    }
    board.push(row);
  }
  ensureValidBoard(board);
  return board;
}

function checkAndRemoveTiles(board, r, c) {
  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const foundTiles = [];

  for (const [dr, dc] of directions) {
    let nr = r + dr;
    let nc = c + dc;
    while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
      if (board[nr][nc] !== -1) {
        foundTiles.push({ r: nr, c: nc, color: board[nr][nc] });
        break;
      }
      nr += dr;
      nc += dc;
    }
  }

  const colorCounts = {};
  foundTiles.forEach(tile => {
    colorCounts[tile.color] = (colorCounts[tile.color] || 0) + 1;
  });

  let removedCount = 0;
  foundTiles.forEach(tile => {
    if (colorCounts[tile.color] >= 2) {
      board[tile.r][tile.c] = -1;
      removedCount++;
    }
  });

  return removedCount;
}

function broadcastScores(roomId) {
  if (!rooms[roomId]) return;
  const scores = {};
  for (const id in rooms[roomId].players) {
    scores[id] = {
      nickname: rooms[roomId].players[id].nickname,
      score: rooms[roomId].players[id].score
    };
  }
  io.to(roomId).emit('updateScores', scores);
}

io.on('connection', (socket) => {

  socket.on('joinRoom', ({ roomId, colorCount, timeLimit, nickname }) => {
    socket.join(roomId);

    if (!rooms[roomId] || rooms[roomId].timeRemaining <= 0) {
      if (rooms[roomId] && rooms[roomId].timer) {
        clearInterval(rooms[roomId].timer);
      }

      const selectedTime = timeLimit || 86400;

      rooms[roomId] = {
        colorCount: colorCount || 24,
        timeLimit: selectedTime,
        timeRemaining: selectedTime,
        players: {},
        timer: null
      };

      rooms[roomId].timer = setInterval(() => {
        if (!rooms[roomId]) return;

        if (rooms[roomId].timeRemaining > 0) {
          rooms[roomId].timeRemaining--;
          io.to(roomId).emit('updateTime', { timeRemaining: rooms[roomId].timeRemaining });
        } else {
          clearInterval(rooms[roomId].timer);
          io.to(roomId).emit('gameOver', { winnerId: null, reason: '제한 시간이 종료되었습니다!' });
        }
      }, 1000);
    }

    rooms[roomId].players[socket.id] = {
      nickname: nickname || '익명',
      score: 0,
      board: generateBoard(rooms[roomId].colorCount)
    };

    socket.emit('initMyBoard', {
      board: rooms[roomId].players[socket.id].board,
      timeRemaining: rooms[roomId].timeRemaining
    });

    broadcastScores(roomId);
  });

  socket.on('clickTile', ({ roomId, r, c }) => {
    const room = rooms[roomId];
    if (!room || room.timeRemaining <= 0) return;

    const player = room.players[socket.id];
    if (!player || player.board[r][c] !== -1) return;

    const removedCount = checkAndRemoveTiles(player.board, r, c);
    const hit = removedCount > 0;

    if (hit) {
      player.score += removedCount;
    }

    let shuffled = false;
    if (!findValidMove(player.board)) {
      ensureValidBoard(player.board);
      shuffled = true;
    }

    socket.emit('updateMyBoard', {
      board: player.board,
      hit,
      shuffled
    });

    broadcastScores(roomId);

    if (player.score >= 200) {
      if (room.timer) clearInterval(room.timer);
      io.to(roomId).emit('gameOver', {
        winnerId: socket.id,
        reason: `${player.nickname}님이 200점을 달성했습니다!`
      });
    }
  });

  socket.on('getHint', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;

    const hintPos = findValidMove(player.board);
    socket.emit('receiveHint', hintPos);
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      if (rooms[roomId].players[socket.id]) {
        delete rooms[roomId].players[socket.id];

        if (Object.keys(rooms[roomId].players).length === 0) {
          if (rooms[roomId].timer) clearInterval(rooms[roomId].timer);
          delete rooms[roomId];
        } else {
          broadcastScores(roomId);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
