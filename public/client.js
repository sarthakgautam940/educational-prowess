(function () {
  const ADMIN_CODE = 'Password940!';

  const POLL_MS = 900;
  const HEARTBEAT_MS = 20_000;

  let selectedRoom = null;
  let memberId = null;
  let currentRoom = null;
  let displayName = null;
  let lastMessageId = 0;
  let pollTimer = null;
  let hbTimer = null;
  let adminLoggedIn = false;

  const $ = (id) => document.getElementById(id);

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  async function readJsonBody(res) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      const flat = text.replace(/\s+/g, ' ').trim().slice(0, 120);
      const isHtml = /^<!DOCTYPE/i.test(text.trim()) || /^<html/i.test(text.trim());
      return {
        ok: false,
        error: isHtml
          ? 'Server returned HTML instead of the chat API. Redeploy the latest branch (uses /api + vercel.json rewrites) or check Vercel project settings.'
          : `Invalid response (${flat || 'not JSON'})`,
      };
    }
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = await readJsonBody(res);
    return { res, data };
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  function stopSession() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = null;
    memberId = null;
    currentRoom = null;
    displayName = null;
    lastMessageId = 0;
  }

  async function fetchRooms() {
    $('roomsLoadError').textContent = '';
    try {
      const res = await fetch('/api/chatrooms');
      const data = await readJsonBody(res);
      if (!data || !data.ok) {
        throw new Error((data && data.error) || 'Failed to load');
      }
      renderRooms(data.rooms || []);
      syncAdminRoomOptions(data.rooms || []);
    } catch (e) {
      $('roomsLoadError').textContent = e.message || 'Could not load rooms';
    }
  }

  function renderRooms(rooms) {
    const list = $('chatroomsList');
    list.innerHTML = '';
    rooms.forEach((name) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'room-tile';
      btn.innerHTML = `<span class="room-tile-name">${escapeHtml(name)}</span><span class="room-tile-chev">→</span>`;
      btn.addEventListener('click', () => openJoin(name));
      list.appendChild(btn);
    });
  }

  function syncAdminRoomOptions(rooms) {
    const dl = $('adminRoomOptions');
    if (!dl) return;
    dl.innerHTML = '';
    rooms.forEach((r) => {
      const o = document.createElement('option');
      o.value = r;
      dl.appendChild(o);
    });
  }

  function openJoin(roomName) {
    selectedRoom = roomName;
    $('roomName').textContent = roomName;
    $('passwordInput').value = '';
    $('usernameInput').value = '';
    $('joinError').textContent = '';
    showScreen('joinScreen');
    requestAnimationFrame(() => $('passwordInput').focus());
  }

  function backToRooms() {
    showScreen('chatroomsScreen');
    fetchRooms();
  }

  function appendMessage(msg, mine) {
    const container = $('messagesContainer');
    const row = document.createElement('div');
    row.className = 'msg' + (mine ? ' msg-mine' : '');
    row.innerHTML = `
      <div class="msg-meta">
        <span class="msg-user">${escapeHtml(msg.username)}</span>
        <span class="msg-time">${escapeHtml(formatTime(msg.time))}</span>
      </div>
      <div class="msg-body">${escapeHtml(msg.text)}</div>
    `;
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  function renderHistory(messages) {
    const container = $('messagesContainer');
    container.innerHTML = '';
    (messages || []).forEach((m) => appendMessage(m, m.username === displayName));
    lastMessageId = messages && messages.length ? messages[messages.length - 1].id : 0;
  }

  function renderMembers(names) {
    const list = names && names.length ? names : [];
    const n = list.length;
    const who =
      n === 0
        ? 'No one here yet'
        : `${n} online: ${list.map(escapeHtml).join(', ')}`;
    $('membersList').innerHTML = who;
  }

  async function pollOnce() {
    if (!memberId || !currentRoom) return;
    const { res, data } = await api('/api/poll', {
      memberId,
      room: currentRoom,
      afterMessageId: lastMessageId,
    });
    if (!res.ok || !data || !data.ok) {
      const err = (data && data.error) || 'Session lost';
      onSessionError(err);
      return;
    }
    renderMembers(data.members || []);
    (data.newMessages || []).forEach((m) => {
      appendMessage(m, m.username === displayName);
      lastMessageId = m.id;
    });
    if (typeof data.lastMessageId === 'number' && data.lastMessageId > lastMessageId) {
      lastMessageId = data.lastMessageId;
    }
  }

  function onSessionError(msg) {
    stopSession();
    $('chatSessionError').textContent = msg;
    $('messagesContainer').innerHTML = '';
    $('membersList').textContent = '';
    showScreen('chatroomsScreen');
    fetchRooms();
  }

  async function joinChatroom() {
    const password = $('passwordInput').value;
    const username = $('usernameInput').value.trim();
    if (!password.trim() || !username) {
      $('joinError').textContent = 'Enter room code and your name';
      return;
    }
    $('joinError').textContent = '';
    const { res, data } = await api('/api/join', {
      room: selectedRoom,
      password,
      username,
    });
    if (!res.ok || !data || !data.ok) {
      $('joinError').textContent = (data && data.error) || 'Could not join';
      return;
    }
    stopSession();
    memberId = data.memberId;
    currentRoom = selectedRoom;
    displayName = username;
    lastMessageId = data.lastMessageId || 0;
    $('currentRoomName').textContent = currentRoom;
    $('chatSessionError').textContent = '';
    renderHistory(data.history || []);
    renderMembers(data.members || []);
    showScreen('chatScreen');
    $('messageInput').value = '';
    $('messageInput').focus();

    pollTimer = setInterval(pollOnce, POLL_MS);
    hbTimer = setInterval(() => {
      api('/api/heartbeat', { memberId }).catch(() => {});
    }, HEARTBEAT_MS);
    pollOnce();
  }

  async function sendMessage() {
    const input = $('messageInput');
    const text = input.value.trim();
    if (!text || !memberId) return;
    input.value = '';
    const { res, data } = await api('/api/send', { memberId, text });
    if (!res.ok || !data || !data.ok) {
      input.value = text;
      $('chatSessionError').textContent = (data && data.error) || 'Send failed';
      return;
    }
    $('chatSessionError').textContent = '';
    if (data.message) {
      appendMessage(data.message, true);
      lastMessageId = data.message.id;
    }
    input.focus();
  }

  async function leaveChatroom() {
    if (memberId) await api('/api/leave', { memberId }).catch(() => {});
    stopSession();
    $('messagesContainer').innerHTML = '';
    $('membersList').textContent = '';
    $('chatSessionError').textContent = '';
    showScreen('chatroomsScreen');
    fetchRooms();
  }

  function openAdminModal() {
    $('adminModal').classList.add('open');
    $('adminModal').setAttribute('aria-hidden', 'false');
    if (!adminLoggedIn) $('adminCode').focus();
  }

  function closeAdminModal() {
    $('adminModal').classList.remove('open');
    $('adminModal').setAttribute('aria-hidden', 'true');
  }

  function resetAdminPanel() {
    adminLoggedIn = false;
    $('adminLogin').classList.remove('hidden');
    $('adminPanel').classList.add('hidden');
    $('adminCode').value = '';
    $('adminLoginError').textContent = '';
    switchTab('create');
  }

  function adminUnlock() {
    const code = $('adminCode').value;
    if (code !== ADMIN_CODE) {
      $('adminLoginError').textContent = 'Invalid admin code';
      return;
    }
    adminLoggedIn = true;
    $('adminLoginError').textContent = '';
    $('adminLogin').classList.add('hidden');
    $('adminPanel').classList.remove('hidden');
    loadManageRooms();
    fetchRooms();
  }

  const TAB_PANES = { create: 'tabCreate', manage: 'tabManage', adminjoin: 'tabAdminjoin' };

  function switchTab(name) {
    const paneId = TAB_PANES[name];
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-pane').forEach((p) => {
      p.classList.toggle('active', !!paneId && p.id === paneId);
    });
  }

  async function adminPost(path, extra) {
    return api(path, { code: ADMIN_CODE, ...(extra || {}) });
  }

  async function createRoom() {
    const name = $('newRoomName').value.trim();
    const password = $('newRoomPassword').value;
    $('createStatus').textContent = '';
    if (!name || !password) {
      $('createStatus').textContent = 'Name and room code required';
      $('createStatus').classList.add('err');
      return;
    }
    const { res, data } = await adminPost('/api/admin/create-room', { name, password });
    if (!res.ok || !data || !data.ok) {
      $('createStatus').textContent = (data && data.error) || 'Could not create';
      $('createStatus').classList.add('err');
      return;
    }
    $('createStatus').textContent = `Created “${name}”`;
    $('createStatus').classList.remove('err');
    $('newRoomName').value = '';
    $('newRoomPassword').value = '';
    renderRooms(data.rooms || []);
    syncAdminRoomOptions(data.rooms || []);
    loadManageRooms();
  }

  async function loadManageRooms() {
    const wrap = $('manageRoomsList');
    wrap.innerHTML = '<p class="subtle small">Loading…</p>';
    const res = await fetch('/api/chatrooms');
    const data = await readJsonBody(res);
    if (!data || !data.ok) {
      wrap.innerHTML =
        '<p class="error-text">' +
        escapeHtml((data && data.error) || 'Could not load rooms') +
        '</p>';
      return;
    }
    const rooms = data.rooms || [];
    wrap.innerHTML = '';
    for (const room of rooms) {
      wrap.appendChild(await renderManageCard(room));
    }
  }

  async function renderManageCard(room) {
    const card = document.createElement('div');
    card.className = 'manage-card';

    const head = document.createElement('div');
    head.className = 'manage-card-head';
    head.innerHTML = `<strong>${escapeHtml(room)}</strong>`;

    const { res, data } = await adminPost('/api/admin/members', { room });
    const members =
      res.ok && data && data.ok && data.members ? data.members : [];

    const kickRow = document.createElement('div');
    kickRow.className = 'kick-row';
    if (!members.length) {
      kickRow.innerHTML = '<span class="subtle small">No active members</span>';
    } else {
      members.forEach((m) => {
        const row = document.createElement('div');
        row.className = 'kick-line';
        row.innerHTML = `<span>${escapeHtml(m.username)}</span>`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn micro danger';
        btn.textContent = 'Kick';
        btn.addEventListener('click', async () => {
          const { res: r2, data: d2 } = await adminPost('/api/admin/kick', {
            room,
            username: m.username,
          });
          $('manageStatus').textContent =
            r2.ok && d2 && d2.ok ? `Removed ${m.username}` : (d2 && d2.error) || 'Kick failed';
          $('manageStatus').classList.toggle('err', !(r2.ok && d2 && d2.ok));
          loadManageRooms();
        });
        row.appendChild(btn);
        kickRow.appendChild(row);
      });
    }

    const rename = document.createElement('label');
    rename.className = 'field tight';
    rename.innerHTML = `<span class="field-label">Rename (optional)</span>`;
    const renameIn = document.createElement('input');
    renameIn.type = 'text';
    renameIn.placeholder = 'New room name';
    renameIn.maxLength = 64;
    rename.appendChild(renameIn);

    const pass = document.createElement('label');
    pass.className = 'field tight';
    pass.innerHTML = `<span class="field-label">New room code (optional)</span>`;
    const passIn = document.createElement('input');
    passIn.type = 'password';
    passIn.placeholder = 'Leave blank to keep';
    pass.appendChild(passIn);

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn small';
    saveBtn.textContent = 'Save changes';
    saveBtn.addEventListener('click', async () => {
      const newName = renameIn.value.trim();
      const newPassword = passIn.value;
      const { res: r2, data: d2 } = await adminPost('/api/admin/edit-room', {
        name: room,
        newName: newName || room,
        newPassword: newPassword || null,
      });
      $('manageStatus').textContent =
        r2.ok && d2 && d2.ok ? 'Room updated' : (d2 && d2.error) || 'Update failed';
      $('manageStatus').classList.toggle('err', !(r2.ok && d2 && d2.ok));
      fetchRooms();
      loadManageRooms();
      passIn.value = '';
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn small danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      if (!window.confirm(`Delete room “${room}”?`)) return;
      const { res: r2, data: d2 } = await adminPost('/api/admin/delete-room', { name: room });
      $('manageStatus').textContent =
        r2.ok && d2 && d2.ok ? 'Room deleted' : (d2 && d2.error) || 'Delete failed';
      $('manageStatus').classList.toggle('err', !(r2.ok && d2 && d2.ok));
      fetchRooms();
      loadManageRooms();
    });

    actions.appendChild(saveBtn);
    actions.appendChild(delBtn);

    card.appendChild(head);
    card.appendChild(kickRow);
    card.appendChild(rename);
    card.appendChild(pass);
    card.appendChild(actions);
    return card;
  }

  async function adminJoinFlow() {
    $('adminJoinStatus').textContent = '';
    const room = $('adminJoinRoom').value.trim();
    const password = $('adminJoinPassword').value;
    const nm = $('adminJoinName').value.trim();
    if (!room || !password) {
      $('adminJoinStatus').textContent = 'Room and code required';
      $('adminJoinStatus').classList.add('err');
      return;
    }
    const { res, data } = await adminPost('/api/admin/join', {
      room,
      password,
      displayName: nm || 'Admin',
    });
    if (!res.ok || !data || !data.ok) {
      $('adminJoinStatus').textContent = (data && data.error) || 'Could not join';
      $('adminJoinStatus').classList.add('err');
      return;
    }
    stopSession();
    memberId = data.memberId;
    currentRoom = room;
    displayName = (nm || 'Admin').trim() || 'Admin';
    lastMessageId = data.lastMessageId || 0;
    $('currentRoomName').textContent = `${currentRoom} · admin`;
    $('chatSessionError').textContent = '';
    renderHistory(data.history || []);
    renderMembers(data.members || []);
    closeAdminModal();
    showScreen('chatScreen');
    $('messageInput').focus();

    pollTimer = setInterval(pollOnce, POLL_MS);
    hbTimer = setInterval(() => {
      api('/api/heartbeat', { memberId }).catch(() => {});
    }, HEARTBEAT_MS);
    pollOnce();
  }

  $('adminText').addEventListener('click', () => {
    resetAdminPanel();
    openAdminModal();
  });
  $('adminText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      resetAdminPanel();
      openAdminModal();
    }
  });

  $('adminCloseBtn').addEventListener('click', () => {
    closeAdminModal();
    resetAdminPanel();
  });

  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => {
      closeAdminModal();
      resetAdminPanel();
    });
  });

  $('adminLoginBtn').addEventListener('click', adminUnlock);
  $('joinBtn').addEventListener('click', joinChatroom);
  $('joinBackBtn').addEventListener('click', backToRooms);
  $('leaveBtn').addEventListener('click', leaveChatroom);
  $('sendBtn').addEventListener('click', sendMessage);
  $('messageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  $('createRoomBtn').addEventListener('click', createRoom);
  $('adminJoinBtn').addEventListener('click', adminJoinFlow);

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('adminModal').classList.contains('open')) {
      closeAdminModal();
      resetAdminPanel();
    }
  });

  fetchRooms();
})();
