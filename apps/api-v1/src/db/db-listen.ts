import type { Sql } from 'postgres';
import postgres from 'postgres';
import { tryWith } from '@shared/resilience/TryWith.ts';
import { readPostgresConnectionUrl } from './db.ts';

let listenSqlInstance: Sql | undefined;

export function getListenSql(): Sql {
  if (listenSqlInstance) {
    return listenSqlInstance;
  }

  listenSqlInstance = postgres(
    readPostgresConnectionUrl(),
    {
      max: 1,
      idle_timeout: 0,
    },
  );

  return listenSqlInstance;
}

export async function startListening<T extends Readonly<{ publisherId: string }>>(
  channel: string,
  options: Readonly<{
    publisherId: string;
    onMessage: (payload: T) => void | Promise<void>;
  }>,
) {
  await tryWith(
    async () => {
      return await getListenSql()
        .listen(
          channel,
          async (payload: string) => {
            const publisherPayload = JSON.parse(payload) as T;

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
