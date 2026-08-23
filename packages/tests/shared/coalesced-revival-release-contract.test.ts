import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { EnqueuedType } from '@shared/api/api-config.ts';
import { isIdempotentHandlerFinalizedRelease } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

const KEY = {
    topicId: 'app-outbox.rtc-topology',
    resourceId: 'overlay-1:group-revision',
    contextId: 'group-context-1'
};

interface CoalescedEntryInput {
    readonly generation: number;
    readonly status: EntityStatus;
    readonly attempts: number;
    readonly typeId?: EnqueuedType;
    readonly coalesced?: boolean;
}

function toCoalescedEntry(input: CoalescedEntryInput): ResourceEntry {
    const envelope = {
        type: 'rtc-topology-recompute',
        topicId: KEY.topicId,
        resourceId: KEY.resourceId,
        contextId: KEY.contextId,
        senderId: 'server-a',
        data: {
            kind: 'group-revision',
            ...(input.coalesced === false ? {} : {
                __rallarCoalescedWork: {
                    generation: input.generation,
                    requestedAtEpochMs: 1_000 + input.generation,
                    dueAtEpochMs: 1_500 + input.generation,
                    reasons: ['group-revision']
                }
            })
        }
    };
    const message = {
        id: { v: 2, msgId: `${KEY.resourceId}:g${input.generation}`, ts: 1_000, senderId: 'server-a' },
        route: KEY,
        payload: {
            typeId: 'rtc-topology-recompute',
            contentType: 'application/json',
            resource: JSON.stringify(envelope)
        },
        audit: { createdBy: 'server-a', createdTs: 1_000 }
    };
    const createdTs = Temporal.Instant.fromEpochMilliseconds(1_000)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key: KEY,
        resource: JSON.stringify(message),
        typeId: input.typeId ?? EnqueuedType.APP_OUTBOX,
        status: input.status,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: 'server-a',
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(9_000_000_000_000)
        },
        dequeueAudit: { attempts: input.attempts }
    };
}

const COMPLETED_DISPOSITION = { status: EntityStatus.COMPLETED, delayMs: null } as const;

describe('coalesced revival release contract', () => {
    it('accepts a release whose reserved coalesced work was finalized and revived in place', () => {
        const reserved = toCoalescedEntry({
            generation: 2,
            status: EntityStatus.RESERVED,
            attempts: 1
        });
        const revived = toCoalescedEntry({ generation: 3, status: EntityStatus.NEW, attempts: 0 });

        expect(isIdempotentHandlerFinalizedRelease(revived, reserved, COMPLETED_DISPOSITION)).toBe(
            true
        );
    });

    it('accepts a revived successor scheduled as RETRY for a later due time', () => {
        const reserved = toCoalescedEntry({
            generation: 2,
            status: EntityStatus.RESERVED,
            attempts: 1
        });
        const revived = toCoalescedEntry({ generation: 3, status: EntityStatus.RETRY, attempts: 0 });

        expect(isIdempotentHandlerFinalizedRelease(revived, reserved, COMPLETED_DISPOSITION)).toBe(
            true
        );
    });

    it('rejects a same-generation rewrite: no proof the reserved work was finalized first', () => {
        const reserved = toCoalescedEntry({
            generation: 2,
            status: EntityStatus.RESERVED,
            attempts: 1
        });
        const rewritten = toCoalescedEntry({ generation: 2, status: EntityStatus.NEW, attempts: 0 });

        expect(isIdempotentHandlerFinalizedRelease(rewritten, reserved, COMPLETED_DISPOSITION)).toBe(
            false
        );
    });

    it('rejects a revived row whose dequeue lifecycle was not reset', () => {
        const reserved = toCoalescedEntry({
            generation: 2,
            status: EntityStatus.RESERVED,
            attempts: 1
        });
        const revived = toCoalescedEntry({ generation: 3, status: EntityStatus.NEW, attempts: 1 });

        expect(isIdempotentHandlerFinalizedRelease(revived, reserved, COMPLETED_DISPOSITION)).toBe(
            false
        );
    });

    it('rejects non-coalesced rows: the generation proof requires both envelopes', () => {
        const reserved = toCoalescedEntry({
            generation: 2,
            status: EntityStatus.RESERVED,
            attempts: 1,
            coalesced: false
        });
        const revived = toCoalescedEntry({ generation: 3, status: EntityStatus.NEW, attempts: 0 });

        expect(isIdempotentHandlerFinalizedRelease(revived, reserved, COMPLETED_DISPOSITION)).toBe(
            false
        );
    });

    it('rejects a retry disposition: revival proof only confirms completions', () => {
        const reserved = toCoalescedEntry({
            generation: 2,
            status: EntityStatus.RESERVED,
            attempts: 1
        });
        const revived = toCoalescedEntry({ generation: 3, status: EntityStatus.NEW, attempts: 0 });

        expect(
            isIdempotentHandlerFinalizedRelease(revived, reserved, {
                status: EntityStatus.RETRY,
                delayMs: 1_000
            })
        ).toBe(false);
    });

    it('rejects WS_OUTBOX rows: revival is an APP_OUTBOX coalesced-work contract', () => {
        const reserved = toCoalescedEntry({
            generation: 2,
            status: EntityStatus.RESERVED,
            attempts: 1,
            typeId: EnqueuedType.WS_OUTBOX
        });
        const revived = toCoalescedEntry({
            generation: 3,
            status: EntityStatus.NEW,
            attempts: 0,
            typeId: EnqueuedType.WS_OUTBOX
        });

        expect(isIdempotentHandlerFinalizedRelease(revived, reserved, COMPLETED_DISPOSITION)).toBe(
            false
        );
    });
});
