import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef, toStateScope } from '@shared/api/api-type-utils.ts';
import { isGroupActive } from '@shared/api/group-client-views.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { FailureBackoff } from '@shared/resilience/failure-backoff.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { ApiHttpError } from '../../api/http-error.ts';
import { isRetryableApiViewFailure } from '../../api/read-api-view.ts';
import { toAuthSessionKey } from '../../auth/to-auth-session-key.ts';
import type { ApiMiddleware } from '../../rallar-connection-facade.ts';
import type { RallarWsLifecycleKind } from '../../rallar-realtime-facade.ts';
import { readStateGroupSnapshot } from '../../state-read/point-read.ts';
import type { CreateBrowserRallarRoomsInput } from '../browser-rallar-rooms.ts';
import { requireOwnWsConnectionGenerationId } from '../require-own-ws-connection-generation-id.ts';
import type { GroupRef, GroupSnapshot } from '../room-group-state-translation.ts';
import { createStateGroupPresenceCommand, type StateGroupWorkflowValue } from '../room-group-state-workflows.ts';
import { readSummarisedRoomPresence } from '../room-presence.ts';
import { captureRoomSession, type RoomSessionFence } from '../room-session-fence.ts';

export namespace SelectedRoomRecovery {
    export interface Input
        extends
            Pick<
                CreateBrowserRallarRoomsInput,
                'requireSession' | 'connect' | 'readPublicationKey' | 'acceptSnapshots'
            > {
        readonly timers: Timers;
        selected(): GroupRef | undefined;
    }
}

/** One restore attempt is owned by the selected room, its socket epoch and its session. */
interface PresenceRestore {
    readonly room: GroupRef;
    readonly scope: StateScope;
    readonly epoch: number;
    readonly fence: RoomSessionFence;
    readonly context: ApiMiddleware;
}

interface PresenceReconnect extends PresenceRestore {
    readonly generationId: string;
    readonly connectionGenerationId: string;
    readonly command: Command<StateGroupWorkflowValue>;
}

interface RestoreSnapshot {
    readonly connectionGenerationId: string;
    readonly snapshot: GroupSnapshot;
}

/** A replacement socket may restore presence only in the same explicitly selected room. */
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
        this.unconfirmed = undefined;
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
        const { connectionGenerationId, snapshot } = await this.readRestoreSnapshot(restore);
        this.assertCurrent(restore);
        if (!isActiveMember(snapshot, fence.session)) {
            return;
        }
        if (
            snapshot.activeSessions.some((row) =>
                row.sessionId === fence.session.sessionId &&
                row.principalId === fence.session.clientId && row.connectionGenerationId === connectionGenerationId
            )
        ) {
            await this.accept(restore, snapshot);
            return;
        }
        await this.reconnect(restore, connectionGenerationId);
    }

    private async readRestoreSnapshot(restore: PresenceRestore): Promise<RestoreSnapshot> {
        return await new Command(async (signal) => {
            this.assertCurrent(restore);
            const connectionGenerationId = await requireOwnWsConnectionGenerationId(restore.context, signal);
            this.assertCurrent(restore);
            const { snapshot } = await readStateGroupSnapshot(restore.room.groupId, restore.scope, {
                authSession: restore.fence.session,
                signal
            });
            return { connectionGenerationId, snapshot };
        }, { maxAttempts: 3, timeoutMs: 15000, shouldRetry: (error) => isRetryableApiViewFailure(toError(error)) })
            .run();
    }

    private async reconnect(restore: PresenceRestore, connectionGenerationId: string): Promise<void> {
        const { room, fence } = restore;
        const generationId = crypto.randomUUID();
        const publicationKey = await this.input.readPublicationKey();
        this.assertCurrent(restore);
        const command = createStateGroupPresenceCommand({
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
                    maxAttempts: 3,
                    timeoutMs: 15000,
                    shouldRetry: (error) => isRetryableApiViewFailure(toError(error))
                }
            }
        });
        const reconnect: PresenceReconnect = { ...restore, generationId, connectionGenerationId, command };
        try {
            await this.sendPresence(reconnect);
        }
        catch (error) {
            this.assertCurrent(restore);
            if (!isRetryableApiViewFailure(toError(error))) {
                throw error;
            }
            this.unconfirmed = reconnect;
            await this.confirmPresence(reconnect);
        }
    }

    private async sendPresence(reconnect: PresenceReconnect): Promise<void> {
        const result = await reconnect.command.run();
        this.assertCurrent(reconnect);
        if (!result || !isSameGroupRef(reconnect.room, result.group)) {
            throw new Error('Selected room did not confirm presence on the replacement socket.');
        }
        const confirmed = await readSummarisedRoomPresence({
            snapshot: result,
            fence: { session: reconnect.fence.session, assertCurrent: () => this.assertCurrent(reconnect) },
            context: reconnect.context,
            options: { timeoutMs: 15000 },
            isSummarised: (snapshot) => isConfirmedPresence(reconnect, snapshot)
        });
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
                { timeoutMs: 15000 }
            ).run();
            this.assertCurrent(reconnect);
            if (isConfirmedPresence(reconnect, snapshot)) {
                await this.accept(reconnect, snapshot);
            }
            else if (isActiveMember(snapshot, fence.session)) {
                await this.sendPresence(reconnect);
            }
        }
        catch (error) {
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

    private assertCurrent(restore: PresenceRestore): void {
        restore.fence.assertCurrent(restore.context);
        if (this.input.selected() !== restore.room || restore.epoch !== this.socketEpoch) {
            throw new DOMException('Socket or room selection changed', 'AbortError');
        }
    }
}

function isActiveMember(snapshot: GroupSnapshot, session: AuthSession): boolean {
    return isGroupActive(snapshot) &&
        snapshot.members.some((member) => member.principalId === session.clientId && member.status === 'active');
}

function isConfirmedPresence(reconnect: PresenceReconnect, snapshot: GroupSnapshot): boolean {
    const { session } = reconnect.fence;
    return isSameGroupRef(reconnect.room, snapshot.group) &&
        snapshot.activeSessions.some((row) =>
            row.principalId === session.clientId && row.sessionId === session.sessionId &&
            row.generationId === reconnect.generationId &&
            row.connectionGenerationId === reconnect.connectionGenerationId
        );
}
