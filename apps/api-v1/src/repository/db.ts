import postgres from "postgres";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
if (!DATABASE_URL) throw new Error("DATABASE_URL missing");

export const sql =
    postgres(
        DATABASE_URL,
        {
            max: 5,              // pool size
            idle_timeout: 20
        }
    );