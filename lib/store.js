const memoryStore = require('./memoryStore');
const redisStore = require('./redisStore');

/** Upstash or Vercel KV (Redis-compatible REST API). */
function useSharedStore() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    process.env.VERCEL_KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.VERCEL_KV_REST_API_TOKEN;
  return !!(url && token);
}

function getStore() {
  return useSharedStore() ? redisStore : memoryStore;
}

module.exports = { getStore, useSharedStore };
