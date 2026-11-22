import { notifyListener } from '../messages/rallar-listener-delivery.ts';

import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { Group, GroupEventType, GroupRef } from '@shared/api/group-types.ts';
import { assertValidRallarGroupRef, assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import { parseGroupStateDeltaEnvelope } from '../state-cache/group-state-delta-application.ts';
import { readStateGroupSnapshot } from '../state-read/point-read.ts';
import type { CreateBrowserRallarRoomsInput } from './browser-rallar-rooms.ts';
import { captureRoomSession } from './room-session-fence.ts';

interface WatchRoomRevisionInput<T> {
    readonly room: GroupRef;
    readonly services: Pick<CreateBrowserRallarRoomsInput, 'requireSession' | 'ws' | 'auth' | 'roomEvents'>;
    readonly signal?: AbortSignal;
    readonly eventTypes?: readonly GroupEventType[];
    project(group: Group): T | null;
    listener(observation: { status: 'current' | 'stale'; value: T | null; }): void;
    regresses(previous: T, next: T): boolean;
    meaningful?(previous: T, next: T): boolean;
}

export function explicitRoomRef(room: GroupRef): GroupRef {
    assertValidRallarGroupRef(room, '$.roomRef');
    assertValidRallarRouteId(room.workspaceId, '$.roomRef.workspaceId', 'Workspace ID');
    return { ...room };
}

export async function readObservedRoom(roomRef: GroupRef, requireSession: CreateBrowserRallarRoomsInput['requireSession'], signal?: AbortSignal): Promise<Group> {
    const room = explicitRoomRef(roomRef);
    const fence = captureRoomSession(requireSession, signal);
    fence.assertCurrent();
    const result = await readStateGroupSnapshot(room.groupId, room, { authSession: fence.session, signal });
    fence.assertCurrent();
    if (result.source !== 'durable' || !isSameGroupRef(result.snapshot.group, room)) throw new Error('Room reads require the requested durable snapshot.');
    return result.snapshot.group;
}

/** Socket events invalidate the durable read. A connected idle room generates no reads. */
export function watchRoomRevision<T extends { readonly revision: number; }>(input: WatchRoomRevisionInput<T>): () => void {
    input.signal?.throwIfAborted();
    const room = explicitRoomRef(input.room);
    const { requireSession, ws, roomEvents, auth } = input.services;
    const fence = captureRoomSession(requireSession, input.signal);
    const lifetime = new AbortController();
    const { signal } = lifetime;
    let request: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    let announcedRevision = 0;
    let pageSuspended = false;
    let socketLost = !ws.status().isOpen;
    let queued = false;
    let status: 'current' | 'stale' = 'stale';
    let observed: T | null = null;

    function publish(nextStatus: 'current' | 'stale', value = observed): void {
        if (signal.aborted || (status === nextStatus && observed?.revision === value?.revision)) {
            return;
        }
        status = nextStatus;
        observed = value;
        notifyListener(input.listener, { status: nextStatus, value });
    }
    function suspend(): void {
        clearTimeout(retry);
        request?.abort();
        request = undefined;
        queued = false;
        publish('stale');
    }
    async function refresh(): Promise<void> {
        clearTimeout(retry);
        const inactive = pageSuspended || socketLost || document.visibilityState === 'hidden' ||
            navigator.onLine === false;
        if (signal.aborted || inactive) {
            suspend();
            return;
        }
        if (request) {
            queued = true;
            return;
        }
        const attempt = new AbortController();
        request = attempt;
        let next: T | null;
        try {
            fence.assertCurrent();
            next = input.project(await readObservedRoom(room, requireSession, AbortSignal.any([attempt.signal, AbortSignal.timeout(15_000)])));
            const previous = observed;
            if ((next?.revision ?? 0) < announcedRevision) {
                throw new Error('Room read predates the server notification.');
            }
            if (
                previous && (!next || next.revision < previous.revision ||
                    input.regresses(previous, next))
            ) {
                throw new Error('Room read regressed.');
            }
        }
        catch {
            if (request === attempt) {
                request = undefined;
                publish('stale');
                // One bounded retry burst per external wakeup, including when the server stays unavailable.
                if (!signal.aborted && retries < 3) {
                    retry = setTimeout(() => void refresh(), 1000 * 2 ** retries++);
                }
            }
            return;
        }
        if (request !== attempt) {
            return;
        }
        request = undefined;
        if (queued) {
            queued = false;
            void refresh();
            return;
        }
        publish('current', next);
    }
    function wake(): void {
        retries = 0;
        void refresh();
    }
    function resume(): void {
        pageSuspended = false;
        wake();
    }
    function hide(): void {
        pageSuspended = true;
        suspend();
    }
    const options = { signal };
    window.addEventListener('pagehide', hide, options);
    window.addEventListener('pageshow', resume, options);
    document.addEventListener('freeze', hide, options);
    document.addEventListener('resume', resume, options);
    document.addEventListener('visibilitychange', wake, options);
    window.addEventListener('offline', suspend, options);
    window.addEventListener('online', wake, options);
    const unsubscribeRoom = roomEvents.onEvent((_event, message) => {
        if (message.transport !== 'ws') return;
        const delta = parseGroupStateDeltaEnvelope(message.raw.payload.resource, room);
        if (!delta) return;
        const announced = input.project(delta.group);
        if (announced && observed && input.meaningful && !input.meaningful(observed, announced)) return;
        const revision = announced?.revision ?? 0;
        if (revision > Math.max(announcedRevision, observed?.revision ?? 0)) {
            announcedRevision = revision;
            publish('stale');
            wake();
        }
    }, { roomRef: room, scope: room, eventTypes: input.eventTypes });
    const unsubscribeSocket = ws.onLifecycle((event) => {
        socketLost = ['close', 'disconnected', 'error'].includes(event.kind);
        wake();
    }, { emitCurrent: false });
    const unsubscribeAuth = auth.onChange(({ session }) => {
        if (session?.sessionId === fence.session.sessionId && session?.clientId === fence.session.clientId) return;
        try {
            publish('stale', null);
        }
        finally {
            dispose();
        }
    }, { emitCurrent: false });
    function dispose(): void {
        lifetime.abort();
        suspend();
        unsubscribeAuth();
        unsubscribeRoom();
        unsubscribeSocket();
        input.signal?.removeEventListener('abort', dispose);
    }
    input.signal?.addEventListener('abort', dispose, { once: true });
    notifyListener(input.listener, { status: 'stale', value: null });
    wake();
    return dispose;
}
