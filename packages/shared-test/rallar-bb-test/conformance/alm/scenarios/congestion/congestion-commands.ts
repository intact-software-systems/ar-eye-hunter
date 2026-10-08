import type { ALCongestionCounters } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import { ALM_OUTBOUND_DIAGNOSTICS_TOPIC, toSentMsgIdReference } from '../../alm-conformance-diagnostic-waits.ts';
import { toBackpressureFaultCommand } from '../../alm-conformance-fault-commands.ts';
import { toResultAssertion, toSendCommand } from '../../alm-conformance-message-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toStatsCommand } from '../../alm-conformance-session-commands.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';

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

/**
 * The page's `defer` of the at-least-once send (D186, priority 5): a submission met the held carrier. The send is held
 * at its carrier and retried on the runtime's drain cadence until the release, so the release waits for this
 * deferral, whatever readiness check answered the submissions before it.
 */
export function toBackpressureDeferralWait(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    const msgId = toSentMsgIdReference({ ...sender, index: 1 });
    return {
        kind: 'wait',
        commandId: toCommandId(sender, 'deferral-1'),
        match: {
            kind: 'diagnostic',
            topic: ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
            payloadPath: 'data',
            contains: `"cause":"backpressured","action":"defer","priority":5,"msgId":"${msgId}"`
        },
        timeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
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
