import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { EXPIRY_TTL_MS, toBudgetMs } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    FAULT_TIMEOUT_MS,
    toFaultCarriers,
    type AlmConformanceFaultCarrier
} from '../alm-conformance-fault-commands.ts';
import {
    toAdmissionCommands,
    toObserveCommand,
    toResultAssertion,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    SMOKE_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from '../alm-conformance-step-identities.ts';

interface AlmConformanceFaultInput extends AlmConformanceStepInput {
    readonly faultCarrier: AlmConformanceFaultCarrier;
    readonly name: 'fault' | 'release';
    readonly remaining: 'until-cleared' | 0;
}

export const deadlineExpiry: AlmConformanceScenarioDefinition = {
    scenarioId: 'deadline-expiry',
    scenarioKey: 'deadline-expiry',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toDeadlineExpirySenderCommands,
    toRecipientCommands: toDeadlineExpiryReceiverCommands
};

function toDeadlineExpiryReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [toReceivedCommand({
        ...receiver,
        index: 1,
        count: 1,
        absent: true
    })];
}

function toDeadlineExpirySenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toFaultCommands(sender, 'fault', 'until-cleared'),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: { ttlMs: EXPIRY_TTL_MS, ack: 'receiver' }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'expired' }),
        toResultAssertion({
            step: sender,
            name: 'assert-expired-1',
            resultName: 'observe-expired-1',
            field: 'state',
            operator: 'equals',
            expected: 'expired'
        }),
        ...toFaultCommands(sender, 'release', 0)
    ];
}

/** A hold, not a frame count: an RTC drop is retried every 50 ms, so a count runs out before the lifetime ends. */
function toFaultCommands(
    sender: AlmConformanceStepInput,
    name: AlmConformanceFaultInput['name'],
    remaining: AlmConformanceFaultInput['remaining']
): readonly RallarBlackBoxTestCommand[] {
    return toFaultCarriers(sender.input.carrier).map((faultCarrier) =>
        toFaultCommand({ ...sender, faultCarrier, name, remaining })
    );
}

function toFaultCommand(fault: AlmConformanceFaultInput): RallarBlackBoxTestCommand {
    const typeId = toScenarioTypeId(fault);
    return {
        kind: 'fault.inject',
        commandId: toCommandId(fault, `${fault.name}-${fault.faultCarrier}`),
        faultId: `drop-${fault.faultCarrier}-${typeId}`,
        carrier: fault.faultCarrier,
        match: { typeId },
        action: 'drop',
        remaining: fault.remaining,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, fault.input.deadlineMs)
    };
}
