import '../../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { createTestALInboundWorkPort } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import { toALInboundPendingAdmissionId } from '@shared/alm/inbound/al-inbound-pending-admission.ts';
import { computeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import {
    AL_INBOUND_WORK_PAGE_SIZE,
    createALInboundWorkSelector
} from '@shared/alm/inbound/read-al-inbound-work-selection.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { EntityStatus, toKeyAsString, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createInboundTestDispatch } from './create-inbound-test-dispatch.ts';
import { createInboundTestMessage, createInboundTestStores } from './inbound-runtime-test-fixture.ts';

const NAMESPACE = 'inbound-selection-starvation';
const RETRY_BACKOFF_MS = 30_000;

/** A retried admission: due at `nextAtMs`, as a release after a failed attempt leaves it. */
function toRetryRow(msgId: string, nextAtMs: number, nowMs: number): ResourceEntry {
    const created = createInboundTestMessage({ msgId });
    const msg = { ...created, constraints: { ...created.constraints, expiresAtMs: nowMs + 60_000 } };
    const { entry } = computeALInboundWorkEntry({
        signsForRecipient: false,
        carrier: 'ws',
        namespace: NAMESPACE,
        effectId: toALInboundPendingAdmissionId(msg),
        payload: {
            kind: 'admit-message',
            msg,
            source: {
                kind: 'ws-client',
                peerId: 'peer-1',
                authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' }
            }
        },
        observedAtMs: nowMs - 5_000,
        expireAtTimestamp: nowMs + 60_000
    });
    return {
        ...entry,
        status: EntityStatus.RETRY,
        dequeueAudit: { attempts: 1, nextTs: Temporal.Instant.fromEpochMilliseconds(nextAtMs) }
    };
}

/** `waiting` rows in retry backoff and one row due now: the one whose key sorts last, behind every page of them. */
function toRowsWithLastKeyDue(waiting: number, nowMs: number): { rows: ResourceEntry[]; due: ResourceEntry; } {
    const rows = Array.from({ length: waiting + 1 }, (_, index) => toRetryRow(`retry-${index}`, nowMs, nowMs))
        .sort((left, right) => toKeyAsString(left.key).localeCompare(toKeyAsString(right.key)));
    const backedOff = rows.slice(0, waiting).map((row) => ({
        ...row,
        dequeueAudit: { ...row.dequeueAudit, nextTs: Temporal.Instant.fromEpochMilliseconds(nowMs + RETRY_BACKOFF_MS) }
    }));
    const due = rows[waiting];
    return { rows: [...backedOff, due], due };
}

describe.each(['memory', 'indexeddb'] as const)('inbound work behind rows in retry backoff on the %s store', (storage) => {
    it.each([
        ['a whole page', AL_INBOUND_WORK_PAGE_SIZE],
        ['more than a page', AL_INBOUND_WORK_PAGE_SIZE + 4]
    ])('claims the row that is due now behind %s of RETRY rows due later, advertising it as due on every round', async (
        _label,
        waiting
    ) => {
        const stores = createInboundTestStores({
            namespace: NAMESPACE,
            storage,
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const port = createTestALInboundWorkPort({ carrier: 'ws', ...stores, nowMs: Date.now });
        const selector = createALInboundWorkSelector({
            delivery: createInboundTestDispatch(stores, Date.now).delivery,
            namespace: NAMESPACE,
            nowMs: Date.now,
            lane: 'durable'
        });
        const { rows, due } = toRowsWithLastKeyDue(waiting, Date.now());
        for (const row of rows) {
            await port.retainIfAbsent(row);
        }
        const firstKeyPage = await port.readPage({
            status: EntityStatus.RETRY,
            maxToRead: AL_INBOUND_WORK_PAGE_SIZE,
            cursor: null
        });
        expect(firstKeyPage.entries.map((entry) => entry.key), 'the due row is behind the first page').not
            .toContainEqual(due.key);

        // The rotation reads NEW (empty), then the RETRY pages in key order: the due row is on the last of them.
        const rotationRounds = 1 + Math.ceil(rows.length / AL_INBOUND_WORK_PAGE_SIZE);
        const claimedAtRound: number[] = [];
        for (let round = 1; round <= rotationRounds; round += 1) {
            const nowMs = Date.now();
            expect(await selector.readNextReadyAtMs(port, nowMs), `round ${round} advertises due work`)
                .toBeLessThanOrEqual(nowMs);
            const selection = await selector.selectReady(port, AL_INBOUND_WORK_PAGE_SIZE);
            const claimedKeys = selection.claims.map((claim) => toKeyAsString(claim.entry.key));
            if (claimedKeys.includes(toKeyAsString(due.key))) {
                claimedAtRound.push(round);
            }
            expect(claimedKeys.filter((key) => key !== toKeyAsString(due.key)), `round ${round} claims no row but the due one`)
                .toEqual([]);
        }

        expect(claimedAtRound).toEqual([rotationRounds]);
    });
});
