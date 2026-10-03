import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

// Tests never touch the development database.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must be set for tests (see .env.example)");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
(process.env as Record<string, string>).NODE_ENV = "test";
