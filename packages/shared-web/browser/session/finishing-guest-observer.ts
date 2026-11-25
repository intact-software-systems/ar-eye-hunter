import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { roomGuestAccessMode, roomGuestCredentialExpiresAt } from '@shared/api/room-guests/access.ts';

import { ApiHttpError } from '../api/http-error.ts';
import { toAuthSessionKey } from '../auth/to-auth-session-key.ts';
import type { BrowserTransportRuntime } from '../connection/browser-transport-runtime.ts';
import { browserStateCacheLifecycle } from '../state-cache/browser-state-cache-lifecycle.ts';
import { readStateGroupSnapshot, type StateGroupSnapshotRead } from '../state-read/point-read.ts';

const POLICY_CLOSE_CALLBACK_ID = 'rallar:guest:access';
const WS_POLICY_CLOSE_CODE = 1008;
const ENDED_ACCESS_STATUSES: readonly number[] = [401, 403, 404];

export namespace FinishingGuestObserver {
    export interface Input {
        readonly session: AuthSession;
        readonly room: GroupRef;
        readonly now: number;
        readonly connection: BrowserTransportRuntime.Connection;
        readonly changed: () => void;
    }
}

/** The durable read may grant a finishing window. Later room observations can only shorten it. */
export class FinishingGuestObserver {
    readonly connection: BrowserTransportRuntime.Connection;
    readonly sessionKey: string;

    private latest: GroupSnapshot | undefined;
    private revision = -1;
    private cutoff: number | undefined;
    private checkingClose = false;
    private verification: Promise<void>;
    private readonly input: FinishingGuestObserver.Input;
    private readonly abort = new AbortController();
    private readonly signal: AbortSignal;

    constructor(input: FinishingGuestObserver.Input) {
        this.input = input;
        this.connection = input.connection;
        this.sessionKey = toAuthSessionKey(input.session);
        this.signal = AbortSignal.any([this.abort.signal, input.connection.serverClock.signal]);
        const socket = input.connection.middleware.middleware.webSocketQueueBox.socket;
        const unsubscribe = browserStateCacheLifecycle.onChange(({ groups }) => this.observeRoom(groups));
        socket.onWebsocketCallbacksDo(POLICY_CLOSE_CALLBACK_ID, {
            onClose: (event) => this.recheckAfterPolicyClose(event.code)
        });
        this.signal.addEventListener('abort', () => {
            unsubscribe();
            socket.removeWebsocketCallbackById(POLICY_CLOSE_CALLBACK_ID);
        }, { once: true });
        this.verification = this.verify();
    }

    get verified(): Promise<void> {
        return this.verification;
    }

    /** The session's own expiry stands until a durable read has answered, and again while a policy close is checked. */
    get deadline(): number {
        return !this.checkingClose && this.cutoff !== undefined ? this.cutoff : this.input.session.expiresAtEpochMs;
    }

    stop(): void {
        this.abort.abort();
    }

    private observeRoom(groups: readonly GroupSnapshot[]): void {
        const snapshot = groups.find((candidate) => isSameGroupRef(candidate.group, this.input.room));
        if (!snapshot || snapshot.causalRevision.groupRevision <= this.revision) {
            return;
        }
        this.latest = snapshot;
        this.revision = snapshot.causalRevision.groupRevision;
        const observed = this.computeDeadline(snapshot);
        if (this.cutoff !== undefined && observed < this.cutoff) {
            this.cutoff = observed;
            this.input.changed();
        }
    }

    private async verify(): Promise<void> {
        try {
            for (;;) {
                const read = await this.readDurableRoom(this.latest?.causalRevision);
                const durable = this.computeDeadline(read.snapshot);
                if (!this.latest || this.revision <= read.groupRevision) {
                    this.cutoff = Math.min(this.cutoff ?? Infinity, durable);
                    this.revision = read.groupRevision;
                    return;
                }
                const observed = this.computeDeadline(this.latest);
                if (observed <= durable) {
                    this.cutoff = Math.min(this.cutoff ?? Infinity, observed);
                    return;
                }
                // Only a new durable read at the observed revision may grant the longer window.
            }
        }
        catch (error) {
            if (!(error instanceof ApiHttpError) || !ENDED_ACCESS_STATUSES.includes(error.status)) {
                throw error;
            }
            this.cutoff = 0;
        }
    }

    private async readDurableRoom(floor: GroupSnapshot['causalRevision'] | undefined): Promise<StateGroupSnapshotRead> {
        const { room, session } = this.input;
        const read = await readStateGroupSnapshot(room.groupId, room, {
            authSession: session,
            signal: this.signal,
            minCausalRevision: floor
        });
        if (read.source !== 'durable' || read.groupRevision < (floor?.groupRevision ?? 0)) {
            throw new Error('Guest access requires a current durable room.');
        }
        return read;
    }

    /** A policy close sometimes arrives before the room can publish its last snapshot. */
    private recheckAfterPolicyClose(closeCode: number): void {
        if (closeCode !== WS_POLICY_CLOSE_CODE || this.checkingClose) {
            return;
        }
        this.checkingClose = true;
        this.verification = this.verification.then(() => this.verify());
        const notifyChange = (): void => {
            if (!this.signal.aborted) {
                this.input.changed();
            }
        };
        void this.verification.then(() => {
            this.checkingClose = false;
            notifyChange();
        }, notifyChange);
    }

    /** How long this room snapshot lets the guest stay: its credential cutoff, bounded by the room's own expiry. */
    private computeDeadline(snapshot: GroupSnapshot): number {
        const { session, now } = this.input;
        const member = snapshot.members.find((row) => row.principalId === session.clientId);
        return member && roomGuestAccessMode(snapshot.group, member, now) !== 'expired'
            ? Math.min(
                roomGuestCredentialExpiresAt(snapshot.group, member),
                snapshot.group.expiresAtEpochMs ?? Infinity
            )
            : 0;
    }
}
