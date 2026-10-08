import type { ALCongestionCounters } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import { toBackpressureFaultCommand } from '../../alm-conformance-fault-commands.ts';
import { toResultAssertion, toSendCommand } from '../../alm-conformance-message-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toStatsCommand } from '../../alm-conformance-session-commands.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';

/** About forty `not-ready` submissions, each retried 50 ms after the last. */
const BACKPRESSURE_HOLD_MS = 2_000;
const BACKPRESSURE_HOLD_TOPIC = 'rallar.black-box.alm.backpressure-held';

const COUNTER_NAMES: Readonly<Record<keyof ALCongestionCounters, string>> = {
    dropped: 'dropped',
    deferred: 'deferred',
    handedOver: 'handed-over'
};

/**
 * The cell's carrier held at its watermark, then one send of its type. A best-effort send has priority 0 and an
 * at-least-once send 5; the harness's channel purposes default to at-least-once, so the send states its reliability.
 */
export function toBackpressuredSendCommands(
    sender: AlmConformanceStepInput,
    reliability: 'best-effort' | 'at-least-once'
): readonly RallarBlackBoxTestCommand[] {
    return [
        toBackpressureFaultCommand(sender, 'hold-backpressure', 'until-cleared'),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: {
                ack: 'receiver',
                reliability,
                ttlMs: NON_EXPIRING_TTL_MS,
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        })
    ];
}

/** Holds the whole window: nothing emits the topic, so it only keeps the carrier at its watermark for that long. */
export function toBackpressureHoldWait(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(sender, 'backpressure-held'),
        match: { kind: 'diagnostic', topic: BACKPRESSURE_HOLD_TOPIC },
        absent: true,
        timeoutMs: BACKPRESSURE_HOLD_MS
    };
}

export function toBackpressureReleaseCommand(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return toBackpressureFaultCommand(sender, 'release-backpressure', 0);
}

/**
 * The page's own count of the decision (D186), read after the verdict. The two-agent family runs these cells after its
 * others, none of which raises a congestion counter, so a count above zero is this cell's.
 */
export function toCongestionCounterCommands(
    sender: AlmConformanceStepInput,
    counter: keyof ALCongestionCounters
): readonly RallarBlackBoxTestCommand[] {
    return [
        toStatsCommand(sender, 'stats-congestion'),
        toResultAssertion({
            step: sender,
            name: `assert-congestion-${COUNTER_NAMES[counter]}`,
            resultName: 'stats-congestion',
            field: `rallar.congestion.${counter}`,
            operator: 'gt',
            expected: 0
        })
    ];
}
