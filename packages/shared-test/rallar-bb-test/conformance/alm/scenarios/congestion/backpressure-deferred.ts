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
    toBackpressuredSendCommands,
    toBackpressureHoldWait,
    toBackpressureReleaseCommand,
    toCongestionCounterCommands
} from './congestion-commands.ts';

const DEFERRED_THEN_SENT_FACTS: readonly AlmConformanceVerdictFact[] = [
    ['acknowledged', 'state', 'equals', 'acknowledged'],
    ['sent-only', 'attemptOutcomes.0', 'equals', 'sent'],
    ['one-row', 'attemptOutcomes', 'length', 1]
];

/**
 * D185: the sender holds its carrier at the watermark for 2 s; the default `drop-low` keeps an at-least-once send
 * (priority 5), whose submission answers `not-ready` until the release. The send reads unacknowledged while held, then
 * acknowledged. The attempt row is overwritten on each retry, so the final rows show only `sent` and the deferral is
 * read from the counter.
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
        toBackpressureHoldWait(sender),
        toReceiptsCommand({ ...sender, index: 1 }),
        toResultAssertion({
            step: sender,
            name: 'assert-unacknowledged-held',
            resultName: 'receipts-1',
            field: 'state',
            operator: 'notEquals',
            expected: 'acknowledged'
        }),
        toBackpressureReleaseCommand(sender),
        ...toVerdictCommands(sender, 'acknowledged', DEFERRED_THEN_SENT_FACTS),
        ...toCongestionCounterCommands(sender, 'deferred')
    ],
    toRecipientCommands: (receiver) => [toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false })]
};
