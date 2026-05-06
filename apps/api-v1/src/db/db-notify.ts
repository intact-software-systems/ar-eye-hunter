import { sql } from './db.ts';
import type { QueueBoxPubSubMessage } from '@shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts';

export async function notify(channel: string, message: QueueBoxPubSubMessage) {
    await sql.notify(channel, JSON.stringify(message));
}
