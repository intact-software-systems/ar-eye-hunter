import { hashMutationCommand, type JsonWireValue } from '../../protocol/json-wire-identity.ts';

import type {
    ClientMutationAuthority,
    ClientMutationCommand,
    ClientMutationCommandInput,
    ClientMutationFacts
} from './client-mutation-contracts.ts';
import { validateClientMutationCommand } from './command-validation/validate-client-mutation-command.ts';

export type ClientMutationPersistedFacts = Omit<ClientMutationFacts, 'commandHash'>;

export async function toClientMutationCommand(
    input: ClientMutationCommandInput,
    facts: ClientMutationPersistedFacts,
    authority: ClientMutationAuthority
): Promise<ClientMutationCommand> {
    const command = {
        ...input,
        authority,
        facts: {
            ...facts,
            commandHash: await hashMutationCommand({ ...input, authority } as JsonWireValue)
        }
    } as ClientMutationCommand;
    validateClientMutationCommand(command);
    return command;
}
