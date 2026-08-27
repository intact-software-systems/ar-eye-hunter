import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

type BenchResult = Readonly<{
    run: number;
    durationMs: number;
    sessionCount: number;
    nodeCount: number;
    edgeCount: number;
    sampleWeight: number;
}>;

const OUT = readArg('--out') ?? 'tmp/perf/results/rtc-room-graph-no-rtt.json';
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
            : (graph.getEdgeAttribute(sampleEdge, 'weight') as number)
    });
}

await Deno.writeTextFile(
    OUT,
    JSON.stringify(
        {
            createdAt: new Date().toISOString(),
            input: {
                sessionCount: SESSIONS,
                runs: RUNS
            },
            results
        },
        null,
        2
    )
);

console.log(`Wrote ${OUT}`);

function createMemberIds(count: number): readonly string[] {
    return Array.from({ length: count }, (_, index) => `peer-${index + 1}`);
}

function createGroupSnapshot(groupId: string, memberSessionIds: readonly string[]): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';

    return {
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group: {
            applicationId,
            workspaceId,
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
            activeMemberCount: memberSessionIds.length,
            ownerPrincipalId: memberSessionIds[0] ?? 'owner',
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: 0,
            created: {
                atEpochMs: 1,
                actor: { kind: 'principal', principalId: 'owner' },
                reason: null,
                traceId: null,
                requestId: null
            },
            updated: {
                atEpochMs: 1,
                actor: { kind: 'principal', principalId: 'owner' },
                reason: null,
                traceId: null,
                requestId: null
            },
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
            lifecycleState: 'active',
            formationEpoch: 0,
            formationAttemptCount: 0,
            lastFormationOutcome: null,
            establishmentStartedAtEpochMs: null,
            formationElectorate: [],
            acceptedLayoutIdentity: null,
            transportState: 'flowing'
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
                actor: { kind: 'principal', principalId: 'owner' },
                reason: null,
                traceId: null,
                requestId: null
            },
            updated: {
                atEpochMs: 1,
                actor: { kind: 'principal', principalId: 'owner' },
                reason: null,
                traceId: null,
                requestId: null
            },
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null
        })),
        activeSessions: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: `generation-${sessionId}`,
            generationVersion: 1,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length
    };
}

function readArg(name: string): string | undefined {
    return Deno.args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}
