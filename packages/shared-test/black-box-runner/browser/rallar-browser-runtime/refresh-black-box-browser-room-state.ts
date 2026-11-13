import type {
    RallarScopedOperationOptions
} from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarRoomSession } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import { hydrateGroupTopologyOverlays } from '@shared-web/browser/state-read/hydrate-group-topology-overlays.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { DeadlineAbortScope } from '@shared/resilience/timing/deadline-abort-scope.ts';
import type { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';

export interface BlackBoxRoomStateRefreshOptions extends RallarScopedOperationOptions {
    readonly scope: StateScope;
    readonly timeoutMs: number;
}

interface RefreshBlackBoxBrowserRoomStateInput {
    readonly roomRef: GroupRef;
    readonly options: BlackBoxRoomStateRefreshOptions;
    readonly rooms: BlackBoxRoomStateRefreshRooms;
    readonly session: BlackBoxRoomStateRefreshSession;
}

interface BlackBoxRoomStateRefreshRoom {
    refresh(
        options: Parameters<RallarRoomSession['refresh']>[0]
    ): Promise<Pick<RallarRoomSession, 'snapshot'>>;
}

interface BlackBoxRoomStateRefreshRooms {
    session(roomRef: GroupRef): BlackBoxRoomStateRefreshRoom;
}

interface BlackBoxRoomStateRefreshContext {
    readonly session: AuthSession;
    readonly middleware: {
        readonly webRtcGroupManager: Pick<WebRtcGroupManager, 'notifyOverlayTopologyChanged'>;
    };
}

interface BlackBoxRoomStateRefreshSession {
    acquireConnection(
        options: RallarScopedOperationOptions
    ): Promise<BlackBoxRoomStateRefreshContext>;
}

interface AbortRejection {
    readonly promise: Promise<never>;
    cleanup(): void;
}

export async function refreshBlackBoxBrowserRoomState(
    input: RefreshBlackBoxBrowserRoomStateInput
): Promise<void> {
    const abortScope = new DeadlineAbortScope({
        parentSignal: input.options.signal,
        timeoutMs: Math.max(0, input.options.timeoutMs),
        toParentReason: (parent) => parent.reason ?? new Error('Room state refresh aborted.'),
        toTimeoutReason: () => {
            const error = new Error(`Room state refresh timed out after ${input.options.timeoutMs} ms.`);
            error.name = 'TimeoutError';
            return error;
        }
    });
    const options = { ...input.options, signal: abortScope.signal };
    let abortRejection: AbortRejection | undefined;
    try {
        throwIfAborted(abortScope.signal);
        abortRejection = createAbortRejection(abortScope.signal);
        const refresh = Promise.resolve().then(() => readAndHydrateRoomState({ ...input, options }));
        await Promise.race([refresh, abortRejection.promise]);
    }
    finally {
        abortRejection?.cleanup();
        abortScope.cleanup();
    }
}

function createAbortRejection(signal: AbortSignal): AbortRejection {
    let rejectPromise: (reason: Error) => void = () => undefined;
    const promise = new Promise<never>((_resolve, reject) => {
        rejectPromise = reject;
    });
    const onAbort = () => rejectPromise(toAbortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    return {
        promise,
        cleanup: () => signal.removeEventListener('abort', onAbort)
    };
}

function toAbortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error('Room state refresh aborted.');
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw toAbortReason(signal);
    }
}

async function readAndHydrateRoomState(input: RefreshBlackBoxBrowserRoomStateInput): Promise<void> {
    const { options } = input;

    const refreshedRoom = await input.rooms
        .session(input.roomRef)
        .refresh(options);
    const groupSnapshot = refreshedRoom.snapshot();
    if (!groupSnapshot) {
        return;
    }
    const context = await input.session.acquireConnection(options);
    await hydrateGroupTopologyOverlays({
        groupSnapshots: [groupSnapshot],
        sessionId: context.session.sessionId,
        webRtcGroupManager: context.middleware.webRtcGroupManager,
        scope: options.scope,
        apiRequest: {
            authSession: context.session,
            signal: options.signal
        }
    });
}
