// Loads .env.local for standalone scripts (Next.js loads it itself).
import { loadEnvFile } from "node:process";
import { join } from "node:path";

try {
  loadEnvFile(join(import.meta.dirname, "../.env.local"));
} catch {
  // fine if missing — env vars may be set by the environment (e.g. cron)
}
