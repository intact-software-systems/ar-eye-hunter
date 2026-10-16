import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    VersionProbedReadThroughCache,
    type VersionProbe
} from '@shared/cache/store-backed/version-probed-read-through-cache.ts';

import type {
    RuntimeStateReadBatchVersion,
    RuntimeStateReadBatchVersionReader
} from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import { readGroupStateAuthorityVersion } from '../persistence/read-group-state-authority.ts';

export interface GroupStateCurrentSnapshotCacheDependencies {
    readonly durable: Readonly<{
        readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
    }>;
    readonly versionReader: RuntimeStateReadBatchVersionReader;
    readonly nowEpochMs: () => number;
    readonly maxEntries: number;
}

/**
 * The current group snapshot, as durable as a full read (D289): every read probes the revisions
 * of the group's stored rows, and an unchanged group is served from memory until a lease or row
 * it shows expires.
 */
export class GroupStateCurrentSnapshotCache {
    private readonly cache: VersionProbedReadThroughCache<GroupRef, GroupSnapshot>;

    public constructor(dependencies: GroupStateCurrentSnapshotCacheDependencies) {
        const { durable, versionReader, nowEpochMs } = dependencies;
        this.cache = new VersionProbedReadThroughCache({
            readVersion: async (ref) =>
                toVersionProbe(await readGroupStateAuthorityVersion(versionReader, ref), nowEpochMs()),
            readValue: async (ref) => {
                const snapshot = await durable.readSnapshot(ref);
                return snapshot === undefined
                    ? undefined
                    : { value: snapshot, validUntilEpochMs: computeSnapshotValidUntil(snapshot, nowEpochMs()) };
            },
            toCacheKey: groupStateGroupStorageKey,
            nowEpochMs,
            maxEntries: dependencies.maxEntries
        });
    }

    public async readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined> {
        return await this.cache.read(ref);
    }
}

/** A stored row that expires changes the read without a write, so the probe is valid until the next one does. */
function toVersionProbe(
    version: RuntimeStateReadBatchVersion | undefined,
    nowEpochMs: number
): VersionProbe | undefined {
    return version === undefined
        ? undefined
        : { version: version.version, validUntilEpochMs: toEarliestAfter(version.expireAtEpochMs, nowEpochMs) };
}

/** The snapshot's live presence ends with the group's expiry and with each shown session's lease. */
function computeSnapshotValidUntil(snapshot: GroupSnapshot, nowEpochMs: number): number | null {
    return toEarliestAfter(
        [
            ...(snapshot.group.expiresAtEpochMs === null ? [] : [snapshot.group.expiresAtEpochMs]),
            ...snapshot.activeSessions.map((session) => session.expiresAtEpochMs)
        ],
        nowEpochMs
    );
}

function toEarliestAfter(instants: readonly number[], nowEpochMs: number): number | null {
    const upcoming = instants.filter((instant) => instant > nowEpochMs);
    return upcoming.length === 0 ? null : Math.min(...upcoming);
}
