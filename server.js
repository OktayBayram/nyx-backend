const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const rooms = {};
const chatBuffers = {}; // roomCode -> array of last messages (max 5)

function cleanDisconnected(io, room) {
  if (!room || !room.players) return;
  room.players = room.players.filter(p => io.sockets.sockets.get(p.id));
}

io.on('connection', (socket) => {
  console.log('Oyuncu baglandi:', socket.id);

  socket.on('createRoom', ({ username, capacity }) => {
    const roomCode = '1234';
    
    rooms[roomCode] = {
      players: [{
        id: socket.id,
        username: username,
        isHost: true
      }],
      currentPassage: 0,
      votes: {},
      gameStarted: false,
      capacity: [1,2,3,5].includes(capacity) ? capacity : 2,
      ready: {}
    };

    socket.join(roomCode);
    socket.emit('roomCreated', { roomCode, room: rooms[roomCode] });
    console.log('Oda olusturuldu:', roomCode);
  });

  socket.on('joinRoom', ({ roomCode, username }) => {
    if (!rooms[roomCode]) {
      socket.emit('error', { message: 'Oda bulunamadi' });
      return;
    }

    const room = rooms[roomCode];
    // prune stale players before capacity check
    cleanDisconnected(io, room);
    if (room.capacity && room.players.length >= room.capacity) {
      socket.emit('error', { message: 'Oda dolu' });
      return;
    }

    room.players.push({
      id: socket.id,
      username: username,
      isHost: false
    });

    socket.join(roomCode);
    socket.emit('roomJoined', { room: rooms[roomCode] });
    // Send last 5 chat messages if exist
    if (chatBuffers[roomCode]?.length) {
      chatBuffers[roomCode].forEach(m => socket.emit('lobbyChatMessage', m));
    }
    io.to(roomCode).emit('playerJoined', { room: rooms[roomCode] });
    console.log(username, 'odaya katildi:', roomCode);
  });

  // Client leaves lobby explicitly
  socket.on('leaveRoom', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.ready) delete room.ready[socket.id];
    try { socket.leave(roomCode); } catch {}
    if (room.players.length === 0) {
      delete rooms[roomCode];
    } else {
      io.to(roomCode).emit('playerLeft', { room });
    }
  });

  socket.on('startGame', ({ roomCode }) => {
    console.log('startGame event received for room:', roomCode);
    if (rooms[roomCode]) {
      const room = rooms[roomCode];
      room.gameStarted = true;
      console.log('Emitting gameStarted to room:', roomCode, 'with', room.players.length, 'players');
      io.to(roomCode).emit('gameStarted', { room: room });
    } else {
      console.log('Room not found:', roomCode);
    }
  });

  // Lobby chat: broadcast and keep only last 5
  socket.on('lobbyChat', ({ roomCode, user, text, time }) => {
    if (!rooms[roomCode]) return;
    const payload = { user, text, time };
    chatBuffers[roomCode] = chatBuffers[roomCode] || [];
    chatBuffers[roomCode].push(payload);
    if (chatBuffers[roomCode].length > 5) chatBuffers[roomCode].shift();
    io.to(roomCode).emit('lobbyChatMessage', payload);
  });

  // Ready toggle per player; host approval required (no auto-start)
  socket.on('ready', ({ roomCode, ready }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.ready[socket.id] = !!ready;
    const host = room.players.find(p => p.isHost);
    const nonHostIds = room.players.filter(p => !p.isHost).map(p => p.id);
    const readyCount = nonHostIds.filter(id => !!room.ready[id]).length;
    const total = nonHostIds.length;
    io.to(roomCode).emit('readyUpdate', { ready: readyCount, total });
  });

  // Kick by host
  socket.on('kick', ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const host = room.players.find(p => p.isHost);
    if (!host || host.id !== socket.id) return; // only host can kick
    const index = room.players.findIndex(p => p.id === targetId);
    if (index === -1) return;
    const kicked = room.players[index];
    room.players.splice(index, 1);
    delete room.ready[targetId];
    try {
      io.to(targetId).emit('kicked');
      const sock = io.sockets.sockets.get(targetId);
      if (sock) {
        sock.leave(roomCode);
        sock.disconnect(true);
      }
    } catch {}
    io.to(roomCode).emit('playerLeft', { room: room });
  });

  socket.on('skipText', ({ roomCode, username, currentPassage }) => {
    console.log('Skip text received:', { roomCode, username, currentPassage, socketId: socket.id });
    if (!rooms[roomCode]) return;
    
    const room = rooms[roomCode];
    // Skip event'ini tüm oyunculara bildir
    io.to(roomCode).emit('textSkipped', { username, currentPassage });
  });

  socket.on('vote', ({ roomCode, choice }) => {
    console.log('Vote received:', { roomCode, choice, socketId: socket.id });
    if (!rooms[roomCode]) return;

    const room = rooms[roomCode];
    // aktif oyuncuları temizle (kopan soketleri çıkar)
    cleanDisconnected(io, room);
    room.votes[socket.id] = choice;

    const roomSet = io.sockets.adapter.rooms.get(roomCode);
    const connectedIds = room.players
      .map(p => p.id)
      .filter(id => io.sockets.sockets.get(id) && (!roomSet || roomSet.has(id)));
    const totalPlayers = connectedIds.length; // tüm bağlı ve odada olan oyuncular
    const totalVotesFiltered = Object.keys(room.votes).filter(id => connectedIds.includes(id)).length;

    console.log('DEBUG: Vote logic:', { 
      totalPlayers, 
      totalVotesFiltered, 
      roomPlayers: room.players.length,
      connectedIds: connectedIds.length,
      votes: Object.keys(room.votes).length
    });

    // Voters by choice (usernames) - sadece bağlı oyuncular
    const votersByChoice = {};
    Object.entries(room.votes).forEach(([voterId, voterChoice]) => {
      if (!connectedIds.includes(voterId)) return;
      const player = room.players.find(p => p.id === voterId);
      const username = player ? player.username : 'Anon';
      if (!votersByChoice[voterChoice]) votersByChoice[voterChoice] = [];
      votersByChoice[voterChoice].push(username);
    });

    io.to(roomCode).emit('voteUpdate', {
      votes: totalVotesFiltered,
      total: totalPlayers,
      votersByChoice
    });

    // Oy sayımları
    const voteCounts = {};
    Object.entries(room.votes).forEach(([voterId, vote]) => {
      if (!connectedIds.includes(voterId)) return; // sadece bağlı oylar
      voteCounts[vote] = (voteCounts[vote] || 0) + 1;
    });

    // Tek oyuncu modu: ilk oyda hemen ilerle
    if (totalPlayers === 1 && totalVotesFiltered >= 1) {
      const onlyVoterId = connectedIds[0];
      const winner = room.votes[onlyVoterId];
      const voteCounts = { [winner]: 1 };
      const votersByChoiceFinal = { [winner]: [ (room.players.find(p=>p.id===onlyVoterId)?.username) || 'Anon' ] };
      room.votes = {};
      const nextPassage = room.currentPassage + 1;
      room.currentPassage = nextPassage;
      const passageId = winner;
      io.to(roomCode).emit('voteResult', { choice: winner, voteCounts, votersByChoice: votersByChoiceFinal, nextPassage: passageId, achievement: null });
      return;
    }

    // Tüm oyuncular oy verince sonucu hesapla (çoğunluk çıkmadıysa/tie durumu)
    if (totalPlayers >= 2 && totalVotesFiltered === totalPlayers) {
      // voteCounts zaten hesaplı

      let winner = null;
      const maxCount = Math.max(...Object.values(voteCounts));
      const topChoices = Object.keys(voteCounts).filter(k => voteCounts[k] === maxCount);

      // Sonuçla birlikte detayları gönder
      const votersByChoiceFinal = {};
      Object.entries(room.votes).forEach(([voterId, voterChoice]) => {
        const player = room.players.find(p => p.id === voterId);
        const username = player ? player.username : 'Anon';
        if (!votersByChoiceFinal[voterChoice]) votersByChoiceFinal[voterChoice] = [];
        votersByChoiceFinal[voterChoice].push(username);
      });

      if (topChoices.length > 1) {
        // Beraberlik durumu - server +1 oy ekleyecek
        const randomIndex = Math.floor(Math.random() * topChoices.length);
        winner = topChoices[randomIndex];
        
        // Server oyunu ekle
        voteCounts[winner] = (voteCounts[winner] || 0) + 1;
        votersByChoiceFinal[winner] = votersByChoiceFinal[winner] || [];
        votersByChoiceFinal[winner].push('Server');
        
        console.log('Tie resolved with server vote:', { winner, topChoices, newVoteCounts: voteCounts });
      } else {
        winner = topChoices[0];
      }

      room.votes = {};

      // Basit achievement sinyali: 3 tur üst üste oybirliği
      room._unanimousStreak = room._unanimousStreak || 0;
      const isUnanimous = Object.keys(voteCounts).length === 1;
      room._unanimousStreak = isUnanimous ? room._unanimousStreak + 1 : 0;

      // Sonraki passage'ı hesapla
      const nextPassage = room.currentPassage + 1;
      room.currentPassage = nextPassage;
      
      // Seçilen seçeneğe göre doğru key'i gönder
      const passageId = winner;

      console.log('Emitting voteResult with nextPassage:', passageId, 'to room:', roomCode);
      console.log('Room players:', room.players.map(p => p.username));
      io.to(roomCode).emit('voteResult', { 
        choice: winner,
        voteCounts: voteCounts,
        votersByChoice: votersByChoiceFinal,
        nextPassage: passageId,
        achievement: room._unanimousStreak >= 3 ? { key: 'unanimous_3', label: '3 Tur Üst Üste Oybirliği' } : null
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('Oyuncu ayrildi:', socket.id);
    
    Object.keys(rooms).forEach(roomCode => {
      const room = rooms[roomCode];
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.ready) delete room.ready[socket.id];
      
      if (room.players.length === 0) {
        delete rooms[roomCode];
      } else {
        io.to(roomCode).emit('playerLeft', { room: room });
      }
    });
  });
});

const PORT = 3002;
server.listen(PORT, () => {
  console.log('Server calisiyor: http://localhost:' + PORT);
});