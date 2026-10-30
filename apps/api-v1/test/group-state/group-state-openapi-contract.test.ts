import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { installApiDocumentationRoutes } from '../../src/routes/swagger-routes.ts';

interface OpenApiSchema {
    readonly $ref?: string;
    readonly type?: string;
    readonly items?: { readonly $ref?: string; };
    readonly enum?: readonly string[];
    readonly default?: string | number;
    readonly minimum?: number;
    readonly maximum?: number;
    readonly additionalProperties?: boolean;
    readonly oneOf?: readonly OpenApiSchema[];
    readonly nullable?: boolean;
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, OpenApiSchema>>;
}

interface OpenApiOperation {
    readonly parameters?: readonly { readonly name?: string; readonly schema?: OpenApiSchema; }[];
    readonly security?: readonly Record<string, readonly string[]>[];
    readonly requestBody?: {
        readonly content?: {
            readonly 'application/json'?: { readonly schema?: OpenApiSchema; };
        };
    };
    readonly responses?: Readonly<
        Record<string, {
            readonly content?: {
                readonly 'application/json'?: { readonly schema?: OpenApiSchema; };
            };
        }>
    >;
}

interface OpenApiDocument {
    readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
    readonly components: { readonly schemas: Readonly<Record<string, OpenApiSchema>>; };
}

interface GroupResponseSchemaContract {
    readonly reference?: string;
    readonly arrayItemReference?: string;
}

interface GroupOperationContract {
    readonly path: string;
    readonly method: 'get' | 'post' | 'put';
    readonly requestSchema?: string;
    readonly status: '200' | '201';
    readonly responseSchema: GroupResponseSchemaContract;
}

const GROUP_PATH = '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups';
const GROUP_ID_PATH = `${GROUP_PATH}/{groupId}`;
const GROUP_OPERATION_CONTRACTS: readonly GroupOperationContract[] = [
    {
        path: `${GROUP_PATH}/quick-join`,
        method: 'post',
        requestSchema: 'QuickJoinGroupRequest',
        status: '200',
        responseSchema: { reference: 'QuickJoinGroupResult' }
    },
    {
        path: GROUP_PATH,
        method: 'get',
        status: '200',
        responseSchema: { arrayItemReference: 'GroupSnapshot' }
    },
    {
        path: GROUP_PATH,
        method: 'post',
        requestSchema: 'CreateGroupRequest',
        status: '201',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: GROUP_ID_PATH,
        method: 'get',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: GROUP_ID_PATH,
        method: 'put',
        requestSchema: 'UpdateGroupRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/events`,
        method: 'get',
        status: '200',
        responseSchema: { arrayItemReference: 'GroupEvent' }
    },
    {
        path: `${GROUP_ID_PATH}/events/page`,
        method: 'get',
        status: '200',
        responseSchema: { reference: 'GroupEventPage' }
    },
    {
        path: `${GROUP_ID_PATH}/director/appoint`,
        method: 'post',
        requestSchema: 'AppointGroupDirectorRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/join`,
        method: 'post',
        requestSchema: 'JoinGroupRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/invites/accept`,
        method: 'post',
        requestSchema: 'AcceptGroupInviteRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/join-code/rotate`,
        method: 'post',
        requestSchema: 'RotateGroupJoinCodeRequest',
        status: '200',
        responseSchema: { reference: 'GroupJoinCodeResponse' }
    },
    {
        path: `${GROUP_ID_PATH}/invites/{principalId}`,
        method: 'post',
        requestSchema: 'CreateGroupInviteRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/invites/{principalId}/revoke`,
        method: 'post',
        requestSchema: 'RevokeGroupInviteRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/members/{principalId}/remove`,
        method: 'post',
        requestSchema: 'RemoveGroupMemberRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/members/{principalId}/ban`,
        method: 'post',
        requestSchema: 'BanGroupMemberRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/members/{principalId}/unban`,
        method: 'post',
        requestSchema: 'UnbanGroupMemberRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/members/{principalId}/role`,
        method: 'put',
        requestSchema: 'SetGroupMemberRoleRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/publication-grants/{principalId}/grant`,
        method: 'post',
        requestSchema: 'GrantGroupPublicationRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/publication-grants/{principalId}/revoke`,
        method: 'post',
        requestSchema: 'RevokeGroupPublicationRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/owner/transfer`,
        method: 'post',
        requestSchema: 'TransferGroupOwnershipRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/members/{principalId}`,
        method: 'put',
        requestSchema: 'SelfUpsertGroupMemberRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/sessions/{sessionId}`,
        method: 'put',
        requestSchema: 'ConnectGroupPresenceSessionRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/sessions/{sessionId}/heartbeat`,
        method: 'post',
        requestSchema: 'HeartbeatGroupPresenceSessionRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/sessions/{sessionId}/disconnect`,
        method: 'post',
        requestSchema: 'DisconnectGroupPresenceSessionRequest',
        status: '200',
        responseSchema: { reference: 'GroupSnapshot' }
    },
    {
        path: `${GROUP_ID_PATH}/sessions/{sessionId}/subscribe`,
        method: 'post',
        requestSchema: 'SubscribeGroupTopicRequest',
        status: '200',
        responseSchema: { reference: 'GroupTopicSubscriptionResult' }
    },
    {
        path: `${GROUP_ID_PATH}/sessions/{sessionId}/unsubscribe`,
        method: 'post',
        requestSchema: 'UnsubscribeGroupTopicRequest',
        status: '200',
        responseSchema: { reference: 'GroupTopicSubscriptionResult' }
    },
    {
        path: `${GROUP_ID_PATH}/sessions/{sessionId}/subscriptions`,
        method: 'get',
        status: '200',
        responseSchema: { reference: 'GroupTopicSubscriptionList' }
    }
];

Deno.test(
    'group OpenAPI retains every route method, request, and success response contract',
    async () => {
        const response = await installApiDocumentationRoutes(new Hono()).request(
            '/api/openapi.json'
        );
        const document = await response.json() as OpenApiDocument;

        for (const expected of GROUP_OPERATION_CONTRACTS) {
            const routePath = expected.method === 'get'
                ? expected.path
                : `${expected.path}/requests/{requestId}`;
            const operation = document.paths[routePath]?.[expected.method];
            assert.ok(operation, `${expected.method.toUpperCase()} ${routePath}`);
            assert.deepEqual(operation.security, [{
                bearerAuth: [],
                clientIdHeader: []
            }]);
            assertOpenApiRequestSchema(operation, expected);
            assertOpenApiResponseSchema(operation, expected);
        }
    }
);

Deno.test('publication grant requests name every permission field and admit no other', async () => {
    const response = await installApiDocumentationRoutes(new Hono()).request('/api/openapi.json');
    const document = await response.json() as OpenApiDocument;
    for (const name of ['GrantGroupPublicationRequest', 'RevokeGroupPublicationRequest']) {
        const request = document.components.schemas[name];
        assert.equal(request.additionalProperties, false, name);
        assert.deepEqual(request.required, ['topicId', 'publish', 'subscribe'], name);
        assert.deepEqual(Object.keys(request.properties ?? {}), ['topicId', 'publish', 'subscribe', 'reason'], name);
        assert.equal(request.properties?.topicId.$ref, '#/components/schemas/RallarWsUserTopicId', name);
        for (const permission of ['publish', 'subscribe']) {
            assert.equal(request.properties?.[permission].type, 'boolean', `${name}.${permission}`);
            assert.equal(request.properties?.[permission].default, undefined, `${name}.${permission}`);
        }
    }
    for (const action of ['grant', 'revoke']) {
        const path = `${GROUP_ID_PATH}/publication-grants/{principalId}/${action}/requests/{requestId}`;
        assert.deepEqual(
            Object.keys(document.paths[path]?.post?.responses ?? {}),
            ['200', '400', '401', '403', '404', '409'],
            path
        );
    }
});

Deno.test('topic subscription requests name the topic and the asserting generation and admit no other', async () => {
    const response = await installApiDocumentationRoutes(new Hono()).request('/api/openapi.json');
    const document = await response.json() as OpenApiDocument;
    for (const name of ['SubscribeGroupTopicRequest', 'UnsubscribeGroupTopicRequest']) {
        const request = document.components.schemas[name];
        assert.equal(request.additionalProperties, false, name);
        assert.deepEqual(request.required, ['topicId', 'connectionGenerationId'], name);
        assert.deepEqual(Object.keys(request.properties ?? {}), ['topicId', 'connectionGenerationId', 'reason'], name);
        assert.equal(request.properties?.topicId.$ref, '#/components/schemas/RallarWsUserTopicId', name);
    }
    for (const action of ['subscribe', 'unsubscribe']) {
        const path = `${GROUP_ID_PATH}/sessions/{sessionId}/${action}/requests/{requestId}`;
        assert.deepEqual(
            Object.keys(document.paths[path]?.post?.responses ?? {}),
            ['200', '400', '401', '403', '404', '409'],
            path
        );
    }
    assert.deepEqual(
        Object.keys(document.paths[`${GROUP_ID_PATH}/sessions/{sessionId}/subscriptions`]?.get?.responses ?? {}),
        ['200', '401', '403']
    );
});

Deno.test('directory OpenAPI exposes opt-in peer ordering and mandatory nullable RTT', async () => {
    const response = await installApiDocumentationRoutes(new Hono()).request('/api/openapi.json');
    const document = await response.json() as OpenApiDocument;
    const operation = document.paths['/api/state/apps/{applicationId}/workspaces/{workspaceId}/group-directory'].get;
    const order = operation.parameters?.find((parameter) => parameter.name === 'order')?.schema;
    assert.deepEqual(order?.enum, ['online-members', 'peer-rtt']);
    assert.equal(order?.default, 'online-members');
    const entry = document.components.schemas.GroupDirectoryEntry;
    assert.ok(entry.required?.includes('peerRttMs'));
    assert.equal(entry.properties?.peerRttMs.type, 'number');
    assert.equal(entry.properties?.peerRttMs.nullable, true);
});

Deno.test('group creation documents closed retention intent and bounded temporary grace', async () => {
    const response = await installApiDocumentationRoutes(new Hono()).request('/api/openapi.json');
    const document = await response.json() as OpenApiDocument;
    const create = document.components.schemas.CreateGroupRequest;
    assert.equal(create.properties?.retention.$ref, '#/components/schemas/GroupRetentionIntent');
    assert.equal(create.required?.includes('retention'), false);
    const choices = document.components.schemas.GroupRetentionIntent?.oneOf;
    assert.equal(choices?.length, 2);
    const persistent = choices?.find((choice) => choice.properties?.mode.enum?.includes('persistent'));
    const temporary = choices?.find((choice) => choice.properties?.mode.enum?.includes('temporary'));
    assert.equal(persistent?.additionalProperties, false);
    assert.deepEqual(persistent?.required, ['mode']);
    assert.deepEqual(Object.keys(persistent?.properties ?? {}), ['mode']);
    assert.equal(temporary?.additionalProperties, false);
    assert.deepEqual(temporary?.required, ['mode']);
    assert.deepEqual(temporary?.properties?.reconnectGraceMs, {
        type: 'integer',
        minimum: 1_000,
        maximum: 86_400_000,
        default: 600_000
    });
    assert.equal(document.components.schemas.UpdateGroupRequest.properties?.retention, undefined);
});

function assertOpenApiRequestSchema(
    operation: OpenApiOperation,
    expected: GroupOperationContract
): void {
    if (expected.requestSchema) {
        assert.equal(
            operation.requestBody?.content?.['application/json']?.schema?.$ref,
            `#/components/schemas/${expected.requestSchema}`
        );
    }
    else {
        assert.equal(operation.requestBody, undefined);
    }
}

function assertOpenApiResponseSchema(
    operation: OpenApiOperation,
    expected: GroupOperationContract
): void {
    const responseSchema = operation.responses?.[expected.status]
        ?.content?.['application/json']?.schema;
    const expectedReference = expected.responseSchema.reference;

    if (expectedReference) {
        assert.equal(
            responseSchema?.$ref,
            `#/components/schemas/${expectedReference}`
        );
    }
    else {
        assert.equal(responseSchema?.type, 'array');
        assert.equal(
            responseSchema?.items?.$ref,
            `#/components/schemas/${expected.responseSchema.arrayItemReference}`
        );
    }
}
