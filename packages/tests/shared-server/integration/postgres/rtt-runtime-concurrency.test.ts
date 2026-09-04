import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { RtcRttMutationCommand } from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-contracts.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import { RTC_RTT_LATEST_NAMESPACE } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-runtime-namespaces.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    cleanupTopologyApplicationRows,
    createPostgresSql,
    topologyGroupSnapshot,
    type PostgresSql
} from '../../rallar-system/topology/concurrency/postgres-topology-concurrency-fixtures.ts';
import { executeRtcRttMutation as executeRtcRttMutationService } from './test-support/execute-rtc-rtt-mutation.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

type TestExecuteRtcRttMutationInput =
    & Omit<Parameters<typeof executeRtcRttMutationService>[0], 'request' | 'readCommand' | 'outboxWriter'>
    & Readonly<{
        command: RtcRttMutationCommand;
        readCommand?: () => RtcRttMutationCommand | Promise<RtcRttMutationCommand>;
    }>;

describe('Postgres RTT runtime concurrency', () => {
    postgresIt(
        'admits one true-overlap RTT endpoint mutation across independent transactions',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const applicationId = `rtt-execution-${crypto.randomUUID()}`;
            const a = `${applicationId}-a`;
            const b = `${applicationId}-b`;
            const c = `${applicationId}-c`;
            const clients = [
                await createPostgresSql(databaseUrl),
                await createPostgresSql(databaseUrl)
            ];
            try {
                const barrier = createReadBarrier(2);
                const firstRuntime = new BarrierRuntimeStateRepository(
                    clients[0]!,
                    RTC_RTT_LATEST_NAMESPACE,
                    barrier
                );
                const secondRuntime = new BarrierRuntimeStateRepository(
                    clients[1]!,
                    RTC_RTT_LATEST_NAMESPACE,
                    barrier
                );
                const groups = [
                    rttGroupSnapshot({ applicationId, workspaceId: 'concurrency', groupId: 'ab' }, [a, b]),
                    rttGroupSnapshot({ applicationId, workspaceId: 'concurrency', groupId: 'ac' }, [a, c])
                ] as const;
                const result = await Promise.allSettled([
                    clients[0]!.begin((transaction) =>
                        executeRtcRttMutation({
                            repository: new RtcRttRepository(firstRuntime, { now: () => 1 }),
                            transaction,
                            attemptCount: 1,
                            command: {
                                rtt: {
                                    sessionIdFrom: a,
                                    sessionIdTo: b,
                                    rttMs: 1,
                                    createdAtEpochMs: 1,
                                    version: 1
                                },
                                alSenderId: a,
                                candidateGroups: [groups[0]],
                                overlaySnapshotsByGroupKey: new Map(),
                                degreeLimit: 1
                            },
                            readFacts: () => ({
                                requestedAtEpochMs: 1,
                                purgeAfterEpochMs: 60_001
                            })
                        })
                    ),
                    clients[1]!.begin((transaction) =>
                        executeRtcRttMutation({
                            repository: new RtcRttRepository(secondRuntime, { now: () => 1 }),
                            transaction,
                            attemptCount: 1,
                            command: {
                                rtt: {
                                    sessionIdFrom: a,
                                    sessionIdTo: c,
                                    rttMs: 2,
                                    createdAtEpochMs: 1,
                                    version: 1
                                },
                                alSenderId: a,
                                candidateGroups: [groups[1]],
                                overlaySnapshotsByGroupKey: new Map(),
                                degreeLimit: 1
                            },
                            readFacts: () => ({
                                requestedAtEpochMs: 1,
                                purgeAfterEpochMs: 60_001
                            })
                        })
                    )
                ]);

                expect(result.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
                expect(result.filter(({ status }) => status === 'rejected')).toHaveLength(1);
                const stored = new RtcRttRepository(firstRuntime, { now: () => 2 });
                expect(await stored.listMeasurements()).toHaveLength(1);
            }
            finally {
                await cleanupApplicationRows(clients, applicationId);
            }
        },
        60_000
    );
});

function executeRtcRttMutation(input: TestExecuteRtcRttMutationInput) {
    const { command, readCommand, ...rest } = input;
    return executeRtcRttMutationService({
        ...rest,
        outboxWriter: new RtcTopologyOutboxWriter({ recordWrite: () => undefined }),
        request: { rtt: command.rtt, alSenderId: command.alSenderId },
        readCommand: readCommand ?? (() => command)
    });
}

class BarrierRuntimeStateRepository extends PSqlRuntimeStateRepository {
    private readonly barrierNamespace: string;
    private readonly barrier: () => Promise<void>;

    constructor(sql: PSqlSql, barrierNamespace: string, barrier: () => Promise<void>) {
        super(sql);
        this.barrierNamespace = barrierNamespace;
        this.barrier = barrier;
    }

    override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        const entry = await super.findEntry(namespace, key);
        if (namespace === this.barrierNamespace) {
            await this.barrier();
        }
        return entry;
    }
}

function createReadBarrier(parties: number): () => Promise<void> {
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
        release = resolve;
    });
    return async () => {
        if (arrivals >= parties) {
            return;
        }
        arrivals += 1;
        if (arrivals === parties) {
            release();
        }
        await ready;
    };
}

function rttGroupSnapshot(groupRef: GroupRef, sessionIds: readonly string[]): GroupSnapshot {
    const base = topologyGroupSnapshot(groupRef);
    return {
        ...base,
        group: {
            ...base.group,
            activeMemberCount: sessionIds.length,
            ownerPrincipalId: sessionIds[0]!
        },
        members: sessionIds.map((sessionId, index) => ({
            ...groupRef,
            principalId: sessionId,
            role: index === 0 ? ('owner' as const) : ('member' as const),
            status: 'active' as const,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
            joined: base.group.created,
            updated: base.group.updated
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            ...groupRef,
            sessionId,
            principalId: sessionId,
            generationId: `${sessionId}-generation`,
            generationVersion: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_001,
            status: 'active' as const,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length
    };
}

async function cleanupApplicationRows(
    clients: readonly PostgresSql[],
    applicationId: string
): Promise<void> {
    const cleanupClient = clients[0];
    try {
        if (cleanupClient) {
            await cleanupTopologyApplicationRows(cleanupClient, applicationId);
        }
    }
    finally {
        await Promise.allSettled(clients.map(async (client) => await client.end()));
    }
}

function requireDatabaseUrl(): string {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1');
    }
    return databaseUrl;
}
