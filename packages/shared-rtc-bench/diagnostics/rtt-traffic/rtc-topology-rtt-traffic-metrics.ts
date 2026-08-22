import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { initRallarSystemWsTopics } from '@shared-server/rallar-system/ws-system-topics.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    AppTopics,
    ConnectionContext,
    InMemoryQueueBox,
    JsonWebSocketServer,
    newALBroadcastMessage,
    newALEventRoute,
    WsQueueBoxServerService,
    type ALMessage
} from '@shared/mod.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import { configureRtcRttTrafficCacheRepositories } from './configure-rtc-rtt-traffic-cache-repositories.ts';

type Args = Readonly<{
    sessions: number;
    debounceMs: number;
    out: string;
}>;

class FakeSocket {
    readonly readyState = WebSocket.OPEN;
    readonly sent: ALMessage[] = [];
    private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

    addEventListener(type: string, listener: (event: MessageEvent) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    send(data: string): void {
        this.sent.push(JSON.parse(data) as ALMessage);
    }

    async dispatchMessage(message: ALMessage): Promise<void> {
        const event = {
            data: JSON.stringify(message)
        } as MessageEvent;

        for (const listener of this.listeners.get('message') ?? []) {
            await listener(event);
        }
    }
}

function parseArgs(): Args {
    const readValue = (name: string, fallback: string): string => {
        const prefix = `--${name}=`;
        return Deno.args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
    };

    return {
        sessions: Number(readValue('sessions', '10')),
        debounceMs: Number(readValue('debounce-ms', '5')),
        out: readValue('out', 'tmp/perf/results/rtc-topology-rtt-traffic-metrics.json')
    };
}

function createSockets(sessionIds: readonly string[]): Map<string, FakeSocket> {
    return new Map(sessionIds.map((sessionId) => [sessionId, new FakeSocket()]));
}

function countSentTopologyMessages(sockets: ReadonlyMap<string, FakeSocket>): number {
    return [...sockets.values()]
        .flatMap((socket) => socket.sent)
        .filter((sent) => sent.payload.typeId === AppTopics.overlayTopology).length;
}

function createCentralRttMeasurements(sessionIds: readonly string[], centralSessionId: string) {
    const measurements = [];
    let version = 1;

    for (let i = 0; i < sessionIds.length; i++) {
        for (let j = i + 1; j < sessionIds.length; j++) {
            const from = sessionIds[i];
            const to = sessionIds[j];
            measurements.push({
                sessionIdFrom: from,
                sessionIdTo: to,
                rttMs: from === centralSessionId || to === centralSessionId ? 1 : 100,
                createdAtEpochMs: version,
                version: version++
            });
        }
    }

    return measurements;
}

function createClientSnapshot(sessionId: string): ClientSnapshot {
    return {
        stateRevision: 1,
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId: sessionId,
            username: sessionId,
            displayName: null,
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            disabled: null,
            deleted: null,
            roles: [],
            metadata: {},
            created: {
                atEpochMs: 1,
                actor: { kind: 'principal', principalId: sessionId },
                reason: null,
                traceId: null,
                requestId: null
            },
            updated: {
                atEpochMs: 1,
                actor: { kind: 'principal', principalId: sessionId },
                reason: null,
                traceId: null,
                requestId: null
            },
            profileVersion: 1,
            presenceVersion: 1,
            snapshotVersion: 1,
            lastSeenAtEpochMs: 1
        },
        activeSessions: [
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId: sessionId,
                sessionId,
                clientInstanceId: `${sessionId}-instance`,
                generationId: `generation-${sessionId}`,
                generationVersion: 1,
                status: 'active',
                disconnectedAtEpochMs: null,
                disconnectReason: null,
                transport: 'ws',
                presenceState: 'online',
                connectionId: null,
                connectedAtEpochMs: 1,
                authenticatedAtEpochMs: 1,
                lastHeartbeatAtEpochMs: 1,
                expiresAtEpochMs: Date.now() + 60_000
            }
        ],
        instances: [],
        activeSessionCount: 1,
        isOnline: true,
        lastSeenAtEpochMs: 1
    };
}

function createGroupSnapshot(groupId: string, memberSessionIds: readonly string[]): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';

    return {
        stateRevision: 1,
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
            formationElectorate: []
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
            expiresAtEpochMs: Date.now() + 60_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length
    };
}

const args = parseArgs();
configureRtcRttTrafficCacheRepositories();

const server = new JsonWebSocketServer();
const sessionIds = Array.from(
    { length: args.sessions },
    (_, index) => `session-${String(index + 1).padStart(3, '0')}`
);
const sockets = createSockets(sessionIds);

for (const [sessionId, socket] of sockets) {
    server.addConnection(new ConnectionContext(sessionId, socket as never));
}

const topologyService = new RallarRtcTopologyService({
    rttRebuildDebounceMs: args.debounceMs
});
const service = new WsQueueBoxServerService(
    new InMemoryQueueBox(new Map()),
    new InMemoryQueueBox(new Map()),
    server,
    'perf-server'
);
initRallarSystemWsTopics(service, {
    rtcTopologyService: topologyService
});

const group = createGroupSnapshot('room-1', sessionIds);
clientStateSnapshotsRepository.setClientStateSnapshots(sessionIds.map(createClientSnapshot));
const senderSocket = sockets.get(sessionIds[0])!;

await senderSocket.dispatchMessage(
    newALBroadcastMessage(
        sessionIds[0],
        newALEventRoute(AppTopics.groupStateSnapshot, group.group.groupId, 'group-snapshot-1'),
        'room',
        AppTopics.groupStateSnapshot,
        group,
        {
            groupRef: group.group
        }
    )
);

const initialTopologyMessages = countSentTopologyMessages(sockets);
for (const socket of sockets.values()) {
    socket.sent.length = 0;
}

const rttMeasurements = createCentralRttMeasurements(sessionIds, sessionIds[0]);
for (const rtt of rttMeasurements) {
    await senderSocket.dispatchMessage(
        newALBroadcastMessage(
            sessionIds[0],
            newALEventRoute(AppTopics.rtt, group.group.groupId, `rtt-${rtt.version}`),
            'room',
            AppTopics.rtt,
            rtt,
            {
                groupRef: group.group
            }
        )
    );
}

const topologyMessagesBeforeDebounce = countSentTopologyMessages(sockets);
await new Promise((resolve) => setTimeout(resolve, args.debounceMs + 10));
const topologyMessagesAfterDebounce = countSentTopologyMessages(sockets);

const output = {
    createdAt: new Date().toISOString(),
    input: {
        sessionCount: args.sessions,
        rttCount: rttMeasurements.length,
        debounceMs: args.debounceMs
    },
    topologyMessages: {
        initial: initialTopologyMessages,
        beforeDebounce: topologyMessagesBeforeDebounce,
        afterDebounce: topologyMessagesAfterDebounce
    },
    metrics: topologyService.readMetrics()
};

await Deno.writeTextFile(args.out, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${args.out}`);
