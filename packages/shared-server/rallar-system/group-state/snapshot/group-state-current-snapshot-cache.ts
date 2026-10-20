import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { VersionProbedReadThroughCache } from '@shared/cache/store-backed/version-probed-read-through-cache.ts';

import type { RuntimeStateReadBatchVersionReader } from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import type { GroupStateSnapshotRepository } from '../persistence/group-state-snapshot-repository.ts';
import { readGroupStateAuthorityVersions } from '../persistence/read-group-state-authority.ts';

export interface GroupStateCurrentSnapshotCacheDependencies {
    readonly repository: Pick<GroupStateSnapshotRepository, 'readVersionedSnapshot'>;
    readonly versionReader: RuntimeStateReadBatchVersionReader;
    /** The one clock: the snapshot is assembled at this instant and kept only until a lease or row it shows expires. */
    readonly nowEpochMs: () => number;
    readonly maxEntries: number;
}

/**
 * The current group snapshot, as durable as a full read. Groups with a kept snapshot cost one revision probe together
 * while unchanged; any other read is one statement per group that returns the rows with their version. A kept snapshot
 * is served only while the probe reports exactly the row versions it was assembled from, and only until a lease or row
 * it shows expires.
 */
export class GroupStateCurrentSnapshotCache {
    private readonly cache: VersionProbedReadThroughCache<GroupRef, GroupSnapshot>;

    public constructor(dependencies: GroupStateCurrentSnapshotCacheDependencies) {
        const { repository, versionReader, nowEpochMs } = dependencies;
        this.cache = new VersionProbedReadThroughCache({
            readVersions: async (refs) => await readGroupStateAuthorityVersions(versionReader, refs),
            readValue: async (ref) => {
                const observedAtEpochMs = nowEpochMs();
                const read = await repository.readVersionedSnapshot(versionReader, ref, observedAtEpochMs);
                return read === undefined ? undefined : {
                    value: read.snapshot,
                    version: read.version?.version ?? null,
                    validUntilEpochMs: toEarliestAfter(
                        [
                            ...(read.version?.expireAtEpochMs ?? []),
                            ...toSnapshotExpiries(read.snapshot)
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

    public async readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined> {
        return await this.cache.read(ref);
    }

    /** The snapshots in ref order, every kept group probed by one statement. */
    public async readSnapshots(refs: readonly GroupRef[]): Promise<readonly (GroupSnapshot | undefined)[]> {
        return await this.cache.readMany(refs);
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
