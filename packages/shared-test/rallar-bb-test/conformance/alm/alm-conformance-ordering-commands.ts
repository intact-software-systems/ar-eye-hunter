import { AL_CONTROL_NACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';

import type { RallarBlackBoxTestCommand } from '../../rallar-black-box-test-contracts.ts';

import { toHeldFaultCommands, toHeldMessageFaultCommands } from './alm-conformance-fault-commands.ts';
import {
    toAdmissionCommands,
    toCommittedControlAdmissionWait,
    toObserveCommand,
    toResultAssertion,
    toSendCommand
} from './alm-conformance-message-commands.ts';
import type { AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';

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

export function toOrderingKey(sender: AlmConformanceStepInput): string {
    return `alm-${sender.input.carrier}-${sender.scenarioId}`;
}

/**
 * Three ordered sends whose second frame alone is held, then the range NACK the third reveals, admitted at the
 * sender. The hold of the type covers the second send until its message id is known; the message hold then takes
 * over, so the third send passes while the second stays held across every retransmission. Over `ws` the relay is
 * the hop that NACKs; over the RTC carriers the receiver is; the sender admits either as `committed`.
 */
export function toHeldSecondSendCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toOrderedSendCommands(sender, 1),
        toObserveCommand({ ...sender, index: 1, state: 'transport-accepted' }),
        toResultAssertion({
            step: sender,
            name: 'assert-sent-1',
            resultName: 'observe-transport-accepted-1',
            field: 'state',
            operator: 'matches',
            expected: '^(transport-accepted|acknowledged)$'
        }),
        ...toHeldFaultCommands(sender, 'hold', 'until-cleared'),
        ...toOrderedSendCommands(sender, 2),
        ...toHeldMessageFaultCommands({ ...sender, index: 2 }, 'hold-message-2', 'until-cleared'),
        ...toHeldFaultCommands(sender, 'release', 0),
        ...toOrderedSendCommands(sender, 3),
        toCommittedControlAdmissionWait({
            step: { ...sender, index: 3 },
            name: 'gap-nack',
            controlTypeId: AL_CONTROL_NACK_TYPE_ID
        })
    ];
}
