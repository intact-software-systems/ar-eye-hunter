import { serializeCanonicalMutationCommand, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import { decodeAppInboxEnqueue } from './app-inbox-command-decoding.ts';
import type { AppInboxEnqueueInput } from './app-inbox-contracts.ts';

export function toJsonWireAppInboxEnqueue<Command, Authority>(
    enqueue: AppInboxEnqueueInput<Command, Authority>
): AppInboxEnqueueInput<JsonWireValue, JsonWireValue> {
    return decodeAppInboxEnqueue(enqueue);
}

export function serializeCanonicalJsonWire(value: JsonWireValue): string {
    return serializeCanonicalMutationCommand(value);
}
