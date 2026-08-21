import { sendStateSyncMessage } from '@shared-server/rallar-system/state-sync-routing.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { ConnectionContext, EncodedJsonWebSocketMessage } from '@shared/websocket/JsonWebSocketServer.ts';

const CONNECTIONS = Number(
    Deno.args.find((arg) => arg.startsWith('--connections='))?.slice('--connections='.length) ??
        '10000'
);
const MEMBERS = Number(
    Deno.args.find((arg) => arg.startsWith('--members='))?.slice('--members='.length) ??
        '100'
);
const RUNS = Number(
    Deno.args.find((arg) => arg.startsWith('--runs='))?.slice('--runs='.length) ??
        '5'
);
const OUT = Deno.args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ??
    'tmp/perf/results/state-sync-send-fanout.json';

const now = 1_700_000_000_000;
const liveUntil = now + 60_000;
async function main(): Promise<void> {
    const clientSnapshots = Array.from({ length: CONNECTIONS }, (_, index) => createClientSnapshot(index));
    const memberIds = new Set(
        Array.from({ length: Math.min(MEMBERS, CONNECTIONS) }, (_, index) => `principal-${index}`)
    );
    const server = new CountingWebSocketServer(
        clientSnapshots.map((snapshot) => snapshot.activeSessions[0].sessionId)
    );
    const groupSnapshot = createGroupSnapshot(memberIds);
    const message: ALMessage = {
        id: {
            msgId: 'message-1',
            senderId: 'server-1'
        },
        route: {
            path: 'event',
            contextId: groupSnapshot.group.groupId,
            targetId: groupSnapshot.group.groupId
        },
        payload: {
            typeId: AppTopics.groupStateSnapshot,
            resource: JSON.stringify(groupSnapshot)
        }
    };

    const results = [];
    for (let run = 1; run <= RUNS; run += 1) {
        server.resetCounters();
        const start = performance.now();
        const sent = sendStateSyncMessage(
            server as never,
            message,
            {
                readClientSnapshots: () => clientSnapshots,
                now: () => now
            }
        );
        const durationMs = performance.now() - start;
        results.push({
            run,
            durationMs,
            sent,
            encodeCalls: server.encodeCalls,
            broadcastConnectionChecks: server.broadcastConnectionChecks,
            sendEncodedCalls: server.sendEncodedCalls,
            socketSendCalls: server.socketSendCalls
        });
    }

    await Deno.mkdir(OUT.slice(0, OUT.lastIndexOf('/')), { recursive: true });
    await Deno.writeTextFile(
        OUT,
        `${
            JSON.stringify(
                {
                    benchmark: 'state-sync-send-fanout',
                    mode: 'direct-recipients',
                    connections: CONNECTIONS,
                    members: MEMBERS,
                    runs: RUNS,
                    results
                },
                null,
                2
            )
        }\n`
    );
}

function createClientSnapshot(index: number): ClientSnapshot {
    const principalId = `principal-${index}`;
    const sessionId = `session-${index}`;
    return {
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId,
            username: principalId,
            displayName: principalId,
            status: 'active',
            roles: [],
            metadata: {},
            profileVersion: 1,
            presenceVersion: 1,
            snapshotVersion: 1,
            created: { atEpochMs: 1, byServiceId: 'perf' },
            updated: { atEpochMs: 1, byServiceId: 'perf' }
        },
        instances: [],
        activeSessions: [
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId,
                clientInstanceId: 'browser',
                sessionId,
                status: 'active',
                presenceState: 'online',
                transport: 'ws',
                authenticatedAtEpochMs: now,
                connectedAtEpochMs: now,
                lastHeartbeatAtEpochMs: now,
                expiresAtEpochMs: liveUntil
            }
        ],
        isOnline: true,
        activeSessionCount: 1
    };
}

function createGroupSnapshot(memberIds: Set<string>): GroupSnapshot {
    return {
        group: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            displayName: 'group-1',
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: 1, byServiceId: 'perf' },
            updated: { atEpochMs: 1, byServiceId: 'perf' }
        },
        members: [...memberIds].map((principalId) => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            principalId,
            role: 'member',
            status: 'active',
            joined: { atEpochMs: 1, byServiceId: 'perf' },
            updated: { atEpochMs: 1, byServiceId: 'perf' }
        })),
        activeSessions: [...memberIds].map((principalId) => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            principalId,
            sessionId: `session-${principalId.slice('principal-'.length)}`,
            connectedAtEpochMs: now,
            lastHeartbeatAtEpochMs: now,
            expiresAtEpochMs: liveUntil
        })),
        memberCount: memberIds.size,
        onlineMemberCount: memberIds.size
    };
}

class CountingWebSocketServer {
    readonly connections = new Map<string, ConnectionContext>();
    encodeCalls = 0;
    sendEncodedCalls = 0;
    socketSendCalls = 0;
    broadcastConnectionChecks = 0;

    constructor(connectionIds: readonly string[]) {
        for (const id of connectionIds) {
            this.connections.set(id, {
                id,
                isOpen: true,
                socket: {
                    send: () => {
                        this.socketSendCalls += 1;
                    }
                }
            } as unknown as ConnectionContext);
        }
    }

    encode(data: unknown): EncodedJsonWebSocketMessage {
        this.encodeCalls += 1;
        return { text: JSON.stringify(data) };
    }

    sendEncoded(connectionId: string, _encoded: EncodedJsonWebSocketMessage): void {
        this.sendEncodedCalls += 1;
        const ctx = this.connections.get(connectionId);
        if (!ctx?.isOpen) {
            throw new Error(`Connection not open: ${connectionId}`);
        }
        this.socketSendCalls += 1;
    }

    broadcast(
        data: unknown,
        filter?: (ctx: ConnectionContext) => boolean
    ): number {
        const encoded = this.encode(data);
        let sent = 0;
        for (const ctx of this.connections.values()) {
            this.broadcastConnectionChecks += 1;
            if (!ctx.isOpen) {
                continue;
            }
            if (filter && !filter(ctx)) {
                continue;
            }
            ctx.socket.send(encoded.text);
            sent += 1;
        }
        return sent;
    }

    resetCounters(): void {
        this.encodeCalls = 0;
        this.sendEncodedCalls = 0;
        this.socketSendCalls = 0;
        this.broadcastConnectionChecks = 0;
    }
}

await main();
