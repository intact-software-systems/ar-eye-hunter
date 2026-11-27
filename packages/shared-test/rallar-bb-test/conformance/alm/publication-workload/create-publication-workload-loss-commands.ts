import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestTransportFaultInjectCommand
} from '../../../rallar-black-box-test-contracts.ts';

import { FAULT_TIMEOUT_MS } from '../alm-conformance-fault-commands.ts';
import {
    resolvePublicationWorkloadLossCarrier,
    toTransportFaultLoss,
    type PublicationWorkloadSeededLoss
} from './validate-publication-workload-loss.ts';
import type { PublicationWorkloadParameters } from './validate-publication-workload-parameters.ts';

/** A publisher's loss commands at each of the window's places; every place is empty for a point with no loss. */
export interface PublicationWorkloadLossCommands {
    /** Before the first send, so no frame of the window escapes the loss. */
    readonly arm: readonly RallarBlackBoxTestCommand[];
    /** After the drain, when no frame of the window is still resubmitted, so the release's count is final. */
    readonly release: readonly RallarBlackBoxTestCommand[];
    /** After the publisher's own gate. */
    readonly asserts: readonly RallarBlackBoxTestCommand[];
}

export interface PublicationWorkloadLossCommandsInput {
    readonly parameters: Pick<PublicationWorkloadParameters, 'carrier' | 'loss'>;
    /** The prefix of the publisher's commands. */
    readonly commandPrefix: string;
    /** The frame's type: the fault meets the window's frames and no other frame of the page. */
    readonly typeId: string;
}

/** One fault id: the release reads the counts of the fault the arm injected. */
const LOSS_FAULT_ID = 'publication-workload-loss';

export function createPublicationWorkloadLossCommands(
    input: PublicationWorkloadLossCommandsInput
): PublicationWorkloadLossCommands {
    const { loss } = input.parameters;
    if (loss.kind === 'none') {
        return { arm: [], release: [], asserts: [] };
    }
    return {
        arm: [createLossFault(input, loss, 'until-cleared')],
        release: [createLossFault(input, loss, 0)],
        asserts: [{
            kind: 'assert',
            commandId: `${input.commandPrefix}-assert-loss-acted`,
            source: `resultCache.${input.commandPrefix}-loss-release.value.acted.drop`,
            operator: 'gte',
            expected: 1
        }]
    };
}

/**
 * Held, not counted: a count runs out after a number of drops, which RTC resubmissions spend before the window ends.
 * Under `rtc-with-ws-fallback` it stands on the RTC leg alone, so a frame handed to WS is not lost.
 */
function createLossFault(
    input: PublicationWorkloadLossCommandsInput,
    loss: PublicationWorkloadSeededLoss,
    remaining: 'until-cleared' | 0
): RallarBlackBoxTestTransportFaultInjectCommand {
    return {
        kind: 'fault.inject',
        commandId: `${input.commandPrefix}-loss-${remaining === 0 ? 'release' : 'arm'}`,
        faultId: LOSS_FAULT_ID,
        carrier: resolvePublicationWorkloadLossCarrier(input.parameters.carrier),
        match: { typeId: input.typeId },
        action: { loss: toTransportFaultLoss(loss) },
        remaining,
        timeoutMs: FAULT_TIMEOUT_MS
    };
}
