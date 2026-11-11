import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import {
    ALVolatileSessionBudget,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionQosProvider } from '@shared/alm/volatile-budget/to-al-volatile-session-qos-provider.ts';

export interface BrowserSessionVolatileBound {
    readonly budget: ALVolatileSessionBudget;
    readonly qosProvider: ALQosInputProvider;
}

export interface CreateBrowserSessionVolatileBoundInput {
    readonly readVolatileSessionLimits: () => ALVolatileSessionLimits;
    readonly qosProvider: ALQosInputProvider;
    readonly nowMs: () => number;
}

export function createBrowserSessionVolatileBound(
    input: CreateBrowserSessionVolatileBoundInput
): BrowserSessionVolatileBound {
    const budget = new ALVolatileSessionBudget(input.readVolatileSessionLimits());
    return {
        budget,
        qosProvider: toALVolatileSessionQosProvider(input.qosProvider, budget, input.nowMs)
    };
}
