import { AL_CONTROL_NACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';

import type { RallarBlackBoxTestCommand } from '../../rallar-black-box-test-contracts.ts';

import { toControlAdmissionWait } from './alm-conformance-diagnostic-waits.ts';
import { toHeldSendCommands } from './alm-conformance-fault-commands.ts';
import {
    toAdmissionCommands,
    toObserveCommand,
    toResultAssertion,
    toSendCommand
} from './alm-conformance-message-commands.ts';
import type { AlmConformanceMessageStepInput, AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';

/** One at-least-once send on the scenario's ordering key, admitted; the sequence names the send and its payload. */
export function toOrderedSendCommands(
    sender: AlmConformanceStepInput,
    seq: number
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: seq,
            payload: { marker: sender.scenarioId, seq },
            delivery: { reliability: 'at-least-once', orderingKey: toOrderingKey(sender), seq }
        }),
        ...toAdmissionCommands({ ...sender, index: seq })
    ];
}

/** The send of `step.index` left the page: its carrier took it, or its recipients already answered it. */
export function toSentCommands(step: AlmConformanceMessageStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toObserveCommand({ ...step, state: 'transport-accepted' }),
        toResultAssertion({
            step,
            name: `assert-sent-${step.index}`,
            resultName: `observe-transport-accepted-${step.index}`,
            field: 'state',
            operator: 'matches',
            expected: '^(transport-accepted|acknowledged)$'
        })
    ];
}

export function toOrderingKey(sender: AlmConformanceStepInput): string {
    return `alm-${sender.input.carrier}-${sender.scenarioId}`;
}

/**
 * Three ordered sends whose second frame alone is held, then the range NACK the third reveals, admitted at the
 * sender. The third send passes while the second stays held across every retransmission. Over `ws` the relay is the
 * hop that NACKs; over the RTC carriers the receiver is; the sender admits either as `committed`.
 */
export function toHeldSecondSendCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toOrderedSendCommands(sender, 1),
        ...toSentCommands({ ...sender, index: 1 }),
        ...toHeldGapCommands(sender)
    ];
}

/** The second ordered send held, the third sent past it, and the range NACK the third reveals admitted. */
export function toHeldGapCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toHeldSendCommands({ ...sender, index: 2 }, toOrderedSendCommands(sender, 2)),
        ...toOrderedSendCommands(sender, 3),
        toControlAdmissionWait({
            step: { ...sender, index: 3 },
            name: 'gap-nack',
            controlTypeId: AL_CONTROL_NACK_TYPE_ID,
            outcome: 'committed'
        })
    ];
}
