import { createClient } from "@supabase/supabase-js";
import "./env";

// Server-only client (secret key) — never import from client components.
export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } }
);
