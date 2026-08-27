import { Either } from '@shared/resilience/Either.ts';
import { describe, expect, it } from 'vitest';

import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { toAppInboxResourceEntry } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { AppInboxCommandClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-command-client.ts';
import type { AppInboxResultWaiter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

const COMMAND: AppInboxEnqueueInput = {
    type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
    resourceId: 'command-1',
    contextId: 'app:workspace:principal',
    senderId: 'principal',
    data: { requestId: 'command-1', principalId: 'principal' }
};

describe('AppInboxCommandClient', () => {
    it('passes the durable queue identity to the result decoding boundary', async () => {
        const entry = toAppInboxResourceEntry(COMMAND, 'server-12345678');
        const decodedValues: JsonWireValue[] = [];
        const client = new AppInboxCommandClient(
            {
                queueEntryWriter: {
                    enqueue: async (enqueue) =>
                        toAppInboxResourceEntry(
                            enqueue,
                            'server-12345678'
                        ),
                    enqueueReplacingWhen: async () => entry.key
                },
                resultWaiter: {
                    waitForResult: async <Result>(
                        enqueue: AppInboxEnqueueInput,
                        key: typeof entry.key,
                        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
                    ) => {
                        if (enqueue !== COMMAND || key.contextId !== COMMAND.contextId) {
                            throw new TypeError('Command client passed an unrelated queue identity');
                        }
                        const value = { status: 'stored' } as const;
                        decodedValues.push(value);
                        return Either.ofRight(decodeResult(value));
                    }
                }
            },
            {
                serviceId: 'server-12345678',
                options: {
                    phaseTiming: false,
                    waitMaxElapsedMsecs: 1_000,
                    waitRetryIntervalMsecs: 1,
                    waitMaxRetryIntervalMsecs: 1,
                    waitJitterRatio: 0
                }
            }
        );

        const result = await client.enqueueAndWaitForResult(COMMAND, (value) => ({
            accepted: typeof value === 'object' &&
                value !== null &&
                'status' in value &&
                value.status === 'stored'
        }));

        expect(result).toEqual(Either.ofRight({ accepted: true }));
        expect(decodedValues).toEqual([{ status: 'stored' }]);
    });
});
