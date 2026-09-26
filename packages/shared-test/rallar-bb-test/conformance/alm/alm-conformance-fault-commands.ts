import type { RallarBlackBoxTestCommand } from '../../rallar-black-box-test-contracts.ts';

import { toBudgetMs } from './alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from './alm-conformance-carriers.ts';
import type { AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from './alm-conformance-step-identities.ts';

export type AlmConformanceFaultCarrier = 'ws' | 'rtc';

export const FAULT_TIMEOUT_MS = 3_000;

export function toHeldFaultCommands(
    step: AlmConformanceStepInput,
    name: string,
    remaining: 'until-cleared' | 0
): readonly RallarBlackBoxTestCommand[] {
    return toFaultCarriers(step.input.carrier).map((carrier) => ({
        kind: 'fault.inject',
        commandId: toCommandId(step, `${name}-${carrier}`),
        faultId: `hold-${carrier}-${toScenarioTypeId(step)}`,
        carrier,
        match: { typeId: toScenarioTypeId(step) },
        action: carrier === 'ws' ? 'not-ready' : 'drop',
        remaining,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, step.input.deadlineMs)
    }));
}

export function toFaultCarriers(
    carrier: AlmConformanceCarrier
): readonly AlmConformanceFaultCarrier[] {
    return carrier === 'rtc-with-ws-fallback' ? ['rtc', 'ws'] : [carrier];
}
