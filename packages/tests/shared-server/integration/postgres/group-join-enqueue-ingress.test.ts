import { describe, expect, it } from 'vitest';

import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { decodePersistedAppInboxEnqueue } from '@shared-server/rallar-system/app-inbox/app-inbox-command-decoding.ts';
import { decodeGroupStateInboxAuthority } from '@shared-server/rallar-system/group-state/inbox/decode-group-state-inbox-authority.ts';

import { toGroupAppInboxStorageCommandId } from './test-support/postgres-group-app-inbox-mutation.ts';
import { createInterleavedGroupWrite, withPostgresGroupJoinHarness } from './test-support/postgres-group-join-harness.ts';

const POSTGRES_INTEGRATION_ENABLED = process.env.RALLAR_POSTGRES_INTEGRATION === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;

describe('Postgres group join enqueue-time ingress', () => {
    postgresIt('stores the join\'s ingress at enqueue and reuses its facts on a conflict retry', async () => {
        await withPostgresGroupJoinHarness('join-enqueue-ingress', async (harness) => {
            harness.probe.interleave = createInterleavedGroupWrite(harness.sql, harness.groupRef);

            const enqueue = await harness.join('bob');

            expect(harness.probe.interleave.writeCount()).toBe(1);
            expect(harness.queueEntries.reservations).toHaveLength(1);
            const enqueued = readIngress(harness.queueEntries.reservations[0]);
            // The lane neither captured nor persisted an ingress on either attempt.
            expect(harness.queueEntries.replacementCount).toBe(0);
            const record = await harness.repository.findIdempotentGroupMutationReceipt(
                harness.groupRef,
                toGroupAppInboxStorageCommandId(enqueue, 'bob')
            );
            expect(record?.receipt).toMatchObject({
                outcome: 'applied',
                attemptCount: 2,
                eventId: enqueued.facts.eventId,
                commandHash: enqueued.facts.commandHash
            });
            const events = await harness.repository.listEvents(harness.groupRef);
            expect(events.find((event) => event.eventId === enqueued.facts.eventId)).toMatchObject({
                occurredAtEpochMs: enqueued.facts.nowEpochMs
            });
        });
    }, 30_000);
});

function readIngress(entry: ResourceEntry | undefined) {
    if (entry === undefined) {
        throw new Error('The join was not reserved at enqueue');
    }
    return decodeGroupStateInboxAuthority(decodePersistedAppInboxEnqueue(entry).authority);
}
