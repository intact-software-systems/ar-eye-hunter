import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-group-state-event-store.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { toGroupMemberPolicy } from '@shared/api/group-lifecycle/to-normalized-group-lifecycle-policy.ts';
import type { AuditStamp, Group, GroupMember, GroupPresenceSession } from '@shared/api/group-types.ts';
import { CountingRuntimeStateRepository } from './counting-runtime-state-repository.ts';

const GROUPS = Number(
    Deno.args.find((arg) => arg.startsWith('--groups='))?.slice('--groups='.length) ??
        '1000'
);
const RUNS = Number(
    Deno.args.find((arg) => arg.startsWith('--runs='))?.slice('--runs='.length) ??
        '3'
);
const OUT = Deno.args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ??
    'tmp/perf/results/group-list-fanout.json';

const scope = {
    applicationId: 'perf-app',
    workspaceId: 'perf-workspace'
};

interface RunResult {
    readonly run: number;
    readonly durationMs: number;
    readonly snapshots: number;
    readonly findEntryCalls: number;
    readonly findAllEntriesCalls: number;
    readonly findEntriesByPrefixCalls: number;
    readonly readRuntimeStateBatchCalls: number;
    readonly readRuntimeStateBatchCallsByNamespace: Readonly<Record<string, number>>;
    readonly maxRowsReturnedPerReadBatchSelector: number;
}

const EXPECTED_BATCH_READS = Object.freeze({
    'group-state:groups': 2,
    'group-state:members': 1,
    'group-state:presence-summaries': 1,
    'group-state:sessions': 1
});

async function main(): Promise<void> {
    const repository = new CountingRuntimeStateRepository();
    const groupStateEventStore = new InMemoryGroupStateEventStore();
    const groupRepository = new GroupStateRepository(repository, groupStateEventStore);
    const service = createGroupStateService({
        runtimeRepository: repository,
        groupStateEventStore,
        now: () => 1_700_000_000_000,
        serviceId: 'group-list-fanout-bench',
        readPlannedLayoutRow: async () => null,
        readAcceptedLayoutRow: async () => null,
        authSessionRepository: new AuthSessionRepository(repository)
    });

    for (let index = 0; index < GROUPS; index += 1) {
        const groupId = `group-${String(index).padStart(6, '0')}`;
        const principalId = `principal-${String(index).padStart(6, '0')}`;
        const sessionId = `session-${String(index).padStart(6, '0')}`;
        await groupRepository.putGroup(createGroup(groupId, principalId));
        await groupRepository.putMember(createMember(groupId, principalId));
        await groupRepository
            .putPresenceSession(createPresenceSession(groupId, principalId, sessionId));
    }

    const results: RunResult[] = [];
    for (let run = 1; run <= RUNS; run += 1) {
        repository.resetCounters();
        const start = performance.now();
        const snapshots = await service.listSnapshots(scope);
        const durationMs = performance.now() - start;
        if (snapshots.length !== GROUPS) {
            throw new Error(`Expected ${GROUPS} snapshots, got ${snapshots.length}`);
        }
        const batchReads = repository.batchReadCounts();
        if (
            repository.readRuntimeStateBatchCalls !== 5 ||
            repository.findEntriesByPrefixCalls !== 0 ||
            repository.findEntryCalls !== 0 ||
            JSON.stringify(batchReads) !== JSON.stringify(EXPECTED_BATCH_READS)
        ) {
            throw new Error(
                `Expected bounded semantic batch reads ${
                    JSON.stringify(EXPECTED_BATCH_READS)
                } and no direct prefix or point reads, got ${
                    JSON.stringify(batchReads)
                }, ${repository.findEntriesByPrefixCalls} direct prefix reads, and ${repository.findEntryCalls} point reads`
            );
        }
        results.push({
            run,
            durationMs,
            snapshots: snapshots.length,
            findEntryCalls: repository.findEntryCalls,
            findAllEntriesCalls: repository.findAllEntriesCalls,
            findEntriesByPrefixCalls: repository.findEntriesByPrefixCalls,
            readRuntimeStateBatchCalls: repository.readRuntimeStateBatchCalls,
            readRuntimeStateBatchCallsByNamespace: batchReads,
            maxRowsReturnedPerReadBatchSelector: repository.maxRowsReturnedPerReadBatchSelector
        });
    }

    await Deno.mkdir(OUT.slice(0, OUT.lastIndexOf('/')), { recursive: true });
    await Deno.writeTextFile(
        OUT,
        `${
            JSON.stringify(
                {
                    benchmark: 'group-list-snapshots-fanout',
                    groups: GROUPS,
                    runs: RUNS,
                    results
                },
                null,
                2
            )
        }\n`
    );
}

function createGroup(groupId: string, ownerPrincipalId: string): Group {
    return {
        ...scope,
        groupId,
        slug: groupId,
        displayName: groupId,
        description: null,
        kind: 'room',
        status: 'active',
        archived: null,
        deleted: null,
        joinMode: 'open',
        maxMembers: null,
        maxSessionsPerMember: null,
        metadata: {},
        activeMemberCount: 1,
        ownerPrincipalId,
        lifecycleState: 'forming',
        formationEpoch: 0,
        formationAttemptCount: 0,
        lastFormationOutcome: null,
        establishmentStartedAtEpochMs: null,
        formationElectorate: [ownerPrincipalId],
        acceptedLayoutIdentity: null,
        transportState: 'flowing',
        memberPolicy: toGroupMemberPolicy(createDefaultGroupLifecyclePolicy()),
        activationStatus: null,
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 1,
        created: createAuditStamp(1),
        updated: createAuditStamp(1),
        expiresAtEpochMs: null,
        emptySinceEpochMs: null,
        purgeAfterEpochMs: null
    };
}

function createMember(groupId: string, principalId: string): GroupMember {
    return {
        ...scope,
        groupId,
        principalId,
        role: 'owner',
        status: 'active',
        joined: createAuditStamp(1),
        updated: createAuditStamp(1),
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null
    };
}

function createPresenceSession(
    groupId: string,
    principalId: string,
    sessionId: string
): GroupPresenceSession {
    return {
        ...scope,
        groupId,
        principalId,
        sessionId,
        generationId: `${sessionId}:generation-1`,
        generationVersion: 1_700_000_000_000,
        status: 'active',
        connectedAtEpochMs: 1_700_000_000_000,
        lastHeartbeatAtEpochMs: 1_700_000_000_000,
        expiresAtEpochMs: 4_102_444_821_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function createAuditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'perf' },
        reason: null,
        traceId: null,
        requestId: null
    };
}

if (import.meta.main) {
    await main();
}
