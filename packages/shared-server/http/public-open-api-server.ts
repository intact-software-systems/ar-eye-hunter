import { type JsonWireObject, type JsonWireValue } from '../rallar-system/protocol/json-wire-identity.ts';
import { resolvePublicServerUrl } from './resolve-public-server-url.ts';

export function decodeOpenApiDocument(
    value: JsonWireValue,
    label = 'OpenAPI document'
): JsonWireObject {
    if (!isJsonWireObject(value)) {
        throw new TypeError(`${label} must decode to an object.`);
    }
    return value;
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
