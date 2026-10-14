import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { toVerdictCommands, type AlmConformanceVerdictFact } from '../../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import {
    toBackpressuredSendCommands,
    toBackpressureReleaseCommand,
    toCongestionCounterCommands
} from './congestion-commands.ts';

/** Only a strategy with no second carrier ends a congested send at its refusal. */
const REFUSED_CARRIERS: readonly AlmConformanceCarrier[] = ['rtc'];

const CONGESTED_REFUSAL_FACTS: readonly AlmConformanceVerdictFact[] = [
    ['refused', 'failure.kind', 'equals', 'refused'],
    ['congested', 'failure.reason', 'equals', 'congested'],
    ['no-attempt', 'attempts', 'equals', 0]
];

/**
 * D185: the sender holds RTC at the watermark, so the RTC origin plans its best-effort send backpressured and the
 * default `drop-low` refuses it: the handle ends `rejected` with `refused`/`congested` and no carrier attempt, and the
 * receiver receives nothing.
 */
export const backpressureRefused: AlmConformanceScenarioDefinition = {
    scenarioId: 'backpressure-refused',
    scenarioKey: 'backpressure-refused',
    tags: FULL_TAGS,
    carriers: REFUSED_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: (sender) => [
        ...toBackpressuredSendCommands(sender, 'best-effort'),
        ...toVerdictCommands(sender, 'rejected', CONGESTED_REFUSAL_FACTS),
        ...toCongestionCounterCommands(sender, 'dropped'),
        toBackpressureReleaseCommand(sender)
    ],
    toRecipientCommands: (receiver) => [toReceivedCommand({ ...receiver, index: 1, count: 1, absent: true })]
};
