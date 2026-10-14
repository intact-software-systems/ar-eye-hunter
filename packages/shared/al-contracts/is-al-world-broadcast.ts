import type { ALMessage } from './al-contract.ts';

export function isALWorldBroadcast(message: ALMessage): boolean {
    return message.targets?.mode === 'broadcast' && message.targets.scope === 'world';
}
