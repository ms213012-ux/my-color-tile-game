const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// 보드 생성 (25% 확률로 빈 공간 배치)
function createBoard(width, height, colorCount) {
  const board = [];
  for (let r = 0; r < height; r++) {
    const row = [];
    for (let c = 0; c < width; c++) {
      // 25% 확률로 빈 공간(null) 배치
      if (Math.random() < 0.25) {
        row.push(null);
      } else {
        row.push(Math.floor(Math.random() * colorCount));
      }
    }
    board.push(row);
  }
  return board;
}

// 4방향 직선 레이저 타일 제거 로직
function checkAndRemoveTiles(board, r, c) {
  const height = board.length;
  const width = board[0].length;
  
  const directions = [
    [-1, 0], [1, 0], [0, -1], [0, 1] // 상, 하, 좌, 우
  ];

  const found = [];

  for (const [dr, dc] of directions) {
    let nr = r + dr;
    let nc = c + dc;
    while (nr >= 0 && nr < height && nc >= 0 && nc < width) {
      if (board[nr][nc] !== null) {
        found.push({ r: nr, c: nc, color: board[nr][nc] });
        break; // 각 방향별 첫번째 타일
      }
      nr += dr;
      nc += dc;
    }
  }

  const colorGroups = {};
  found.forEach(item => {
    if (!colorGroups[item.color]) colorGroups[item.color] = [];
    colorGroups[item.color].push(item);
  });

  let removedCount = 0;
  Object.values(colorGroups).forEach(group => {
    if (group.length >= 2) {
      group.forEach(item => {
        if (board[item.r][item.c] !== null) {
          board[item.r][item.c] = null;
          removedCount++;
        }
      });
    }
  });

  return removedCount;
}

// 힌트 탐색
function getBestHint(board) {
  const height = board.length;
  const width = board[0].length;

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      const found = [];
      for (const [dr, dc] of directions) {
        let nr = r + dr;
        let nc = c + dc;
        while (nr >= 0 && nr < height && nc >= 0 && nc < width) {
          if (board[nr][nc] !== null) {
            found.push(board[nr][nc]);
            break;
          }
          nr += dr;
          nc += dc;
        }
      }
      
      const counts = {};
      for (const col of found) {
        counts[col] = (counts[col] || 0) + 1;
        if (counts[col] >= 2) return { r, c };
      }
    }
  }
  return null;
}

io.on('connection', (socket) => {
  console.log(`클라이언트 연결: ${socket.id}`);

  socket.on('joinRoom', ({ roomId, playerName, colorCount, width, height, targetScore, timeLimit }) => {
    const rId = roomId.trim() || 'default-room';
    const name = playerName.trim() || `플레이어_${socket.id.substring(0, 4)}`;
    const safeTargetScore = parseInt(targetScore) || 200;
    const safeColorCount = Math.min(Math.max(parseInt(colorCount) || 8, 2), 24);
    const safeWidth = Math.min(Math.max(parseInt(width) || 16, 6), 30);
    const safeHeight = Math.min(Math.max(parseInt(height) || 12, 6), 30);
    const safeTimeLimit = Math.min(Math.max(parseInt(timeLimit) || 120, 10), 600);

    socket.join(rId);
    socket.roomId = rId;

    if (!rooms[rId]) {
      rooms[rId] = {
        players: {},
        targetScore: safeTargetScore,
        colorCount: safeColorCount,
        width: safeWidth,
        height: safeHeight,
        timeLimit: safeTimeLimit,
        timeRemaining: safeTimeLimit,
        timerInterval: null,
        gameOver: false
      };
    }

    const room = rooms[rId];

    room.players[socket.id] = {
      id: socket.id,
      name: name,
      board: createBoard(room.width, room.height, room.colorCount),
      score: 0
    };

    // 멀티플레이 타이머
    if (!room.timerInterval) {
      room.timerInterval = setInterval(() => {
        if (room.gameOver) return;
        room.timeRemaining--;
        io.to(rId).emit('timeUpdate', { timeRemaining: room.timeRemaining });

        if (room.timeRemaining <= 0) {
          clearInterval(room.timerInterval);
          room.timerInterval = null;
          room.gameOver = true;

          // 시간 종료 시 최고점 플레이어 찾기
          const playerList = Object.values(room.players);
          playerList.sort((a, b) => b.score - a.score);
          const winner = playerList[0];

          io.to(rId).emit('matchEnded', {
            winnerName: winner ? winner.name : '없음',
            winnerScore: winner ? winner.score : 0,
            reason: '시간이 종료되었습니다!'
          });
        }
      }, 1000);
    }

    // 접속한 유저에게 본인 보드 및 방 정보 전송
    socket.emit('initMyBoard', {
      board: room.players[socket.id].board,
      targetScore: room.targetScore,
      timeRemaining: room.timeRemaining,
      colorCount: room.colorCount
    });

    // 방 안의 전체 플레이어 상황 브로드캐스트
    broadcastRoomStatus(rId);
  });

  function broadcastRoomStatus(rId) {
    const room = rooms[rId];
    if (!room) return;

    const playerList = Object.values(room.players).map(p => ({
      id: p.id,
      name: p.name,
      score: p.score
    }));

    io.to(rId).emit('roomStatusUpdate', {
      players: playerList,
      targetScore: room.targetScore
    });
  }

  // 타일 클릭 이벤트
  socket.on('clickTile', ({ r, c }) => {
    const rId = socket.roomId;
    if (!rId || !rooms[rId] || rooms[rId].gameOver) return;

    const room = rooms[rId];
    const player = room.players[socket.id];
    if (!player) return;

    const removedCount = checkAndRemoveTiles(player.board, r, c);
    
    if (removedCount > 0) {
      player.score += removedCount * 10;
      
      socket.emit('updateBoard', {
        board: player.board,
        score: player.score
      });

      broadcastRoomStatus(rId);

      // 목표 점수 달성 확인 (200점 / 500점 승리 메커니즘)
      if (player.score >= room.targetScore) {
        room.gameOver = true;
        if (room.timerInterval) clearInterval(room.timerInterval);

        io.to(rId).emit('matchEnded', {
          winnerName: player.name,
          winnerScore: player.score,
          reason: `목표 점수 ${room.targetScore}점을 달성했습니다!`
        });
      }
    }
  });

  socket.on('requestHint', () => {
    const rId = socket.roomId;
    if (!rId || !rooms[rId] || rooms[rId].gameOver) return;

    const player = rooms[rId].players[socket.id];
    if (!player) return;

    const hintPos = getBestHint(player.board);
    socket.emit('receiveHint', { hintPos });
  });

  socket.on('disconnect', () => {
    const rId = socket.roomId;
    if (rId && rooms[rId]) {
      delete rooms[rId].players[socket.id];
      const remaining = Object.keys(rooms[rId].players).length;

      if (remaining === 0) {
        if (rooms[rId].timerInterval) clearInterval(rooms[rId].timerInterval);
        delete rooms[rId];
      } else {
        broadcastRoomStatus(rId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Color Tile Server running on port ${PORT}`));
