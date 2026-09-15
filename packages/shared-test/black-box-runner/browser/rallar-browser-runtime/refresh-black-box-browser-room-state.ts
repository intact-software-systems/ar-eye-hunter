import type {
    RallarScopedOperationOptions
} from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarRoomSession } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import { hydrateGroupTopologyOverlays } from '@shared-web/browser/state-read/hydrate-group-topology-overlays.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
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
    connect(
        options: RallarScopedOperationOptions
    ): Promise<BlackBoxRoomStateRefreshContext>;
}

interface RoomStateRefreshAbortScope {
    readonly signal: AbortSignal;
    cleanup(): void;
}

interface AbortRejection {
    readonly promise: Promise<never>;
    cleanup(): void;
}

export async function refreshBlackBoxBrowserRoomState(
    input: RefreshBlackBoxBrowserRoomStateInput
): Promise<void> {
    const abortScope = createRoomStateRefreshAbortScope(input.options);
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

function createRoomStateRefreshAbortScope(
    options: BlackBoxRoomStateRefreshOptions
): RoomStateRefreshAbortScope {
    const controller = new AbortController();
    const abortFromCaller = () => {
        controller.abort(
            options.signal?.reason ?? new Error('Room state refresh aborted.')
        );
    };
    if (options.signal?.aborted) {
        abortFromCaller();
    }
    else {
        options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    }
    const timeout = controller.signal.aborted
        ? undefined
        : setTimeout(
            () => {
                const error = new Error(
                    `Room state refresh timed out after ${options.timeoutMs} ms.`
                );
                error.name = 'TimeoutError';
                controller.abort(error);
            },
            Math.max(0, options.timeoutMs)
        );

    return {
        signal: controller.signal,
        cleanup: () => {
            if (timeout !== undefined) {
                clearTimeout(timeout);
            }
            options.signal?.removeEventListener('abort', abortFromCaller);
        }
    };
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
    const context = await input.session.connect(options);
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
