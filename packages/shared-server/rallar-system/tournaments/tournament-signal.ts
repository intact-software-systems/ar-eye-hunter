import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { requireEpoch, requireExactKeys, requireOneOf, requireRecord } from '@shared/api/exact-object-decoding.ts';
import { decodeTournamentMatchBinding } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { AppOutboxInsert } from '../app-outbox/app-outbox-insert.ts';
import { computeAppOutboxSignal } from '../app-outbox/compute-app-outbox-signal.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import { decodeJsonWireText } from '../protocol/json-wire-identity.ts';

export const TOURNAMENT_RECONCILE_TOPIC = 'app:rallar-tournaments:reconcile';
export const TOURNAMENT_SIGNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface TournamentSignal {
    readonly kind: 'start' | 'cancel' | 'no-show' | 'result';
    readonly binding: TournamentMatchBinding;
    readonly dueAtEpochMs: number;
}

export interface TournamentSignalInput {
    readonly signal: TournamentSignal;
    readonly topic: string;
    readonly createdAtEpochMs: number;
    readonly retentionMs: number;
    readonly serviceId: string;
    readonly traceId: string;
}

/** Signal identity follows the exact attempt, so delayed delivery never grants a replacement game authority. */
export function computeTournamentSignal(input: TournamentSignalInput): AppOutboxInsert {
    const signal = decodeTournamentSignal(input.signal);
    const route = signalRoute(signal, input.topic);
    return computeAppOutboxSignal({
        ...route,
        typeId: input.topic,
        resource: JSON.stringify(signal),
        createdAtEpochMs: input.createdAtEpochMs,
        dueAtEpochMs: signal.dueAtEpochMs,
        expiresAtEpochMs: Math.max(signal.dueAtEpochMs, input.createdAtEpochMs) + input.retentionMs,
        serviceId: input.serviceId,
        traceId: input.traceId
    });
}

export function decodeTournamentSignal(value: unknown): TournamentSignal {
    const signal = requireRecord(value, 'Tournament signal');
    requireExactKeys(signal, ['kind', 'binding', 'dueAtEpochMs'], 'Tournament signal');
    requireEpoch(signal.dueAtEpochMs, 'Tournament signal time');
    return {
        kind: requireOneOf(signal.kind, ['start', 'cancel', 'no-show', 'result'], 'Tournament signal kind'),
        binding: decodeTournamentMatchBinding(signal.binding),
        dueAtEpochMs: signal.dueAtEpochMs
    };
}

export function readTournamentSignal(message: ALMessage, topic: string, nowEpochMs: number): TournamentSignal {
    const signal = decodeTournamentSignal(decodeJsonWireText(message.payload.resource));
    const expected = signalRoute(signal, topic);
    if (
        message.route.topicId !== expected.topicId || message.route.contextId !== expected.contextId ||
        message.route.resourceId !== expected.resourceId || message.payload.typeId !== topic
    ) {
        throw new TypeError('Tournament signal envelope differs');
    }
    if (nowEpochMs < signal.dueAtEpochMs) {
        throw new Error('Tournament signal is not due');
    }
    return signal;
}

function signalRoute(signal: TournamentSignal, topicId: string) {
    return toAppQueueKey({
        topicId,
        contextId: computeSha256CanonicalJson(signal.binding.tournamentRef),
        resourceId: computeSha256CanonicalJson(signal)
    });
}
