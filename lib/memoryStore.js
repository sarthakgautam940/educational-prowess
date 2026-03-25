const { v4: uuidv4 } = require('uuid');
const structuredClone =
  typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone.bind(globalThis)
    : (v) => JSON.parse(JSON.stringify(v));

const {
  DEFAULT_ROOMS,
  MAX_MESSAGES_PER_ROOM,
  HEARTBEAT_MS,
  POLL_LIMIT_MESSAGES,
} = require('./constants');

function deepCloneRooms(source) {
  const out = {};
  for (const [name, room] of Object.entries(source)) {
    out[name] = {
      password: room.password,
      nextMessageId: room.nextMessageId ?? 0,
      messages: structuredClone(room.messages || []),
    };
  }
  return out;
}

function createMemoryState() {
  return {
    rooms: deepCloneRooms(DEFAULT_ROOMS),
    members: {},
  };
}

let state = createMemoryState();

function pruneMessages(room) {
  if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
    room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM);
  }
}

function nowTs() {
  return Date.now();
}

function publicRoomSummaries() {
  return Object.keys(state.rooms).sort((a, b) => a.localeCompare(b));
}

function membersInRoom(roomName) {
  const names = [];
  const stale = [];
  const t = nowTs();
  for (const [id, m] of Object.entries(state.members)) {
    if (m.room !== roomName) continue;
    if (t - m.lastSeen > HEARTBEAT_MS) {
      stale.push(id);
      continue;
    }
    names.push(m.username);
  }
  for (const id of stale) delete state.members[id];
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

function addMember(roomName, username, isAdmin) {
  const id = uuidv4();
  state.members[id] = {
    room: roomName,
    username,
    lastSeen: nowTs(),
    isAdmin: !!isAdmin,
  };
  return id;
}

function touchMember(memberId) {
  const m = state.members[memberId];
  if (!m) return false;
  m.lastSeen = nowTs();
  return true;
}

function removeMember(memberId) {
  delete state.members[memberId];
}

function appendMessage(roomName, username, text) {
  const room = state.rooms[roomName];
  if (!room) return null;
  room.nextMessageId += 1;
  const msg = {
    id: room.nextMessageId,
    username,
    text,
    time: new Date().toISOString(),
  };
  room.messages.push(msg);
  pruneMessages(room);
  return msg;
}

function getMessagesSince(roomName, afterId) {
  const room = state.rooms[roomName];
  if (!room) return [];
  return room.messages.filter((m) => m.id > afterId).slice(-POLL_LIMIT_MESSAGES);
}

function getHistory(roomName) {
  const room = state.rooms[roomName];
  if (!room) return [];
  return structuredClone(room.messages);
}

async function getChatrooms() {
  return publicRoomSummaries();
}

async function tryJoin({ room, password, username }) {
  const r = state.rooms[room];
  if (!r) return { ok: false, error: 'Chatroom not found' };
  if (r.password !== password) return { ok: false, error: 'Incorrect password' };
  const taken = Object.values(state.members).some(
    (m) => m.room === room && m.username === username && nowTs() - m.lastSeen <= HEARTBEAT_MS
  );
  if (taken) return { ok: false, error: 'That name is already in this room' };
  const memberId = addMember(room, username, false);
  return {
    ok: true,
    memberId,
    members: membersInRoom(room),
    history: getHistory(room),
    lastMessageId: r.messages.length ? r.messages[r.messages.length - 1].id : 0,
  };
}

async function tryPoll({ memberId, room, afterMessageId }) {
  const m = state.members[memberId];
  if (!m || m.room !== room) {
    return { ok: false, error: 'Session expired — rejoin the room' };
  }
  touchMember(memberId);
  const members = membersInRoom(room);
  const newMessages = getMessagesSince(room, afterMessageId ?? 0);
  const roomRef = state.rooms[room];
  const lastMessageId = roomRef?.messages.length
    ? roomRef.messages[roomRef.messages.length - 1].id
    : 0;
  return { ok: true, members, newMessages, lastMessageId };
}

async function trySend({ memberId, text }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, error: 'Message is empty' };
  const m = state.members[memberId];
  if (!m) return { ok: false, error: 'Not in a room' };
  touchMember(memberId);
  const msg = appendMessage(m.room, m.username, trimmed);
  return { ok: true, message: msg, room: m.room };
}

async function tryHeartbeat({ memberId }) {
  if (!touchMember(memberId)) return { ok: false };
  return { ok: true };
}

async function tryLeave({ memberId }) {
  const m = state.members[memberId];
  if (m) removeMember(memberId);
  return { ok: true };
}

async function adminCreateRoom({ name, password }) {
  const n = String(name || '').trim();
  const p = String(password || '').trim();
  if (!n || !p) return { ok: false, error: 'Name and password required' };
  if (state.rooms[n]) return { ok: false, error: 'Room already exists' };
  state.rooms[n] = { password: p, messages: [], nextMessageId: 0 };
  return { ok: true };
}

async function adminDeleteRoom({ name }) {
  const n = String(name || '').trim();
  if (!state.rooms[n]) return { ok: false, error: 'Room not found' };
  for (const [id, m] of Object.entries(state.members)) {
    if (m.room === n) delete state.members[id];
  }
  delete state.rooms[n];
  return { ok: true };
}

async function adminEditRoom({ name, newName, newPassword }) {
  const n = String(name || '').trim();
  if (!state.rooms[n]) return { ok: false, error: 'Room not found' };
  const nn = newName != null && String(newName).trim() !== '' ? String(newName).trim() : n;
  const np = newPassword != null && String(newPassword).trim() !== '' ? String(newPassword).trim() : null;
  if (nn !== n && state.rooms[nn]) return { ok: false, error: 'New name already exists' };
  const room = state.rooms[n];
  if (nn !== n) {
    state.rooms[nn] = room;
    delete state.rooms[n];
    for (const m of Object.values(state.members)) {
      if (m.room === n) m.room = nn;
    }
  }
  if (np) room.password = np;
  return { ok: true };
}

async function adminKick({ room, username }) {
  const r = String(room || '').trim();
  const u = String(username || '').trim();
  if (!state.rooms[r]) return { ok: false, error: 'Room not found' };
  let kicked = false;
  for (const [id, m] of Object.entries(state.members)) {
    if (m.room === r && m.username === u) {
      delete state.members[id];
      kicked = true;
    }
  }
  if (!kicked) return { ok: false, error: 'Member not online' };
  return { ok: true };
}

async function adminJoin({ room, password, displayName }) {
  const r = state.rooms[room];
  if (!r) return { ok: false, error: 'Chatroom not found' };
  if (r.password !== password) return { ok: false, error: 'Incorrect room password' };
  const name = String(displayName || 'Admin').trim() || 'Admin';
  const memberId = addMember(room, name, true);
  return {
    ok: true,
    memberId,
    members: membersInRoom(room),
    history: getHistory(room),
    lastMessageId: r.messages.length ? r.messages[r.messages.length - 1].id : 0,
  };
}

async function adminListMembers({ room }) {
  const r = String(room || '').trim();
  if (!state.rooms[r]) return { ok: false, error: 'Room not found' };
  const list = [];
  const t = nowTs();
  for (const [id, m] of Object.entries(state.members)) {
    if (m.room !== r) continue;
    if (t - m.lastSeen > HEARTBEAT_MS) continue;
    list.push({ memberId: id, username: m.username });
  }
  list.sort((a, b) => a.username.localeCompare(b.username));
  return { ok: true, members: list };
}

function resetForTests() {
  state = createMemoryState();
}

module.exports = {
  getChatrooms,
  tryJoin,
  tryPoll,
  trySend,
  tryHeartbeat,
  tryLeave,
  adminCreateRoom,
  adminDeleteRoom,
  adminEditRoom,
  adminKick,
  adminJoin,
  adminListMembers,
  resetForTests,
};
