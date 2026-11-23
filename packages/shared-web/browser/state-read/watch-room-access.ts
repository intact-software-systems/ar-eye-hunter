import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    findGroupStateSnapshotByRef, removeGroupStateSnapshotIfUnchanged, waitForGroupStateSnapshotChangesIdle
} from '@shared/repository/group-state-snapshots-repository.ts';
import { ApiHttpError } from '../api/http-error.ts';
import { subscribeViewInvalidations } from '../api/subscribe-view-invalidations.ts';
import { notifyListener } from '../messages/rallar-listener-delivery.ts';
import { emitBrowserStateReadDiagnostic } from './diagnostics.ts';
import { readObservedRoom } from './observed-room.ts';
import { watchRoomRevision } from './watch-room-revision.ts';
import type { CreateBrowserRallarRoomsInput } from '../rooms/browser-rallar-rooms.ts';
import { readRoomMembershipRevocation } from '../rooms/read-room-membership-revocation.ts';
import { captureRoomSession } from '../rooms/room-session-fence.ts';
import type { RallarRoomStateStorePort } from '../rooms/room-state-store.ts';

export type RoomAccessObservation =
    | { readonly status: 'current' | 'stale' }
    | { readonly status: 'denied'; readonly reason: 'banned' | 'removed' | 'unavailable' };

/** An authorized point read proves access. A room-specific notice or recovery rechecks it. */
export function watchRoomAccess(
    services: CreateBrowserRallarRoomsInput, room: GroupRef,
    listener: (access: RoomAccessObservation) => void, signal?: AbortSignal
): () => void {
    return watchRoomRevision({
        room, services, signal, readEarliestServerEpochMs: services.readEarliestServerEpochMs,
        subscribeInvalidation: (watched, invalidate) => subscribeViewInvalidations({
            browser: { messages: services.messages, session: services.readSession },
            scope: watched, resource: 'room-access',
            changed(notice) {
                if (!notice || (notice.resource === 'room-access' && notice.groupId === watched.groupId)) {
                    invalidate('access-changed');
                }
            }
        }),
        async read(watched, readSignal) {
            const observed = findGroupStateSnapshotByRef(watched);
            const fence = captureRoomSession(services.requireSession, readSignal);
            try {
                return await readObservedRoom(watched, services.requireSession, readSignal);
            }
            catch (error) {
                fence.assertCurrent();
                if (error instanceof ApiHttpError && (error.status === 403 || error.status === 404)) {
                    if (!await clearDeniedRoomIfUnchanged(services.stateStore, watched, observed)) {
                        throw new Error('A newer room observation superseded the denied read.');
                    }
                    fence.assertCurrent();
                    services.stateStore.emit(services.stateStore.state());
                }
                throw error;
            }
        },
        project: group => ({ revision: group.snapshotVersion }),
        regresses: () => false,
        listener: ({ status }) => listener({ status }),
        onDenied: error => notifyListener(listener, { status: 'denied', reason: readRoomMembershipRevocation(error) ?? 'unavailable' })
    });
}

export async function clearDeniedRoomIfUnchanged(
    store: RallarRoomStateStorePort, room: GroupRef, observed: GroupSnapshot | undefined
): Promise<boolean> {
    if (findGroupStateSnapshotByRef(room) !== observed) return false;
    store.clearCurrentRoomIfMatches(room, true);
    if (observed) await removeMissingRoomSnapshot(room, observed);
    return true;
}

export async function removeMissingRoomSnapshot(roomRef: GroupRef, observed: GroupSnapshot): Promise<void> {
    const removed = removeGroupStateSnapshotIfUnchanged(roomRef, observed);
    emitBrowserStateReadDiagnostic({
        name: 'rallar.browser.state-read',
        feature: 'group',
        operation: 'point',
        result: removed ? 'removed' : 'preserved',
        durationMs: 0
    });
    await waitForGroupStateSnapshotChangesIdle();
}
