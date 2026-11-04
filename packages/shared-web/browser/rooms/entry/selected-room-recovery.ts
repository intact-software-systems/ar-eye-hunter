import { isSameGroupRef, toStateScope } from '@shared/api/api-type-utils.ts';
import { isGroupActive } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { ApiHttpError } from '../../api/http-error.ts';
import { isRetryableApiViewFailure } from '../../api/read-api-view.ts';
import { toAuthSessionKey } from '../../auth/to-auth-session-key.ts';
import type { RallarWsLifecycleKind } from '../../rallar-realtime-facade.ts';
import { readStateGroupSnapshot } from '../../state-read/point-read.ts';
import type { CreateBrowserRallarRoomsInput } from '../browser-rallar-rooms.ts';
import { requireOwnWsConnectionGenerationId } from '../require-own-ws-connection-generation-id.ts';
import { createStateGroupPresenceCommand } from '../room-group-state-workflows.ts';
import { captureRoomSession, type RoomSessionFence } from '../room-session-fence.ts';

export namespace SelectedRoomRecovery {
    export interface Reconnect {
        readonly room: GroupRef;
        readonly fence: RoomSessionFence;
        readonly connectionGenerationId: string;
        assertCurrent(): void;
        accept(snapshot: GroupSnapshot): Promise<void>;
    }
    export interface Input
        extends
            Pick<
                CreateBrowserRallarRoomsInput,
                'requireSession' | 'connect' | 'readPublicationKey' | 'acceptSnapshots'
            > {
        selected(): GroupRef | undefined;
    }
}

/** A replacement socket may restore presence only in the same explicitly selected room. */
export class SelectedRoomRecovery {
    private interrupted?: GroupRef;
    private socketEpoch = 0;
    private changing = 0;
    private pending?: { owner: string; settled: Promise<void>; };

    // A lost PUT receipt is not evidence that presence was never committed.
    private unconfirmed?: { room: GroupRef; confirm(): Promise<void>; };
    private socketOpen = false;
    private readonly input: SelectedRoomRecovery.Input;

    constructor(input: SelectedRoomRecovery.Input) {
        this.input = input;
    }

    onSocket(kind: RallarWsLifecycleKind): void {
        if (kind === 'close' || kind === 'disconnected') {
            this.socketOpen = false;
            this.socketEpoch++;
            this.unconfirmed = undefined;
            this.pending = undefined;
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
                await unresolved.confirm();
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
        if (!this.socketOpen || this.changing || this.pending || !room || this.input.selected() !== room) {
            return;
        }
        this.interrupted = undefined;
        const epoch = this.socketEpoch;
        const owner = toAuthSessionKey(this.input.requireSession());
        const settled: Promise<void> = this.restore(room, epoch).catch((error) => {
            if (this.input.selected() === room && epoch === this.socketEpoch) {
                console.warn('Selected room presence recovery failed', toError(error));
            }
        }).finally(() => {
            if (this.pending?.settled === settled) {
                this.pending = undefined;
                this.resume();
            }
        });
        this.pending = { owner, settled };
    }

    private async restore(room: GroupRef, epoch: number): Promise<void> {
        const fence = captureRoomSession(this.input.requireSession, undefined);
        const context = await this.input.connect();
        const assertCurrent = () => {
            fence.assertCurrent(context);
            if (this.input.selected() !== room || epoch !== this.socketEpoch) {
                throw new DOMException('Socket or room selection changed', 'AbortError');
            }
        };
        assertCurrent();
        const scope = toStateScope(room);
        const { connectionGenerationId, snapshot } = await new Command(async (signal) => {
            assertCurrent();
            const connectionGenerationId = await requireOwnWsConnectionGenerationId(context, signal);
            assertCurrent();
            const { snapshot } = await readStateGroupSnapshot(room.groupId, scope, {
                authSession: fence.session,
                signal
            });
            return { connectionGenerationId, snapshot };
        }, { maxAttempts: 3, timeoutMs: 15000, shouldRetry: (error) => isRetryableApiViewFailure(toError(error)) })
            .run();
        assertCurrent();
        if (
            !isGroupActive(snapshot) ||
            !snapshot.members.some((member) =>
                member.principalId === fence.session.clientId && member.status === 'active'
            )
        ) {
            return;
        }
        const accept = async (current: GroupSnapshot) => {
            assertCurrent();
            await this.input.acceptSnapshots({ context, clients: [], groups: [current], scope, assertCurrent });
        };
        if (
            snapshot.activeSessions.some((row) =>
                row.sessionId === fence.session.sessionId &&
                row.principalId === fence.session.clientId && row.connectionGenerationId === connectionGenerationId
            )
        ) {
            await accept(snapshot);
            return;
        }
        await this.reconnect({ room, fence, connectionGenerationId, assertCurrent, accept });
    }

    private async reconnect(input: SelectedRoomRecovery.Reconnect): Promise<void> {
        const { room, fence, connectionGenerationId, assertCurrent, accept } = input;
        const generationId = crypto.randomUUID();
        const publicationKey = await this.input.readPublicationKey();
        assertCurrent();
        const command = createStateGroupPresenceCommand({
            groupId: room.groupId,
            scope: toStateScope(room),
            principalId: fence.session.clientId,
            sessionId: fence.session.sessionId,
            generationId,
            connectionGenerationId,
            publicationKey,
            authSession: fence.session,
            assertCurrent,
            policies: {
                command: {
                    maxAttempts: 3,
                    timeoutMs: 15000,
                    shouldRetry: (error) => isRetryableApiViewFailure(toError(error))
                }
            }
        });
        const confirmed = (snapshot: GroupSnapshot | undefined): snapshot is GroupSnapshot =>
            Boolean(
                snapshot &&
                    isSameGroupRef(room, snapshot.group) && snapshot.activeSessions.some((row) =>
                        row.principalId === fence.session.clientId && row.sessionId === fence.session.sessionId &&
                        row.generationId === generationId && row.connectionGenerationId === connectionGenerationId
                    )
            );
        const send = async () => {
            const result = await command.run();
            assertCurrent();
            if (!confirmed(result)) {
                throw new Error('Selected room did not confirm presence on the replacement socket.');
            }
            await accept(result);
        };
        try {
            await send();
        }
        catch (error) {
            assertCurrent();
            if (!isRetryableApiViewFailure(toError(error))) {
                throw error;
            }
            const confirm = async () => {
                await confirmRoomPresence({ room, fence, assertCurrent, confirmed, accept, send });
                assertCurrent();
                this.unconfirmed = undefined;
            };
            this.unconfirmed = { room, confirm };
            await confirm();
        }
    }
}

/** Resolve the original PUT before departure uses the recovered generation. */
async function confirmRoomPresence(input: {
    room: GroupRef;
    fence: RoomSessionFence;
    assertCurrent(): void;
    confirmed(snapshot: GroupSnapshot): boolean;
    accept(snapshot: GroupSnapshot): Promise<void>;
    send(): Promise<void>;
}): Promise<void> {
    const { room, fence, assertCurrent } = input;
    assertCurrent();
    try {
        const { snapshot } = await new Command(
            (signal) =>
                readStateGroupSnapshot(room.groupId, toStateScope(room), { authSession: fence.session, signal }),
            { timeoutMs: 15000 }
        ).run();
        assertCurrent();
        if (input.confirmed(snapshot)) {
            await input.accept(snapshot);
        }
        else if (
            isGroupActive(snapshot) &&
            snapshot.members.some((row) => row.principalId === fence.session.clientId && row.status === 'active')
        ) {
            await input.send();
        }
    }
    catch (error) {
        if (!(error instanceof ApiHttpError && (error.status === 403 || error.status === 404))) {
            throw error;
        }
    }
}
