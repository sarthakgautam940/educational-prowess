const memoryStore = require('./memoryStore');
const redisStore = require('./redisStore');

function useRedis() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function getStore() {
  return useRedis() ? redisStore : memoryStore;
}

module.exports = { getStore, useRedis };
