const { Redis } = require('@upstash/redis');
const { v4: uuidv4 } = require('uuid');

const {
  MAX_MESSAGES_PER_ROOM,
  HEARTBEAT_MS,
  POLL_LIMIT_MESSAGES,
  DEFAULT_ROOMS,
} = require('./constants');

let redis;

function getRedis() {
  if (!redis) redis = Redis.fromEnv();
  return redis;
}

const ROOMS_KEY = 'chat:rooms';
const MEMBERS_KEY = 'chat:members';
const MSG_LIST_PREFIX = 'chat:msgs:';
const SEQ_PREFIX = 'chat:seq:';

function msgListKey(roomName) {
  return `${MSG_LIST_PREFIX}${roomName}`;
}

function seqKey(roomName) {
  return `${SEQ_PREFIX}${roomName}`;
}

function nowTs() {
  return Date.now();
}

async function ensureDefaultRooms(r) {
  const exists = await r.exists(ROOMS_KEY);
  if (!exists) {
    const pipe = r.pipeline();
    for (const [name, cfg] of Object.entries(DEFAULT_ROOMS)) {
      pipe.hset(ROOMS_KEY, { [name]: JSON.stringify({ password: cfg.password }) });
      pipe.set(seqKey(name), '0');
    }
    await pipe.exec();
  }
}

async function getRoomMeta(r, name) {
  const raw = await r.hget(ROOMS_KEY, name);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function publicRoomSummaries(r) {
  const all = await r.hgetall(ROOMS_KEY);
  if (!all) return [];
  return Object.keys(all).sort((a, b) => a.localeCompare(b));
}

async function loadMembersMap(r) {
  const all = await r.hgetall(MEMBERS_KEY);
  if (!all) return {};
  const out = {};
  for (const [id, raw] of Object.entries(all)) {
    try {
      out[id] = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      /* skip */
    }
  }
  return out;
}

async function saveMember(r, id, data) {
  await r.hset(MEMBERS_KEY, { [id]: JSON.stringify(data) });
}

async function deleteMember(r, id) {
  await r.hdel(MEMBERS_KEY, id);
}

async function pruneStaleMembers(r, members) {
  const t = nowTs();
  const staleIds = [];
  for (const [id, m] of Object.entries(members)) {
    if (t - m.lastSeen > HEARTBEAT_MS) staleIds.push(id);
  }
  if (staleIds.length) await r.hdel(MEMBERS_KEY, ...staleIds);
}

async function membersInRoom(r, roomName) {
  const members = await loadMembersMap(r);
  await pruneStaleMembers(r, members);
  const fresh = await loadMembersMap(r);
  const names = [];
  const t = nowTs();
  for (const m of Object.values(fresh)) {
    if (m.room !== roomName) continue;
    if (t - m.lastSeen > HEARTBEAT_MS) continue;
    names.push(m.username);
  }
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

async function getMessagesSince(r, roomName, afterId) {
  const rawList = await r.lrange(msgListKey(roomName), 0, -1);
  if (!rawList || !rawList.length) return [];
  const msgs = [];
  for (const raw of rawList) {
    try {
      const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (m.id > afterId) msgs.push(m);
    } catch {
      /* skip */
    }
  }
  return msgs.slice(-POLL_LIMIT_MESSAGES);
}

async function getHistory(r, roomName) {
  const rawList = await r.lrange(msgListKey(roomName), 0, -1);
  if (!rawList) return [];
  return rawList.map((raw) => (typeof raw === 'string' ? JSON.parse(raw) : raw));
}

async function lastMessageId(r, roomName) {
  const rawList = await r.lrange(msgListKey(roomName), -1, -1);
  if (!rawList || !rawList.length) return 0;
  try {
    const m = typeof rawList[0] === 'string' ? JSON.parse(rawList[0]) : rawList[0];
    return m.id || 0;
  } catch {
    return 0;
  }
}

async function getChatrooms() {
  const r = getRedis();
  await ensureDefaultRooms(r);
  return publicRoomSummaries(r);
}

async function tryJoin({ room, password, username }) {
  const r = getRedis();
  await ensureDefaultRooms(r);
  const meta = await getRoomMeta(r, room);
  if (!meta) return { ok: false, error: 'Chatroom not found' };
  if (meta.password !== password) return { ok: false, error: 'Incorrect password' };

  const members = await loadMembersMap(r);
  await pruneStaleMembers(r, members);
  const live = await loadMembersMap(r);
  const t = nowTs();
  const taken = Object.values(live).some(
    (m) => m.room === room && m.username === username && t - m.lastSeen <= HEARTBEAT_MS
  );
  if (taken) return { ok: false, error: 'That name is already in this room' };

  const memberId = uuidv4();
  await saveMember(r, memberId, {
    room,
    username,
    lastSeen: nowTs(),
    isAdmin: false,
  });

  const memNames = await membersInRoom(r, room);
  const history = await getHistory(r, room);
  const lid = await lastMessageId(r, room);
  return { ok: true, memberId, members: memNames, history, lastMessageId: lid };
}

async function tryPoll({ memberId, room, afterMessageId }) {
  const r = getRedis();
  const members = await loadMembersMap(r);
  const m = members[memberId];
  if (!m || m.room !== room) {
    return { ok: false, error: 'Session expired — rejoin the room' };
  }
  m.lastSeen = nowTs();
  await saveMember(r, memberId, m);

  const memNames = await membersInRoom(r, room);
  const newMessages = await getMessagesSince(r, room, afterMessageId ?? 0);
  const lid = await lastMessageId(r, room);
  return { ok: true, members: memNames, newMessages, lastMessageId: lid };
}

async function trySend({ memberId, text }) {
  const r = getRedis();
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, error: 'Message is empty' };
  const members = await loadMembersMap(r);
  const m = members[memberId];
  if (!m) return { ok: false, error: 'Not in a room' };
  m.lastSeen = nowTs();
  await saveMember(r, memberId, m);

  const id = await r.incr(seqKey(m.room));
  const msg = {
    id,
    username: m.username,
    text: trimmed,
    time: new Date().toISOString(),
  };
  await r.rpush(msgListKey(m.room), JSON.stringify(msg));
  await r.ltrim(msgListKey(m.room), -MAX_MESSAGES_PER_ROOM, -1);
  return { ok: true, message: msg, room: m.room };
}

async function tryHeartbeat({ memberId }) {
  const r = getRedis();
  const members = await loadMembersMap(r);
  const m = members[memberId];
  if (!m) return { ok: false };
  m.lastSeen = nowTs();
  await saveMember(r, memberId, m);
  return { ok: true };
}

async function tryLeave({ memberId }) {
  const r = getRedis();
  await deleteMember(r, memberId);
  return { ok: true };
}

async function adminCreateRoom({ name, password }) {
  const r = getRedis();
  await ensureDefaultRooms(r);
  const n = String(name || '').trim();
  const p = String(password || '').trim();
  if (!n || !p) return { ok: false, error: 'Name and password required' };
  if (await r.hget(ROOMS_KEY, n)) return { ok: false, error: 'Room already exists' };
  await r.hset(ROOMS_KEY, { [n]: JSON.stringify({ password: p }) });
  await r.set(seqKey(n), '0');
  return { ok: true };
}

async function adminDeleteRoom({ name }) {
  const r = getRedis();
  const n = String(name || '').trim();
  if (!(await r.hget(ROOMS_KEY, n))) return { ok: false, error: 'Room not found' };
  const members = await loadMembersMap(r);
  for (const [id, m] of Object.entries(members)) {
    if (m.room === n) await deleteMember(r, id);
  }
  await r.hdel(ROOMS_KEY, n);
  await r.del(msgListKey(n), seqKey(n));
  return { ok: true };
}

async function adminEditRoom({ name, newName, newPassword }) {
  const r = getRedis();
  const n = String(name || '').trim();
  const meta = await getRoomMeta(r, n);
  if (!meta) return { ok: false, error: 'Room not found' };
  const nn =
    newName != null && String(newName).trim() !== '' ? String(newName).trim() : n;
  const np =
    newPassword != null && String(newPassword).trim() !== ''
      ? String(newPassword).trim()
      : null;

  if (nn !== n) {
    if (await r.hget(ROOMS_KEY, nn)) return { ok: false, error: 'New name already exists' };
    const nextPassword = np || meta.password;
    await r.hset(ROOMS_KEY, { [nn]: JSON.stringify({ password: nextPassword }) });
    await r.hdel(ROOMS_KEY, n);

    const oldMsgs = msgListKey(n);
    const newMsgs = msgListKey(nn);
    if (await r.exists(oldMsgs)) await r.rename(oldMsgs, newMsgs);

    const oldSeq = seqKey(n);
    const newSeq = seqKey(nn);
    if (await r.exists(oldSeq)) await r.rename(oldSeq, newSeq);
    else await r.set(newSeq, '0');

    const members = await loadMembersMap(r);
    for (const [id, m] of Object.entries(members)) {
      if (m.room === n) {
        m.room = nn;
        await saveMember(r, id, m);
      }
    }
  } else if (np) {
    await r.hset(ROOMS_KEY, { [n]: JSON.stringify({ password: np }) });
  }
  return { ok: true };
}

async function adminKick({ room, username }) {
  const r = getRedis();
  const ro = String(room || '').trim();
  const u = String(username || '').trim();
  if (!(await r.hget(ROOMS_KEY, ro))) return { ok: false, error: 'Room not found' };
  const members = await loadMembersMap(r);
  let kicked = false;
  for (const [id, m] of Object.entries(members)) {
    if (m.room === ro && m.username === u) {
      await deleteMember(r, id);
      kicked = true;
    }
  }
  if (!kicked) return { ok: false, error: 'Member not online' };
  return { ok: true };
}

async function adminJoin({ room, password, displayName }) {
  const r = getRedis();
  await ensureDefaultRooms(r);
  const meta = await getRoomMeta(r, room);
  if (!meta) return { ok: false, error: 'Chatroom not found' };
  if (meta.password !== password) return { ok: false, error: 'Incorrect room password' };
  const name = String(displayName || 'Admin').trim() || 'Admin';
  const memberId = uuidv4();
  await saveMember(r, memberId, {
    room,
    username: name,
    lastSeen: nowTs(),
    isAdmin: true,
  });
  const memNames = await membersInRoom(r, room);
  const history = await getHistory(r, room);
  const lid = await lastMessageId(r, room);
  return { ok: true, memberId, members: memNames, history, lastMessageId: lid };
}

async function adminListMembers({ room }) {
  const r = getRedis();
  const ro = String(room || '').trim();
  if (!(await r.hget(ROOMS_KEY, ro))) return { ok: false, error: 'Room not found' };
  const members = await loadMembersMap(r);
  const t = nowTs();
  const list = [];
  for (const [id, m] of Object.entries(members)) {
    if (m.room !== ro) continue;
    if (t - m.lastSeen > HEARTBEAT_MS) continue;
    list.push({ memberId: id, username: m.username });
  }
  list.sort((a, b) => a.username.localeCompare(b.username));
  return { ok: true, members: list };
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
};
