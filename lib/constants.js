const ADMIN_CODE = 'Password940!';

const DEFAULT_ROOMS = {
  English: { password: '67', messages: [], nextMessageId: 0 },
};

const MAX_MESSAGES_PER_ROOM = 200;
const HEARTBEAT_MS = 45_000;
const POLL_LIMIT_MESSAGES = 100;

module.exports = {
  ADMIN_CODE,
  DEFAULT_ROOMS,
  MAX_MESSAGES_PER_ROOM,
  HEARTBEAT_MS,
  POLL_LIMIT_MESSAGES,
};
