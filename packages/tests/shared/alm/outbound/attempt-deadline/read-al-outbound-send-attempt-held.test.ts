import { describe, expect, it } from 'vitest';

import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { readALOutboundSendAttemptHeld } from '@shared/alm/outbound/attempt-deadline/read-al-outbound-send-attempt-held.ts';
import {
    toALOutboundAttemptSendEffectIds,
    type ALOutboundPlannedSendAttempt
} from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import {
    EntityStatus,
    toKeyAsString,
    toResourceEntryWithKey,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

const NAMESPACE = 'attempt-held';

/** The work rows of a store, by key, and how many reads they answered. */
interface WorkRowsDouble {
    readonly namespace: string;
    readonly reads: { count: number; };
    readWork(key: Key): Promise<ResourceEntry | undefined>;
}

function toAttempt(copies: readonly string[], phase: 'immediate' | 'dequeue' = 'immediate'): ALOutboundPlannedSendAttempt<string> {
    return { msgId: 'held-message', attemptIdentity: 'initial', phase, preparedMessages: copies };
}

/** A store holding one row per send of `written`, each in the status named for its copy. */
function createWorkRows(written: ALOutboundPlannedSendAttempt<string>, statuses: readonly EntityStatus[]): WorkRowsDouble {
    const rows = new Map(
        toALOutboundAttemptSendEffectIds(written).map((effectId, index) => {
            const key = toALOutboundWorkKey(NAMESPACE, effectId);
            return [toKeyAsString(key), { ...toResourceEntryWithKey(key, 'send-prepared', {}), status: statuses[index]! }];
        })
    );
    const reads = { count: 0 };
    return {
        namespace: NAMESPACE,
        reads,
        readWork: async (key) => {
            reads.count += 1;
            return rows.get(toKeyAsString(key));
        }
    };
}

describe('whether an attempt is still held for its carrier', () => {
    it('is not held when the message is planned with no copy, and reads nothing', async () => {
        const store = createWorkRows(toAttempt(['copy-a']), [EntityStatus.NEW]);

        expect(await readALOutboundSendAttemptHeld(store, toAttempt([]))).toBe(false);
        expect(store.reads.count).toBe(0);
    });

    it.each([EntityStatus.NEW, EntityStatus.RETRY, EntityStatus.RESERVED])('is held while its one copy is %s', async (status) => {
        const attempt = toAttempt(['copy-a']);

        expect(await readALOutboundSendAttemptHeld(createWorkRows(attempt, [status]), attempt)).toBe(true);
    });

    it('is not held once its one copy completed', async () => {
        const attempt = toAttempt(['copy-a']);

        expect(await readALOutboundSendAttemptHeld(createWorkRows(attempt, [EntityStatus.COMPLETED]), attempt)).toBe(false);
    });

    it('is not held when its one copy has no row', async () => {
        const attempt = toAttempt(['copy-a']);

        expect(await readALOutboundSendAttemptHeld(createWorkRows(toAttempt([]), []), attempt)).toBe(false);
    });

    it('is held while both copies are pending, after reading both', async () => {
        const attempt = toAttempt(['copy-a', 'copy-b']);
        const store = createWorkRows(attempt, [EntityStatus.NEW, EntityStatus.RETRY]);

        expect(await readALOutboundSendAttemptHeld(store, attempt)).toBe(true);
        expect(store.reads.count).toBe(2);
    });

    it('is not held once its first copy completed, after one read', async () => {
        const attempt = toAttempt(['copy-a', 'copy-b']);
        const store = createWorkRows(attempt, [EntityStatus.COMPLETED, EntityStatus.NEW]);

        expect(await readALOutboundSendAttemptHeld(store, attempt)).toBe(false);
        expect(store.reads.count).toBe(1);
    });

    it('is not held when one copy left and the other is still pending', async () => {
        const attempt = toAttempt(['copy-a', 'copy-b']);

        expect(await readALOutboundSendAttemptHeld(createWorkRows(attempt, [EntityStatus.NEW, EntityStatus.COMPLETED]), attempt))
            .toBe(false);
    });

    it.each([
        { label: 'another prepared copy', written: toAttempt(['copy-b']) },
        { label: 'another phase', written: toAttempt(['copy-a'], 'dequeue') }
    ])('is not held when the pending row was written for $label than the message is planned with now', async ({ written }) => {
        expect(await readALOutboundSendAttemptHeld(createWorkRows(written, [EntityStatus.NEW]), toAttempt(['copy-a']))).toBe(false);
    });
});
