import { decodeJsonWireValue, type JsonWireValue } from '../protocol/json-wire-identity.ts';

export function decodeNullAppInboxCommand(value: JsonWireValue): null {
    if (value !== null) {
        throw new TypeError('AppInbox command data must be null');
    }
    return null;
}

export function encodeAppInboxResult<Result>(
    result: Result,
    label: string
): JsonWireValue {
    return decodeJsonWireValue(result, label);
}
