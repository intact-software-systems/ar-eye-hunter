import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { VersionProbedReadThroughCache } from '@shared/cache/store-backed/version-probed-read-through-cache.ts';

import type { RuntimeStateReadBatchVersionReader } from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import type { GroupStateSnapshotRepository } from '../persistence/group-state-snapshot-repository.ts';
import { readGroupStateSnapshotVersions } from '../persistence/read-group-state-authority.ts';

export interface GroupStateCurrentSnapshotCacheDependencies {
    readonly repository: Pick<GroupStateSnapshotRepository, 'readVersionedSnapshot'>;
    readonly versionReader: RuntimeStateReadBatchVersionReader;
    /** The one clock: the snapshot is assembled at this instant and kept only until a lease or row it shows expires. */
    readonly nowEpochMs: () => number;
    readonly maxEntries: number;
}

/** The snapshots in ref order, with the statements the read issued: a full read that fell back to several counts once. */
export interface GroupStateCurrentSnapshotReads {
    readonly snapshots: readonly (GroupSnapshot | undefined)[];
    readonly probes: number;
    readonly reads: number;
}

/**
 * The current group snapshot, as durable as a full read. Groups with a kept snapshot cost one revision probe together
 * while unchanged; any other read is one statement per group that returns the rows with their version. A kept snapshot
 * is served only while the probe reports exactly the row versions it was assembled from, and only until a lease or row
 * it shows expires.
 */
export class GroupStateCurrentSnapshotCache {
    /** Null keeps a group without a live row, under the version of the rows it leaves, until a write moves them. */
    private readonly cache: VersionProbedReadThroughCache<GroupRef, GroupSnapshot | null>;

    public constructor(dependencies: GroupStateCurrentSnapshotCacheDependencies) {
        const { repository, versionReader, nowEpochMs } = dependencies;
        this.cache = new VersionProbedReadThroughCache({
            readVersions: async (refs) => await readGroupStateSnapshotVersions(versionReader, refs, nowEpochMs()),
            readValue: async (ref) => {
                const observedAtEpochMs = nowEpochMs();
                const read = await repository.readVersionedSnapshot(versionReader, ref, observedAtEpochMs);
                return {
                    value: read.snapshot ?? null,
                    version: read.version?.version ?? null,
                    validUntilEpochMs: toEarliestAfter(
                        [
                            ...(read.version?.expireAtEpochMs ?? []),
                            ...(read.snapshot === undefined ? [] : toSnapshotExpiries(read.snapshot))
                        ],
                        observedAtEpochMs
                    )
                };
            },
            toCacheKey: groupStateGroupStorageKey,
            nowEpochMs,
            maxEntries: dependencies.maxEntries
        });
    }

    /** The groups kept, each absent group's null among them. */
    public size(): number {
        return this.cache.size();
    }

    public async readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined> {
        const [snapshot] = (await this.readSnapshots([ref])).snapshots;
        return snapshot;
    }

    /** The snapshots in ref order, every kept group probed by one statement. */
    public async readSnapshots(refs: readonly GroupRef[]): Promise<GroupStateCurrentSnapshotReads> {
        const read = await this.cache.readMany(refs);
        return {
            snapshots: read.values.map((snapshot) => snapshot ?? undefined),
            probes: read.probes,
            reads: read.reads
        };
    }
}

/** The snapshot's live presence ends with the group's expiry and with each shown session's lease. */
function toSnapshotExpiries(snapshot: GroupSnapshot): readonly number[] {
    return [
        ...(snapshot.group.expiresAtEpochMs === null ? [] : [snapshot.group.expiresAtEpochMs]),
        ...snapshot.activeSessions.map((session) => session.expiresAtEpochMs)
    ];
}

function toEarliestAfter(instants: readonly number[], nowEpochMs: number): number | null {
    const upcoming = instants.filter((instant) => instant > nowEpochMs);
    return upcoming.length === 0 ? null : Math.min(...upcoming);
}
