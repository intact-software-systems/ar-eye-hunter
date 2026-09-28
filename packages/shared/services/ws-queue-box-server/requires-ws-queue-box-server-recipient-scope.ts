import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALControlMessage } from '../../al-contracts/al-control.ts';

/** Only a fully decoded AL control envelope is exempt from public recipient scope. */
export function requiresWsQueueBoxServerRecipientScope(message: ALMessage): boolean {
    return message.targets?.mode === 'unicast' && decodeALControlMessage(message).right === undefined;
}
