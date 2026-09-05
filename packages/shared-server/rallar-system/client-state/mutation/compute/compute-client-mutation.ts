import type {
    ClientMutationCommand,
    ClientMutationComputed,
    ClientMutationRead
} from '../client-mutation-contracts.ts';
import {
    assertClientMutationCommand,
    assertClientMutationFacts
} from '../command-validation/assert-client-mutation-command.ts';
import { assertClientMutationRead } from '../result-validation/assert-client-mutation-read.ts';
import { computeClientInstanceMutation } from './compute-client-instance-mutation.ts';
import { requireClientMutationReadSnapshot } from './compute-client-mutation-result.ts';
import { computeClientPrincipalMutation } from './compute-client-principal-mutation.ts';
import { computeClientSessionConnect } from './compute-client-session-connect.ts';
import { computeClientSessionDisconnect } from './compute-client-session-disconnect.ts';
import { computeClientSessionExpiry } from './compute-client-session-expiry.ts';
import { computeClientSessionHeartbeat } from './compute-client-session-heartbeat.ts';

export function computeClientMutation(
    input: Readonly<{ command: ClientMutationCommand; read: ClientMutationRead; }>
): ClientMutationComputed {
    const { command, read } = input;
    assertClientMutationCommand(command);
    assertClientMutationFacts(command.facts);
    assertClientMutationRead(command, read);
    if (read.idempotency) {
        return read.idempotency.value.commandHash === command.facts.commandHash
            ? {
                outcome: 'replay',
                receipt: read.idempotency.value.receipt,
                snapshot: requireClientMutationReadSnapshot(read, command),
                event: read.receiptEvent
            }
            : {
                outcome: 'idempotency-conflict',
                existingCommandHash: read.idempotency.value.commandHash,
                receivedCommandHash: command.facts.commandHash
            };
    }

    switch (command.operation) {
        case 'upsertPrincipal':
            return computeClientPrincipalMutation({ command, read });
        case 'upsertInstance':
            return computeClientInstanceMutation({ command, read });
        case 'connectSession':
        case 'connectAuthorisedWsSession':
            return computeClientSessionConnect({ command, read });
        case 'heartbeatSession':
            return computeClientSessionHeartbeat({ command, read });
        case 'disconnectSession':
        case 'disconnectAuthorisedWsSession':
            return computeClientSessionDisconnect({ command, read });
        case 'expireSession':
            return computeClientSessionExpiry({ command, read });
    }
}
