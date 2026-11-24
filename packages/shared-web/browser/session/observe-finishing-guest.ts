import type { BrowserTransportRuntime } from '../connection/browser-transport-runtime.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { roomGuestAccessMode, roomGuestCredentialExpiresAt } from '@shared/api/room-guests/access.ts';

import { ApiHttpError } from '../api/http-error.ts';
import { toAuthSessionKey } from '../auth/to-auth-session-key.ts';
import { browserStateCacheLifecycle } from '../state-cache/browser-state-cache-lifecycle.ts';
import { readStateGroupSnapshot } from '../state-read/point-read.ts';

interface ObserveFinishingGuestInput {
    readonly session: AuthSession;
    readonly room: GroupRef;
    readonly now: number;
    readonly connection: BrowserTransportRuntime.Connection;
    readonly changed: () => void;
}

/** The durable read may grant a finishing window. Later room observations can only shorten it. */
export function observeFinishingGuest({ session, room, now, connection, changed }: ObserveFinishingGuestInput) {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, connection.serverClock.signal]);
    const socket = connection.middleware.middleware.webSocketQueueBox.socket;
    let latest: GroupSnapshot | undefined;
    let revision = -1;
    let cutoff: number | undefined;
    function deadline(snapshot: GroupSnapshot): number {
        const member = snapshot.members.find(row => row.principalId === session.clientId);
        return member && roomGuestAccessMode(snapshot.group, member, now) !== 'expired'
            ? Math.min(roomGuestCredentialExpiresAt(snapshot.group, member), snapshot.group.expiresAtEpochMs ?? Infinity)
            : 0;
    }
    const unsubscribe = browserStateCacheLifecycle.onChange(({ groups }) => {
        const snapshot = groups.find(candidate => isSameGroupRef(candidate.group, room));
        if (!snapshot || snapshot.causalRevision.groupRevision <= revision) return;
        latest = snapshot;
        revision = snapshot.causalRevision.groupRevision;
        if (cutoff !== undefined && deadline(snapshot) < cutoff) {
            cutoff = deadline(snapshot);
            changed();
        }
    });
    async function verify(): Promise<void> {
        try {
            for (;;) {
                const floor = latest?.causalRevision;
                const read = await readStateGroupSnapshot(room.groupId, room, {
                    authSession: session, signal, minCausalRevision: floor
                });
                if (read.source !== 'durable' || read.groupRevision < (floor?.groupRevision ?? 0)) {
                    throw new Error('Guest access requires a current durable room.');
                }
                const durable = deadline(read.snapshot);
                if (!latest || revision <= read.groupRevision) {
                    cutoff = Math.min(cutoff ?? Infinity, durable);
                    revision = read.groupRevision;
                    return;
                }
                const observed = deadline(latest);
                if (observed <= durable) {
                    cutoff = Math.min(cutoff ?? Infinity, observed);
                    return;
                }
                // Only a new durable read at the observed revision may grant the longer window.
            }
        }
        catch (error) {
            if (!(error instanceof ApiHttpError) || ![401, 403, 404].includes(error.status)) throw error;
            cutoff = 0;
        }
    }
    let verified = verify();
    let checkingClose = false;
    const callbackId = 'rallar:guest:access';
    socket.onWebsocketCallbacksDo(callbackId, { onClose(event) {
        if (event.code !== 1008 || checkingClose) return;
        checkingClose = true;
        verified = verified.then(verify);
        // A policy close sometimes arrives before the room can publish its last snapshot.
        void verified.then(() => {
            checkingClose = false;
            if (!signal.aborted) changed();
        }, () => {
            if (!signal.aborted) changed();
        });
    } });
    signal.addEventListener('abort', () => {
        unsubscribe();
        socket.removeWebsocketCallbackById(callbackId);
    }, { once: true });
    return {
        connection, sessionKey: toAuthSessionKey(session),
        get verified() { return verified; },
        get deadline() { return (!checkingClose && cutoff !== undefined) ? cutoff : session.expiresAtEpochMs; },
        stop() { abort.abort(); }
    };
}
