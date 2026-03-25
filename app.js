const path = require('path');
const express = require('express');
const cors = require('cors');
const { ADMIN_CODE } = require('./lib/constants');
const { getStore } = require('./lib/store');

function createApp() {
  const store = getStore();

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '32kb' }));

  function requireAdmin(req, res, next) {
    if (req.body && req.body.code === ADMIN_CODE) return next();
    res.status(403).json({ ok: false, error: 'Invalid admin code' });
  }

  function chatroomsHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }
    (async () => {
      try {
        const rooms = await store.getChatrooms();
        res.json({ ok: true, rooms });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Server error' });
      }
    })();
  }

  app.get('/api/chatrooms', chatroomsHandler);
  app.post('/api/chatrooms', chatroomsHandler);

  app.post('/api/join', async (req, res) => {
    try {
      const { room, password, username } = req.body || {};
      const result = await store.tryJoin({
        room: String(room || '').trim(),
        password: String(password || ''),
        username: String(username || '').trim(),
      });
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  app.post('/api/poll', async (req, res) => {
    try {
      const { memberId, room, afterMessageId } = req.body || {};
      const result = await store.tryPoll({
        memberId: String(memberId || ''),
        room: String(room || '').trim(),
        afterMessageId: Number(afterMessageId) || 0,
      });
      if (!result.ok) return res.status(401).json(result);
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  app.post('/api/send', async (req, res) => {
    try {
      const { memberId, text } = req.body || {};
      const result = await store.trySend({ memberId: String(memberId || ''), text });
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  app.post('/api/heartbeat', async (req, res) => {
    try {
      const { memberId } = req.body || {};
      const result = await store.tryHeartbeat({ memberId: String(memberId || '') });
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  app.post('/api/leave', async (req, res) => {
    try {
      const { memberId } = req.body || {};
      await store.tryLeave({ memberId: String(memberId || '') });
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  app.post('/api/admin/create-room', requireAdmin, async (req, res) => {
    try {
      const { name, password } = req.body || {};
      const result = await store.adminCreateRoom({
        name: String(name || '').trim(),
        password: String(password || ''),
      });
      if (!result.ok) return res.status(400).json(result);
      const rooms = await store.getChatrooms();
      res.json({ ok: true, rooms });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  app.post('/api/admin/delete-room', requireAdmin, async (req, res) => {
    try {
      const { name } = req.body || {};
      const result = await store.adminDeleteRoom({ name: String(name || '').trim() });
      if (!result.ok) return res.status(400).json(result);
      const rooms = await store.getChatrooms();
      res.json({ ok: true, rooms });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  app.post('/api/admin/edit-room', requireAdmin, async (req, res) => {
    try {
      const { name, newName, newPassword } = req.body || {};
      const result = await store.adminEditRoom({
        name: String(name || '').trim(),
        newName: newName != null ? String(newName) : null,
        newPassword: newPassword != null ? String(newPassword) : null,
      });
      if (!result.ok) return res.status(400).json(result);
      const rooms = await store.getChatrooms();
      res.json({ ok: true, rooms });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  app.post('/api/admin/kick', requireAdmin, async (req, res) => {
    try {
      const { room, username } = req.body || {};
      const result = await store.adminKick({
        room: String(room || '').trim(),
        username: String(username || '').trim(),
      });
      if (!result.ok) return res.status(400).json(result);
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  app.post('/api/admin/join', requireAdmin, async (req, res) => {
    try {
      const { room, password, displayName } = req.body || {};
      const result = await store.adminJoin({
        room: String(room || '').trim(),
        password: String(password || ''),
        displayName: String(displayName || '').trim(),
      });
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  app.post('/api/admin/members', requireAdmin, async (req, res) => {
    try {
      const { room } = req.body || {};
      const result = await store.adminListMembers({ room: String(room || '').trim() });
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Server error' });
    }
  });

  app.use(express.static(path.join(__dirname, 'public')));

  return app;
}

module.exports = createApp;
