import { ALM_CONFORMANCE_SINGLE_HOP_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toVerdictCommands } from '../../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import {
    toBackpressuredSendCommands,
    toBackpressureHoldWait,
    toBackpressureReleaseCommand,
    toCongestionCounterCommands
} from './congestion-commands.ts';

/**
 * D185: the sender holds its carrier at the watermark for 2 s; the default `drop-low` keeps an at-least-once send
 * (priority 5), whose submission answers `not-ready` until the release, and the send is then acknowledged. The attempt
 * row is overwritten on each retry, so the deferral is read from the counter.
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
        toBackpressureReleaseCommand(sender),
        ...toVerdictCommands(sender, 'acknowledged', [['acknowledged', 'state', 'equals', 'acknowledged']]),
        ...toCongestionCounterCommands(sender, 'deferred')
    ],
    toRecipientCommands: (receiver) => [toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false })]
};
