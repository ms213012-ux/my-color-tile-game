const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));

// 모드별 설정 (타일 수 = 완파 목표 점수)
const MODE_CONFIG = {
  normal: { rows: 12, cols: 22, targetTileCount: 200, winScore: 200 }, // 200개 타일 지우면 200점
  hard: { rows: 25, cols: 40, targetTileCount: 500, winScore: 500 }   // 500개 타일 지우면 500점 (완파)
};

const rooms = {};

// 짝이 맞는 타일 세트 생성 (반드시 2개씩 쌍으로 생성)
function generateTileSet(targetTileCount, colorCount) {
  const tiles = [];
  const pairs = Math.floor(targetTileCount / 2);
  for (let i = 0; i < pairs; i++) {
    const color = i % colorCount;
    tiles.push(color, color);
  }
  return tiles;
}

// 보드 초기화
function clearBoard(board, rows, cols) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      board[r][c] = -1;
    }
  }
}

// 타일 무작위 배치
function placeTilesRandomly(board, rows, cols, tiles) {
  clearBoard(board, rows, cols);

  const emptyPositions = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      emptyPositions.push({ r, c });
    }
  }

  // Fisher-Yates 셔플
  for (let i = emptyPositions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [emptyPositions[i], emptyPositions[j]] = [emptyPositions[j], emptyPositions[i]];
  }

  const count = Math.min(tiles.length, emptyPositions.length);
  for (let i = 0; i < count; i++) {
    const { r, c } = emptyPositions[i];
    board[r][c] = tiles[i];
  }
}

// 셔플 실패 시 남은 타일만 가지고 최소 1개 이상의 길을 강제 배치 (새 타일 생성 X)
function forceValidPlacement(board, rows, cols, tiles) {
  clearBoard(board, rows, cols);
  if (tiles.length < 2) return;

  const midR = Math.floor(rows / 2);
  const midC = Math.floor(cols / 2);

  // 동일 색상 2개 타일을 중앙 빈칸 기준 위/아래 직선상에 배치하여 수 만듦
  const targetColor = tiles[0];
  board[midR - 1][midC] = targetColor;
  board[midR + 1][midC] = targetColor;

  const remainingTiles = tiles.slice(2);
  const emptyPositions = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((r === midR && c === midC) || (r === midR - 1 && c === midC) || (r === midR + 1 && c === midC)) {
        continue;
      }
      emptyPositions.push({ r, c });
    }
  }

  for (let i = emptyPositions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [emptyPositions[i], emptyPositions[j]] = [emptyPositions[j], emptyPositions[i]];
  }

  for (let i = 0; i < Math.min(remainingTiles.length, emptyPositions.length); i++) {
    const { r, c } = emptyPositions[i];
    board[r][c] = remainingTiles[i];
  }
}

function findValidMove(board, rows, cols) {
  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c] !== -1) continue;

      const colorCounts = {};
      for (const [dr, dc] of directions) {
        let nr = r + dr;
        let nc = c + dc;
        while (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
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

function countRemainingTiles(board, rows, cols) {
  let count = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c] !== -1) count++;
    }
  }
  return count;
}

function ensureValidBoard(board, config, colorCount, currentScore) {
  const { rows, cols, winScore } = config;
  let remaining = countRemainingTiles(board, rows, cols);
  let isShuffled = false;

  // 완파 또는 목표 점수 도달 시 새로운 판을 새로 채우지 않음
  if (remaining === 0 || (currentScore && currentScore >= winScore)) {
    return false;
  }

  // 수가 막혔을 때 기존 남은 타일들만 섞기
  if (remaining > 0 && !findValidMove(board, rows, cols)) {
    isShuffled = true;

    const existingTiles = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (board[r][c] !== -1) {
          existingTiles.push(board[r][c]);
        }
      }
    }

    let attempts = 0;
    let foundValid = false;
    const MAX_ATTEMPTS = 100;

    while (attempts < MAX_ATTEMPTS) {
      for (let i = existingTiles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [existingTiles[i], existingTiles[j]] = [existingTiles[j], existingTiles[i]];
      }

      placeTilesRandomly(board, rows, cols, existingTiles);

      if (findValidMove(board, rows, cols)) {
        foundValid = true;
        break;
      }
      attempts++;
    }

    if (!foundValid) {
      forceValidPlacement(board, rows, cols, existingTiles);
    }
  }

  return isShuffled;
}

function generateBoard(config, colorCount) {
  const board = Array.from({ length: config.rows }, () => Array(config.cols).fill(-1));
  const tiles = generateTileSet(config.targetTileCount, colorCount);
  placeTilesRandomly(board, config.rows, config.cols, tiles);
  ensureValidBoard(board, config, colorCount, 0);
  return board;
}

// 짝수 개(2개 또는 4개)만 제거하여 홀수 잔여 타일 발생 원천 차단
function checkAndRemoveTiles(board, r, c, rows, cols) {
  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const foundTiles = [];

  for (const [dr, dc] of directions) {
    let nr = r + dr;
    let nc = c + dc;
    while (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
      if (board[nr][nc] !== -1) {
        foundTiles.push({ r: nr, c: nc, color: board[nr][nc] });
        break;
      }
      nr += dr;
      nc += dc;
    }
  }

  const colorGroups = {};
  foundTiles.forEach(tile => {
    if (!colorGroups[tile.color]) colorGroups[tile.color] = [];
    colorGroups[tile.color].push(tile);
  });

  let removedCount = 0;
  for (const color in colorGroups) {
    const tilesOfColor = colorGroups[color];
    if (tilesOfColor.length >= 2) {
      const removeLimit = tilesOfColor.length >= 4 ? 4 : 2; // 3개일 때도 2개만 지워 홀수 방지
      for (let i = 0; i < removeLimit; i++) {
        const tile = tilesOfColor[i];
        board[tile.r][tile.c] = -1;
        removedCount++;
      }
    }
  }

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
  io.to(roomId).emit('updateScores', {
    scores,
    winScore: rooms[roomId].config.winScore
  });
}

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ roomId, colorCount, timeLimit, nickname, mode }) => {
    socket.join(roomId);

    if (!rooms[roomId] || rooms[roomId].timeRemaining <= 0) {
      if (rooms[roomId] && rooms[roomId].timer) {
        clearInterval(rooms[roomId].timer);
      }

      const selectedMode = MODE_CONFIG[mode] ? mode : 'normal';
      const config = MODE_CONFIG[selectedMode];
      const selectedTime = timeLimit || 86400;

      rooms[roomId] = {
        mode: selectedMode,
        config,
        colorCount: colorCount || 16,
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

    const room = rooms[roomId];
    room.players[socket.id] = {
      nickname: nickname || '익명',
      score: 0,
      board: generateBoard(room.config, room.colorCount)
    };

    socket.emit('initMyBoard', {
      board: room.players[socket.id].board,
      timeRemaining: room.timeRemaining,
      config: room.config
    });

    broadcastScores(roomId);
  });

  socket.on('clickTile', ({ roomId, r, c }) => {
    const room = rooms[roomId];
    if (!room || room.timeRemaining <= 0) return;

    const player = room.players[socket.id];
    if (!player || player.board[r][c] !== -1) return;

    const removedCount = checkAndRemoveTiles(player.board, r, c, room.config.rows, room.config.cols);
    const hit = removedCount > 0;

    if (hit) {
      player.score += removedCount;
    }

    let shuffled = false;
    if (player.score < room.config.winScore) {
      shuffled = ensureValidBoard(player.board, room.config, room.colorCount, player.score);
    }

    socket.emit('updateMyBoard', {
      board: player.board,
      hit,
      shuffled
    });

    broadcastScores(roomId);

    if (player.score >= room.config.winScore) {
      if (room.timer) clearInterval(room.timer);
      io.to(roomId).emit('gameOver', {
        winnerId: socket.id,
        reason: `${player.nickname}님이 ${room.config.winScore}점을 달성하여 모든 타일을 완파했습니다!`
      });
    }
  });

  socket.on('getHint', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;

    const hintPos = findValidMove(player.board, room.config.rows, room.config.cols);
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
