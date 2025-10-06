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
      capacity: [2,3,5].includes(capacity) ? capacity : 2
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
    room.votes[socket.id] = choice;

    const totalPlayers = room.players.length;
    const totalVotes = Object.keys(room.votes).length;

    // Voters by choice (usernames)
    const votersByChoice = {};
    Object.entries(room.votes).forEach(([voterId, voterChoice]) => {
      const player = room.players.find(p => p.id === voterId);
      const username = player ? player.username : 'Anon';
      if (!votersByChoice[voterChoice]) votersByChoice[voterChoice] = [];
      votersByChoice[voterChoice].push(username);
    });

    io.to(roomCode).emit('voteUpdate', {
      votes: totalVotes,
      total: totalPlayers,
      votersByChoice
    });

    if (totalVotes >= 1) { // Geçici olarak tek kişilik test için
      const voteCounts = {};
      Object.values(room.votes).forEach(vote => {
        voteCounts[vote] = (voteCounts[vote] || 0) + 1;
      });

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