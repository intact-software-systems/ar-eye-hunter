import { describe, expect, it } from 'vitest';
import type { AuthSession } from '../../../packages/shared/api/api-config.ts';
import {
    applyRallarServerEndpointPreset,
    assertRallarServerRestResponse,
    buildRallarServerCollectionStepRequestInput,
    buildRallarServerRestRequest,
    createRallarServerRestCollectionTemplates,
    defaultRallarServerWorkbenchVariables,
    executeRallarServerRestRequest,
    extractRallarServerRestVariables,
    extractRallarServerOpenApiEndpoints,
    RALLAR_SERVER_ENDPOINT_PRESETS,
    readRallarServerJsonPath,
    resolveRallarServerCollectionValue,
    toRallarServerBlackBoxCommand,
    toRallarServerCurl,
    toRallarServerRestCollectionRecipe,
} from '../../../apps/rallar-black-box/src/rallar-server-workbench.ts';

const authSession: AuthSession = {
    clientId: 'alice-client',
    username: 'alice',
    sessionId: 'alice-session',
    accessToken: 'secret-token',
    expiresAtEpochMs: Date.now() + 60_000,
};

describe('rallar-black-box Rallar Server workbench helpers', () => {
    it('applies endpoint presets with encoded path variables and body defaults', () => {
        const draft = applyRallarServerEndpointPreset(
            {
                presetId: 'group-create',
                tag: 'Group State',
                label: 'Create group',
                method: 'POST',
                pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups',
                requiresAuth: true,
                body: {
                    groupId: '{groupId}',
                    createdByPrincipalId: '{principalId}',
                },
            },
            defaultRallarServerWorkbenchVariables({
                applicationId: 'rallar app',
                workspaceId: 'default',
                principalId: 'alice/client',
                groupId: 'room one',
            }),
        );

        expect(draft).toMatchObject({
            method: 'POST',
            path: '/api/state/apps/rallar%20app/workspaces/default/groups',
            attachAuth: true,
        });
        expect(JSON.parse(draft.bodyText)).toEqual({
            groupId: 'room one',
            createdByPrincipalId: 'alice/client',
        });
    });

    it('builds authenticated requests and redacts the bearer token', () => {
        const request = buildRallarServerRestRequest({
            apiBaseUrl: 'http://localhost:8080',
            method: 'GET',
            path: '/api/webrtc/ice',
            headersText: '{"x-trace":"one"}',
            queryText: '{"fresh":true}',
            bodyText: '',
            responseBodyMode: 'auto',
            attachAuth: true,
            authSession,
            timeoutMs: 5000,
        });

        expect(request.url).toBe('http://localhost:8080/api/webrtc/ice?fresh=true');
        expect(request.headers).toMatchObject({
            accept: 'application/json',
            authorization: 'Bearer secret-token',
            'x-client-id': 'alice-client',
            'x-trace': 'one',
        });
        expect(request.redactedHeaders.authorization).toBe('<redacted>');
    });

    it('rejects placeholder API base URLs for real-provider calls', () => {
        expect(() => buildRallarServerRestRequest({
            apiBaseUrl: 'https://api.example.invalid',
            method: 'GET',
            path: '/api/config',
            headersText: '{}',
            queryText: '{}',
            bodyText: '',
            responseBodyMode: 'auto',
            attachAuth: false,
            forbidPlaceholderBaseUrl: true,
            timeoutMs: 5000,
        })).toThrow(/placeholder API base URL/);
    });

    it('executes a request and parses JSON responses', async () => {
        const response = await executeRallarServerRestRequest(
            {
                apiBaseUrl: 'http://localhost:8080',
                method: 'GET',
                path: '/api/config',
                headersText: '{}',
                queryText: '{}',
                bodyText: '',
                responseBodyMode: 'auto',
                attachAuth: false,
                timeoutMs: 5000,
            },
            async () => new Response(
                JSON.stringify({ apiBaseUrl: 'http://localhost:8080' }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                },
            ),
        );

        expect(response).toMatchObject({
            ok: true,
            status: 200,
            bodyKind: 'json',
            bodyJson: {
                apiBaseUrl: 'http://localhost:8080',
            },
        });
    });

    it('classifies unauthenticated responses and invalid JSON bodies', async () => {
        const response = await executeRallarServerRestRequest(
            {
                apiBaseUrl: 'http://localhost:8080',
                method: 'GET',
                path: '/api/webrtc/ice',
                headersText: '{}',
                queryText: '{}',
                bodyText: '',
                responseBodyMode: 'json',
                attachAuth: true,
                authSession,
                timeoutMs: 5000,
            },
            async () => new Response('not-json', {
                status: 401,
                statusText: 'Unauthorized',
                headers: { 'content-type': 'application/json' },
            }),
        );

        expect(response.ok).toBe(false);
        expect(response.error?.kind).toBe('invalid-json');
        expect(response.status).toBe(401);
    });

    it('creates black-box http.request commands without embedding auth headers', () => {
        const command = toRallarServerBlackBoxCommand({
            apiBaseUrl: 'http://localhost:8080',
            method: 'POST',
            path: '/api/auth/ws-ticket',
            headersText: '{"x-trace":"one"}',
            queryText: '{}',
            bodyText: '{}',
            responseBodyMode: 'json',
            attachAuth: true,
            authSession,
            timeoutMs: 5000,
        }, 'rest-ws-ticket');

        expect(command).toEqual({
            kind: 'http.request',
            commandId: 'rest-ws-ticket',
            request: {
                path: '/api/auth/ws-ticket',
                method: 'POST',
                headers: {
                    'x-trace': 'one',
                },
                body: {},
            },
            response: {
                body: 'json',
            },
        });
    });

    it('extracts endpoint picker rows from OpenAPI JSON', () => {
        const endpoints = extractRallarServerOpenApiEndpoints({
            paths: {
                '/api/config': {
                    get: {
                        tags: ['Config'],
                        summary: 'Read runtime configuration',
                    },
                },
                '/api/webrtc/ice': {
                    get: {
                        tags: ['WebRTC'],
                        summary: 'Read ICE servers',
                        security: [{ bearerAuth: [] }],
                    },
                },
            },
        });

        expect(endpoints).toMatchObject([
            {
                method: 'GET',
                pathTemplate: '/api/config',
                requiresAuth: false,
            },
            {
                method: 'GET',
                pathTemplate: '/api/webrtc/ice',
                requiresAuth: true,
            },
        ]);
    });

    it('includes scoped graph and topology endpoint presets without deprecated graph presets', () => {
        const presets = new Map(
            RALLAR_SERVER_ENDPOINT_PRESETS.map((preset) => [preset.presetId, preset]),
        );

        expect(presets.get('graph-scoped-global')).toMatchObject({
            tag: 'Graph',
            method: 'GET',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/graphs/global',
            requiresAuth: false,
        });
        expect(presets.get('group-graph-latest')).toMatchObject({
            tag: 'Graph',
            method: 'GET',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/graphs/latest',
            requiresAuth: true,
        });
        expect(presets.get('group-topology-read')).toMatchObject({
            tag: 'Topology',
            method: 'GET',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology',
            requiresAuth: true,
        });
        expect(presets.get('group-topology-config-put')).toMatchObject({
            tag: 'Topology',
            method: 'PUT',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/config',
            requiresAuth: true,
        });
        expect(presets.get('group-topology-override-put')).toMatchObject({
            tag: 'Topology',
            method: 'PUT',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/override',
            requiresAuth: true,
        });
        expect(presets.get('group-topology-reconfigure')).toMatchObject({
            tag: 'Topology',
            method: 'POST',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/reconfigure',
            requiresAuth: true,
        });
        expect(presets.get('group-topology-config-delete')).toMatchObject({
            method: 'DELETE',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/config',
        });
        expect(presets.get('group-topology-override-delete')).toMatchObject({
            method: 'DELETE',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/override',
        });
        expect(presets.has('graph-global')).toBe(false);
        expect(presets.has('graph-group')).toBe(false);
    });

    it('redacts authorization, query secrets, and body secrets in cURL output', () => {
        const curl = toRallarServerCurl({
            apiBaseUrl: 'http://localhost:8080',
            method: 'POST',
            path: '/api/webrtc/ice',
            headersText: '{}',
            queryText: '{"access_token":"query-secret"}',
            bodyText: '{"password":"body-secret"}',
            responseBodyMode: 'auto',
            attachAuth: true,
            authSession,
            timeoutMs: 5000,
        });

        expect(curl).toContain('authorization: <redacted>');
        expect(curl).not.toContain('secret-token');
        expect(curl).not.toContain('query-secret');
        expect(curl).not.toContain('body-secret');
    });

    it('resolves REST collection variables into requests', () => {
        const templates = createRallarServerRestCollectionTemplates(
            defaultRallarServerWorkbenchVariables({
                applicationId: 'app',
                workspaceId: 'workspace',
                groupId: 'bb-group',
                principalId: 'alice-client',
            }),
        );
        const collection = templates.find(entry => entry.collectionId === 'group-membership-evidence');
        expect(collection).toBeDefined();

        const input = buildRallarServerCollectionStepRequestInput({
            step: collection!.steps[0],
            apiBaseUrl: 'http://localhost:8080',
            variables: collection!.variables ?? {},
            authSession,
            defaultTimeoutMs: 5000,
        });

        expect(input.path).toBe('/api/state/apps/app/workspaces/workspace/groups');
        expect(JSON.parse(input.bodyText)).toMatchObject({
            groupId: 'bb-group',
            createdByPrincipalId: 'alice-client',
        });
        expect(input.attachAuth).toBe(true);
    });

    it('evaluates collection assertions and extracts variables', () => {
        const response = {
            ok: true,
            url: 'http://localhost:8080/api/state',
            status: 200,
            statusText: 'OK',
            durationMs: 12,
            headers: { 'content-type': 'application/json', 'x-snapshot-version': '3' },
            bodyText: JSON.stringify({
                group: { groupId: 'bb-group' },
                members: [{ principalId: 'alice-client' }],
            }),
            bodyJson: {
                group: { groupId: 'bb-group' },
                members: [{ principalId: 'alice-client' }],
            },
            bodyKind: 'json' as const,
        };

        expect(readRallarServerJsonPath(response.bodyJson, '$.members[0].principalId'))
            .toBe('alice-client');
        expect(resolveRallarServerCollectionValue(
            '/groups/{{groupId}}/${principalId}',
            { groupId: 'bb-group', principalId: 'alice-client' },
        )).toBe('/groups/bb-group/alice-client');

        const assertions = assertRallarServerRestResponse(response, {
            status: [200, 201],
            body: [{ path: '$.group.groupId', equals: '{{groupId}}' }],
            headers: [{ name: 'x-snapshot-version', exists: true }],
        }, { groupId: 'bb-group' });

        expect(assertions.every(assertion => assertion.ok)).toBe(true);
        expect(extractRallarServerRestVariables(response, [
            { name: 'observedGroupId', path: '$.group.groupId' },
            { name: 'snapshotVersion', from: 'headers', header: 'x-snapshot-version' },
            { name: 'statusCode', from: 'status' },
        ])).toEqual({
            observedGroupId: 'bb-group',
            snapshotVersion: '3',
            statusCode: 200,
        });
    });

    it('exports REST collections as black-box recipes with assertion metadata', () => {
        const collection = createRallarServerRestCollectionTemplates(
            defaultRallarServerWorkbenchVariables({
                applicationId: 'app',
                workspaceId: 'workspace',
                groupId: 'bb-group',
                principalId: 'alice-client',
            }),
        )[0];

        const recipe = toRallarServerRestCollectionRecipe({
            collection,
            apiBaseUrl: 'http://localhost:8080',
            variables: collection.variables ?? {},
            authSession,
            defaultTimeoutMs: 5000,
        }) as {
            recipeId: string;
            commands: Array<{
                kind: string;
                commandId: string;
                metadata?: { restCollection?: { expect?: unknown; attachAuth?: boolean } };
            }>;
        };

        expect(recipe.recipeId).toBe('group-membership-evidence');
        expect(recipe.commands[0]).toMatchObject({
            kind: 'http.request',
            commandId: 'group-membership-evidence-1-create-group',
        });
        expect(recipe.commands[0].metadata?.restCollection?.attachAuth).toBe(true);
        expect(recipe.commands[2].metadata?.restCollection?.expect).toBeDefined();
    });
});
