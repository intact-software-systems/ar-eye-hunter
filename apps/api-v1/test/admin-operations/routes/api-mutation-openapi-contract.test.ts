import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { installApiDocumentationRoutes } from '../../../src/routes/swagger-routes.ts';

interface CoveredApiMutation {
    readonly method: 'delete' | 'post' | 'put';
    readonly path: string;
}

const API_MUTATION_REQUEST_ID_DESCRIPTION = 'Case-sensitive mutation request identity. ' +
    'It must contain 20 to 128 letters, digits, underscores, or hyphens.';
const AUTH_PATH = '/api/auth';
const CLIENT_PATH = '/api/state/apps/{applicationId}/workspaces/{workspaceId}/clients';
const CLIENT_INSTANCE_PATH = `${CLIENT_PATH}/{principalId}/instances/{clientInstanceId}`;
const CLIENT_SESSION_PATH = `${CLIENT_INSTANCE_PATH}/sessions/{sessionId}`;
const GROUP_PATH = '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups';
const GROUP_ITEM_PATH = `${GROUP_PATH}/{groupId}`;
const TOPOLOGY_PATH = `${GROUP_ITEM_PATH}/topology`;
const REQUEST_PATH = '/requests/{requestId}';

const COVERED_API_MUTATIONS: readonly CoveredApiMutation[] = [
    { method: 'post', path: `${AUTH_PATH}/register${REQUEST_PATH}` },
    { method: 'post', path: `${AUTH_PATH}/login${REQUEST_PATH}` },
    { method: 'post', path: `${AUTH_PATH}/logout${REQUEST_PATH}` },
    { method: 'post', path: `${AUTH_PATH}/ws-ticket${REQUEST_PATH}` },
    { method: 'post', path: `${AUTH_PATH}/agent-session-tickets${REQUEST_PATH}` },
    {
        method: 'post',
        path: `${AUTH_PATH}/agent-session-tickets/consume${REQUEST_PATH}`
    },
    {
        method: 'put',
        path: `${CLIENT_PATH}/{principalId}/principal${REQUEST_PATH}`
    },
    { method: 'put', path: `${CLIENT_INSTANCE_PATH}${REQUEST_PATH}` },
    { method: 'put', path: `${CLIENT_SESSION_PATH}${REQUEST_PATH}` },
    { method: 'post', path: `${CLIENT_SESSION_PATH}/heartbeat${REQUEST_PATH}` },
    { method: 'post', path: `${CLIENT_SESSION_PATH}/disconnect${REQUEST_PATH}` },
    { method: 'post', path: `${GROUP_PATH}${REQUEST_PATH}` },
    { method: 'put', path: `${GROUP_ITEM_PATH}${REQUEST_PATH}` },
    {
        method: 'post',
        path: `${GROUP_ITEM_PATH}/director/appoint${REQUEST_PATH}`
    },
    { method: 'post', path: `${GROUP_ITEM_PATH}/lifecycle/plan${REQUEST_PATH}` },
    { method: 'post', path: `${GROUP_ITEM_PATH}/lifecycle/connect${REQUEST_PATH}` },
    { method: 'post', path: `${GROUP_ITEM_PATH}/lifecycle/activate${REQUEST_PATH}` },
    { method: 'post', path: `${GROUP_ITEM_PATH}/lifecycle/reconfigure${REQUEST_PATH}` },
    { method: 'post', path: `${GROUP_ITEM_PATH}/lifecycle/pause${REQUEST_PATH}` },
    { method: 'post', path: `${GROUP_ITEM_PATH}/lifecycle/resume${REQUEST_PATH}` },
    { method: 'post', path: `${GROUP_ITEM_PATH}/lifecycle/reset${REQUEST_PATH}` },
    { method: 'post', path: `${GROUP_ITEM_PATH}/lifecycle/start${REQUEST_PATH}` },
    { method: 'post', path: `${GROUP_ITEM_PATH}/join${REQUEST_PATH}` },
    {
        method: 'post',
        path: `${GROUP_ITEM_PATH}/invites/{principalId}${REQUEST_PATH}`
    },
    {
        method: 'post',
        path: `${GROUP_ITEM_PATH}/invites/{principalId}/revoke${REQUEST_PATH}`
    },
    {
        method: 'post',
        path: `${GROUP_ITEM_PATH}/admissions/{principalId}/grant${REQUEST_PATH}`
    },
    {
        method: 'post',
        path: `${GROUP_ITEM_PATH}/admissions/{principalId}/decline${REQUEST_PATH}`
    },
    { method: 'post', path: `${GROUP_ITEM_PATH}/invites/accept${REQUEST_PATH}` },
    {
        method: 'post',
        path: `${GROUP_ITEM_PATH}/join-code/rotate${REQUEST_PATH}`
    },
    {
        method: 'post',
        path: `${GROUP_ITEM_PATH}/members/{principalId}/remove${REQUEST_PATH}`
    },
    {
        method: 'post',
        path: `${GROUP_ITEM_PATH}/members/{principalId}/ban${REQUEST_PATH}`
    },
    {
        method: 'post',
        path: `${GROUP_ITEM_PATH}/members/{principalId}/unban${REQUEST_PATH}`
    },
    {
        method: 'put',
        path: `${GROUP_ITEM_PATH}/members/{principalId}/role${REQUEST_PATH}`
    },
    { method: 'post', path: `${GROUP_ITEM_PATH}/owner/transfer${REQUEST_PATH}` },
    {
        method: 'put',
        path: `${GROUP_ITEM_PATH}/members/{principalId}${REQUEST_PATH}`
    },
    {
        method: 'put',
        path: `${GROUP_ITEM_PATH}/sessions/{sessionId}${REQUEST_PATH}`
    },
    {
        method: 'post',
        path: `${GROUP_ITEM_PATH}/sessions/{sessionId}/heartbeat${REQUEST_PATH}`
    },
    {
        method: 'post',
        path: `${GROUP_ITEM_PATH}/sessions/{sessionId}/disconnect${REQUEST_PATH}`
    },
    { method: 'put', path: `${TOPOLOGY_PATH}/config${REQUEST_PATH}` },
    { method: 'delete', path: `${TOPOLOGY_PATH}/config${REQUEST_PATH}` },
    { method: 'put', path: `${TOPOLOGY_PATH}/override${REQUEST_PATH}` },
    { method: 'delete', path: `${TOPOLOGY_PATH}/override${REQUEST_PATH}` },
    { method: 'post', path: `${TOPOLOGY_PATH}/reconfigure${REQUEST_PATH}` },
    {
        method: 'post',
        path: `/api/admin/operations/topology/recompute${REQUEST_PATH}`
    },
    {
        method: 'post',
        path: `/api/admin/operations/maintenance/prune-expired${REQUEST_PATH}`
    },
    { method: 'post', path: `/api/admin/operations/crdt/compact${REQUEST_PATH}` },
    {
        method: 'post',
        path: `/api/admin/operations/crdt/lifecycle${REQUEST_PATH}`
    },
    { method: 'post', path: `/api/admin/operations/crdt/erase${REQUEST_PATH}` },
    {
        method: 'post',
        path: `/api/crdt/admin/documents/rebuild-projection${REQUEST_PATH}`
    },
    { method: 'post', path: `/api/crdt/admin/documents/compact${REQUEST_PATH}` },
    {
        method: 'post',
        path: `/api/crdt/admin/documents/lifecycle${REQUEST_PATH}`
    },
    { method: 'post', path: `/api/crdt/admin/documents/erase${REQUEST_PATH}` }
];

Deno.test('OpenAPI publishes the reusable strict API mutation request path parameter', async () => {
    const document = await readOpenApiDocument();
    const parameters = requireObject(
        requireObject(document.components).parameters
    );

    assert.deepEqual(parameters.ApiMutationRequestId, {
        name: 'requestId',
        in: 'path',
        required: true,
        description: API_MUTATION_REQUEST_ID_DESCRIPTION,
        schema: {
            type: 'string',
            minLength: 20,
            maxLength: 128,
            pattern: '^[A-Za-z0-9_-]+$'
        }
    });
    assert.equal(parameters.IdempotencyKey, undefined);
});

const API_REQUEST_TRACE_SCHEMA = {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    pattern: '^[A-Za-z0-9_-]+$'
};
const OPENAPI_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;
const WEBSOCKET_UPGRADE_PATH = '/api/ws/{sessionId}';

Deno.test('OpenAPI publishes the reusable x-request-id trace parameter and its echoed response header', async () => {
    const components = requireObject((await readOpenApiDocument()).components);

    assert.deepEqual(requireObject(components.parameters).XRequestId, {
        name: 'x-request-id',
        in: 'header',
        required: false,
        description: 'Request trace identity. A missing or malformed value is replaced by a minted trace; ' +
            'every API response except a WebSocket upgrade echoes the trace it ran under.',
        schema: API_REQUEST_TRACE_SCHEMA
    });
    assert.deepEqual(requireObject(components.headers).XRequestId, {
        description: 'The trace the request ran under: the valid x-request-id it sent, or the minted replacement.',
        schema: API_REQUEST_TRACE_SCHEMA
    });
});

Deno.test('OpenAPI gives every API operation the x-request-id parameter and every non-upgrade response its echo', async () => {
    const document = await readOpenApiDocument();
    const components = requireObject(document.components);
    const componentResponses = requireObject(components.responses);

    for (const [path, pathItem] of Object.entries(requireObject(document.paths))) {
        for (const method of OPENAPI_METHODS) {
            const operation = optionalObject(requireObject(pathItem)[method]);
            if (!operation || !path.startsWith('/api/')) {
                continue;
            }
            const parameters = operation.parameters === undefined ? [] : requireArray(operation.parameters);
            const traceParameters = parameters.filter((parameter) => isReference(parameter, '#/components/parameters/XRequestId'));
            assert.equal(traceParameters.length, 1, `${method} ${path} x-request-id parameter`);
            for (const [status, responseValue] of Object.entries(requireObject(operation.responses))) {
                const response = resolveResponse(requireObject(responseValue), componentResponses);
                const echo = optionalObject(response.headers)?.['x-request-id'];
                // Only a request without `Upgrade: websocket` reaches the 426; the middleware echoes on it alone.
                if (path === WEBSOCKET_UPGRADE_PATH && status !== '426') {
                    assert.equal(echo, undefined, `${method} ${path} ${status} must not echo on an upgrade`);
                    continue;
                }
                assert.deepEqual(echo, { $ref: '#/components/headers/XRequestId' }, `${method} ${path} ${status}`);
            }
        }
    }
});

Deno.test('OpenAPI request bodies carry no trace: the trace travels only as x-request-id', async () => {
    const document = await readOpenApiDocument();
    const schemas = requireObject(requireObject(document.components).schemas);
    const paths = requireObject(document.paths);

    for (const mutation of COVERED_API_MUTATIONS) {
        const operation = requireObject(requireObject(paths[mutation.path])[mutation.method]);
        const schemaName = readRequestBodySchemaName(operation);
        if (schemaName === undefined) {
            continue;
        }
        assert.equal(
            collectSchemaPropertyNames(schemaName, schemas).has('traceId'),
            false,
            `${mutation.method} ${mutation.path} ${schemaName}`
        );
    }
});

Deno.test('OpenAPI gives all AppInbox REST mutations path-only request identity', async () => {
    const document = await readOpenApiDocument();
    const paths = requireObject(document.paths);
    const schemas = requireObject(requireObject(document.components).schemas);

    for (const mutation of COVERED_API_MUTATIONS) {
        const operation = requireObject(
            requireObject(paths[mutation.path])[mutation.method]
        );
        const parameters = requireArray(operation.parameters);
        const requestIdentityParameters = parameters.filter((parameter) => isReference(parameter, '#/components/parameters/ApiMutationRequestId'));

        assert.equal(
            requestIdentityParameters.length,
            1,
            `${mutation.method} ${mutation.path}`
        );
        assert.equal(
            parameters.some((parameter) =>
                isReference(parameter, '#/components/parameters/IdempotencyKey') ||
                isIdempotencyHeader(parameter)
            ),
            false,
            `${mutation.method} ${mutation.path}`
        );
        assertSemanticBodyOmitsRequestId(operation, schemas, mutation);

        const oldPath = mutation.path.slice(0, -REQUEST_PATH.length);
        assert.equal(
            optionalObject(paths[oldPath])?.[mutation.method],
            undefined,
            `${mutation.method} ${oldPath} must be removed`
        );
    }
});

Deno.test('OpenAPI gives every covered mutation the canonical failure envelope', async () => {
    const document = await readOpenApiDocument();
    const paths = requireObject(document.paths);
    const components = requireObject(document.components);
    const responses = requireObject(components.responses);
    const schemas = requireObject(components.schemas);
    const failureSchema = requireObject(schemas.ApiMutationFailure);

    assert.deepEqual(requireArray(failureSchema.required), [
        'type',
        'version',
        'code',
        'status',
        'message',
        'issues',
        'denial',
        'retry'
    ]);
    for (const mutation of COVERED_API_MUTATIONS) {
        const operation = requireObject(
            requireObject(paths[mutation.path])[mutation.method]
        );
        const operationResponses = requireObject(operation.responses);
        for (const [status, responseValue] of Object.entries(operationResponses)) {
            if (!/^[45]\d\d$/.test(status)) {
                continue;
            }
            const responseReference = requireString(
                requireObject(responseValue).$ref,
                `${mutation.method} ${mutation.path} ${status}`
            );
            const responseName = responseReference.replace(
                '#/components/responses/',
                ''
            );
            const response = requireObject(responses[responseName]);
            const content = requireObject(response.content);
            const mediaType = requireObject(content['application/json']);
            assert.equal(
                requireObject(mediaType.schema).$ref,
                '#/components/schemas/ApiMutationFailure',
                `${mutation.method} ${mutation.path} ${status}`
            );
            if (status === '429') {
                assert.equal(
                    requireObject(requireObject(response.headers)['Retry-After'])
                        .description,
                    'Seconds to wait before retrying the rate-limited request.',
                    `${mutation.method} ${mutation.path} ${status}`
                );
            }
        }
    }
});

async function readOpenApiDocument(): Promise<JsonWireObject> {
    const response = await installApiDocumentationRoutes(new Hono()).request(
        '/api/openapi.json'
    );
    return requireObject(
        decodeJsonWireValue(await response.json(), 'OpenAPI response')
    );
}

function assertSemanticBodyOmitsRequestId(
    operation: JsonWireObject,
    schemas: JsonWireObject,
    mutation: CoveredApiMutation
): void {
    const requestBody = optionalObject(operation.requestBody);
    if (!requestBody) {
        return;
    }
    const content = requireObject(requestBody.content);
    const mediaType = requireObject(content['application/json']);
    const schema = requireObject(mediaType.schema);
    const reference = requireString(schema.$ref);
    const schemaName = reference.replace('#/components/schemas/', '');
    const semanticSchema = requireObject(schemas[schemaName]);
    const properties = optionalObject(semanticSchema.properties);
    const required = semanticSchema.required === undefined
        ? []
        : requireArray(semanticSchema.required);

    assert.equal(
        properties?.requestId,
        undefined,
        `${mutation.method} ${mutation.path}`
    );
    assert.equal(
        required.includes('requestId'),
        false,
        `${mutation.method} ${mutation.path}`
    );
}

function resolveResponse(response: JsonWireObject, componentResponses: JsonWireObject): JsonWireObject {
    const reference = response.$ref;
    return typeof reference === 'string'
        ? requireObject(componentResponses[reference.replace('#/components/responses/', '')])
        : response;
}

function readRequestBodySchemaName(operation: JsonWireObject): string | undefined {
    const requestBody = optionalObject(operation.requestBody);
    if (!requestBody) {
        return undefined;
    }
    const mediaType = requireObject(requireObject(requestBody.content)['application/json']);
    return requireString(requireObject(mediaType.schema).$ref).replace('#/components/schemas/', '');
}

function collectSchemaPropertyNames(schemaName: string, schemas: JsonWireObject): ReadonlySet<string> {
    const schema = requireObject(schemas[schemaName]);
    const names = new Set(Object.keys(optionalObject(schema.properties) ?? {}));
    for (const part of schema.allOf === undefined ? [] : requireArray(schema.allOf)) {
        const reference = optionalObject(part)?.$ref;
        const partNames = typeof reference === 'string'
            ? collectSchemaPropertyNames(reference.replace('#/components/schemas/', ''), schemas)
            : new Set(Object.keys(optionalObject(requireObject(part).properties) ?? {}));
        partNames.forEach((name) => names.add(name));
    }
    return names;
}

function isReference(value: JsonWireValue, reference: string): boolean {
    return optionalObject(value)?.$ref === reference;
}

function isIdempotencyHeader(value: JsonWireValue): boolean {
    const parameter = optionalObject(value);
    return parameter?.in === 'header' && parameter.name === 'Idempotency-Key';
}

function requireObject(value: JsonWireValue | undefined): JsonWireObject {
    const object = optionalObject(value);
    if (!object) {
        throw new TypeError('Expected an OpenAPI object');
    }
    return object;
}

function optionalObject(
    value: JsonWireValue | undefined
): JsonWireObject | undefined {
    return value !== undefined && isJsonWireObject(value) ? value : undefined;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireArray(
    value: JsonWireValue | undefined
): readonly JsonWireValue[] {
    if (!Array.isArray(value)) {
        throw new TypeError('Expected an OpenAPI array');
    }
    return value;
}

function requireString(
    value: JsonWireValue | undefined,
    context = 'OpenAPI value'
): string {
    if (typeof value !== 'string') {
        throw new TypeError(`Expected an OpenAPI string for ${context}`);
    }
    return value;
}
