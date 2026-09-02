import { PGlite } from '@electric-sql/pglite';
import { Temporal } from '@js-temporal/polyfill';
import { readFileSync } from 'node:fs';
// dprint-ignore
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    validateCoalescedAppOutboxWrite,
    writeCoalescedAppOutboxWork,
    type ComputedCoalescedAppOutboxWork
} from '@shared-server/rallar-system/app-outbox/coalesced-app-outbox-work.ts';
import { computeCoalescedRtcTopologyGroupRevisionWork } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createPGliteSqlClient, type PGliteSql } from '../../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';
import { createTestGroup } from '../../../create-test-group.ts';

const NOW = 1_900_000_000_000;
const REF = { applicationId: 'coalesced-app', workspaceId: 'main', groupId: 'group-1' };

describe('coalesced topology transaction write boundary', () => {
    let database: PGliteSql;

    beforeEach(async () => {
        database = createPGliteSqlClient(new PGlite());
        await database.exec(readFileSync(new URL('../../../../../apps/api-v1/src/db/in-memory-schema.sql', import.meta.url), 'utf8'));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await database.close();
    });

    it.each(['insert', 'pending', 'finished', 'reserved'] as const)(
        'uses precomputed timestamp bindings for %s work',
        async (kind) => {
            const first = computeWork(null, 1);
            if (kind !== 'insert') {
                await database.begin((transaction) => writeCoalescedAppOutboxWork(transaction, first));
            }
            const expected = kind === 'insert' ? null : toCoalescedPredecessor(kind, first.entryWrite.entry);
            if (kind === 'finished' || kind === 'reserved') {
                await database`update resource_inbox set ri_status = ${expected!.status}, ri_attempts = 1,
                    start_ts = ${new Date(NOW + 1).toISOString()},
                    end_ts = ${kind === 'finished' ? new Date(NOW + 2).toISOString() : null}, next_ts = null`;
            }
            const computed = kind === 'insert' ? first : computeWork(expected, 2);
            expect(validateCoalescedAppOutboxWrite(expected, computed)).toEqual([]);
            const candidateTimestamps = new Set([
                computed.entryWrite.entry.audit.createdTs,
                computed.entryWrite.entry.audit.expiryTs,
                computed.entryWrite.entry.dequeueAudit.nextTs,
                computed.successorWrite.entry.audit.createdTs,
                computed.successorWrite.entry.audit.expiryTs,
                computed.successorWrite.entry.dequeueAudit.nextTs
            ]);
            const plainToString = Temporal.PlainDateTime.prototype.toString;
            const instantToString = Temporal.Instant.prototype.toString;
            const formatting: string[] = [];
            vi.spyOn(Temporal.PlainDateTime.prototype, 'toString').mockImplementation(function (this: Temporal.PlainDateTime, options) {
                if (candidateTimestamps.has(this)) {
                    formatting.push('candidate plain timestamp');
                    throw new Error('Candidate timestamp formatted inside transaction');
                }
                return plainToString.call(this, options);
            });
            vi.spyOn(Temporal.Instant.prototype, 'toString').mockImplementation(function (this: Temporal.Instant, options) {
                if (candidateTimestamps.has(this)) {
                    formatting.push('candidate instant');
                    throw new Error('Candidate timestamp formatted inside transaction');
                }
                return instantToString.call(this, options);
            });

            await database.begin((transaction) => writeCoalescedAppOutboxWork(transaction, computed));

            expect(formatting).toEqual([]);
            const entry = kind === 'reserved' ? computed.successorWrite.entry : computed.entryWrite.entry;
            expect(
                await database`select ri_resource from resource_inbox where ri_topic_id = ${entry.key.topicId}
                and ri_resource_id = ${entry.key.resourceId} and fk_ext_bank_id = ${entry.key.contextId}`
            )
                .toEqual([{ ri_resource: entry.resource }]);
        }
    );

    it('reports all independent replacement invariants before any transaction', () => {
        const previous = computeWork(null, 1).entryWrite.entry;
        const computed = computeWork(previous, 2);
        if (computed.operation.kind === 'insert' || computed.operation.kind === 'successor') {
            throw new Error('Expected a pending replacement');
        }
        const candidate: ComputedCoalescedAppOutboxWork = {
            ...computed,
            operation: { ...computed.operation, expectedGeneration: 0 },
            entryWrite: {
                ...computed.entryWrite,
                entry: {
                    ...computed.entryWrite.entry,
                    key: { ...computed.entryWrite.entry.key, resourceId: 'wrong-identity' },
                    typeId: 'WRONG',
                    status: EntityStatus.COMPLETED,
                    dequeueAudit: { ...computed.entryWrite.entry.dequeueAudit, attempts: 4 }
                }
            }
        };
        const issues = validateCoalescedAppOutboxWrite(previous, candidate);

        expect(issues.map((issue) => issue.path)).toEqual([
            'coalesced.entryWrite.entry.key',
            'coalesced.entryWrite.entry.typeId',
            'coalesced.entryWrite.entry.status',
            'coalesced.entryWrite.entry.dequeueAudit.attempts',
            'coalesced.operation.expectedGeneration'
        ]);
    });
});

function computeWork(previousEntry: ResourceEntry | null, groupRevision: number): ComputedCoalescedAppOutboxWork {
    return computeCoalescedRtcTopologyGroupRevisionWork({
        aggregateRef: REF,
        groupSnapshot: createSnapshot(groupRevision),
        requestedAtEpochMs: NOW + groupRevision,
        expireAtEpochMs: NOW + 60_000,
        recomputeDebounceMs: 500,
        senderId: 'coalesced-worker',
        origin: 'automatic',
        previousEntry
    });
}

function createSnapshot(groupRevision: number): GroupSnapshot {
    const group = createTestGroup({ ...REF, snapshotVersion: groupRevision, presenceVersion: 1 });
    return {
        group,
        causalRevision: { groupRevision, presenceRevision: 1 },
        members: [{
            ...REF,
            principalId: 'alice',
            role: 'owner',
            status: 'active',
            joined: group.created,
            updated: group.updated,
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null
        }],
        activeSessions: [],
        memberCount: 1,
        onlineMemberCount: 0
    };
}

function toCoalescedPredecessor(kind: 'pending' | 'finished' | 'reserved', entry: ResourceEntry): ResourceEntry {
    if (kind === 'pending') {
        return entry;
    }
    return {
        ...entry,
        status: kind === 'finished' ? EntityStatus.COMPLETED : EntityStatus.RESERVED,
        dequeueAudit: {
            attempts: 1,
            startTs: Temporal.Instant.fromEpochMilliseconds(NOW + 1),
            ...(kind === 'finished' ? { endTs: Temporal.Instant.fromEpochMilliseconds(NOW + 2) } : {})
        }
    };
}
