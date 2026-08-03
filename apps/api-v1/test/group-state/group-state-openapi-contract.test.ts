import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import { init as installSwaggerRoutes } from '../../src/routes/swagger-routes.ts';

interface OpenApiOperation {
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly requestBody?: {
    readonly content?: {
      readonly 'application/json'?: { readonly schema?: { readonly $ref?: string } };
    };
  };
  readonly responses?: Readonly<Record<string, unknown>>;
}

interface OpenApiDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
}

const GROUP_PATH = '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups';
const GROUP_ID_PATH = `${GROUP_PATH}/{groupId}`;

Deno.test('group OpenAPI retains every route method, security contract, request schema, and success status', async () => {
  const response = await installSwaggerRoutes(new Hono()).request('/api/openapi.json');
  const document = await response.json() as OpenApiDocument;

  for (const expected of groupOperationContracts()) {
    const operation = document.paths[expected.path]?.[expected.method];
    assert.ok(operation, `${expected.method.toUpperCase()} ${expected.path}`);
    assert.deepEqual(operation.security, [{ bearerAuth: [], clientIdHeader: [] }]);
    assert.ok(operation.responses?.[expected.status]);
    if (expected.requestSchema) {
      assert.equal(
        operation.requestBody?.content?.['application/json']?.schema?.$ref,
        `#/components/schemas/${expected.requestSchema}`,
      );
    } else {
      assert.equal(operation.requestBody, undefined);
    }
  }
});

function groupOperationContracts(): readonly {
  readonly path: string;
  readonly method: 'get' | 'post' | 'put';
  readonly requestSchema?: string;
  readonly status: '200' | '201';
}[] {
  return [
    { path: GROUP_PATH, method: 'get', status: '200' },
    { path: GROUP_PATH, method: 'post', requestSchema: 'CreateGroupRequest', status: '201' },
    { path: GROUP_ID_PATH, method: 'get', status: '200' },
    { path: GROUP_ID_PATH, method: 'put', requestSchema: 'UpdateGroupRequest', status: '200' },
    { path: `${GROUP_ID_PATH}/events`, method: 'get', status: '200' },
    { path: `${GROUP_ID_PATH}/events/page`, method: 'get', status: '200' },
    {
      path: `${GROUP_ID_PATH}/director/appoint`,
      method: 'post',
      requestSchema: 'AppointGroupDirectorRequest',
      status: '200',
    },
    {
      path: `${GROUP_ID_PATH}/join`,
      method: 'post',
      requestSchema: 'JoinGroupRequest',
      status: '200',
    },
    {
      path: `${GROUP_ID_PATH}/invites/accept`,
      method: 'post',
      requestSchema: 'AcceptGroupInviteRequest',
      status: '200',
    },
    {
      path: `${GROUP_ID_PATH}/join-code/rotate`,
      method: 'post',
      requestSchema: 'RotateGroupJoinCodeRequest',
      status: '200',
    },
    {
      path: `${GROUP_ID_PATH}/invites/{principalId}`,
      method: 'post',
      requestSchema: 'CreateGroupInviteRequest',
      status: '200',
    },
    {
      path: `${GROUP_ID_PATH}/invites/{principalId}/revoke`,
      method: 'post',
      requestSchema: 'RevokeGroupInviteRequest',
      status: '200',
    },
    {
      path: `${GROUP_ID_PATH}/members/{principalId}/remove`,
      method: 'post',
      requestSchema: 'RemoveGroupMemberRequest',
      status: '200',
    },
    {
      path: `${GROUP_ID_PATH}/members/{principalId}/ban`,
      method: 'post',
      requestSchema: 'BanGroupMemberRequest',
      status: '200',
    },
    {
      path: `${GROUP_ID_PATH}/members/{principalId}/unban`,
      method: 'post',
      requestSchema: 'UnbanGroupMemberRequest',
      status: '200',
    },
    {
      path: `${GROUP_ID_PATH}/members/{principalId}/role`,
      method: 'put',
      requestSchema: 'SetGroupMemberRoleRequest',
      status: '200',
    },
    {
      path: `${GROUP_ID_PATH}/owner/transfer`,
      method: 'post',
      requestSchema: 'TransferGroupOwnershipRequest',
      status: '200',
    },
    {
      path: `${GROUP_ID_PATH}/members/{principalId}`,
      method: 'put',
      requestSchema: 'SelfUpsertGroupMemberRequest',
      status: '200',
    },
    {
      path: `${GROUP_ID_PATH}/sessions/{sessionId}`,
      method: 'put',
      requestSchema: 'ConnectGroupPresenceSessionRequest',
      status: '200',
    },
    {
      path: `${GROUP_ID_PATH}/sessions/{sessionId}/heartbeat`,
      method: 'post',
      requestSchema: 'HeartbeatGroupPresenceSessionRequest',
      status: '200',
    },
    {
      path: `${GROUP_ID_PATH}/sessions/{sessionId}/disconnect`,
      method: 'post',
      requestSchema: 'DisconnectGroupPresenceSessionRequest',
      status: '200',
    },
  ];
}
