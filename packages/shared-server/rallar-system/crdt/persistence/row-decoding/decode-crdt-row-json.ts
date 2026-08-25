import {
    decodeJsonWireValue,
    type JsonWireValue
} from '../../../protocol/json-wire-identity.ts';

export function decodeCrdtRowJson(value: string, label: string): JsonWireValue {
    try {
        return decodeJsonWireValue(JSON.parse(value), label);
    }
    catch {
        throw new TypeError(`${label} is corrupt`);
    }
}
