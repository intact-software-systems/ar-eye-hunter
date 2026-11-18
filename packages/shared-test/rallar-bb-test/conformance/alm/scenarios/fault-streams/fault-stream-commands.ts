import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestTransportFaultInjectCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { toBudgetMs } from '../../alm-conformance-budgets.ts';
import { FAULT_TIMEOUT_MS } from '../../alm-conformance-fault-commands.ts';
import { toResultAssertion } from '../../alm-conformance-message-commands.ts';
import { toOrderedSendCommands } from '../../alm-conformance-ordering-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from '../../alm-conformance-step-identities.ts';
import { toSettledStateCommands } from '../../to-settled-state-commands.ts';

/** The sends of one stream cell: enough for a seeded draw to act, few enough to settle inside the cell's deadline. */
export const FAULT_STREAM_SENDS = 20;

type SeededFaultKind = 'loss' | 'jitter';

interface SeededFault {
    readonly kind: SeededFaultKind;
    readonly action: RallarBlackBoxTestTransportFaultInjectCommand['action'];
}

/** The least number of frames the fault must have dropped or delayed by its release. */
interface SeededFaultFloor {
    readonly decision: 'drop' | 'delay';
    readonly floor: number;
}

/** The receipted sends `from` to `to` of the cell's track, each admitted. */
export function toStreamSendCommands(
    sender: AlmConformanceStepInput,
    from: number,
    to: number
): readonly RallarBlackBoxTestCommand[] {
    return toSequences(from, to).flatMap((seq) => toOrderedSendCommands(sender, seq, 'receiver'));
}

/** The handles of the sends `from` to `to` each ended `acknowledged`: the receiver confirmed every one of them. */
export function toStreamAcknowledgedCommands(
    sender: AlmConformanceStepInput,
    from: number,
    to: number
): readonly RallarBlackBoxTestCommand[] {
    return toSequences(from, to).flatMap((seq) => toSettledStateCommands({ ...sender, index: seq }, 'acknowledged'));
}

/**
 * Holds a seeded fault on the data frames of the cell's type on the cell's one carrier, until its release. A control
 * frame carries another type, so no ACK, NACK or repair is ever acted on.
 */
export function toSeededFaultArmCommand(
    sender: AlmConformanceStepInput,
    fault: SeededFault
): RallarBlackBoxTestTransportFaultInjectCommand {
    return toSeededFaultCommand(sender, fault, 'until-cleared');
}

/**
 * Releases the fault and proves it acted: the release reads how many frames the fault acted on, and the cell fails
 * when that is below the floor. A cell whose fault met no frame therefore never passes.
 */
export function toSeededFaultReleaseCommands(
    sender: AlmConformanceStepInput,
    fault: SeededFault,
    { decision, floor }: SeededFaultFloor
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSeededFaultCommand(sender, fault, 0),
        toResultAssertion({
            step: sender,
            name: `assert-${fault.kind}-${decision === 'drop' ? 'dropped' : 'delayed'}`,
            resultName: `${fault.kind}-release`,
            field: `acted.${decision}`,
            operator: 'gte',
            expected: floor
        })
    ];
}

/** Every send of the stream arrived, each sequence above the one before it, and nothing after the last. */
export function toStreamReceivedCommands(
    receiver: AlmConformanceStepInput,
    sends: number
): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({ ...receiver, index: sends, count: sends, absent: false, ascendingBy: 'seq' }),
        toReceivedCommand({ ...receiver, index: sends + 1, count: sends + 1, absent: true })
    ];
}

function toSeededFaultCommand(
    sender: AlmConformanceStepInput,
    { kind, action }: SeededFault,
    remaining: 'until-cleared' | 0
): RallarBlackBoxTestTransportFaultInjectCommand {
    const carrier = sender.input.carrier === 'ws' ? 'ws' : 'rtc';
    const typeId = toScenarioTypeId(sender);
    return {
        kind: 'fault.inject',
        commandId: toCommandId(sender, `${kind}-${remaining === 0 ? 'release' : 'arm'}`),
        faultId: `${kind}-${carrier}-${typeId}`,
        carrier,
        match: { typeId },
        action,
        remaining,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, sender.input.deadlineMs)
    };
}

function toSequences(from: number, to: number): readonly number[] {
    return Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
}
