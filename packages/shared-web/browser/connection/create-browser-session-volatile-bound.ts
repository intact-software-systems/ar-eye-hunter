import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    ALVolatileSessionBudget,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionQosProvider } from '@shared/alm/volatile-budget/to-al-volatile-session-qos-provider.ts';

/** What one session's transports share: the budget its three memory pairs count against, and its QoS provider. */
export interface BrowserSessionVolatileBound {
    readonly budget: ALVolatileSessionBudget;
    /** The application's provider with the budget's `overloaded` (C13); both carriers plan with it. */
    readonly qosProvider: ALQosInputProvider;
}

export interface CreateBrowserSessionVolatileBoundInput {
    /** The composition's limit reader, read once here; `undefined` keeps D74's two constants. */
    readonly readVolatileSessionLimits: (() => ALVolatileSessionLimits) | undefined;
    /** The application's provider the session's provider wraps. */
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
