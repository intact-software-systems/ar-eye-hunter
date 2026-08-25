import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '../rallar-system/protocol/json-wire-identity.ts';
import { resolvePublicServerUrl } from './public-server-url.ts';

export function decodeOpenApiDocument(
    value: unknown,
    label = 'OpenAPI document'
): JsonWireObject {
    const document = decodeJsonWireValue(value, label);
    if (!isJsonWireObject(document)) {
        throw new TypeError(`${label} must decode to an object.`);
    }
    return document;
}

export function withPublicOpenApiServer(
    document: JsonWireObject,
    request: Request,
    description: string
): JsonWireObject {
    return {
        ...document,
        servers: [
            {
                url: resolvePublicServerUrl(request),
                description
            }
        ]
    };
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
