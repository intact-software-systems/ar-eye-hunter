import { describe, expect, it } from 'vitest';
import type { AuthSession } from '../../../packages/shared/api/api-config.ts';
import {
    applyRallarServerEndpointPreset,
    buildRallarServerRestRequest,
    defaultRallarServerWorkbenchVariables,
    executeRallarServerRestRequest,
    extractRallarServerOpenApiEndpoints,
    toRallarServerBlackBoxCommand,
    toRallarServerCurl,
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

    it('redacts authorization in cURL output', () => {
        const curl = toRallarServerCurl({
            apiBaseUrl: 'http://localhost:8080',
            method: 'GET',
            path: '/api/webrtc/ice',
            headersText: '{}',
            queryText: '{}',
            bodyText: '',
            responseBodyMode: 'auto',
            attachAuth: true,
            authSession,
            timeoutMs: 5000,
        });

        expect(curl).toContain('authorization: <redacted>');
        expect(curl).not.toContain('secret-token');
    });
});
