import { describe, expect, it } from 'vitest';

import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '@shared-server/rallar-system/auth/persistence/auth-storage-keys.ts';
import { GROUP_LIFECYCLE_POLICIES_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import {
    GROUPS_NAMESPACE,
    IDEMPOTENT_NAMESPACE,
    MEMBERS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    SESSIONS_NAMESPACE
} from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { WS_SESSION_CLOSE_HIGH_WATER_NAMESPACE } from '@shared-server/rallar-system/websocket/ws-session-generation-computation.ts';

import { NO_POSTGRES_RUN_ROWS } from './test-support/delete-postgres-run-rows.ts';
import { toGroupAppInboxStorageCommandId } from './test-support/postgres-group-app-inbox-mutation.ts';
import {
    createInterleavedSummaryWrite,
    toGroupJoinAuthority,
    withPostgresGroupJoinHarness,
    type GroupJoinAttempt,
    type PostgresGroupJoinHarness
} from './test-support/postgres-group-join-harness.ts';

const POSTGRES_INTEGRATION_ENABLED = process.env.RALLAR_POSTGRES_INTEGRATION === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;

/** Every namespace a join's one statement selects: its session, its policy, its decision rows and its result snapshot. */
const JOIN_BATCH_NAMESPACES = [
    AUTH_SESSIONS_BY_SESSION_NAMESPACE,
    GROUP_LIFECYCLE_POLICIES_NAMESPACE,
    IDEMPOTENT_NAMESPACE,
    GROUPS_NAMESPACE,
    MEMBERS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    SESSIONS_NAMESPACE
];

describe('Postgres group join read batch', () => {
    postgresIt('reads a join\'s session, policy, decision rows and result snapshot in one statement', async () => {
        const leftover = await withPostgresGroupJoinHarness('join-read-statements', async (harness) => {
            const reads = await harness.recordReads(async () => {
                await harness.join('bob');
            });

            expect(reads.statements).toBe(reads.calls.length);
            expect(reads.calls.map((call) => call.namespaces)).toEqual([
                expect.arrayContaining(JOIN_BATCH_NAMESPACES)
            ]);
        });
        expect(leftover).toEqual(NO_POSTGRES_RUN_ROWS);
    }, 30_000);

    postgresIt('applies a join on its first attempt when the presence summary moves during its read', async () => {
        const leftover = await withPostgresGroupJoinHarness('join-read-summary-move', async (harness) => {
            harness.probe.interleave = createInterleavedSummaryWrite(harness.sql, harness.groupRef);

            const enqueue = await harness.join('bob');

            expect(harness.probe.interleave.writeCount()).toBe(1);
            const record = await harness.repository.findIdempotentGroupMutationReceipt(
                harness.groupRef,
                toGroupAppInboxStorageCommandId(enqueue, 'bob')
            );
            expect(record?.receipt).toMatchObject({ outcome: 'applied', attemptCount: 1 });
            const snapshot = await harness.repository.readSnapshot(harness.groupRef);
            expect(snapshot?.members.find((member) => member.principalId === 'bob')?.status).toBe('active');
        });
        expect(leftover).toEqual(NO_POSTGRES_RUN_ROWS);
    }, 30_000);

    postgresIt('denies a join whose session row is missing, from the one statement', async () => {
        const leftover = await withPostgresGroupJoinHarness('join-read-missing-session', async (harness) => {
            const authority = toGroupJoinAuthority(harness.groupRef, 'bob');

            await expectDeniedFromOneStatement(harness, { authority, storedSession: null });
        });
        expect(leftover).toEqual(NO_POSTGRES_RUN_ROWS);
    }, 30_000);

    postgresIt('denies a join whose session row differs from the verified session, from the one statement', async () => {
        const leftover = await withPostgresGroupJoinHarness('join-read-mismatched-session', async (harness) => {
            const authority = toGroupJoinAuthority(harness.groupRef, 'bob');

            await expectDeniedFromOneStatement(harness, {
                authority,
                storedSession: { ...authority, issuedAtEpochMs: authority.issuedAtEpochMs + 1 }
            });
        });
        expect(leftover).toEqual(NO_POSTGRES_RUN_ROWS);
    }, 30_000);

    postgresIt('denies a join whose session expired before its execution, from the one statement', async () => {
        const leftover = await withPostgresGroupJoinHarness('join-read-expired-session', async (harness) => {
            const nowEpochMs = Date.now();
            const authority = {
                ...toGroupJoinAuthority(harness.groupRef, 'bob'),
                issuedAtEpochMs: nowEpochMs - 1_000,
                expiresAtEpochMs: nowEpochMs + 60_000
            };
            harness.advanceLaneClock(120_000);

            await expectDeniedFromOneStatement(harness, { authority, storedSession: authority });
        });
        expect(leftover).toEqual(NO_POSTGRES_RUN_ROWS);
    }, 30_000);

    postgresIt('reads a presence connect\'s session lifecycle and mutation rows together', async () => {
        const leftover = await withPostgresGroupJoinHarness('connect-read-overlap', async (harness) => {
            await harness.join('bob');

            const reads = await harness.recordReads(async () => {
                await harness.connect('bob');
            });

            expect(reads.statements).toBe(reads.calls.length);
            const lifecycle = reads.calls.find((call) => call.namespaces.includes(WS_SESSION_CLOSE_HIGH_WATER_NAMESPACE));
            const session = reads.calls.find((call) => call.namespaces.includes(AUTH_SESSIONS_BY_SESSION_NAMESPACE));
            expect(lifecycle?.startedAt).toBeLessThan(session?.endedAt ?? -1);
            expect(session?.startedAt).toBeLessThan(lifecycle?.endedAt ?? -1);
        });
        expect(leftover).toEqual(NO_POSTGRES_RUN_ROWS);
    }, 30_000);
});

async function expectDeniedFromOneStatement(
    harness: PostgresGroupJoinHarness,
    attempt: GroupJoinAttempt
): Promise<void> {
    let denial: Awaited<ReturnType<PostgresGroupJoinHarness['attemptJoin']>> | undefined;
    const reads = await harness.recordReads(async () => {
        denial = await harness.attemptJoin(attempt);
    });

    expect(denial?.left).toMatchObject({ status: 403, code: 'group-mutation-authority-denied' });
    expect(reads.calls.map((call) => call.namespaces)).toEqual([
        expect.arrayContaining(JOIN_BATCH_NAMESPACES)
    ]);
    const snapshot = await harness.repository.readSnapshot(harness.groupRef);
    expect(snapshot?.members.map((member) => member.principalId)).toEqual(['alice']);
}
