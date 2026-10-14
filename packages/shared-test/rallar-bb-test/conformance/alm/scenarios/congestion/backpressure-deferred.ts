import { ALM_CONFORMANCE_SINGLE_HOP_CARRIERS } from '../../alm-conformance-carriers.ts';
import {
    toReceiptsCommand,
    toResultAssertion,
    toVerdictCommands,
    type AlmConformanceVerdictFact
} from '../../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import {
    toBackpressureDeferralWait,
    toBackpressuredSendCommands,
    toBackpressureReleaseCommand,
    toCongestionCounterCommands
} from './congestion-commands.ts';

const DEFERRED_THEN_SENT_FACTS: readonly AlmConformanceVerdictFact[] = [
    ['acknowledged', 'state', 'equals', 'acknowledged'],
    ['sent-only', 'attemptOutcomes.0', 'equals', 'sent'],
    ['every-row-sent', 'attemptOutcomes', 'matches', '^sent$']
];

/**
 * D185: the sender holds its carrier at the watermark; the default `drop-low` keeps an at-least-once send (priority 5),
 * whose submissions answer `not-ready` until the release. Once the page wrote the send's `defer`, the send reads
 * unsubmitted and the hold is released. Each retry overwrites the attempt rows, one per next hop of the carrier, so
 * every row then reads `sent` and the deferral is read from the counter.
 */
export const backpressureDeferred: AlmConformanceScenarioDefinition = {
    scenarioId: 'backpressure-deferred',
    scenarioKey: 'backpressure-deferred',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_SINGLE_HOP_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: (sender) => [
        ...toBackpressuredSendCommands(sender, 'at-least-once'),
        toBackpressureDeferralWait(sender),
        toReceiptsCommand({ ...sender, index: 1 }),
        toResultAssertion({
            step: sender,
            name: 'assert-unsubmitted-held',
            resultName: 'receipts-1',
            field: 'submitted',
            operator: 'equals',
            expected: false
        }),
        toBackpressureReleaseCommand(sender),
        ...toVerdictCommands(sender, 'acknowledged', DEFERRED_THEN_SENT_FACTS),
        ...toCongestionCounterCommands(sender, 'deferred')
    ],
    toRecipientCommands: (receiver) => [toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false })]
};
