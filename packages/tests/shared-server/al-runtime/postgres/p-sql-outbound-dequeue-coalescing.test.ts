import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { createPSqlALOutboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundMessageRuntime
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { ALOutboundDequeueCoalescing } from '@shared/alm/outbound/lane/claim-al-outbound-work.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createOutboundMessage,
    createOutboundRuntimeWithWorkTask,
    OUTBOUND_TEST_SEND_PLANNER,
    runOutboundWorkTask
} from '../../../shared/alm/outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from '../../../shared/alm/outbound-test-payload.ts';
import { createPSqlAdmissionTestStorage, type PSqlAdmissionTestStorage } from './create-p-sql-admission-test-storage.ts';

describe('the PostgreSQL outbound lane coalescing a queued backlog', () => {
    // Before step 2g D300 the lane sent a backlog in queue order: the promotion's row waited behind 176 older rows,
    // eleven passes of sixteen, while the outbox drained 6.3 rows/s on the hosted 50.
    it('sends the newest row of a coalescing key in the first pass and never sends the rows it superseded', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { runtime, sent, outbox } = createCoalescingLane(storage);
        await runOutboundWorkTask(runtime);
        const groupRows = Array.from({ length: 100 }, (_value, index) => `group:${index}`);
        const otherRows = Array.from({ length: 77 }, (_value, index) => `other-${index}`);
        for (const resourceId of [...groupRows.slice(0, 50), ...otherRows, ...groupRows.slice(50)]) {
            await outbox.enqueue(
                QueueBoxUtilities.toResourceEntryFromMsg(createOutboundMessage(resourceId), 'outbox', Temporal.Now.instant())
            );
        }

        // A pass admits the rows it claims and the next one sends what the admission prepared.
        let passes = 0;
        while (passes < 30 && !sent.map(toText).includes('group:99')) {
            await runOutboundWorkTask(runtime);
            passes += 1;
        }
        expect(passes).toBeLessThanOrEqual(2);

        for (let pass = 0; pass < 20 && sent.length < otherRows.length + 1; pass += 1) {
            await runOutboundWorkTask(runtime);
        }
        expect(sent.map(toText).sort()).toEqual(['group:99', ...otherRows].sort());
        expect(
            (await storage.sql<{ count: number; }[]>`
            select count(*)::int as count from resource_inbox where ri_type_id = 'outbox' and ri_status <> 'COMPLETED'
        `)[0]!.count
        ).toBe(0);
    });
});

/** The test's coalescing key is the text before a colon: of one key's queued rows only the newest is sent. */
function resolveTestCoalescing(entries: readonly ResourceEntry[]): ALOutboundDequeueCoalescing {
    const keyed = entries.flatMap((entry) => {
        const text = toText(decodePersistedALMessage(entry.resource));
        return text.includes(':') ? [{ key: text.split(':')[0]!, entry }] : [];
    });
    const newestByKey = new Map(keyed.map(({ key, entry }) => [key, entry]));
    const superseded = keyed.flatMap(({ key, entry }) => newestByKey.get(key) === entry ? [] : [entry]);
    return { superseded, survivors: superseded.length === 0 ? [] : [...newestByKey.values()] };
}

function toText(message: ALMessage): string {
    return (JSON.parse(message.payload.resource) as { text: string; }).text;
}

function createCoalescingLane(storage: PSqlAdmissionTestStorage) {
    const stores = createPSqlALOutboundRuntimeStores({
        repository: storage.repository,
        namespace: 'dequeue-coalescing',
        nowMs: Date.now,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: undefined,
        decodePrepared: decodeOutboundTestPayload
    });
    const sent: ALMessage[] = [];
    const runtime = createOutboundRuntimeWithWorkTask(() =>
        createDefaultALOutboundMessageRuntime({
            decodePreparedMessage: decodeOutboundTestPayload,
            outbox: stores.workQueue,
            stores,
            dequeue: { types: new Set(['outbox']), resilience: createDefaultALOutboundDequeueResilience() },
            carrier: 'ws',
            nowMs: Date.now,
            toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox', Temporal.Now.instant()),
            readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
            resolveDequeueCoalescing: resolveTestCoalescing,
            planOutgoingMessage: OUTBOUND_TEST_SEND_PLANNER,
            sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                sent.push(lifecycle.canonicalMessage);
                return { status: 'sent', submissionAttempted: true };
            }
        })
    );
    return { runtime, sent, outbox: stores.workQueue };
}
