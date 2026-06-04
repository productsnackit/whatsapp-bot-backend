import Redis from "ioredis";

console.log("REDIS_URL:", process.env.REDIS_URL);

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: process.env.REDIS_URL?.startsWith("rediss://") ? {} : undefined, // ✅ FIX
});

redis.on("connect", () => {
  console.log("✅ Redis connected");
});

redis.on("error", (err) => {
  console.error("❌ Redis error:", err.message);
});

export default redis;