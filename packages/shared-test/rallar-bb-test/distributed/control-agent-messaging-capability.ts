import type { RallarBlackBoxControlAgentMessagingCapability } from '../distributed-run.ts';
import type { RallarBlackBoxTestMessagesCarrier, RallarBlackBoxTestRecord } from '../types.ts';

const CONTROL_AGENT_MESSAGES_CARRIERS: readonly RallarBlackBoxTestMessagesCarrier[] = [
    'ws',
    'rtc',
    'rtc-with-ws-fallback'
];

export const CONTROL_AGENT_MESSAGING_CAPABILITY: RallarBlackBoxControlAgentMessagingCapability = {
    supported: true,
    carriers: CONTROL_AGENT_MESSAGES_CARRIERS,
    faults: true,
    storageCounters: true,
    reload: true
};

export function decodeControlAgentMessagingCapability(
    value: unknown
): RallarBlackBoxControlAgentMessagingCapability | undefined {
    if (!isMessagingCapabilityRecord(value)) {
        return undefined;
    }
    if (
        typeof value.supported !== 'boolean' ||
        typeof value.faults !== 'boolean' ||
        typeof value.storageCounters !== 'boolean' ||
        typeof value.reload !== 'boolean'
    ) {
        return undefined;
    }
    if (!Array.isArray(value.carriers) || !value.carriers.every(isMessagesCarrier)) {
        return undefined;
    }

    return {
        supported: value.supported,
        carriers: value.carriers,
        faults: value.faults,
        storageCounters: value.storageCounters,
        reload: value.reload
    };
}

function isMessagingCapabilityRecord(value: unknown): value is RallarBlackBoxTestRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMessagesCarrier(value: unknown): value is RallarBlackBoxTestMessagesCarrier {
    return typeof value === 'string' &&
        CONTROL_AGENT_MESSAGES_CARRIERS.includes(value as RallarBlackBoxTestMessagesCarrier);
}
