import type { TournamentMutationResult } from '@shared/api/tournaments/tournament-mutation-result.ts';
import { decodeTournamentMutationResult } from '@shared/api/tournaments/tournament-mutation-result.ts';
import type { RallarServerAppInbox } from '../../rallar-server/rallar-server-app-inbox.ts';
import { toAppInboxCommandAttempt } from '../app-inbox/app-inbox-contracts.ts';
import { computeSha256CanonicalJson } from '../protocol/canonical-json.ts';
import { encodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import { decodeTournamentCommand } from './decode-tournament-command.ts';
import type { TournamentService } from './tournament-service.ts';

export interface RegisterTournamentInboxInput {
    readonly appInbox: RallarServerAppInbox;
    readonly service: TournamentService;
}

export function registerTournamentInbox(
    { appInbox, service }: RegisterTournamentInboxInput
): RallarServerAppInbox.Operation<TournamentService.Command, TournamentMutationResult> {
    return appInbox.register({
        type: 'app:rallar-tournaments:mutate',
        decodeEnvelope: decodeEnvelope,
        encodeEnvelope: (command) => ({
            data: encodeJsonWireValue(command),
            senderId: command.actor?.sessionId ?? 'tournament-clock'
        }),
        toBinding: (command) => ({ contextId: computeSha256CanonicalJson(command.ref), resourceId: command.requestId }),
        toLogicalCommand: (command) => encodeJsonWireValue({ ...command, materialized: null }),
        materialize: (command) => service.materialize(command),
        encodeResult: (result) => encodeJsonWireValue(result),
        decodeResult: decodeTournamentMutationResult,
        handle: async (command, context) => {
            const read = await service.read(command, toAppInboxCommandAttempt(context));
            const computed = service.compute(read);
            const issue = service.validate(read, computed)[0];
            if (issue !== undefined) {
                throw issue.cause;
            }
            return await appInbox.commit(
                context,
                computed.result,
                (transaction) => service.write(transaction, computed)
            );
        }
    });
}

function decodeEnvelope(envelope: RallarServerAppInbox.Envelope): TournamentService.Command {
    const command = decodeTournamentCommand(envelope.data);
    if (envelope.authority !== undefined || envelope.senderId !== (command.actor?.sessionId ?? 'tournament-clock')) {
        throw new TypeError('Tournament envelope differs from its actor');
    }
    return command;
}
