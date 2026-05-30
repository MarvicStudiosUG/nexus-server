const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ROOMS_FILE = './rooms.json';

// ─── Load or create rooms data ────────────────────────────────────────────
let roomsData = {};
if (fs.existsSync(ROOMS_FILE)) {
    try {
        roomsData = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    } catch (e) {
        roomsData = {};
    }
}

function saveRooms() {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(roomsData, null, 2));
}

// ─── HTTP server (health check for Render) ──────────────────────────────
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Nexus Terminal Server is running ✅');
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// ─── WebSocket server ────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

// Store connected clients: userId -> { ws, userId, alias, roomId }
const clients = new Map();

wss.on('connection', (ws) => {
    const userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const userData = { ws, userId, alias: userId, roomId: null };
    clients.set(userId, userData);

    console.log(`🟢 User ${userId} connected`);

    // Send initial room list
    sendRoomList(ws);

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            handleMessage(userId, msg);
        } catch (e) {
            console.error('❌ Invalid message:', e.message);
        }
    });

    ws.on('close', () => {
        console.log(`🔴 User ${userId} disconnected`);
        const data = clients.get(userId);
        if (data && data.roomId) {
            const roomId = data.roomId;
            if (roomsData[roomId] && roomsData[roomId].members) {
                delete roomsData[roomId].members[userId];
                if (Object.keys(roomsData[roomId].members).length === 0) {
                    delete roomsData[roomId];
                    saveRooms();
                    broadcast({ type: 'room_deleted', data: { id: roomId } });
                } else {
                    saveRooms();
                    broadcastToRoom(roomId, {
                        type: 'room_left',
                        data: { id: roomId, userId, alias: data.alias }
                    });
                }
            }
        }
        clients.delete(userId);
    });
});

// ─── Message handler ──────────────────────────────────────────────────────
function handleMessage(userId, msg) {
    const user = clients.get(userId);
    if (!user) return;

    switch (msg.type) {

        // ─── CREATE ROOM ──────────────────────────────────────────────
        case 'create_room': {
            const { name, description, password, temporary, ttl } = msg.data;
            const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
            const meta = {
                name: name || 'Unnamed Room',
                description: description || '',
                creator: userId,
                creatorAlias: user.alias,
                created: Date.now(),
                passwordProtected: !!password,
                memberCount: 1,
                lastActivity: Date.now(),
                temporary: !!temporary,
                searchableName: (name || 'Unnamed Room').toLowerCase(),
                searchableDescription: (description || '').toLowerCase(),
                searchableId: roomId.toLowerCase()
            };
            if (password && password.length >= 4) {
                meta.passwordHash = btoa(password);
            }
            if (temporary) {
                meta.expiresAt = Date.now() + (parseInt(ttl) || 604800000);
            }
            const members = {};
            members[userId] = { alias: user.alias, joined: Date.now(), role: 'admin' };
            roomsData[roomId] = { meta, members };
            saveRooms();

            user.roomId = roomId;
            broadcast({ type: 'room_created', data: { id: roomId, name: meta.name, creator: userId } });
            broadcastToRoom(roomId, {
                type: 'room_joined',
                data: { id: roomId, userId, alias: user.alias, role: 'admin' }
            });
            sendRoomListToAll();
            break;
        }

        // ─── JOIN ROOM ─────────────────────────────────────────────────
        case 'join_room': {
            const { roomId, password } = msg.data;
            if (!roomsData[roomId]) {
                user.ws.send(JSON.stringify({ type: 'error', data: 'Room not found' }));
                return;
            }
            const meta = roomsData[roomId].meta;
            if (meta.temporary && meta.expiresAt && Date.now() > meta.expiresAt) {
                delete roomsData[roomId];
                saveRooms();
                user.ws.send(JSON.stringify({ type: 'error', data: 'Room has expired' }));
                return;
            }
            if (meta.passwordProtected) {
                if (!password || btoa(password) !== meta.passwordHash) {
                    user.ws.send(JSON.stringify({ type: 'error', data: 'Incorrect password' }));
                    return;
                }
            }
            roomsData[roomId].members[userId] = { alias: user.alias, joined: Date.now(), role: 'member' };
            saveRooms();
            user.roomId = roomId;
            broadcastToRoom(roomId, {
                type: 'room_joined',
                data: { id: roomId, userId, alias: user.alias, role: 'member' }
            });
            sendRoomListToAll();
            break;
        }

        // ─── LEAVE ROOM ─────────────────────────────────────────────────
        case 'leave_room': {
            const roomId = user.roomId;
            if (!roomId || !roomsData[roomId]) return;
            delete roomsData[roomId].members[userId];
            if (Object.keys(roomsData[roomId].members).length === 0) {
                delete roomsData[roomId];
                saveRooms();
                broadcast({ type: 'room_deleted', data: { id: roomId } });
            } else {
                saveRooms();
                broadcastToRoom(roomId, {
                    type: 'room_left',
                    data: { id: roomId, userId, alias: user.alias }
                });
            }
            user.roomId = null;
            sendRoomListToAll();
            break;
        }

        // ─── DELETE ROOM ────────────────────────────────────────────────
        case 'delete_room': {
            const roomId = user.roomId;
            if (!roomId || !roomsData[roomId]) return;
            if (roomsData[roomId].meta.creator !== userId) {
                user.ws.send(JSON.stringify({ type: 'error', data: 'Only the creator can delete this room' }));
                return;
            }
            delete roomsData[roomId];
            saveRooms();
            user.roomId = null;
            broadcast({ type: 'room_deleted', data: { id: roomId } });
            sendRoomListToAll();
            break;
        }

        // ─── CHAT MESSAGE ──────────────────────────────────────────────
        case 'chat_message': {
            const roomId = user.roomId;
            if (!roomId || !roomsData[roomId]) return;
            const msgData = {
                msgId: 'chat_' + Date.now() + Math.random().toString(36).substr(2, 4),
                senderId: userId,
                senderAlias: user.alias,
                text: msg.data.text,
                timestamp: Date.now(),
                roomId
            };
            broadcastToRoom(roomId, { type: 'chat_message', data: msgData });
            break;
        }

        // ─── COMMAND EXECUTED ──────────────────────────────────────────
        case 'command_executed': {
            const roomId = user.roomId;
            if (!roomId || !roomsData[roomId]) return;
            const msgData = {
                msgId: 'log_' + Date.now() + Math.random().toString(36).substr(2, 4),
                senderId: userId,
                senderAlias: user.alias,
                cmd: msg.data.cmd,
                outputHTML: msg.data.outputHTML,
                timestamp: Date.now(),
                roomId
            };
            broadcastToRoom(roomId, { type: 'command_executed', data: msgData });
            break;
        }

        // ─── SET NICKNAME ──────────────────────────────────────────────
        case 'set_nick': {
            const newAlias = msg.data.alias.trim();
            if (!newAlias) return;
            user.alias = newAlias;
            if (user.roomId && roomsData[user.roomId]) {
                if (roomsData[user.roomId].members[userId]) {
                    roomsData[user.roomId].members[userId].alias = newAlias;
                    saveRooms();
                }
                broadcastToRoom(user.roomId, {
                    type: 'presence_update',
                    data: { roomId: user.roomId, userId, alias: newAlias, lastSeen: Date.now() }
                });
            }
            break;
        }

        // ─── LIST ROOMS ─────────────────────────────────────────────────
        case 'list_rooms': {
            sendRoomList(user.ws);
            break;
        }

        // ─── SEARCH ROOMS ──────────────────────────────────────────────
        case 'search_rooms': {
            const query = msg.data.query.toLowerCase();
            const results = {};
            Object.entries(roomsData).forEach(([id, data]) => {
                const meta = data.meta;
                if (meta.temporary && meta.expiresAt && Date.now() > meta.expiresAt) {
                    delete roomsData[id];
                    return;
                }
                const name = (meta.name || '').toLowerCase();
                const desc = (meta.description || '').toLowerCase();
                const idLower = id.toLowerCase();
                if (idLower.includes(query) || name.includes(query) || desc.includes(query)) {
                    results[id] = meta;
                }
            });
            saveRooms();
            user.ws.send(JSON.stringify({ type: 'room_search_results', data: results }));
            break;
        }

        // ─── ROOM INFO ──────────────────────────────────────────────────
        case 'room_info': {
            const roomId = msg.data.roomId;
            if (!roomsData[roomId]) {
                user.ws.send(JSON.stringify({ type: 'error', data: 'Room not found' }));
                return;
            }
            user.ws.send(JSON.stringify({
                type: 'room_info_result',
                data: { id: roomId, meta: roomsData[roomId].meta, members: roomsData[roomId].members }
            }));
            break;
        }

        // ─── PRESENCE UPDATE ───────────────────────────────────────────
        case 'presence_update': {
            if (user.roomId && roomsData[user.roomId]) {
                broadcastToRoom(user.roomId, {
                    type: 'presence_update',
                    data: { roomId: user.roomId, userId, alias: user.alias, lastSeen: Date.now() }
                });
            }
            break;
        }

        default:
            console.warn(`⚠️ Unknown message type: ${msg.type}`);
    }
}

// ─── Broadcast helpers ──────────────────────────────────────────────────

function broadcast(message) {
    const str = JSON.stringify(message);
    clients.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(str);
        }
    });
}

function broadcastToRoom(roomId, message) {
    const str = JSON.stringify(message);
    clients.forEach((client) => {
        if (client.roomId === roomId && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(str);
        }
    });
}

function sendRoomList(ws) {
    const now = Date.now();
    const rooms = {};
    Object.entries(roomsData).forEach(([id, data]) => {
        const meta = data.meta;
        if (meta.temporary && meta.expiresAt && now > meta.expiresAt) {
            delete roomsData[id];
            return;
        }
        rooms[id] = meta;
    });
    saveRooms();
    ws.send(JSON.stringify({ type: 'room_list', data: rooms }));
}

function sendRoomListToAll() {
    const now = Date.now();
    const rooms = {};
    Object.entries(roomsData).forEach(([id, data]) => {
        const meta = data.meta;
        if (meta.temporary && meta.expiresAt && now > meta.expiresAt) {
            delete roomsData[id];
            return;
        }
        rooms[id] = meta;
    });
    saveRooms();
    const str = JSON.stringify({ type: 'room_list', data: rooms });
    clients.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(str);
        }
    });
}

// ─── Start server ──────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Nexus Terminal Server running on port ${PORT}`);
    console.log(`   Connect clients to: ws://${require('os').hostname()}:${PORT}`);
});
