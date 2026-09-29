import type { ALQosInputProvider } from '../../al-contracts/al-policy.ts';
import type { ALVolatileSessionBudget } from './al-volatile-session-budget.ts';

/**
 * The application's provider with `overloaded` set while the session's volatile budget is at or over a limit
 * (D78, C13); every other answer is the application's own. Under default QoS only best-effort traffic reads it.
 */
export function toALVolatileSessionQosProvider(
    provider: ALQosInputProvider | undefined,
    budget: ALVolatileSessionBudget,
    nowMs: () => number
): ALQosInputProvider {
    return {
        defaultsForMessage: (msg, context) => provider?.defaultsForMessage?.(msg, context),
        capabilitiesForMessage: (msg, context) => provider?.capabilitiesForMessage?.(msg, context),
        authorizationForMessage: (msg, context) => provider?.authorizationForMessage?.(msg, context),
        liveForMessage: (msg, context) => {
            const live = provider?.liveForMessage?.(msg, context);
            return budget.isOverloaded(nowMs()) ? { ...live, overloaded: true } : live;
        }
    };
}
