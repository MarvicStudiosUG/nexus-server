const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// ─── FILE PATHS ──────────────────────────────────────────────────
const ROOMS_FILE = path.join(__dirname, 'rooms.json');

// ─── IN-MEMORY STORE ─────────────────────────────────────────────
let rooms = {};

// ─── LOAD / SAVE ROOMS ──────────────────────────────────────────
function loadRooms() {
  try {
    if (fs.existsSync(ROOMS_FILE)) {
      const data = fs.readFileSync(ROOMS_FILE, 'utf8');
      rooms = JSON.parse(data);
      // Convert string member counts to numbers
      for (const id in rooms) {
        const r = rooms[id];
        r.memberCount = parseInt(r.memberCount) || 0;
        r.members = r.members || {};
        if (typeof r.passwordProtected === 'undefined') {
          r.passwordProtected = !!r.password;
        }
      }
    } else {
      rooms = {};
      saveRooms();
    }
  } catch (err) {
    console.error('Error loading rooms.json:', err);
    rooms = {};
  }
}

function saveRooms() {
  try {
    // Clean up data before saving
    const clean = {};
    for (const id in rooms) {
      const r = rooms[id];
      clean[id] = {
        id: r.id,
        name: r.name || null,
        description: r.description || null,
        password: r.password || null,
        temporary: r.temporary || false,
        ttl: r.ttl || null,
        createdAt: r.createdAt || Date.now(),
        creatorId: r.creatorId || null,
        creatorAlias: r.creatorAlias || null,
        members: r.members || {},
        memberCount: Object.keys(r.members || {}).length,
        passwordProtected: !!(r.password && r.password.length > 0),
        lastActivity: Date.now()
      };
    }
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(clean, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving rooms.json:', err);
  }
}

// ─── WEB SOCKET SERVER ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

console.log(`Nexus Terminal Server listening on ws://localhost:${PORT}`);

// ─── UTILITIES ──────────────────────────────────────────────────
function generateRoomId() {
  return 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

function broadcastToRoom(roomId, message, excludeWs = null) {
  const room = rooms[roomId];
  if (!room) return;
  for (const userId in room.members) {
    const socket = room.members[userId].socket;
    if (socket && socket !== excludeWs && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}

function broadcastPresence(roomId, excludeWs = null) {
  const room = rooms[roomId];
  if (!room) return;
  const presenceData = [];
  for (const userId in room.members) {
    const mem = room.members[userId];
    presenceData.push({
      userId: userId,
      alias: mem.alias || userId,
      role: mem.role || 'member',
      lastSeen: Date.now()
    });
  }
  for (const userId in room.members) {
    const socket = room.members[userId].socket;
    if (socket && socket !== excludeWs && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'presence_update',
        data: { roomId: roomId, users: presenceData }
      }));
    }
  }
}

// ─── WEBSOCKET HANDLER ──────────────────────────────────────────
function handleMessage(ws, raw) {
  try {
    const msg = JSON.parse(raw);
    const { type, data } = msg;

    // Only require userId / alias for authenticated messages
    if (!data) {
      ws.send(JSON.stringify({ type: 'error', data: 'Invalid message format' }));
      return;
    }

    // Bind this socket to a user
    if (!ws.userId) {
      ws.userId = data.userId || ('user_' + Math.random().toString(36).substr(2, 8));
      ws.alias = data.alias || ws.userId;
    }

    switch (type) {

      // ─── CREATE ROOM ──────────────────────────────────────────
      case 'create_room': {
        const { name, description, password, temporary, ttl } = data;
        const roomId = generateRoomId();
        const room = {
          id: roomId,
          name: name || null,
          description: description || null,
          password: password || null,
          temporary: temporary || false,
          ttl: ttl ? parseInt(ttl) : null,
          createdAt: Date.now(),
          creatorId: ws.userId,
          creatorAlias: ws.alias,
          members: {},
          memberCount: 0,
          passwordProtected: !!(password && password.length > 0),
          lastActivity: Date.now()
        };
        // Add creator as first member
        room.members[ws.userId] = {
          alias: ws.alias,
          role: 'admin',
          socket: ws,
          joinedAt: Date.now()
        };
        room.memberCount = 1;
        rooms[roomId] = room;
        saveRooms();

        // Send room_created to creator
        ws.send(JSON.stringify({
          type: 'room_created',
          data: { id: roomId, name: room.name, description: room.description, temporary: room.temporary,
            passwordProtected: room.passwordProtected }
        }));

        // Immediately join the room (auto-join)
        ws.currentRoomId = roomId;
        // Send join_success to creator
        ws.send(JSON.stringify({
          type: 'join_success',
          data: { roomId: roomId, meta: { id: roomId, name: room.name, temporary: room.temporary,
              passwordProtected: room.passwordProtected } }
        }));
        // Send room_joined to others (none yet, but future)
        // Broadcast presence
        broadcastPresence(roomId, ws);
        break;
      }

      // ─── JOIN ROOM ────────────────────────────────────────────
      case 'join_room': {
        const { roomId, password } = data;
        const room = rooms[roomId];
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', data: 'Room not found' }));
          return;
        }
        // Check password
        if (room.password && room.password.length > 0) {
          if (!password || password !== room.password) {
            ws.send(JSON.stringify({ type: 'error', data: 'Incorrect password' }));
            return;
          }
        }
        // Check if already in room
        if (room.members[ws.userId]) {
          ws.send(JSON.stringify({ type: 'error', data: 'Already in this room' }));
          return;
        }
        // Add user to room
        room.members[ws.userId] = {
          alias: ws.alias,
          role: 'member',
          socket: ws,
          joinedAt: Date.now()
        };
        room.memberCount = Object.keys(room.members).length;
        room.lastActivity = Date.now();
        saveRooms();

        // ⚡ IMMEDIATE JOIN SUCCESS to the joiner
        ws.send(JSON.stringify({
          type: 'join_success',
          data: { roomId: roomId, meta: { id: roomId, name: room.name, temporary: room.temporary,
              passwordProtected: room.passwordProtected } }
        }));

        // Broadcast room_joined to others in the room
        broadcastToRoom(roomId, {
          type: 'room_joined',
          data: { id: roomId, userId: ws.userId, alias: ws.alias, role: 'member' }
        }, ws);

        ws.currentRoomId = roomId;
        broadcastPresence(roomId, ws);
        break;
      }

      // ─── LEAVE ROOM ───────────────────────────────────────────
      case 'leave_room': {
        const roomId = ws.currentRoomId;
        if (!roomId || !rooms[roomId]) {
          ws.send(JSON.stringify({ type: 'error', data: 'Not in a room' }));
          return;
        }
        const room = rooms[roomId];
        if (room.members[ws.userId]) {
          delete room.members[ws.userId];
          room.memberCount = Object.keys(room.members).length;
          room.lastActivity = Date.now();
          saveRooms();

          // Broadcast room_left to others
          broadcastToRoom(roomId, {
            type: 'room_left',
            data: { id: roomId, userId: ws.userId, alias: ws.alias }
          }, ws);
          // Send leave confirmation to the user
          ws.send(JSON.stringify({ type: 'room_left', data: { id: roomId, userId: ws.userId } }));
          ws.currentRoomId = null;
          broadcastPresence(roomId, ws);
        } else {
          ws.send(JSON.stringify({ type: 'error', data: 'You are not in this room' }));
        }
        break;
      }

      // ─── DELETE ROOM ──────────────────────────────────────────
      case 'delete_room': {
        const roomId = ws.currentRoomId;
        if (!roomId || !rooms[roomId]) {
          ws.send(JSON.stringify({ type: 'error', data: 'Not in a room' }));
          return;
        }
        const room = rooms[roomId];
        if (room.creatorId !== ws.userId) {
          ws.send(JSON.stringify({ type: 'error', data: 'Only the room creator can delete this room' }));
          return;
        }
        // Notify all members
        broadcastToRoom(roomId, {
          type: 'room_deleted',
          data: { id: roomId }
        });
        delete rooms[roomId];
        saveRooms();
        ws.currentRoomId = null;
        break;
      }

      // ─── LIST ROOMS ───────────────────────────────────────────
      case 'list_rooms': {
        const roomList = {};
        for (const id in rooms) {
          const r = rooms[id];
          roomList[id] = {
            id: r.id,
            name: r.name || null,
            description: r.description || null,
            memberCount: Object.keys(r.members || {}).length,
            passwordProtected: !!r.password,
            temporary: r.temporary || false,
            creatorAlias: r.creatorAlias || null,
            createdAt: r.createdAt
          };
        }
        ws.send(JSON.stringify({ type: 'room_list', data: roomList }));
        break;
      }

      // ─── SEARCH ROOMS ─────────────────────────────────────────
      case 'search_rooms': {
        const { query } = data;
        if (!query || query.trim() === '') {
          ws.send(JSON.stringify({ type: 'error', data: 'Search query required' }));
          return;
        }
        const results = {};
        const lower = query.toLowerCase().trim();
        for (const id in rooms) {
          const r = rooms[id];
          const name = (r.name || '').toLowerCase();
          const desc = (r.description || '').toLowerCase();
          if (name.includes(lower) || desc.includes(lower) || id.toLowerCase().includes(lower)) {
            results[id] = {
              id: r.id,
              name: r.name || null,
              description: r.description || null,
              memberCount: Object.keys(r.members || {}).length,
              passwordProtected: !!r.password,
              temporary: r.temporary || false,
              creatorAlias: r.creatorAlias || null
            };
          }
        }
        ws.send(JSON.stringify({ type: 'room_search_results', data: results }));
        break;
      }

      // ─── ROOM INFO ────────────────────────────────────────────
      case 'room_info': {
        const { roomId } = data;
        if (!roomId || !rooms[roomId]) {
          ws.send(JSON.stringify({ type: 'error', data: 'Room not found' }));
          return;
        }
        const r = rooms[roomId];
        const members = {};
        for (const uid in r.members) {
          const m = r.members[uid];
          members[uid] = { alias: m.alias || uid, role: m.role || 'member', joinedAt: m.joinedAt };
        }
        ws.send(JSON.stringify({
          type: 'room_info_result',
          data: {
            id: r.id,
            meta: { id: r.id, name: r.name, description: r.description, temporary: r.temporary,
              passwordProtected: !!r.password, creatorId: r.creatorId, creatorAlias: r.creatorAlias,
              createdAt: r.createdAt },
            members: members
          }
        }));
        break;
      }

      // ─── CHAT MESSAGE ─────────────────────────────────────────
      case 'chat_message': {
        const { text } = data;
        const roomId = ws.currentRoomId;
        if (!roomId || !rooms[roomId]) {
          ws.send(JSON.stringify({ type: 'error', data: 'Not in a room' }));
          return;
        }
        const room = rooms[roomId];
        if (!room.members[ws.userId]) {
          ws.send(JSON.stringify({ type: 'error', data: 'You are not in this room' }));
          return;
        }
        const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        const chatMsg = {
          type: 'chat_message',
          data: {
            msgId: msgId,
            roomId: roomId,
            senderId: ws.userId,
            senderAlias: ws.alias,
            text: text,
            timestamp: Date.now()
          }
        };
        // Broadcast to all in room including sender
        broadcastToRoom(roomId, chatMsg);
        break;
      }

      // ─── COMMAND EXECUTED ─────────────────────────────────────
      case 'command_executed': {
        const { cmd, outputHTML } = data;
        const roomId = ws.currentRoomId;
        if (!roomId || !rooms[roomId]) {
          ws.send(JSON.stringify({ type: 'error', data: 'Not in a room' }));
          return;
        }
        const room = rooms[roomId];
        if (!room.members[ws.userId]) {
          ws.send(JSON.stringify({ type: 'error', data: 'You are not in this room' }));
          return;
        }
        const msgId = 'cmd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        const cmdMsg = {
          type: 'command_executed',
          data: {
            msgId: msgId,
            roomId: roomId,
            senderId: ws.userId,
            senderAlias: ws.alias,
            cmd: cmd,
            outputHTML: outputHTML,
            timestamp: Date.now()
          }
        };
        // Broadcast to all in room including sender
        broadcastToRoom(roomId, cmdMsg);
        break;
      }

      // ─── SET NICK ─────────────────────────────────────────────
      case 'set_nick': {
        const { alias } = data;
        if (!alias || alias.trim() === '') {
          ws.send(JSON.stringify({ type: 'error', data: 'Nickname cannot be empty' }));
          return;
        }
        const oldAlias = ws.alias;
        ws.alias = alias.trim();
        // Update in current room
        const roomId = ws.currentRoomId;
        if (roomId && rooms[roomId]) {
          const room = rooms[roomId];
          if (room.members[ws.userId]) {
            room.members[ws.userId].alias = ws.alias;
            saveRooms();
            // Broadcast nick change to room
            broadcastToRoom(roomId, {
              type: 'nick_changed',
              data: { roomId: roomId, userId: ws.userId, oldAlias: oldAlias, newAlias: ws.alias }
            });
          }
        }
        ws.send(JSON.stringify({ type: 'nick_set', data: { alias: ws.alias } }));
        break;
      }

      // ─── PRESENCE UPDATE ──────────────────────────────────────
      case 'presence_update': {
        const { alias, lastSeen } = data;
        if (alias) ws.alias = alias;
        // Update presence in current room
        const roomId = ws.currentRoomId;
        if (roomId && rooms[roomId]) {
          const room = rooms[roomId];
          if (room.members[ws.userId]) {
            room.members[ws.userId].lastSeen = lastSeen || Date.now();
            room.members[ws.userId].alias = ws.alias;
            saveRooms();
            broadcastPresence(roomId, ws);
          }
        }
        break;
      }

      // ─── UNKNOWN ──────────────────────────────────────────────
      default: {
        ws.send(JSON.stringify({ type: 'error', data: 'Unknown command type: ' + type }));
      }
    }
  } catch (err) {
    console.error('Message handling error:', err);
    ws.send(JSON.stringify({ type: 'error', data: 'Server error: ' + err.message }));
  }
}

// ─── CLIENT CONNECTION ────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('New client connected');

  ws.userId = null;
  ws.alias = null;
  ws.currentRoomId = null;

  ws.on('message', (raw) => {
    handleMessage(ws, raw);
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    // Remove from all rooms
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (room.members[ws.userId]) {
        delete room.members[ws.userId];
        room.memberCount = Object.keys(room.members).length;
        room.lastActivity = Date.now();
        saveRooms();
        // Broadcast room_left
        broadcastToRoom(roomId, {
          type: 'room_left',
          data: { id: roomId, userId: ws.userId, alias: ws.alias }
        }, ws);
        broadcastPresence(roomId, ws);
      }
    }
  });

  // Send initial welcome
  ws.send(JSON.stringify({ type: 'connected', data: { message: 'Connected to Nexus Terminal Server' } }));
});

// ─── PERIODIC CLEANUP ─────────────────────────────────────────────
function cleanupExpiredRooms() {
  const now = Date.now();
  for (const roomId in rooms) {
    const room = rooms[roomId];
    if (room.temporary && room.ttl && (now - room.createdAt) > room.ttl) {
      // Delete expired temporary room
      broadcastToRoom(roomId, { type: 'room_deleted', data: { id: roomId, reason: 'expired' } });
      delete rooms[roomId];
    } else if (room.temporary && Object.keys(room.members).length === 0) {
      // Delete empty temporary rooms after 1 hour
      if (now - room.lastActivity > 3600000) {
        delete rooms[roomId];
      }
    }
  }
  saveRooms();
}

setInterval(cleanupExpiredRooms, 60000); // Clean up every minute

// ─── LOAD ROOMS ON START ──────────────────────────────────────────
loadRooms();

console.log('Nexus Terminal Server is ready.');
console.log(`Loaded ${Object.keys(rooms).length} rooms.`);
