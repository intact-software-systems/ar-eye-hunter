import { Either } from '@shared/resilience/Either.ts';
import { describe, expect, it, vi } from 'vitest';

import { AppInboxCommandClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-command-client.ts';
import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxResultWaiter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import { toAppInboxResourceEntry } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

const COMMAND: AppInboxEnqueueInput = {
    type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
    resourceId: 'command-1',
    contextId: 'app:workspace:principal',
    senderId: 'principal',
    data: { requestId: 'command-1', principalId: 'principal' }
};

describe('AppInboxCommandClient', () => {
    it('enqueues once and decodes the completed persisted result at the boundary', async () => {
        const entry = toAppInboxResourceEntry(COMMAND, 'server-12345678');
        const enqueue = vi.fn(async () => entry);
        const decodedValues: JsonWireValue[] = [];
        const waitForResult = vi.fn(async (
            _enqueue: AppInboxEnqueueInput,
            _key: typeof entry.key,
            decodeResult: AppInboxResultWaiter.ResultDecoder<{ accepted: boolean; }>
        ) => {
            const value = { status: 'stored' } as const;
            decodedValues.push(value);
            return Either.ofRight(decodeResult(value));
        });
        const client = new AppInboxCommandClient(
            {
                queueEntryWriter: {
                    enqueue,
                    enqueueReplacingWhen: vi.fn()
                },
                resultWaiter: { waitForResult }
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
            accepted: typeof value === 'object' && value !== null && value.status === 'stored'
        }));

        expect(result).toEqual(Either.ofRight({ accepted: true }));
        expect(enqueue).toHaveBeenCalledExactlyOnceWith(COMMAND);
        expect(waitForResult).toHaveBeenCalledOnce();
        expect(decodedValues).toEqual([{ status: 'stored' }]);
    });
});
