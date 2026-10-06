import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Neon requires SSL
  },
});

// Debug logs
console.log("✅ DB CONNECTING TO:", process.env.DATABASE_URL?.slice(0, 30) + "...");
console.log("✅ Pool Query Type:", typeof pool.query);

// ✅ Export clean query wrapper (IMPORTANT FIX)
export default {
  query: (...args) => pool.query(...args),
  connect: () => pool.connect(), // a client of its own, for a transaction
};