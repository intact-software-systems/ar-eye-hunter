import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';

type BenchResult = Readonly<{
    run: number;
    durationMs: number;
    sessionCount: number;
    nodeCount: number;
    edgeCount: number;
    sampleWeight: number;
}>;

const OUT = readArg('--out') ??
    'tmp/perf/results/rtc-room-graph-no-rtt.json';
const SESSIONS = Number(readArg('--sessions') ?? '1000');
const RUNS = Number(readArg('--runs') ?? '5');

const group = createGroupSnapshot('room-1', createMemberIds(SESSIONS));
const results: BenchResult[] = [];

for (let run = 1; run <= RUNS; run++) {
    const service = new RallarRtcTopologyService();
    const start = performance.now();
    const graph = service.createRoomGraph(group);
    const durationMs = performance.now() - start;
    const sampleEdge = graph.edge('peer-1', 'peer-3');

    results.push({
        run,
        durationMs,
        sessionCount: SESSIONS,
        nodeCount: graph.order,
        edgeCount: graph.size,
        sampleWeight: sampleEdge === undefined
            ? Number.NaN
            : graph.getEdgeAttribute(sampleEdge, 'weight') as number,
    });
}

await Deno.writeTextFile(
    OUT,
    JSON.stringify({
        createdAt: new Date().toISOString(),
        input: {
            sessionCount: SESSIONS,
            runs: RUNS,
        },
        results,
    }, null, 2),
);

console.log(`Wrote ${OUT}`);

function createMemberIds(count: number): readonly string[] {
    return Array.from({ length: count }, (_, index) => `peer-${index + 1}`);
}

function createGroupSnapshot(
    groupId: string,
    memberSessionIds: readonly string[],
): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';

    return {
        stateRevision: 1,
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
        members: memberSessionIds.map((sessionId) => ({
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
        activeSessions: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length,
    };
}

function readArg(name: string): string | undefined {
    return Deno.args.find((arg) => arg.startsWith(`${name}=`))
        ?.slice(name.length + 1);
}
