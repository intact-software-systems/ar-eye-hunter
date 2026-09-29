import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    ALVolatileSessionBudget,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionQosProvider } from '@shared/alm/volatile-budget/to-al-volatile-session-qos-provider.ts';

export interface BrowserSessionVolatileBound {
    readonly budget: ALVolatileSessionBudget;
    readonly qosProvider: ALQosInputProvider;
}

export interface CreateBrowserSessionVolatileBoundInput {
    readonly readVolatileSessionLimits: (() => ALVolatileSessionLimits) | undefined;
    readonly qosProvider: ALQosInputProvider | undefined;
    readonly nowMs: () => number;
}

export function createBrowserSessionVolatileBound(
    input: CreateBrowserSessionVolatileBoundInput
): BrowserSessionVolatileBound {
    const budget = new ALVolatileSessionBudget(
        input.readVolatileSessionLimits?.() ?? {
            maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
            maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
        }
    );
    return {
        budget,
        qosProvider: toALVolatileSessionQosProvider(input.qosProvider, budget, input.nowMs)
    };
}
