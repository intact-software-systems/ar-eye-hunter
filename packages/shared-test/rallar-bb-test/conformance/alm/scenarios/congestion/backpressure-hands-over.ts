import { ASSERT_TIMEOUT_MS, toBudgetMs } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_FALLBACK_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toVerdictCommands, type AlmConformanceVerdictFact } from '../../alm-conformance-message-commands.ts';
import { toAdmissionOutcomeWait, toSingleArrivalReceiverCommands } from '../../alm-conformance-receiver-commands.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import {
    toBackpressuredSendCommands,
    toBackpressureReleaseCommand,
    toCongestionCounterCommands
} from './congestion-commands.ts';

/**
 * A refusal at admission is the refused leg's evidence row, not a hand-over of an admitted message: the RTC row reads
 * `refused` with its reason before the WS row, and no `carrierFallback` is written.
 */
const HANDED_OVER_FACTS: readonly AlmConformanceVerdictFact[] = [
    ['acknowledged', 'state', 'equals', 'acknowledged'],
    ['rtc-refused', 'attemptOutcomes.0', 'equals', 'refused'],
    ['ws-sent', 'attemptOutcomes.1', 'equals', 'sent'],
    ['rtc-leg', 'attemptCarriers.0', 'equals', 'rtc'],
    ['ws-leg', 'attemptCarriers.1', 'equals', 'ws'],
    ['congested', 'attemptRefusalReasons.0', 'equals', 'congested']
];

/**
 * D185: the sender holds its RTC leg at the watermark, so the RTC origin plans its best-effort send backpressured and
 * the default `drop-low` refuses it `congested`; the strategy hands it to WS at admission, the send is acknowledged,
 * and the receiver delivers the one copy WS carries.
 */
export const backpressureHandsOver: AlmConformanceScenarioDefinition = {
    scenarioId: 'backpressure-hands-over',
    scenarioKey: 'backpressure-hands-over',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_FALLBACK_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: (sender) => [
        ...toBackpressuredSendCommands(sender, 'best-effort'),
        ...toVerdictCommands(sender, 'acknowledged', HANDED_OVER_FACTS),
        ...toCongestionCounterCommands(sender, 'handedOver'),
        toBackpressureReleaseCommand(sender)
    ],
    toRecipientCommands: (receiver) => [
        ...toSingleArrivalReceiverCommands(receiver),
        toAdmissionOutcomeWait(receiver, {
            name: 'ws-arrival',
            contains: '"carrier":"ws","outcome":"committed","reason":"admitted"',
            timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, receiver.input.deadlineMs)
        })
    ]
};
