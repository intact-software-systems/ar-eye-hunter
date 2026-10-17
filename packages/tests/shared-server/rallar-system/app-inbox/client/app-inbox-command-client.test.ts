import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { createAppInboxResourceEntry } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { AppInboxCommandClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-command-client.ts';
import type { AppInboxResultWaiter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';

import { createAppInboxQueueMessageFixture } from '../test-support/create-app-inbox-queue-message-fixture.ts';

const COMMAND: AppInboxEnqueueInput = {
    type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
    resourceId: 'command-1',
    contextId: 'app:workspace:principal',
    senderId: 'principal',
    data: { requestId: 'command-1', principalId: 'principal' }
};

describe('AppInboxCommandClient', () => {
    it('passes the durable queue identity to the result decoding boundary', async () => {
        const decodedValues: JsonWireValue[] = [];
        const client = new AppInboxCommandClient(
            {
                queueEntryWriter: {
                    enqueue: async (enqueue) =>
                        createAppInboxResourceEntry(
                            enqueue,
                            'server-12345678',
                            { creationNow: Temporal.Now.instant, createMessage: createAppInboxQueueMessageFixture }
                        )
                },
                resultWaiter: {
                    waitForResult: async <Result>(
                        enqueue: AppInboxEnqueueInput,
                        key: Key,
                        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
                    ) => {
                        expect(enqueue).toEqual(COMMAND);
                        expect(key).toEqual({ topicId: '', resourceId: 'command-1', contextId: 'app:workspace:principal' });
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

        const result = await client.enqueueAndWaitForResult({
            ...COMMAND,
            data: { requestId: 'command-1', principalId: 'principal' }
        }, (value) => ({
            accepted: typeof value === 'object' &&
                value !== null &&
                'status' in value &&
                value.status === 'stored'
        }));

        expect(result).toEqual(Either.ofRight({ accepted: true }));
        expect(decodedValues).toEqual([{ status: 'stored' }]);
    });
});
