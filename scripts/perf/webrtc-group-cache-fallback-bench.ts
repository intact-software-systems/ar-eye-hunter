import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { ReadableKeyedValues } from '@shared/cache/RepositoryInterfaces.ts';
import { WebRtcGroupService } from '@shared/services/WebRtcGroupService.ts';

type BenchResult = Readonly<{
    run: number;
    durationMs: number;
    snapshotCount: number;
    matchingVersions: number;
    lookups: number;
    readCalls: number;
    peekCalls: number;
    readAllValuesCalls: number;
    latestVersion: number | undefined;
    targetPeerCount: number;
}>;

const OUT = readArg('--out') ??
    'tmp/perf/results/webrtc-group-cache-fallback.json';
const SNAPSHOTS = Number(readArg('--snapshots') ?? '20000');
const MATCHING_VERSIONS = Number(readArg('--matching-versions') ?? '5000');
const LOOKUPS = Number(readArg('--lookups') ?? '500');
const RUNS = Number(readArg('--runs') ?? '5');

class FallbackOnlyGroupCache
    implements ReadableKeyedValues<string, GroupSnapshot> {
    readCalls = 0;
    peekCalls = 0;
    readAllValuesCalls = 0;

    constructor(private readonly snapshots: readonly GroupSnapshot[]) {
    }

    read(_key: string): GroupSnapshot | undefined {
        this.readCalls += 1;
        return undefined;
    }

    peek(_key: string): GroupSnapshot | undefined {
        this.peekCalls += 1;
        return undefined;
    }

    hasValue(_key: string): boolean {
        return false;
    }

    expired(_key: string): boolean {
        return true;
    }

    refreshing(_key: string): boolean {
        return false;
    }

    has(_key: string): boolean {
        return false;
    }

    delete(_key: string): boolean {
        return false;
    }

    clear(_key: string): void {
    }

    clearAll(): void {
    }

    deleteExpired(): number {
        return 0;
    }

    size(): number {
        return this.snapshots.length;
    }

    keys(): IterableIterator<string> {
        return [][Symbol.iterator]();
    }

    readAllValues(): GroupSnapshot[] {
        this.readAllValuesCalls += 1;
        return [...this.snapshots];
    }
}

const targetGroupId = 'target-room';
const targetScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
};
const snapshots = createSnapshots(SNAPSHOTS, MATCHING_VERSIONS);
const results: BenchResult[] = [];

for (let run = 1; run <= RUNS; run++) {
    const cache = new FallbackOnlyGroupCache(snapshots);
    const service = new WebRtcGroupService(
        {
            input: {
                sessionId: 'self',
            },
        } as never,
        {
            ...targetScope,
            groupId: targetGroupId,
        },
        cache,
    );
    let latestVersion: number | undefined;
    let targetPeerCount = 0;
    const start = performance.now();

    for (let index = 0; index < LOOKUPS; index++) {
        const snapshot = service.readGroup();
        latestVersion = snapshot?.group.rosterVersion;
        targetPeerCount = service.targetPeerIds().length;
    }

    results.push({
        run,
        durationMs: performance.now() - start,
        snapshotCount: SNAPSHOTS,
        matchingVersions: MATCHING_VERSIONS,
        lookups: LOOKUPS,
        readCalls: cache.readCalls,
        peekCalls: cache.peekCalls,
        readAllValuesCalls: cache.readAllValuesCalls,
        latestVersion,
        targetPeerCount,
    });
}

await Deno.writeTextFile(
    OUT,
    JSON.stringify({
        createdAt: new Date().toISOString(),
        input: {
            snapshotCount: SNAPSHOTS,
            matchingVersions: MATCHING_VERSIONS,
            lookups: LOOKUPS,
            runs: RUNS,
        },
        results,
    }, null, 2),
);

console.log(`Wrote ${OUT}`);

function createSnapshots(
    snapshotCount: number,
    matchingVersions: number,
): readonly GroupSnapshot[] {
    const snapshots: GroupSnapshot[] = [];
    for (let version = 1; version <= matchingVersions; version++) {
        snapshots.push(
            createGroupSnapshot(
                targetGroupId,
                version,
                ['self', `target-peer-${version}`],
                targetScope,
            ),
        );
    }

    for (let index = matchingVersions; index < snapshotCount; index++) {
        snapshots.push(
            createGroupSnapshot(
                `other-room-${index}`,
                index + 1,
                ['self', `other-peer-${index}`],
                {
                    applicationId: 'app-1',
                    workspaceId: `workspace-${index % 20}`,
                },
            ),
        );
    }

    return shuffleDeterministically(snapshots);
}

function shuffleDeterministically<T>(values: readonly T[]): readonly T[] {
    const shuffled = [...values];
    for (let index = 0; index < shuffled.length; index++) {
        const swapIndex = (index * 48271 + 17) % shuffled.length;
        const current = shuffled[index];
        shuffled[index] = shuffled[swapIndex];
        shuffled[swapIndex] = current;
    }
    return shuffled;
}

function createGroupSnapshot(
    groupId: string,
    version: number,
    memberSessionIds: readonly string[],
    scope: Readonly<{
        applicationId: string;
        workspaceId: string;
    }>,
): GroupSnapshot {
    return {
        group: {
            applicationId: scope.applicationId,
            workspaceId: scope.workspaceId,
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: version,
            metadataVersion: 0,
            rosterVersion: version,
            presenceVersion: 0,
            created: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
            updated: {
                atEpochMs: version,
                byPrincipalId: 'creator',
            },
        },
        members: memberSessionIds.map((sessionId) => ({
            applicationId: scope.applicationId,
            workspaceId: scope.workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
            updated: {
                atEpochMs: version,
                byPrincipalId: 'creator',
            },
        })),
        activeSessions: memberSessionIds.map((sessionId) => ({
            applicationId: scope.applicationId,
            workspaceId: scope.workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: version,
            expiresAtEpochMs: version + 60_000,
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length,
    };
}

function readArg(name: string): string | undefined {
    return Deno.args.find((arg) => arg.startsWith(`${name}=`))
        ?.slice(name.length + 1);
}
