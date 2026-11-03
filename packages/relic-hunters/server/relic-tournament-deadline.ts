import type { AppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { computeAppOutboxSignal } from '@shared-server/rallar-system/app-outbox/compute-app-outbox-signal.ts';
import { computeSha256CanonicalJson } from '@shared-server/rallar-system/protocol/canonical-json.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { RelicGameState } from '../src/model.ts';
import { RELIC_TOURNAMENT_REVIEW_MS } from '../src/tournament-expedition.ts';
import type { RelicGameInboxService } from './relic-game-inbox-service.ts';
import { decodeRelicGameCommand, type RelicGameMutationService } from './relic-game-mutation-service.ts';

const DEADLINE_TOPIC = 'app:relic:tournament-clock';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Each phase transition commits its deadline with the native save. Player refreshes never extend it. */
export function computeRelicTournamentDeadline(
    read: RelicGameMutationService.Attempt,
    previous: RelicGameState | null,
    next: RelicGameState
): readonly AppOutboxInsert[] {
    if (
        read.tournament === null || next.phase !== 'planning' && next.phase !== 'review' ||
        previous?.phase === next.phase && previous.round === next.round
    ) {
        return [];
    }
    const dueAtEpochMs = next.phase === 'planning'
        ? next.roundStartedAtEpochMs! + next.roundTimeLimitMs
        : next.updatedAtEpochMs + RELIC_TOURNAMENT_REVIEW_MS;
    const clock = { phase: next.phase, round: next.round, dueAtEpochMs };
    const requestId = computeSha256CanonicalJson({ binding: read.tournament.binding, clock });
    const command: RelicGameMutationService.ClockCommand = {
        operation: 'tournament-clock',
        gameId: next.gameId,
        requestId,
        actor: null,
        authorization: 'tournament',
        move: null,
        clock
    };
    return [
        computeAppOutboxSignal({
            topicId: DEADLINE_TOPIC,
            typeId: DEADLINE_TOPIC,
            contextId: next.gameId,
            resourceId: requestId,
            resource: JSON.stringify(command),
            createdAtEpochMs: read.attemptAtEpochMs,
            dueAtEpochMs,
            expiresAtEpochMs: dueAtEpochMs + RETENTION_MS,
            serviceId: read.ingress.serverPeerId,
            traceId: read.traceId
        })
    ];
}

export interface InstallRelicTournamentClockInput {
    readonly outbox: OutboxQueueReader;
    readonly inbox: RelicGameInboxService;
    readonly nowEpochMs: () => number;
}

export function installRelicTournamentClock(input: InstallRelicTournamentClockInput): void {
    input.outbox.onOutboxMessageDo(DEADLINE_TOPIC, {
        onMessage: async (message) => {
            const command = decodeRelicGameCommand(JSON.parse(message.payload.resource));
            const expected = toAppQueueKey({
                topicId: DEADLINE_TOPIC,
                contextId: command.gameId,
                resourceId: command.requestId
            });
            if (
                command.operation !== 'tournament-clock' || command.clock.phase === 'start' ||
                message.route.topicId !== DEADLINE_TOPIC || message.payload.typeId !== DEADLINE_TOPIC ||
                message.route.contextId !== expected.contextId || message.route.resourceId !== expected.resourceId ||
                command.clock.dueAtEpochMs <= message.id.ts
            ) {
                throw new TypeError('Relic tournament deadline envelope differs');
            }
            if (input.nowEpochMs() < command.clock.dueAtEpochMs) {
                throw new Error('Relic tournament deadline is not due');
            }
            await input.inbox.enqueueTournamentClock(command, message.id.traceId);
        }
    }, [DEADLINE_TOPIC]);
}
