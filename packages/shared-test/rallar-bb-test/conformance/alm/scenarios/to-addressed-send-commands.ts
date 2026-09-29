import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand
} from '../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../alm-conformance-budgets.ts';
import { toAdmissionCommands, toObserveCommand, toSendCommand } from '../alm-conformance-message-commands.ts';
import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';

/** The first send of an addressed scenario, admitted and observed until its addressee acknowledges it. */
export function toAddressedSendCommands(
    sender: AlmConformanceStepInput,
    toPeer: NonNullable<RallarBlackBoxTestMessagesSendCommand['toPeer']>
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: {
                toPeer,
                ack: 'receiver',
                ttlMs: NON_EXPIRING_TTL_MS,
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'acknowledged' })
    ];
}
