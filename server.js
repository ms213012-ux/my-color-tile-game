const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 정적 파일 제공 (public 폴더)
app.use(express.static(path.join(__dirname, 'public')));

// 방 상태 관리 객체
const rooms = {};

// 보드 생성 함수
function createBoard(width, height, colorCount) {
  const board = [];
  for (let r = 0; r < height; r++) {
    const row = [];
    for (let c = 0; c < width; c++) {
      row.push(Math.floor(Math.random() * colorCount));
    }
    board.push(row);
  }
  return board;
}

// Flood Fill 알고리즘 (동일 색상 연쇄 변경)
function floodFill(board, targetColor, replacementColor) {
  if (targetColor === replacementColor) return;
  const height = board.length;
  const width = board[0].length;

  function dfs(r, c) {
    if (r < 0 || r >= height || c < 0 || c >= width) return;
    if (board[r][c] !== targetColor) return;

    board[r][c] = replacementColor;
    dfs(r + 1, c);
    dfs(r - 1, c);
    dfs(r, c + 1);
    dfs(r, c - 1);
  }

  dfs(0, 0);
}

// 보드 완판 여부 확인
function isBoardCleared(board) {
  const target = board[0][0];
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board[r].length; c++) {
      if (board[r][c] !== target) return false;
    }
  }
  return true;
}

// 힌트 찾기 (가장 많은 타일 영역을 늘려주는 색상 추천)
function getBestHintColor(board, colorCount) {
  const currentColor = board[0][0];
  let maxCount = -1;
  let bestColor = (currentColor + 1) % colorCount;

  for (let color = 0; color < colorCount; color++) {
    if (color === currentColor) continue;

    // 가상 보드 복사 후 flood fill 실행
    const tempBoard = board.map(row => [...row]);
    floodFill(tempBoard, currentColor, color);

    // 색상 변경 후 연동된 영역 크기 측정
    let count = 0;
    const visited = tempBoard.map(row => row.map(() => false));
    const stack = [[0, 0]];
    visited[0][0] = true;

    while (stack.length > 0) {
      const [r, c] = stack.pop();
      count++;
      const neighbors = [[r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]];
      for (const [nr, nc] of neighbors) {
        if (
          nr >= 0 && nr < tempBoard.length &&
          nc >= 0 && nc < tempBoard[0].length &&
          !visited[nr][nc] &&
          tempBoard[nr][nc] === color
        ) {
          visited[nr][nc] = true;
          stack.push([nr, nc]);
        }
      }
    }

    if (count > maxCount) {
      maxCount = count;
      bestColor = color;
    }
  }

  return bestColor;
}

// Socket.io 연결 처리
io.on('connection', (socket) => {
  console.log(`클라이언트 연결됨: ${socket.id}`);

  // 방 참가 및 생성
  socket.on('joinRoom', ({ roomId, colorCount, width, height, timeLimit }) => {
    const rId = roomId.trim() || 'default-room';
    
    // 최대 색상 수 32개 허용으로 수정 완료
    const safeColorCount = Math.min(Math.max(parseInt(colorCount) || 16, 2), 32);
    const safeWidth = Math.min(Math.max(parseInt(width) || 12, 4), 30);
    const safeHeight = Math.min(Math.max(parseInt(height) || 12, 4), 30);
    const safeTimeLimit = Math.min(Math.max(parseInt(timeLimit) || 60, 10), 300);

    socket.join(rId);
    socket.roomId = rId;

    if (!rooms[rId]) {
      rooms[rId] = {
        players: {},
        colorCount: safeColorCount,
        width: safeWidth,
        height: safeHeight,
        timeLimit: safeTimeLimit,
        timeRemaining: safeTimeLimit,
        timerInterval: null
      };
    }

    const room = rooms[rId];

    // 플레이어 보드 초기화
    room.players[socket.id] = {
      board: createBoard(room.width, room.height, room.colorCount),
      cleared: false,
      moves: 0
    };

    // 타임아웃 타이머 시작 (첫 플레이어 입장 시)
    if (!room.timerInterval) {
      room.timerInterval = setInterval(() => {
        room.timeRemaining--;
        io.to(rId).emit('timeUpdate', { timeRemaining: room.timeRemaining });

        if (room.timeRemaining <= 0) {
          clearInterval(room.timerInterval);
          room.timerInterval = null;
          io.to(rId).emit('gameOver', { reason: '시간 초과! 게임이 종료되었습니다.' });
        }
      }, 1000);
    }

    // colorCount 포함하여 내 보드 정보 클라이언트에 전송 (동기화 버그 수정 완료)
    socket.emit('initMyBoard', {
      board: room.players[socket.id].board,
      timeRemaining: room.timeRemaining,
      config: {
        width: room.width,
        height: room.height,
        timeLimit: room.timeLimit
      },
      colorCount: room.colorCount
    });

    // 방의 접속자 수 갱신 알림
    io.to(rId).emit('roomInfo', { playerCount: Object.keys(room.players).length });
  });

  // 타일 클릭 (색상 선택)
  socket.on('clickTile', ({ selectedColor }) => {
    const rId = socket.roomId;
    if (!rId || !rooms[rId]) return;

    const room = rooms[rId];
    const player = room.players[socket.id];
    if (!player || player.cleared || room.timeRemaining <= 0) return;

    const currentColor = player.board[0][0];
    if (currentColor === selectedColor) return;

    // Flood Fill 수행
    floodFill(player.board, currentColor, selectedColor);
    player.moves++;

    // 보드 상태 클라이언트에 전송
    socket.emit('updateBoard', {
      board: player.board,
      moves: player.moves
    });

    // 클리어 여부 확인
    if (isBoardCleared(player.board)) {
      player.cleared = true;
      socket.emit('gameCleared', { moves: player.moves, timeLeft: room.timeRemaining });
      
      // 방 내의 모든 유저가 클리어했는지 확인
      const allCleared = Object.values(room.players).every(p => p.cleared);
      if (allCleared) {
        if (room.timerInterval) {
          clearInterval(room.timerInterval);
          room.timerInterval = null;
        }
        io.to(rId).emit('allPlayersCleared');
      }
    }
  });

  // 힌트 요청
  socket.on('requestHint', () => {
    const rId = socket.roomId;
    if (!rId || !rooms[rId]) return;

    const room = rooms[rId];
    const player = room.players[socket.id];
    if (!player || player.cleared) return;

    const hintColor = getBestHintColor(player.board, room.colorCount);
    socket.emit('receiveHint', { hintColor });
  });

  // 연결 해제
  socket.on('disconnect', () => {
    const rId = socket.roomId;
    if (rId && rooms[rId]) {
      delete rooms[rId].players[socket.id];
      const remainingPlayers = Object.keys(rooms[rId].players).length;

      if (remainingPlayers === 0) {
        if (rooms[rId].timerInterval) {
          clearInterval(rooms[rId].timerInterval);
        }
        delete rooms[rId];
      } else {
        io.to(rId).emit('roomInfo', { playerCount: remainingPlayers });
      }
    }
    console.log(`클라이언트 퇴장: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 서버가 포트 ${PORT}에서 실행 중입니다.`);
});
