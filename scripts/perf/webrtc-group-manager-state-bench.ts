import type { ClientInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { ReadableKeyedValues } from '@shared/cache/RepositoryInterfaces.ts';
import { Either } from '@shared/resilience/Either.ts';
import { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';

type BenchResult = Readonly<{
    run: number;
    durationMs: number;
    clientCount: number;
    desiredPeerCount: number;
    lookups: number;
    keysCalls: number;
    readCalls: number;
    onlineDesiredPeerCount: number;
    onlinePeerCount: number;
}>;

const OUT = readArg('--out') ??
    'tmp/perf/results/webrtc-group-manager-state.json';
const CLIENTS = Number(readArg('--clients') ?? '5000');
const DESIRED = Number(readArg('--desired') ?? '1000');
const LOOKUPS = Number(readArg('--lookups') ?? '20');
const RUNS = Number(readArg('--runs') ?? '5');

class CountingClientCache implements ReadableKeyedValues<string, ClientInfo> {
    keysCalls = 0;
    readCalls = 0;
    private readonly values = new Map<string, ClientInfo>();

    set(key: string, value: ClientInfo): void {
        this.values.set(key, value);
    }

    resetCounters(): void {
        this.keysCalls = 0;
        this.readCalls = 0;
    }

    read(key: string): ClientInfo | undefined {
        this.readCalls += 1;
        return this.values.get(key);
    }

    peek(key: string): ClientInfo | undefined {
        return this.values.get(key);
    }

    hasValue(key: string): boolean {
        return this.values.has(key);
    }

    expired(key: string): boolean {
        return !this.values.has(key);
    }

    refreshing(_key: string): boolean {
        return false;
    }

    has(key: string): boolean {
        return this.values.has(key);
    }

    delete(key: string): boolean {
        return this.values.delete(key);
    }

    clear(key: string): void {
        this.values.delete(key);
    }

    clearAll(): void {
        this.values.clear();
    }

    deleteExpired(): number {
        return 0;
    }

    size(): number {
        return this.values.size;
    }

    keys(): IterableIterator<string> {
        this.keysCalls += 1;
        return this.values.keys();
    }

    readAllValues(): ClientInfo[] {
        return Array.from(this.values.values());
    }
}

const results: BenchResult[] = [];

for (let run = 1; run <= RUNS; run++) {
    const groupCache = new LatestRepository<string, GroupSnapshot>();
    const clientCache = new CountingClientCache();
    const rtcQBox = createRtcQBoxHarness('self');
    const manager = new WebRtcGroupManager(
        rtcQBox.service as never,
        groupCache,
        clientCache,
    );

    for (let index = 0; index < CLIENTS; index++) {
        const peerId = `peer-${index}`;
        clientCache.set(peerId, {
            clientId: peerId,
            sessionId: peerId,
            isOnline: true,
        });
    }

    await manager.acceptGroupUpdate(
        createGroupSnapshot(
            'room-1',
            1,
            [
                'self',
                ...Array.from({ length: DESIRED }, (_, index) => `peer-${index}`),
            ],
        ),
    );

    clientCache.resetCounters();
    let onlineDesiredPeerCount = 0;
    let onlinePeerCount = 0;
    const start = performance.now();

    for (let lookup = 0; lookup < LOOKUPS; lookup++) {
        const state = manager.state();
        onlineDesiredPeerCount = state.onlineDesiredPeerIds.length;
        onlinePeerCount = state.onlinePeerIds.length;
    }

    results.push({
        run,
        durationMs: performance.now() - start,
        clientCount: CLIENTS,
        desiredPeerCount: DESIRED,
        lookups: LOOKUPS,
        keysCalls: clientCache.keysCalls,
        readCalls: clientCache.readCalls,
        onlineDesiredPeerCount,
        onlinePeerCount,
    });
}

await Deno.writeTextFile(
    OUT,
    JSON.stringify({
        createdAt: new Date().toISOString(),
        input: {
            clientCount: CLIENTS,
            desiredPeerCount: DESIRED,
            lookups: LOOKUPS,
            runs: RUNS,
        },
        results,
    }, null, 2),
);

console.log(`Wrote ${OUT}`);

function createRtcQBoxHarness(sessionId: string) {
    const knownPeerIds = new Set<string>();
    const connectedPeerIds = new Set<string>();

    const service = {
        input: {
            sessionId,
        },
        knownPeerIds: () => Array.from(knownPeerIds),
        peerIdsWithNoReconnectableLanes: () => Array.from(connectedPeerIds),
        ensurePeerConnectionStarted: (peerId: string) => {
            knownPeerIds.add(peerId);
            connectedPeerIds.add(peerId);
            return Either.ofRight({ peerId } as never);
        },
        disconnectPeer: (peerId: string) => {
            knownPeerIds.delete(peerId);
            return connectedPeerIds.delete(peerId);
        },
    };

    return {
        service,
    };
}

function createGroupSnapshot(
    groupId: string,
    membershipVersion: number,
    memberSessionIds: readonly string[],
): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';

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
            snapshotVersion: membershipVersion,
            metadataVersion: 0,
            rosterVersion: membershipVersion,
            presenceVersion: 0,
            created: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
            updated: {
                atEpochMs: membershipVersion,
                byPrincipalId: 'creator',
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
                byPrincipalId: 'creator',
            },
            updated: {
                atEpochMs: membershipVersion,
                byPrincipalId: 'creator',
            },
        })),
        activeSessions: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: membershipVersion,
            expiresAtEpochMs: membershipVersion + 60_000,
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length,
    };
}

function readArg(name: string): string | undefined {
    return Deno.args.find((arg) => arg.startsWith(`${name}=`))
        ?.slice(name.length + 1);
}
