import { toStateScope } from '@shared/api/api-type-utils.ts';
import { Command } from '@shared/cache/Command.ts';
import { FailureBackoff } from '@shared/resilience/failure-backoff.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';
import {
    readBrowserServerExpiryEpochMs
} from '../../connection/server-clock/browser-server-clock-session.ts';
import { readGroupPresenceCreationEpochMs } from '../../session/group-presence-policy.ts';

import { ApiHttpError } from '../../api/http-error.ts';
import { isRetryableApiViewFailure } from '../../api/read-api-view.ts';
import { toAuthSessionKey } from '../../auth/to-auth-session-key.ts';
import type { ApiMiddleware } from '../../rallar-connection-facade.ts';
import type { RallarWsLifecycleKind } from '../../rallar-realtime-facade.ts';
import { readStateGroupSnapshot } from '../../state-read/point-read.ts';
import type { CreateBrowserRallarRoomsInput } from '../browser-rallar-rooms.ts';
import {
    toRoomPresenceLeaseExpiresAtEpochMs,
    type GroupRef,
    type GroupSnapshot
} from '../room-group-state-translation.ts';
import { createStateGroupPresenceCommand } from '../room-group-state-workflows.ts';
import { captureRoomSession } from '../room-session-fence.ts';
import {
    isActiveMember,
    isConfirmedPresence,
    needsPresenceRestore,
    readRestoreSnapshot,
    RestoredPresenceExpiredError,
    sendPresenceReconnect,
    type PresenceReconnect,
    type PresenceRestore
} from './presence-reconnect.ts';

export namespace SelectedRoomRecovery {
    export interface Input
        extends
            Pick<
                CreateBrowserRallarRoomsInput,
                'requireSession' | 'connect' | 'readPublicationKey' | 'acceptSnapshots'
            > {
        readonly timers: Timers;
        readonly newPresenceGenerationId: () => string;
        selected(): GroupRef | undefined;
    }
}

/** Restores expired or disconnected presence only in the same explicitly selected room. */
export class SelectedRoomRecovery {
    private readonly input: SelectedRoomRecovery.Input;
    private readonly retries = new FailureBackoff({ baseMs: 1_000, maxMs: 30_000 });
    private interrupted?: GroupRef;
    private socketEpoch = 0;
    private socketOpen = false;
    private changing = 0;
    private pending?: { owner: string; settled: Promise<void>; };
    private cancelRetry?: () => void;
    // A lost PUT receipt is not evidence that presence was never committed.
    private unconfirmed?: PresenceReconnect;

    constructor(input: SelectedRoomRecovery.Input) {
        this.input = input;
    }

    observePresence(snapshot: GroupSnapshot | undefined, context: ApiMiddleware): void {
        const room = this.input.selected();
        const window = context.serverTime.readWindow().right;
        if (!this.socketOpen || this.changing || !room || !window) {
            return;
        }
        const session = this.input.requireSession();
        const connectionGenerationId = context.middleware.ownWsConnectionGeneration.readKnown();
        if (
            needsPresenceRestore({ room, session, snapshot, nowEpochMs: window.latestEpochMs, connectionGenerationId })
        ) {
            this.interrupted = room;
            this.resume();
        }
    }

    onSocket(kind: RallarWsLifecycleKind): void {
        if (kind === 'close' || kind === 'disconnected') {
            this.socketOpen = false;
            this.socketEpoch++;
            this.unconfirmed = undefined;
            this.pending = undefined;
            this.cancelRetry?.();
            this.cancelRetry = undefined;
            this.retries.recordSuccess();
            this.interrupted = kind === 'close' ? this.input.selected() : undefined;
        }
        if (kind === 'open' || kind === 'connected') {
            this.socketOpen = true;
            this.resume();
        }
    }

    async changeRoom<T>(operation: () => Promise<T>): Promise<T> {
        this.changing++;
        try {
            // Finish any issued presence write before the departure reads the old generation.
            if (this.pending) {
                const fence = captureRoomSession(this.input.requireSession, undefined);
                if (this.pending.owner === toAuthSessionKey(fence.session)) {
                    await this.pending.settled;
                    fence.assertCurrent();
                }
            }
            this.discardObsoletePresence();
            const unresolved = this.unconfirmed;
            if (unresolved && unresolved.room === this.input.selected()) {
                await this.confirmPresence(unresolved);
            }
            return await operation();
        }
        finally {
            this.changing--;
            this.resume();
        }
    }

    private resume(): void {
        const room = this.interrupted;
        if (
            !this.socketOpen || this.changing || this.pending || this.cancelRetry || !room ||
            this.input.selected() !== room
        ) {
            return;
        }
        this.interrupted = undefined;
        const epoch = this.socketEpoch;
        const owner = toAuthSessionKey(this.input.requireSession());
        const settled: Promise<void> = this.restore(room, epoch).then(
            () => this.retries.recordSuccess(),
            (error) => this.restoreFailed(room, epoch, toError(error))
        ).finally(() => {
            if (this.pending?.settled === settled) {
                this.pending = undefined;
                this.resume();
            }
        });
        this.pending = { owner, settled };
    }

    /** A transient failure keeps the same socket's selection armed for a backoff retry. */
    private restoreFailed(room: GroupRef, epoch: number, error: Error): void {
        if (this.input.selected() !== room || epoch !== this.socketEpoch) {
            return;
        }
        console.warn('Selected room presence recovery failed', error);
        if (!isRetryableApiViewFailure(error)) {
            return;
        }
        this.interrupted = room;
        const retryAtMs = this.retries.recordFailure(this.input.timers.nowMs());
        this.cancelRetry = this.input.timers.schedule(() => {
            this.cancelRetry = undefined;
            this.resume();
        }, retryAtMs - this.input.timers.nowMs());
    }

    private async restore(room: GroupRef, epoch: number): Promise<void> {
        const fence = captureRoomSession(this.input.requireSession, undefined);
        const context = await this.input.connect();
        const restore: PresenceRestore = { room, scope: toStateScope(room), epoch, fence, context };
        this.assertCurrent(restore);
        this.discardObsoletePresence();
        if (this.unconfirmed) {
            await this.confirmPresence(this.unconfirmed);
            return;
        }
        const { connectionGenerationId, snapshot } = await readRestoreSnapshot(
            restore,
            () => this.assertCurrent(restore)
        );
        this.assertCurrent(restore);
        if (!isActiveMember(snapshot, fence.session)) {
            return;
        }
        const latestEpochMs = readBrowserServerExpiryEpochMs(restore.context.serverTime);
        if (
            snapshot.activeSessions.some((row) =>
                row.sessionId === fence.session.sessionId &&
                row.principalId === fence.session.clientId && row.connectionGenerationId === connectionGenerationId &&
                row.expiresAtEpochMs > latestEpochMs
            )
        ) {
            await this.accept(restore, snapshot);
            return;
        }
        await this.reconnect(restore, connectionGenerationId);
    }

    private async reconnect(restore: PresenceRestore, connectionGenerationId: string): Promise<void> {
        const { room, fence } = restore;
        const generationId = this.input.newPresenceGenerationId();
        const publicationKey = await this.input.readPublicationKey();
        this.assertCurrent(restore);
        const expiresAtEpochMs = toRoomPresenceLeaseExpiresAtEpochMs(
            readGroupPresenceCreationEpochMs(restore.context),
            restore.context.middleware.heartbeat.groupPresence?.leaseMs
        );
        const command = createStateGroupPresenceCommand({
            nowMs: () => readGroupPresenceCreationEpochMs(restore.context),
            groupPresence: restore.context.middleware.heartbeat.groupPresence,
            expiresAtEpochMs,
            groupId: room.groupId,
            scope: restore.scope,
            principalId: fence.session.clientId,
            sessionId: fence.session.sessionId,
            generationId,
            connectionGenerationId,
            publicationKey,
            authSession: fence.session,
            assertCurrent: () => this.assertCurrent(restore),
            policies: {
                command: {
                    maxAttempts: restore.context.middleware.heartbeat.groupPresence ? 1 : 3,
                    timeoutMs: restore.context.middleware.heartbeat.groupPresence?.requestTimeoutMs ?? 15000,
                    shouldRetry: (error) => isRetryableApiViewFailure(toError(error))
                }
            }
        });
        const reconnect: PresenceReconnect = {
            ...restore,
            generationId,
            connectionGenerationId,
            command,
            expiresAtEpochMs
        };
        try {
            await this.sendPresence(reconnect);
        }
        catch (error) {
            this.assertCurrent(restore);
            if (error instanceof RestoredPresenceExpiredError) {
                throw error;
            }
            if (!isRetryableApiViewFailure(toError(error))) {
                throw error;
            }
            this.unconfirmed = reconnect;
            await this.confirmPresence(reconnect);
        }
    }

    private async sendPresence(reconnect: PresenceReconnect): Promise<void> {
        const confirmed = await sendPresenceReconnect(
            reconnect,
            () => this.assertCurrent(reconnect)
        );
        await this.accept(reconnect, confirmed);
    }

    /** Resolve the original PUT before departure uses the recovered generation. */
    private async confirmPresence(reconnect: PresenceReconnect): Promise<void> {
        const { room, fence } = reconnect;
        this.assertCurrent(reconnect);
        try {
            const { snapshot } = await new Command(
                (signal) =>
                    readStateGroupSnapshot(room.groupId, reconnect.scope, { authSession: fence.session, signal }),
                { timeoutMs: reconnect.context.middleware.heartbeat.groupPresence?.requestTimeoutMs ?? 15000 }
            ).run();
            this.assertCurrent(reconnect);
            if (
                isConfirmedPresence(reconnect, snapshot, readBrowserServerExpiryEpochMs(reconnect.context.serverTime))
            ) {
                await this.accept(reconnect, snapshot);
            }
            else if (isActiveMember(snapshot, fence.session)) {
                await this.sendPresence(reconnect);
            }
        }
        catch (error) {
            if (error instanceof RestoredPresenceExpiredError && this.unconfirmed === reconnect) {
                this.unconfirmed = undefined;
            }
            if (!(error instanceof ApiHttpError && (error.status === 403 || error.status === 404))) {
                throw error;
            }
        }
        this.assertCurrent(reconnect);
        if (this.unconfirmed === reconnect) {
            this.unconfirmed = undefined;
        }
    }

    private async accept(restore: PresenceRestore, snapshot: GroupSnapshot): Promise<void> {
        this.assertCurrent(restore);
        await this.input.acceptSnapshots({
            context: restore.context,
            clients: [],
            groups: [snapshot],
            scope: restore.scope,
            assertCurrent: () => this.assertCurrent(restore)
        });
    }

    private discardObsoletePresence(): void {
        const unresolved = this.unconfirmed;
        if (
            unresolved && (
                unresolved.room !== this.input.selected() || unresolved.epoch !== this.socketEpoch ||
                toAuthSessionKey(unresolved.fence.session) !== toAuthSessionKey(this.input.requireSession())
            )
        ) {
            this.unconfirmed = undefined;
        }
    }

    private assertCurrent(restore: PresenceRestore): void {
        restore.fence.assertCurrent(restore.context);
        if (this.input.selected() !== restore.room || restore.epoch !== this.socketEpoch) {
            throw new DOMException('Socket or room selection changed', 'AbortError');
        }
    }
}
