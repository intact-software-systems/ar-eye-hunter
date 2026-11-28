import { BrowserDirectorRelayRuntime } from '@shared-web/browser/director/browser-director-relay-runtime.ts';
import { BrowserDirectorRelayTransport } from '@shared-web/browser/director/browser-director-relay-transport.ts';
import { BrowserDirectorStatusRuntime } from '@shared-web/browser/director/browser-director-status-runtime.ts';
import { RoomStateStore } from '@shared-web/browser/rooms/room-state-store.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

import { createDefaultTestSession } from '../api-middleware-test-double.ts';
import { createEdgeOrderPage, type EdgeOrderPage } from '../messages/edge-order/edge-order-page-fixture.ts';

/** One page's real messaging stack, director status and relay runtime. */
export interface DirectorRelayPage {
    readonly page: EdgeOrderPage;
    readonly session: AuthSession;
    readonly status: BrowserDirectorStatusRuntime;
    readonly runtime: BrowserDirectorRelayRuntime;
}

/** One page signed in as the given session, whose status reads the directors the given room snapshots appoint. */
export function createDirectorRelayPage(sessionId: string, snapshots: readonly GroupSnapshot[]): DirectorRelayPage {
    const page = createEdgeOrderPage({ sessionId });
    const session: AuthSession = { ...createDefaultTestSession(), sessionId };
    const status = createStatusRuntime(session, snapshots);
    const runtime = new BrowserDirectorRelayRuntime({
        status,
        transport: new BrowserDirectorRelayTransport({
            messages: page.messages,
            readSession: () => session,
            isWebSocketDown: () => false
        }),
        messages: page.messages,
        timers: createDefaultTimers(),
        readSession: () => session
    });
    return { page, session, status, runtime };
}

/** Who the director is in each room, read from cached room snapshots whose appointments name the director sessions. */
function createStatusRuntime(session: AuthSession, snapshots: readonly GroupSnapshot[]): BrowserDirectorStatusRuntime {
    const { applicationId, workspaceId } = snapshots[0].group;
    const scope = { applicationId, workspaceId };
    const roomStateStore = new RoomStateStore({
        runtime: {
            currentRoomRef: () => undefined,
            setCurrentRoom: () => {},
            clearCurrentRoomIfMatches: () => {},
            readDefaultScope: () => scope,
            resolveOperationScope: () => scope
        },
        readSession: () => session,
        stateCache: {
            onCacheChange: () => () => {},
            readGroupSnapshots: () => snapshots,
            findGroupSnapshotByRef: (roomRef) => snapshots.find((snapshot) => snapshot.group.groupId === roomRef.groupId),
            wasGroupSnapshotObserved: () => true,
            findFirstGroupRefForSession: () => snapshots[0].group,
            readClientSnapshots: () => [],
            findClientSnapshot: () => undefined
        }
    });
    return new BrowserDirectorStatusRuntime({
        roomStateStore,
        readWindow: () => ({ earliestEpochMs: Date.now(), latestEpochMs: Date.now() }),
        readSession: () => session,
        resolveDefaultRoom: () => undefined
    });
}
