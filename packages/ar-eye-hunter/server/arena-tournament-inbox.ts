import type { RallarServerAppInbox } from '@shared-server/rallar-server/rallar-server-app-inbox.ts';
import { computeSha256CanonicalJson } from '@shared-server/rallar-system/protocol/compute-sha256-canonical-json.ts';
import { encodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { decodeArenaTournamentCommand, type ArenaTournamentMutation } from './arena-tournament-mutation.ts';

export interface RegisterArenaTournamentInboxInput {
    readonly appInbox: RallarServerAppInbox;
    readonly mutations: ArenaTournamentMutation;
    readonly nowEpochMs: () => number;
    readonly onCheckpointCommitted: (binding: TournamentMatchBinding) => void;
}

/** Register before starting the app server. Only authenticated routes and the durable server clock admit commands. */
export function registerArenaTournamentInbox(
    { appInbox, mutations, nowEpochMs, onCheckpointCommitted }: RegisterArenaTournamentInboxInput
): RallarServerAppInbox.Operation<ArenaTournamentMutation.Command, ArenaTournamentMutation.Result> {
    return appInbox.register({
        type: 'app:ar-eye:tournament',
        decodeEnvelope: decodeArenaTournamentEnvelope,
        encodeEnvelope: (command) => ({
            data: encodeJsonWireValue(command, 'Arena tournament command'),
            senderId: command.actor?.sessionId ?? 'tournament-clock'
        }),
        toBinding: (command) => ({
            contextId: computeSha256CanonicalJson(command.roomRef),
            resourceId: command.requestId
        }),
        toLogicalCommand: ({ capturedAtEpochMs: _captured, ...command }) =>
            encodeJsonWireValue(command, 'Logical arena tournament command'),
        materialize: (command) => ({ ...command, capturedAtEpochMs: nowEpochMs() }),
        encodeResult: (result: ArenaTournamentMutation.Result) =>
            encodeJsonWireValue(result, 'Arena tournament result'),
        decodeResult: decodeArenaTournamentMutationResult,
        handle: async (command, context) => {
            const read = await mutations.read(command, context.message.id.traceId);
            const computed = mutations.compute(read);
            const issue = mutations.validate(read, computed)[0];
            if (issue !== undefined) {
                throw issue.cause;
            }
            const result = await appInbox.commit(
                context,
                computed.result,
                (transaction) => mutations.write(transaction, computed)
            );
            if (computed.save !== null && computed.resultWrite === null && read.tournament !== null) {
                onCheckpointCommitted(read.tournament.binding);
            }
            return result;
        }
    });
}

function decodeArenaTournamentEnvelope(envelope: RallarServerAppInbox.Envelope): ArenaTournamentMutation.Command {
    const command = decodeArenaTournamentCommand(envelope.data);
    if (envelope.authority !== undefined || envelope.senderId !== (command.actor?.sessionId ?? 'tournament-clock')) {
        throw new TypeError('Arena tournament envelope differs from its command');
    }
    return command;
}

function decodeArenaTournamentMutationResult(
    value: JsonWireValue,
    command: ArenaTournamentMutation.Command
): ArenaTournamentMutation.Result {
    const result = requireRecord(value, 'Arena tournament result');
    requireExactKeys(
        result,
        ['status', 'roomRef', 'reason', 'simulatedAtEpochMs', 'complete'],
        'Arena tournament result'
    );
    const status = requireOneOf(result.status, ['applied', 'refused'], 'Arena tournament result status');
    if (!jsonEquals(result.roomRef, command.roomRef) || typeof result.complete !== 'boolean') {
        throw new TypeError('Arena tournament result scope or completion differs');
    }
    if (result.simulatedAtEpochMs !== null) {
        requireEpoch(result.simulatedAtEpochMs, 'Arena tournament result clock');
    }
    if (result.reason !== null) {
        requireString(result.reason, 'Arena tournament result refusal');
    }
    if ((status === 'applied') !== (result.reason === null) || result.complete && result.simulatedAtEpochMs === null) {
        throw new TypeError('Arena tournament result status is inconsistent');
    }
    return {
        status,
        roomRef: command.roomRef,
        reason: result.reason,
        simulatedAtEpochMs: result.simulatedAtEpochMs,
        complete: result.complete
    };
}
