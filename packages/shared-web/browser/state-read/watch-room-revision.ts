import { observeRoomReadLifecycle } from './observe-room-read-lifecycle.ts';
import { RoomPurgeWakeup } from './room-purge-wakeup.ts';
import { explicitRoomRef, readObservedRoom, readObservedRoomDelta, validateReadRevision, type ObservedRoomMetadata } from './observed-room.ts';
import { isRetryableApiViewFailure } from '../api/read-api-view.ts';
import { toExponentialBackoffMs } from '@shared/resilience/ComputeAsyncTask.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { ApiHttpError } from '../api/http-error.ts';
import { notifyListener } from '../messages/rallar-listener-delivery.ts';

import type { GroupRef } from '@shared/api/group-types.ts';
import type { CreateBrowserRallarRoomsInput } from '../rooms/browser-rallar-rooms.ts';
import type { RallarRoomEventOptions } from '../rooms/rallar-room-contracts.ts';
import { captureRoomSession } from '../rooms/room-session-fence.ts';

interface WatchRoomRevisionInput<T> extends Pick<RallarRoomEventOptions, 'eventTypes'> {
    readonly room: GroupRef;
    readonly services: Pick<CreateBrowserRallarRoomsInput, 'requireSession' | 'ws' | 'auth' | 'roomEvents'>;
    subscribeInvalidation?(room: GroupRef, invalidate: (reason: 'program-changed' | 'access-changed') => void): () => void;
    readonly signal?: AbortSignal;
    readEarliestServerEpochMs?(): number | undefined;
    read?(room: GroupRef, signal: AbortSignal): Promise<ObservedRoomMetadata>;
    onDenied?(error: ApiHttpError): void;
    project(group: ObservedRoomMetadata): T | null;
    listener(observation: { status: 'current' | 'stale'; value: T | null; }): void;
    regresses(previous: T, next: T): boolean;
    onDelta?(previous: T, next: T): 'ignore' | 'publish' | 'refresh';
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
    const purge = input.readEarliestServerEpochMs && new RoomPurgeWakeup(input.readEarliestServerEpochMs, wake);
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
        purge?.observe(null);
        request?.abort();
        request = undefined;
        queued = false;
        publish('stale');
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
        queued = false;
        const attempt = new AbortController();
        request = attempt;
        let group: ObservedRoomMetadata;
        let next: T | null;
        const readSignal = AbortSignal.any([attempt.signal, AbortSignal.timeout(15_000)]);
        try {
            fence.assertCurrent();
            group = input.read ? await input.read(room, readSignal) : await readObservedRoom(room, requireSession, readSignal);
            next = input.project(group);
            validateReadRevision(next, observed, announcedRevision, input.regresses);
        }
        catch (error) {
            handleReadFailure(attempt, toError(error), readSignal);
            return;
        }
        if (request !== attempt) {
            return;
        }
        request = undefined;
        retries = 0;
        purge?.observe(group.purgeAfterEpochMs);
        publish('current', next);
        if (queued) {
            void refresh();
        }
    }
    function handleReadFailure(attempt: AbortController, error: Error, readSignal: AbortSignal): void {
        if (request !== attempt) {
            return;
        }
        request = undefined;
        if (error instanceof ApiHttpError && [401, 403, 404].includes(error.status)) {
            purge?.observe(null);
            queued = false;
            announcedRevision = 0;
            publish('stale', null);
            if (!signal.aborted) input.onDenied?.(error);
            return;
        }
        publish('stale');
        const transient = readSignal.aborted || isRetryableApiViewFailure(error);
        if (!signal.aborted && (transient || retries < 3)) {
            retry = setTimeout(() => void refresh(), toExponentialBackoffMs(++retries, 30_000, 1_000));
        }
    }
    function wake(): void {
        retries = 0;
        void refresh();
    }
    const { isInactive } = observeRoomReadLifecycle(ws, signal, wake, suspend);
    const unsubscribeRoom = input.subscribeInvalidation?.(room, (reason) => {
        if (reason === 'access-changed') {
            request?.abort();
            request = undefined;
            queued = false;
            announcedRevision = 0;
            publish('stale', null);
        }
        else {
            publish('stale');
        }
        wake();
    }) ?? roomEvents.onEvent((_event, message) => {
        const announced = readObservedRoomDelta(message, room, input.project, Math.max(announcedRevision, observed?.revision ?? 0));
        if (!announced) {
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
        input.signal?.removeEventListener('abort', dispose);
    }
    input.signal?.addEventListener('abort', dispose, { once: true });
    notifyListener(input.listener, { status: 'stale', value: null });
    wake();
    return dispose;
}
