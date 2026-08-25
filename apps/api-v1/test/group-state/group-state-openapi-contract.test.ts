import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { installApiDocumentationRoutes } from '../../src/routes/swagger-routes.ts';

interface OpenApiSchema {
    readonly $ref?: string;
    readonly type?: string;
    readonly items?: { readonly $ref?: string; };
}

interface OpenApiOperation {
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
