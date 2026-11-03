import type { TournamentMutationResult } from '@shared/api/tournaments/tournament-mutation-result.ts';
import type { Tournament, TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { RallarServerAppInbox } from '../../rallar-server/rallar-server-app-inbox.ts';
import type { AppOutboxInsert } from '../app-outbox/app-outbox-insert.ts';
import { computeSha256CanonicalJson } from '../protocol/canonical-json.ts';
import type { TournamentService } from './tournament-service.ts';
import {
    computeTournamentSignal,
    readTournamentSignal,
    TOURNAMENT_RECONCILE_TOPIC
} from './tournament-signal.ts';

/** Scheduling and starting create durable deliveries in the same transaction as the bracket transition. */
export function computeTournamentLifecycleSignals(
    read: TournamentService.Read,
    after: Tournament
): readonly AppOutboxInsert[] {
    const profile = read.command.materialized?.profile;
    if (!profile) {
        throw new TypeError('Tournament signals require a captured profile');
    }
    const signals: AppOutboxInsert[] = [];
    for (const match of after.matches) {
        const attempt = match.attempt;
        if (attempt === null) {
            continue;
        }
        const previous = read.bracket.record?.tournament.matches.find((candidate) => candidate.slot === match.slot);
        const common = {
            createdAtEpochMs: read.nowEpochMs,
            retentionMs: read.signalRetentionMs,
            serviceId: read.serviceId,
            traceId: read.traceId
        };
        if (match.status === 'scheduled' && previous?.attempt?.binding.attemptId !== attempt.binding.attemptId) {
            signals.push(
                computeTournamentSignal({
                    ...common,
                    topic: TOURNAMENT_RECONCILE_TOPIC,
                    signal: {
                        kind: 'no-show',
                        binding: attempt.binding,
                        dueAtEpochMs: attempt.scheduledAtEpochMs + after.noShowGraceMs
                    }
                })
            );
        }
        if (match.status === 'playing' && previous?.status !== 'playing') {
            signals.push(
                computeTournamentSignal({
                    ...common,
                    topic: profile.gameStartTopic,
                    signal: { kind: 'start', binding: attempt.binding, dueAtEpochMs: attempt.startedAtEpochMs! }
                })
            );
        }
    }
    return signals;
}

export interface InstallTournamentReconciliationInput {
    readonly outbox: OutboxQueueReader;
    readonly operation: RallarServerAppInbox.Operation<TournamentService.Command, TournamentMutationResult>;
    readonly nowEpochMs: () => number;
}

export function installTournamentReconciliation(
    { outbox, operation, nowEpochMs }: InstallTournamentReconciliationInput
): void {
    outbox.onOutboxMessageDo(TOURNAMENT_RECONCILE_TOPIC, {
        onMessage: async (message) => {
            const signal = readTournamentSignal(message, TOURNAMENT_RECONCILE_TOPIC, nowEpochMs());
            if (signal.kind === 'start') {
                throw new TypeError('Game starts are not tournament reconciliation');
            }
            const admitted = await operation.enqueue({
                command: {
                    ref: signal.binding.tournamentRef,
                    requestId: computeSha256CanonicalJson(signal),
                    actor: null,
                    request: { type: 'reconcile' },
                    materialized: null
                },
                traceId: message.id.traceId
            });
            if (admitted.left !== undefined) {
                throw new Error(admitted.left.message);
            }
        }
    }, [TOURNAMENT_RECONCILE_TOPIC]);
}

export interface InstallTournamentGameStartInput {
    readonly outbox: OutboxQueueReader;
    readonly topic: string;
    readonly nowEpochMs: () => number;
    /** Admit an idempotent game-owned AppInbox command; the game must validate the exact private attempt. */
    readonly enqueue: (
        binding: TournamentMatchBinding,
        requestId: string,
        traceId: string,
        startedAtEpochMs: number
    ) => Promise<void>;
}

export function installTournamentGameStart(
    { outbox, topic, nowEpochMs, enqueue }: InstallTournamentGameStartInput
): void {
    outbox.onOutboxMessageDo(topic, {
        onMessage: async (message) => {
            const signal = readTournamentSignal(message, topic, nowEpochMs());
            if (signal.kind !== 'start') {
                throw new TypeError('Tournament game owner requires a start signal');
            }
            await enqueue(signal.binding, computeSha256CanonicalJson(signal), message.id.traceId, signal.dueAtEpochMs);
        }
    }, [topic]);
}
