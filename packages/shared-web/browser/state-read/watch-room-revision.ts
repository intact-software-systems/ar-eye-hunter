import { ApiHttpError } from '../api/http-error.ts';
import { notifyListener } from '../messages/rallar-listener-delivery.ts';
import type { RallarStateEventMessage } from '../messages/rallar-message-contracts.ts';

import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { assertValidRallarGroupRef, assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import type { CreateBrowserRallarRoomsInput } from '../rooms/browser-rallar-rooms.ts';
import type { RallarRoomEventOptions } from '../rooms/rallar-room-contracts.ts';
import { captureRoomSession } from '../rooms/room-session-fence.ts';
import { parseGroupStateDeltaEnvelope } from '../state-cache/group-state-delta-application.ts';
import { readStateGroupSnapshot } from './point-read.ts';

export interface ObservedRoomMetadata {
    readonly snapshotVersion: number;
    readonly metadata: ApiJsonObject;
}

interface WatchRoomRevisionInput<T> extends Pick<RallarRoomEventOptions, 'eventTypes'> {
    readonly room: GroupRef;
    readonly services: Pick<CreateBrowserRallarRoomsInput, 'requireSession' | 'ws' | 'auth' | 'roomEvents'>;
    subscribeInvalidation?(room: GroupRef, invalidate: (reason: 'program-changed' | 'access-changed') => void): () => void;
    readonly signal?: AbortSignal;
    project(group: ObservedRoomMetadata): T | null;
    listener(observation: { status: 'current' | 'stale'; value: T | null; }): void;
    regresses(previous: T, next: T): boolean;
    onDelta?(previous: T, next: T): 'ignore' | 'publish' | 'refresh';
}

export function explicitRoomRef(room: GroupRef): GroupRef {
    assertValidRallarGroupRef(room, '$.roomRef');
    assertValidRallarRouteId(room.workspaceId, '$.roomRef.workspaceId', 'Workspace ID');
    return { ...room };
}

export async function readObservedRoom(
    roomRef: GroupRef,
    requireSession: CreateBrowserRallarRoomsInput['requireSession'],
    signal?: AbortSignal
): Promise<ObservedRoomMetadata> {
    const room = explicitRoomRef(roomRef);
    const fence = captureRoomSession(requireSession, signal);
    fence.assertCurrent();
    const result = await readStateGroupSnapshot(room.groupId, room, { authSession: fence.session, signal });
    fence.assertCurrent();
    if (result.source !== 'durable' || !isSameGroupRef(result.snapshot.group, room)) {
        throw new Error('Room reads require the requested durable snapshot.');
    }
    return result.snapshot.group;
}

function validateReadRevision<T extends { readonly revision: number; }>(
    next: T | null,
    previous: T | null,
    announcedRevision: number,
    regresses: WatchRoomRevisionInput<T>['regresses']
): void {
    if ((next?.revision ?? 0) < announcedRevision) {
        throw new Error('Room read predates the server notification.');
    }
    if (previous && (!next || next.revision < previous.revision || regresses(previous, next))) {
        throw new Error('Room read regressed.');
    }
}

function readServerDelta(
    message: Pick<RallarStateEventMessage, 'transport' | 'topicId' | 'typeId' | 'raw'>,
    room: GroupRef
) {
    if (
        message.transport !== 'ws' || message.topicId !== AppTopics.groupStateEvent ||
        message.typeId !== AppTopics.groupStateEvent
    ) {
        return;
    }
    const target = readALTargetGroupRef(message.raw);
    if (!target || !isSameGroupRef(target, room)) {
        return;
    }
    return parseGroupStateDeltaEnvelope(message.raw.payload.resource, room);
}

/** Read on entry and recovery. Scoped server deltas can publish a projection or invalidate the read. */
export function watchRoomRevision<T extends { readonly revision: number; }>(
    input: WatchRoomRevisionInput<T>
): () => void {
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
    function isInactive(): boolean {
        return signal.aborted || pageSuspended || socketLost || document.visibilityState === 'hidden' ||
            navigator.onLine === false;
    }
    async function refresh(): Promise<void> {
        clearTimeout(retry);
        if (isInactive()) {
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
            next = input.project(
                await readObservedRoom(
                    room,
                    requireSession,
                    AbortSignal.any([attempt.signal, AbortSignal.timeout(15_000)])
                )
            );
            validateReadRevision(next, observed, announcedRevision, input.regresses);
        }
        catch (error) {
            if (request !== attempt) {
                return;
            }
            request = undefined;
            if (error instanceof ApiHttpError && [401, 403, 404].includes(error.status)) {
                queued = false;
                announcedRevision = 0;
                publish('stale', null);
                return;
            }
            publish('stale');
            // One bounded retry burst per external wakeup, including when the server stays unavailable.
            if (!signal.aborted && retries < 3) {
                retry = setTimeout(() => void refresh(), 1000 * 2 ** retries++);
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
    const unsubscribeRoom = input.subscribeInvalidation?.(room, (reason) => {
        request?.abort();
        request = undefined;
        queued = false;
        if (reason === 'access-changed') {
            announcedRevision = 0;
            publish('stale', null);
        }
        else {
            publish('stale');
        }
        wake();
    }) ?? roomEvents.onEvent((_event, message) => {
        const delta = readServerDelta(message, room);
        if (!delta) {
            return;
        }
        const announced = input.project(delta.group);
        if (!announced || announced.revision <= Math.max(announcedRevision, observed?.revision ?? 0)) {
            return;
        }
        const action = observed && input.onDelta?.(observed, announced);
        if (action === 'ignore') {
            return;
        }
        announcedRevision = announced.revision;
        if (
            action === 'publish' && observed && status === 'current' && !request && !isInactive() &&
            !input.regresses(observed, announced)
        ) {
            fence.assertCurrent();
            publish('current', announced);
            return;
        }
        publish('stale');
        wake();
    }, { roomRef: room, scope: room, eventTypes: input.eventTypes });
    const unsubscribeSocket = ws.onLifecycle((event) => {
        socketLost = ['close', 'disconnected', 'error'].includes(event.kind);
        wake();
    }, { emitCurrent: false });
    const unsubscribeAuth = auth.onChange(({ session }) => {
        if (session?.sessionId === fence.session.sessionId && session?.clientId === fence.session.clientId) {
            return;
        }
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
