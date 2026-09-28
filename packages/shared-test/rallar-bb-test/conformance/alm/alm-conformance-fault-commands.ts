import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestFaultInjectCommand
} from '../../rallar-black-box-test-contracts.ts';

import { toBudgetMs } from './alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from './alm-conformance-carriers.ts';
import type { AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from './alm-conformance-step-identities.ts';

export type AlmConformanceFaultCarrier = 'ws' | 'rtc';

export const FAULT_TIMEOUT_MS = 3_000;

interface AlmConformanceFaultCommandInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** Prefixes the scenario's type id: one fault id per carrier and purpose. */
    readonly faultName: string;
    readonly carrier: AlmConformanceFaultCarrier;
    readonly action: 'drop' | 'not-ready';
    readonly remaining: 'until-cleared' | 0;
}

export function toHeldFaultCommands(
    step: AlmConformanceStepInput,
    name: string,
    remaining: 'until-cleared' | 0
): readonly RallarBlackBoxTestCommand[] {
    return toFaultCarriers(step.input.carrier).map((carrier) =>
        toFaultCommand({
            step,
            name: `${name}-${carrier}`,
            faultName: `hold-${carrier}`,
            carrier,
            action: carrier === 'ws' ? 'not-ready' : 'drop',
            remaining
        })
    );
}

/**
 * Drops every RTC frame of the scenario's type this page sends: each attempt settles `not-ready` and its
 * owner resubmits it 50 ms later, so a hold yields the consecutive run D56 hands to WS.
 */
export function toRtcDropFaultCommand(
    step: AlmConformanceStepInput,
    name: string,
    remaining: 'until-cleared' | 0
): RallarBlackBoxTestCommand {
    return toFaultCommand({
        step,
        name,
        faultName: 'drop-rtc',
        carrier: 'rtc',
        action: 'drop',
        remaining
    });
}

function toFaultCommand(
    input: AlmConformanceFaultCommandInput
): RallarBlackBoxTestFaultInjectCommand {
    const typeId = toScenarioTypeId(input.step);
    return {
        kind: 'fault.inject',
        commandId: toCommandId(input.step, input.name),
        faultId: `${input.faultName}-${typeId}`,
        carrier: input.carrier,
        match: { typeId },
        action: input.action,
        remaining: input.remaining,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, input.step.input.deadlineMs)
    };
}

export function toFaultCarriers(
    carrier: AlmConformanceCarrier
): readonly AlmConformanceFaultCarrier[] {
    return carrier === 'rtc-with-ws-fallback' ? ['rtc', 'ws'] : [carrier];
}
