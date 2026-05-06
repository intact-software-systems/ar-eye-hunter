import type { Sql } from 'postgres';
import postgres from 'postgres';
import { tryWith } from '@shared/resilience/TryWith.ts';
import type { QueueBoxPubSubMessage } from '@shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts';

let listenSqlInstance: Sql | undefined;

export function getListenSql(): Sql {
    if (listenSqlInstance) {
        return listenSqlInstance;
    }

    const DATABASE_URL = Deno.env.get('DATABASE_URL');
    if (!DATABASE_URL) {
        throw new Error('DATABASE_URL missing');
    }

    listenSqlInstance = postgres(
        DATABASE_URL,
        {
            max: 1,
            idle_timeout: 0,
        },
    );

    return listenSqlInstance;
}

export async function startListening(
    channel: string,
    options: Readonly<{
        publisherId: string;
        onMessage: (payload: QueueBoxPubSubMessage) => void | Promise<void>;
    }>,
) {
    await tryWith(
        async () => {
            return await getListenSql()
                .listen(
                    channel,
                    async (payload: string) => {
                        const publisherPayload = JSON.parse(payload) as QueueBoxPubSubMessage;

                        if (publisherPayload.publisherId === options.publisherId) {
                            // I sent it so ignore it
                            // console.log(`Ignoring my own message: ${payload}`)
                            return;
                        }

                        try {
                            await options.onMessage(publisherPayload);
                        } catch (e) {
                            console.error(e);
                        }
                    },
                );
        },
    );

    console.log(`Listening on channel '${channel}'`);
}
