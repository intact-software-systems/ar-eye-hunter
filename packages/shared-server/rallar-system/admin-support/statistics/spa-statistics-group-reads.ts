import { type GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type { GroupEvent, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { listRecentStateEvents, type StateEventListQuery } from '../../state-events/state-event-listing.ts';

export type SpaStatisticsGroupStateReads =
    & Pick<GroupStateService, 'listSnapshots' | 'listSnapshotsPage' | 'listEvents' | 'listRecentEvents'>
    & Readonly<{
        readCurrentSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
    }>;

interface SpaStatisticsGroupSnapshotScan {
    readonly snapshots: readonly GroupSnapshot[];
    readonly scannedGroupCount: number;
    readonly hasMore: boolean;
}

export async function countRecentGroupEvents(
    service: SpaStatisticsGroupStateReads,
    refs: readonly GroupRef[],
    limit: number
): Promise<number> {
    const totalLimit = Math.max(0, Math.floor(limit));
    let count = 0;

    for (const ref of refs) {
        const remaining = totalLimit - count;
        if (remaining <= 0) {
            break;
        }

        const events = await listRecentGroupEvents(service, ref, {
            limit: remaining
        });
        count += Math.min(events.length, remaining);
    }

    return count;
}

export async function readBoundedGroupSnapshots(
    service: SpaStatisticsGroupStateReads,
    scope: StateScope,
    limit: number
): Promise<SpaStatisticsGroupSnapshotScan> {
    const scanLimit = Math.max(1, Math.floor(limit));

    if (service.listSnapshotsPage) {
        return await service.listSnapshotsPage(scope, { limit: scanLimit });
    }

    const snapshots = await service.listSnapshots(scope);
    return {
        snapshots: snapshots.slice(0, scanLimit),
        scannedGroupCount: Math.min(snapshots.length, scanLimit),
        hasMore: snapshots.length > scanLimit
    };
}

export async function listRecentGroupEvents(
    service: SpaStatisticsGroupStateReads,
    ref: GroupRef,
    query: StateEventListQuery
): Promise<readonly GroupEvent[]> {
    if (service.listRecentEvents) {
        return await service.listRecentEvents(ref, query);
    }

    return listRecentStateEvents(await service.listEvents(ref), query);
}
