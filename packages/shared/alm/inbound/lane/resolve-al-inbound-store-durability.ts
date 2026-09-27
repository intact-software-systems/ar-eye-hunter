import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { normalizeALQosPolicy, shouldPersistInbox } from '../../../al-contracts/al-policy.ts';

export type ALStoreDurability = 'volatile' | 'durable';

/**
 * The sending channel's declared durability, carried as the envelope's `qos.durability`, decides the
 * inbound store: only `local-inbox` keeps the receiver's copy. No receiver-side policy moves it.
 */
export function resolveALInboundStoreDurability(msg: ALMessage): ALStoreDurability {
    return shouldPersistInbox(normalizeALQosPolicy(msg).effective) ? 'durable' : 'volatile';
}
