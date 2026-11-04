import type { RallarServerAppInbox } from '@shared-server/rallar-server/rallar-server-app-inbox.ts';
import type { AppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { computeAppOutboxSignal } from '@shared-server/rallar-system/app-outbox/compute-app-outbox-signal.ts';
import { computeSha256CanonicalJson } from '@shared-server/rallar-system/protocol/compute-sha256-canonical-json.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { TournamentArena } from '../tournament-arena.ts';
import { decodeArenaTournamentCommand, type ArenaTournamentMutation } from './arena-tournament-mutation.ts';

export const ARENA_TOURNAMENT_FINISH_TOPIC = 'app:ar-eye:tournament-finished';
const DEADLINE_TYPE = 'app:ar-eye:tournament-clock';
const RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Each clock transition commits its successor with state. Player input never forks the durable clock chain. */
export function computeArenaTournamentDeadline(
    read: ArenaTournamentMutation.Read,
    state: TournamentArena
): readonly AppOutboxInsert[] {
    if (
        state.arena.match?.status !== 'active' || read.state !== null &&
            read.command.kind !== 'tick'
    ) {
        return [];
    }
    const dueAtEpochMs = Math.max(read.nowEpochMs + 1, state.simulatedAtEpochMs + 50);
    const requestId = computeSha256CanonicalJson({
        roomRef: read.command.roomRef,
        gameId: state.gameId,
        predecessorRequestId: read.command.requestId,
        simulatedAtEpochMs: state.simulatedAtEpochMs
    });
    const command: ArenaTournamentMutation.Command = {
        kind: 'tick',
        roomRef: read.command.roomRef,
        requestId,
        actor: null,
        input: null,
        capturedAtEpochMs: dueAtEpochMs
    };
    const route = toAppQueueKey({
        topicId: DEADLINE_TYPE,
        contextId: computeSha256CanonicalJson(command.roomRef),
        resourceId: requestId
    });
    return [computeAppOutboxSignal({
        ...route,
        typeId: DEADLINE_TYPE,
        resource: JSON.stringify(command),
        createdAtEpochMs: read.nowEpochMs,
        dueAtEpochMs,
        expiresAtEpochMs: dueAtEpochMs + RECOVERY_RETENTION_MS,
        serviceId: read.serverId,
        traceId: read.traceId
    })];
}

export interface InstallArenaTournamentClockInput {
    readonly outbox: OutboxQueueReader;
    readonly operation: RallarServerAppInbox.Operation<ArenaTournamentMutation.Command, ArenaTournamentMutation.Result>;
    readonly nowEpochMs: () => number;
}

/** Restart-safe delivery admits the exact same AppInbox command if the outbox acknowledgement is lost. */
export function installArenaTournamentClock({ outbox, operation, nowEpochMs }: InstallArenaTournamentClockInput): void {
    outbox.onOutboxMessageDo(DEADLINE_TYPE, {
        onMessage: async (message) => {
            const command = decodeArenaTournamentCommand(JSON.parse(message.payload.resource));
            const expected = toAppQueueKey({
                topicId: DEADLINE_TYPE,
                contextId: computeSha256CanonicalJson(command.roomRef),
                resourceId: command.requestId
            });
            if (
                command.kind !== 'tick' || message.route.topicId !== expected.topicId ||
                message.route.contextId !== expected.contextId ||
                message.route.resourceId !== expected.resourceId || command.capturedAtEpochMs <= message.id.ts
            ) {
                throw new TypeError('Arena tournament clock envelope differs');
            }
            if (nowEpochMs() < command.capturedAtEpochMs) {
                throw new Error('Arena tournament clock is not due');
            }
            const admitted = await operation.enqueue({ command, traceId: message.id.traceId });
            if (admitted.left !== undefined) {
                throw new Error(admitted.left.message);
            }
        }
    }, [DEADLINE_TYPE]);
}
