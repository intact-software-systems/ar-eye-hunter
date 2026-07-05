import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';

type Mode = 'retain' | 'cleanup';

type Args = Readonly<{
    groups: number;
    sessions: number;
    runs: number;
    mode: Mode;
    out: string;
}>;

type BenchResult = Readonly<{
    run: number;
    mode: Mode;
    groupCount: number;
    sessionsPerGroup: number;
    activeUpdateDurationMs: number;
    inactivePhaseDurationMs: number;
    finalTopologySnapshotCount: number;
    topologyRemovalRequestCount: number;
    topologyRemovedCount: number;
    topologyRemoveMissCount: number;
}>;

const args = parseArgs();
const results: BenchResult[] = [];

for (let run = 1; run <= args.runs; run++) {
    const service = new RallarRtcTopologyService({
        now: () => 1_000 + run,
    });
    const groups = Array.from(
        { length: args.groups },
        (_unused, index) =>
            createGroupSnapshot(
                `room-${String(index + 1).padStart(5, '0')}`,
                args.sessions,
            ),
    );

    const activeStartedAt = performance.now();
    for (const group of groups) {
        service.updateGroupTopology(group);
    }
    const activeUpdateDurationMs = performance.now() - activeStartedAt;

    const inactiveStartedAt = performance.now();
    if (args.mode === 'cleanup') {
        for (const group of groups) {
            service.removeGroupTopology(
                createInactiveGroupSnapshot(group, 'archived'),
            );
        }
    } else {
        for (const group of groups) {
            createInactiveGroupSnapshot(group, 'archived');
        }
    }
    const inactivePhaseDurationMs = performance.now() - inactiveStartedAt;
    const metrics = service.readMetrics();

    results.push({
        run,
        mode: args.mode,
        groupCount: args.groups,
        sessionsPerGroup: args.sessions,
        activeUpdateDurationMs,
        inactivePhaseDurationMs,
        finalTopologySnapshotCount: metrics.topologySnapshotCount,
        topologyRemovalRequestCount: metrics.topologyRemovalRequestCount,
        topologyRemovedCount: metrics.topologyRemovedCount,
        topologyRemoveMissCount: metrics.topologyRemoveMissCount,
    });
}

await Deno.writeTextFile(
    args.out,
    JSON.stringify({
        createdAt: new Date().toISOString(),
        input: args,
        results,
    }, null, 2),
);

console.log(`Wrote ${args.out}`);

function parseArgs(): Args {
    const mode = readArg('--mode') ?? 'cleanup';
    if (mode !== 'retain' && mode !== 'cleanup') {
        throw new Error(`Unsupported --mode=${mode}`);
    }

    return {
        groups: Number(readArg('--groups') ?? '10000'),
        sessions: Number(readArg('--sessions') ?? '5'),
        runs: Number(readArg('--runs') ?? '3'),
        mode,
        out: readArg('--out') ??
            `tmp/perf/results/rtc-topology-inactive-churn-${mode}.json`,
    };
}

function readArg(name: string): string | undefined {
    return Deno.args.find((arg) => arg.startsWith(`${name}=`))
        ?.slice(name.length + 1);
}

function createGroupSnapshot(groupId: string, sessionCount: number): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    const sessionIds = Array.from(
        { length: sessionCount },
        (_unused, index) => `${groupId}-session-${index + 1}`,
    );

    return {
        group: {
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: 0,
            created: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
        },
        members: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}

function createInactiveGroupSnapshot(
    snapshot: GroupSnapshot,
    status: 'archived' | 'deleted',
): GroupSnapshot {
    const audit = {
        atEpochMs: 2,
        byPrincipalId: 'owner',
    };

    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            status,
            snapshotVersion: snapshot.group.snapshotVersion + 1,
            updated: audit,
            archived: status === 'archived' ? audit : snapshot.group.archived,
            deleted: status === 'deleted' ? audit : snapshot.group.deleted,
        },
        activeSessions: [],
        onlineMemberCount: 0,
    };
}
