const express = require('express');

const http = require('http');

const { Server } = require('socket.io');



const app = express();

const server = http.createServer(app);

const io = new Server(server);



app.use(express.static('public'));



// 모드별 설정 값

const MODE_CONFIG = {

  normal: { rows: 12, cols: 22, targetTileCount: 198, winScore: 200, refillThreshold: 30 },

  hard: { rows: 20, cols: 30, targetTileCount: 450, winScore: 500, refillThreshold: 40 }

};



const rooms = {};



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



function ensureValidBoard(board, config, colorCount) {

  const { rows, cols, targetTileCount, refillThreshold } = config;

  let remaining = countRemainingTiles(board, rows, cols);



  if (remaining < refillThreshold || !findValidMove(board, rows, cols)) {

    const tiles = [];

    for (let r = 0; r < rows; r++) {

      for (let c = 0; c < cols; c++) {

        if (board[r][c] !== -1) tiles.push(board[r][c]);

      }

    }



    while (tiles.length < targetTileCount) {

      tiles.push(Math.floor(Math.random() * colorCount));

    }



    for (let i = tiles.length - 1; i > 0; i--) {

      const j = Math.floor(Math.random() * (i + 1));

      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];

    }



    for (let r = 0; r < rows; r++) {

      for (let c = 0; c < cols; c++) {

        board[r][c] = -1;

      }

    }



    let placed = 0;

    while (placed < targetTileCount) {

      const r = Math.floor(Math.random() * rows);

      const c = Math.floor(Math.random() * cols);

      if (board[r][c] === -1) {

        board[r][c] = tiles[placed++];

      }

    }

  }



  let attempts = 0;

  while (!findValidMove(board, rows, cols) && attempts < 50) {

    const tiles = [];

    for (let r = 0; r < rows; r++) {

      for (let c = 0; c < cols; c++) {

        if (board[r][c] !== -1) tiles.push(board[r][c]);

      }

    }

    for (let i = tiles.length - 1; i > 0; i--) {

      const j = Math.floor(Math.random() * (i + 1));

      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];

    }

    let idx = 0;

    for (let r = 0; r < rows; r++) {

      for (let c = 0; c < cols; c++) {

        if (board[r][c] !== -1) board[r][c] = tiles[idx++];

      }

    }

    attempts++;

  }

}



function generateBoard(config, colorCount) {

  const { rows, cols, targetTileCount } = config;

  const board = Array.from({ length: rows }, () => Array(cols).fill(-1));

  const tiles = [];



  for (let i = 0; i < targetTileCount; i++) {

    tiles.push(Math.floor(Math.random() * colorCount));

  }



  let placed = 0;

  while (placed < targetTileCount) {

    const r = Math.floor(Math.random() * rows);

    const c = Math.floor(Math.random() * cols);

    if (board[r][c] === -1) {

      board[r][c] = tiles[placed++];

    }

  }



  ensureValidBoard(board, config, colorCount);

  return board;

}



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

    const oldTileCount = countRemainingTiles(player.board, room.config.rows, room.config.cols);

    

    ensureValidBoard(player.board, room.config, room.colorCount);

    if (countRemainingTiles(player.board, room.config.rows, room.config.cols) > oldTileCount) {

      shuffled = true;

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

        reason: `${player.nickname}님이 ${room.config.winScore}점을 달성했습니다!`

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
