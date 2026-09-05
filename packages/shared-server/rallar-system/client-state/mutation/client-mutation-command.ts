import { encodeJsonWireValue, hashMutationCommand } from '../../protocol/json-wire-identity.ts';

import type {
    ClientMutationAuthority,
    ClientMutationCommand,
    ClientMutationCommandInput,
    ClientMutationFacts
} from './client-mutation-contracts.ts';
import { assertClientMutationCommand } from './command-validation/assert-client-mutation-command.ts';

export type ClientMutationPersistedFacts = Omit<ClientMutationFacts, 'commandHash'>;

export async function toClientMutationCommand(
    input: ClientMutationCommandInput,
    facts: ClientMutationPersistedFacts,
    authority: ClientMutationAuthority
): Promise<ClientMutationCommand> {
    const command: ClientMutationCommand = {
        ...input,
        authority,
        facts: {
            ...facts,
            commandHash: await hashMutationCommand(
                encodeJsonWireValue(
                    { ...input, authority },
                    'Client mutation command identity'
                )
            )
        }
    };
    assertClientMutationCommand(command);
    return command;
}
