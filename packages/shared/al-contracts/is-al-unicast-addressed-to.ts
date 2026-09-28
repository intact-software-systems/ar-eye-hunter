import type { ALMessage } from './al-contract.ts';

/** Whether the message is a unicast to exactly this peer; the server tests its own id with it (D57 as applied). */
export function isALUnicastAddressedTo(message: ALMessage, peerId: string): boolean {
    return message.targets?.mode === 'unicast' && message.targets.toPeerId === peerId;
}
