import { sql } from './db.ts';
export async function notify(channel: string, message: unknown) {
  await sql.notify(channel, JSON.stringify(message));
}
