import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestTransportFaultInjectCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { toBudgetMs } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { FAULT_TIMEOUT_MS } from '../../alm-conformance-fault-commands.ts';
import { toResultAssertion } from '../../alm-conformance-message-commands.ts';
import { toOrderedSendCommands, toOrderingKey } from '../../alm-conformance-ordering-commands.ts';
import { toGapNackWait } from '../../alm-conformance-repair-waits.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from '../../alm-conformance-step-identities.ts';
import { toSettledStateCommands } from '../../to-settled-state-commands.ts';
import { STREAM_SENDS, toOrderedStreamReceiverCommands, toSequences } from './ordered-stream.ts';

/** An RTC channel applies no delay, so a jitter has one carrier. */
const JITTER_CARRIERS: readonly AlmConformanceCarrier[] = ['ws'];
const JITTER = { jitter: { minDelayMs: 0, maxDelayMs: 80, seed: 11 } } as const;

/**
 * An ordered receipted stream keeps its order when every data frame leaves after a seeded delay of 0 to 80 ms: all
 * twenty arrive in sequence order, nothing arrives twice, and every handle ends `acknowledged`. Two facts prove the
 * jitter disturbed the stream. Every matching frame draws a delay, so the release must read one for each send at
 * least; and the sender must have admitted a gap NACK about its track, which the server sends only when a later
 * sequence reached it first. A run whose frames all arrived in order claims nothing and fails.
 */
export const seededJitterStream: AlmConformanceScenarioDefinition = {
    scenarioId: 'seeded-jitter-stream',
    scenarioKey: 'seeded-jitter-stream',
    tags: FULL_TAGS,
    carriers: JITTER_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toSeededJitterStreamSenderCommands,
    toRecipientCommands: toOrderedStreamReceiverCommands
};

function toSeededJitterStreamSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const sequences = toSequences(1, STREAM_SENDS);
    return [
        toJitterCommand(sender, 'arm'),
        ...sequences.flatMap((seq) => toOrderedSendCommands(sender, seq, { ack: 'receiver' })),
        ...sequences.flatMap((seq) => toSettledStateCommands({ ...sender, index: seq }, 'acknowledged')),
        toGapNackWait({ step: sender, name: 'gap-nack', orderingKey: toOrderingKey(sender), absent: false }),
        toJitterCommand(sender, 'release'),
        toResultAssertion({
            step: sender,
            name: 'assert-jitter-delayed',
            resultName: 'jitter-release',
            field: 'acted.delay',
            operator: 'gte',
            expected: STREAM_SENDS
        })
    ];
}

/** Held on the data frames of the cell's type until its release. A control frame carries another type and passes. */
function toJitterCommand(
    sender: AlmConformanceStepInput,
    phase: 'arm' | 'release'
): RallarBlackBoxTestTransportFaultInjectCommand {
    const typeId = toScenarioTypeId(sender);
    return {
        kind: 'fault.inject',
        commandId: toCommandId(sender, `jitter-${phase}`),
        faultId: `jitter-ws-${typeId}`,
        carrier: 'ws',
        match: { typeId },
        action: JITTER,
        remaining: phase === 'arm' ? 'until-cleared' : 0,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, sender.input.deadlineMs)
    };
}
