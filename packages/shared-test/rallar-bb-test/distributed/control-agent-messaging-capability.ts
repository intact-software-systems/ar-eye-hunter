import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxControlAgentMessagingCapability } from '../distributed-run.ts';
import type { RallarBlackBoxTestMessagesCarrier } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

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
): Either<string, RallarBlackBoxControlAgentMessagingCapability> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('capabilities.messaging must be a JSON object');
    }
    if (
        typeof value.supported !== 'boolean' ||
        typeof value.faults !== 'boolean' ||
        typeof value.storageCounters !== 'boolean' ||
        typeof value.reload !== 'boolean'
    ) {
        return Either.ofLeft('capabilities.messaging must report supported, faults, storageCounters and reload');
    }
    if (!Array.isArray(value.carriers) || !value.carriers.every(isMessagesCarrier)) {
        return Either.ofLeft('capabilities.messaging.carriers must list known message carriers');
    }

    return Either.ofRight({
        supported: value.supported,
        carriers: value.carriers,
        faults: value.faults,
        storageCounters: value.storageCounters,
        reload: value.reload
    });
}

function isMessagesCarrier(value: unknown): value is RallarBlackBoxTestMessagesCarrier {
    return typeof value === 'string' && CONTROL_AGENT_MESSAGES_CARRIERS.some((carrier) => carrier === value);
}
