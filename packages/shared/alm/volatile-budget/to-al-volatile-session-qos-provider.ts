import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { isALControlTypeId } from '../../al-contracts/al-control-type-ids.ts';
import type { ALQosInputProvider, ALQosMessageContext } from '../../al-contracts/al-policy.ts';
import type { ALVolatileSessionBudget } from './al-volatile-session-budget.ts';

/**
 * Only outbound data this session originates reads `overloaded`: a control, a relay forward or an inbound plan
 * that read it would stop this session acknowledging, forwarding and delivering for other sessions at its bound.
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
            return isALSessionDataOrigination(msg, context) && budget.isOverloaded(nowMs())
                ? { ...live, overloaded: true }
                : live;
        }
    };
}

function isALSessionDataOrigination(msg: ALMessage, context: ALQosMessageContext): boolean {
    return context.direction === 'outbound' && context.fromPeerId === undefined &&
        !isALControlTypeId(msg.payload.typeId);
}
