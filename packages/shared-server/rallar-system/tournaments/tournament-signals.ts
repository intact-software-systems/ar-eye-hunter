import type { TournamentMutationResult } from '@shared/api/tournaments/tournament-mutation-result.ts';
import type { Tournament, TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { RallarServerAppInbox } from '../../rallar-server/rallar-server-app-inbox.ts';
import type { AppOutboxInsert } from '../app-outbox/app-outbox-insert.ts';
import { computeSha256CanonicalJson } from '../protocol/canonical-json.ts';
import { computeTournamentAttemptState } from './tournament-repository.ts';
import type { TournamentService } from './tournament-service.ts';
import {
    computeTournamentSignal,
    readTournamentSignal,
    TOURNAMENT_RECONCILE_TOPIC
} from './tournament-signal.ts';

/** Bracket transitions commit game lifecycle and reconciliation deliveries atomically. */
export function computeTournamentLifecycleSignals(
    read: TournamentService.Read,
    after: Tournament
): readonly AppOutboxInsert[] {
    const profile = read.command.materialized?.profile;
    if (!profile) {
        throw new TypeError('Tournament signals require a captured profile');
    }
    const signals = computeTournamentCancellationSignals(read, after, profile.gameLifecycleTopic);
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
                    topic: profile.gameLifecycleTopic,
                    signal: { kind: 'start', binding: attempt.binding, dueAtEpochMs: attempt.startedAtEpochMs! }
                })
            );
        }
    }
    return signals;
}

/** Replaced attempts also need cancellation delivery to their original game room. */
function computeTournamentCancellationSignals(
    read: TournamentService.Read,
    after: Tournament,
    topic: string
): AppOutboxInsert[] {
    return read.bracket.attempts.flatMap((current) => {
        if (
            current.attempt?.status !== 'playing' ||
            computeTournamentAttemptState(current, after).status !== 'cancelled'
        ) {
            return [];
        }
        return [computeTournamentSignal({
            topic,
            createdAtEpochMs: read.nowEpochMs,
            retentionMs: read.signalRetentionMs,
            serviceId: read.serviceId,
            traceId: read.traceId,
            signal: { kind: 'cancel', binding: current.binding, dueAtEpochMs: read.nowEpochMs }
        })];
    });
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
            if (signal.kind === 'start' || signal.kind === 'cancel') {
                throw new TypeError('Game lifecycle changes are not tournament reconciliation');
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

export interface InstallTournamentGameLifecycleInput {
    readonly outbox: OutboxQueueReader;
    readonly topic: string;
    readonly nowEpochMs: () => number;
    /** Admit an idempotent game-owned AppInbox command; the game must validate the exact private attempt. */
    readonly enqueue: (
        binding: TournamentMatchBinding,
        requestId: string,
        traceId: string,
        dueAtEpochMs: number,
        kind: 'start' | 'cancel'
    ) => Promise<void>;
}

export function installTournamentGameLifecycle(
    { outbox, topic, nowEpochMs, enqueue }: InstallTournamentGameLifecycleInput
): void {
    outbox.onOutboxMessageDo(topic, {
        onMessage: async (message) => {
            const signal = readTournamentSignal(message, topic, nowEpochMs());
            if (signal.kind !== 'start' && signal.kind !== 'cancel') {
                throw new TypeError('Tournament game owner requires a lifecycle signal');
            }
            await enqueue(
                signal.binding,
                computeSha256CanonicalJson(signal),
                message.id.traceId,
                signal.dueAtEpochMs,
                signal.kind
            );
        }
    }, [topic]);
}
