import { load as loadYaml } from 'js-yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    applyRallarServerEndpointPreset,
    assertRallarServerRestResponse,
    buildRallarServerCollectionStepRequestInput,
    buildRallarServerRestRequest,
    defaultRallarServerWorkbenchVariables,
    executeRallarServerMutationRequest,
    executeRallarServerRestRequest,
    extractRallarServerOpenApiEndpoints,
    extractRallarServerRestVariables,
    RALLAR_SERVER_ENDPOINT_PRESETS,
    readRallarServerJsonPath,
    resolveRallarServerCollectionValue,
    toRallarServerBlackBoxCommand,
    toRallarServerCurl,
    toRallarServerRestCollectionRecipe
} from '../../../apps/rallar-black-box/src/rallar-server-workbench.ts';
import {
    createRallarServerRestCollectionTemplates
} from '../../../apps/rallar-black-box/src/rallar-server-workbench/create-rallar-server-rest-collection-templates.ts';
import type { AuthSession } from '../../../packages/shared/api/api-config.ts';

const authSession: AuthSession = {
    clientId: 'alice-client',
    username: 'alice',
    sessionId: 'alice-session',
    accessToken: 'secret-token',
    expiresAtEpochMs: Date.now() + 60_000
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
                    createdByPrincipalId: '{principalId}'
                }
            },
            defaultRallarServerWorkbenchVariables({
                applicationId: 'rallar app',
                workspaceId: 'default',
                principalId: 'alice/client',
                groupId: 'room one'
            })
        );

        expect(draft).toMatchObject({
            method: 'POST',
            path: '/api/state/apps/rallar%20app/workspaces/default/groups',
            attachAuth: true
        });
        expect(JSON.parse(draft.bodyText)).toEqual({
            groupId: 'room one',
            createdByPrincipalId: 'alice/client'
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
            timeoutMs: 5000
        });

        expect(request.url).toBe('http://localhost:8080/api/webrtc/ice?fresh=true');
        expect(request.headers).toMatchObject({
            accept: 'application/json',
            authorization: 'Bearer secret-token',
            'x-client-id': 'alice-client',
            'x-trace': 'one'
        });
        expect(request.redactedHeaders.authorization).toBe('<redacted>');
    });

    it('rejects placeholder API base URLs for real-provider calls', () => {
        expect(() =>
            buildRallarServerRestRequest({
                apiBaseUrl: 'https://api.example.invalid',
                method: 'GET',
                path: '/api/config',
                headersText: '{}',
                queryText: '{}',
                bodyText: '',
                responseBodyMode: 'auto',
                attachAuth: false,
                forbidPlaceholderBaseUrl: true,
                timeoutMs: 5000
            })
        ).toThrow(/placeholder API base URL/);
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
                timeoutMs: 5000
            },
            async () =>
                new Response(JSON.stringify({ apiBaseUrl: 'http://localhost:8080' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                })
        );

        expect(response).toMatchObject({
            ok: true,
            status: 200,
            bodyKind: 'json',
            bodyJson: {
                apiBaseUrl: 'http://localhost:8080'
            }
        });
    });

    it('executes operator mutations with path-only request identity', async () => {
        const calls: Array<Readonly<{ url: string; body: string | undefined; }>> = [];

        await executeRallarServerMutationRequest(
            {
                apiBaseUrl: 'http://localhost:8080',
                method: 'POST',
                path: '/api/auth/ws-ticket',
                headersText: '{}',
                queryText: '{}',
                bodyText: '{"requestId":"legacy-body-id"}',
                responseBodyMode: 'json',
                attachAuth: false,
                timeoutMs: 5000
            },
            'opaque-operator-request-id',
            async (input, init) => {
                calls.push({
                    url: String(input),
                    body: init?.body === undefined ? undefined : String(init.body)
                });
                return new Response('{}', {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                });
            }
        );

        expect(calls).toEqual([
            {
                url: 'http://localhost:8080/api/auth/ws-ticket/requests/opaque-operator-request-id',
                body: '{}'
            }
        ]);
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
                timeoutMs: 5000
            },
            async () =>
                new Response('not-json', {
                    status: 401,
                    statusText: 'Unauthorized',
                    headers: { 'content-type': 'application/json' }
                })
        );

        expect(response.ok).toBe(false);
        expect(response.error?.kind).toBe('invalid-json');
        expect(response.status).toBe(401);
    });

    it('creates black-box http.request commands without embedding auth headers', () => {
        const command = toRallarServerBlackBoxCommand(
            {
                apiBaseUrl: 'http://localhost:8080',
                method: 'POST',
                path: '/api/auth/ws-ticket',
                headersText: '{"x-trace":"one"}',
                queryText: '{}',
                bodyText: '{}',
                responseBodyMode: 'json',
                attachAuth: true,
                authSession,
                timeoutMs: 5000
            },
            'rest-ws-ticket'
        );

        expect(command).toEqual({
            kind: 'http.request',
            commandId: 'rest-ws-ticket',
            request: {
                path: '/api/auth/ws-ticket',
                method: 'POST',
                headers: {
                    'x-trace': 'one'
                },
                body: {}
            },
            response: {
                body: 'json'
            }
        });
    });

    it('extracts endpoint picker rows from OpenAPI JSON', () => {
        const endpoints = extractRallarServerOpenApiEndpoints({
            paths: {
                '/api/config': {
                    get: {
                        tags: ['Config'],
                        summary: 'Read runtime configuration'
                    }
                },
                '/api/webrtc/ice': {
                    get: {
                        tags: ['WebRTC'],
                        summary: 'Read ICE servers',
                        security: [{ bearerAuth: [] }]
                    }
                }
            }
        });

        expect(endpoints).toMatchObject([
            {
                method: 'GET',
                pathTemplate: '/api/config',
                requiresAuth: false
            },
            {
                method: 'GET',
                pathTemplate: '/api/webrtc/ice',
                requiresAuth: true
            }
        ]);
    });

    it('includes scoped graph and topology endpoint presets without deprecated graph presets', () => {
        const presets = new Map(
            RALLAR_SERVER_ENDPOINT_PRESETS.map((preset) => [preset.presetId, preset])
        );

        expect(presets.get('graph-scoped-global')).toMatchObject({
            tag: 'Graph',
            method: 'GET',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/graphs/global',
            requiresAuth: false
        });
        expect(presets.get('group-graph-latest')).toMatchObject({
            tag: 'Graph',
            method: 'GET',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}' +
                '/groups/{groupId}/graphs/latest',
            requiresAuth: true
        });
        expect(presets.get('group-topology-read')).toMatchObject({
            tag: 'Topology',
            method: 'GET',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}' + '/groups/{groupId}/topology',
            requiresAuth: true
        });
        expect(presets.get('group-topology-config-put')).toMatchObject({
            tag: 'Topology',
            method: 'PUT',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}' +
                '/groups/{groupId}/topology/config/requests/{requestId}',
            requiresAuth: true
        });
        expect(presets.get('group-topology-override-put')).toMatchObject({
            tag: 'Topology',
            method: 'PUT',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}' +
                '/groups/{groupId}/topology/override/requests/{requestId}',
            requiresAuth: true
        });
        expect(presets.get('group-topology-reconfigure')).toMatchObject({
            tag: 'Topology',
            method: 'POST',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}' +
                '/groups/{groupId}/topology/reconfigure/requests/{requestId}',
            requiresAuth: true
        });
        expect(presets.get('group-topology-config-delete')).toMatchObject({
            method: 'DELETE',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}' +
                '/groups/{groupId}/topology/config/requests/{requestId}'
        });
        expect(presets.get('group-topology-override-delete')).toMatchObject({
            method: 'DELETE',
            pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}' +
                '/groups/{groupId}/topology/override/requests/{requestId}'
        });
        expect(presets.has('graph-global')).toBe(false);
        expect(presets.has('graph-group')).toBe(false);
    });

    it('uses strict request paths for every built-in mutation preset and collection step', () => {
        const mutationPresets = RALLAR_SERVER_ENDPOINT_PRESETS.filter(
            (preset) => preset.method !== 'GET'
        );
        expect(mutationPresets).toHaveLength(17);
        for (const preset of mutationPresets) {
            expect(preset.pathTemplate, preset.presetId).toMatch(/\/requests\/\{requestId\}$/u);
            expect(preset.body).not.toMatchObject({ requestId: expect.anything() });
        }

        const collectionMutationSteps = createRallarServerRestCollectionTemplates(
            defaultRallarServerWorkbenchVariables({})
        ).flatMap((collection) => collection.steps.filter((step) => step.request.method !== 'GET'));
        expect(collectionMutationSteps).toHaveLength(15);
        for (const step of collectionMutationSteps) {
            expect(step.request.path, step.stepId).toMatch(/\/requests\/\{\{requestId\}\}$/u);
            expect(step.request.body).not.toMatchObject({ requestId: expect.anything() });
        }
    });

    it('threads one generation through client session lifecycle presets and collections', () => {
        const variables = defaultRallarServerWorkbenchVariables({
            generationId: 'generation-1'
        });
        const presets = new Map(
            RALLAR_SERVER_ENDPOINT_PRESETS.map((preset) => [preset.presetId, preset])
        );

        for (
            const presetId of [
                'client-session-connect',
                'client-session-heartbeat',
                'client-session-disconnect'
            ]
        ) {
            const draft = applyRallarServerEndpointPreset(presets.get(presetId)!, variables);
            expect(JSON.parse(draft.bodyText)).toMatchObject({
                generationId: 'generation-1'
            });
        }

        const collection = createRallarServerRestCollectionTemplates(variables).find(
            (entry) => entry.collectionId === 'client-presence-lifecycle'
        );
        const lifecycleSteps = collection!.steps.filter((step) => step.stepId.includes('client-session'));

        expect(lifecycleSteps.map((step) => step.stepId)).toEqual([
            'connect-client-session',
            'heartbeat-client-session',
            'disconnect-client-session'
        ]);
        for (const step of lifecycleSteps) {
            const input = buildRallarServerCollectionStepRequestInput({
                step,
                apiBaseUrl: 'http://localhost:8080',
                variables: collection!.variables ?? {},
                authSession,
                defaultTimeoutMs: 5000
            });
            expect(JSON.parse(input.bodyText)).toMatchObject({
                generationId: 'generation-1'
            });
        }
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
            timeoutMs: 5000
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
                requestId: 'request-000000000001'
            })
        );
        const collection = templates.find(
            (entry) => entry.collectionId === 'group-membership-evidence'
        );
        expect(collection).toBeDefined();

        const input = buildRallarServerCollectionStepRequestInput({
            step: collection!.steps[0],
            apiBaseUrl: 'http://localhost:8080',
            variables: collection!.variables ?? {},
            authSession,
            defaultTimeoutMs: 5000
        });

        expect(input.path).toBe(
            '/api/state/apps/app/workspaces/workspace/groups/requests/request-000000000001'
        );
        expect(JSON.parse(input.bodyText)).toMatchObject({
            groupId: 'bb-group',
            createdByPrincipalId: 'alice-client'
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
                members: [{ principalId: 'alice-client' }]
            }),
            bodyJson: {
                group: { groupId: 'bb-group' },
                members: [{ principalId: 'alice-client' }]
            },
            bodyKind: 'json' as const
        };

        expect(readRallarServerJsonPath(response.bodyJson, '$.members[0].principalId')).toBe(
            'alice-client'
        );
        expect(
            resolveRallarServerCollectionValue('/groups/{{groupId}}/${principalId}', {
                groupId: 'bb-group',
                principalId: 'alice-client'
            })
        ).toBe('/groups/bb-group/alice-client');

        const assertions = assertRallarServerRestResponse(
            response,
            {
                status: [200, 201],
                body: [{ path: '$.group.groupId', equals: '{{groupId}}' }],
                headers: [{ name: 'x-snapshot-version', exists: true }]
            },
            { groupId: 'bb-group' }
        );

        expect(assertions.every((assertion) => assertion.ok)).toBe(true);
        expect(
            extractRallarServerRestVariables(response, [
                { name: 'observedGroupId', path: '$.group.groupId' },
                { name: 'snapshotVersion', from: 'headers', header: 'x-snapshot-version' },
                { name: 'statusCode', from: 'status' }
            ])
        ).toEqual({
            observedGroupId: 'bb-group',
            snapshotVersion: '3',
            statusCode: 200
        });
    });

    it('exports REST collections as black-box recipes with assertion metadata', () => {
        const collection = createRallarServerRestCollectionTemplates(
            defaultRallarServerWorkbenchVariables({
                applicationId: 'app',
                workspaceId: 'workspace',
                groupId: 'bb-group',
                principalId: 'alice-client'
            })
        )[0];

        const recipe = toRallarServerRestCollectionRecipe({
            collection,
            apiBaseUrl: 'http://localhost:8080',
            variables: collection.variables ?? {},
            authSession,
            defaultTimeoutMs: 5000
        }) as {
            recipeId: string;
            commands: Array<{
                kind: string;
                commandId: string;
                metadata?: { restCollection?: { expect?: unknown; attachAuth?: boolean; }; };
            }>;
        };

        expect(recipe.recipeId).toBe('group-membership-evidence');
        expect(recipe.commands[0]).toMatchObject({
            kind: 'http.request',
            commandId: 'group-membership-evidence-1-create-group'
        });
        expect(recipe.commands[0].metadata?.restCollection?.attachAuth).toBe(true);
        expect(recipe.commands[2].metadata?.restCollection?.expect).toBeDefined();
    });
    // Slice 13: the cheapest way to drive the stage machine by hand before the
    // live-RTC specs exist.
    it('drives every lifecycle boundary manually in the stage collection', () => {
        const collection = createRallarServerRestCollectionTemplates(
            defaultRallarServerWorkbenchVariables({})
        ).find((entry) => entry.collectionId === 'group-lifecycle-stages');

        expect(collection).toBeDefined();
        expect(collection!.steps.map((step) => step.stepId)).toEqual([
            'create-phased-group',
            'plan-layout',
            // Connect is fenced on the exact planned identity, so the layout
            // read between them is load-bearing, not a convenience.
            'read-planned-layout',
            'connect-layout',
            'activate-layout',
            'read-formation',
            'pause-transport',
            'resume-transport'
        ]);

        // Nothing may auto-advance between the steps, or the operator is
        // reading a stage the server reached on its own (product decision 8).
        expect(collection!.steps[0]!.request.body).toMatchObject({
            lifecyclePolicy: {
                establishment: {
                    planTrigger: { kind: 'manual' },
                    connectTrigger: { kind: 'manual' }
                },
                activation: { mode: 'manual' }
            }
        });

        // The valve is orthogonal to the stage (product decision 25): the
        // pause and resume steps assert the transport moved and say nothing
        // about the lifecycle state.
        const valveSteps = collection!.steps.filter((step) => step.stepId.endsWith('-transport'));
        expect(valveSteps.flatMap((step) => step.expect?.body ?? [])).toEqual([
            { path: '$.group.transportState', equals: 'halted' },
            { path: '$.group.transportState', equals: 'flowing' }
        ]);
    });
    /**
     * The collections are hand-written HTTP paths that nothing executes in
     * CI, so a wrong one is invisible until an operator clicks it. This
     * checks every step against the served contract instead.
     */
    it('addresses paths the API actually serves', () => {
        const openApi = loadYaml(
            readFileSync(path.join(process.cwd(), 'apps/api-v1/resources/api-v1-openapi.yaml'), 'utf8')
        ) as OpenApiPaths;
        const served = new Set(Object.keys(openApi.paths));

        const steps = createRallarServerRestCollectionTemplates(
            defaultRallarServerWorkbenchVariables({})
        ).flatMap((collection) => collection.steps);

        for (const step of steps) {
            const templated = step.request.path.replaceAll(/\{\{(\w+)\}\}/gu, '{$1}');
            const candidates = [...served].filter((servedPath) => toPathShape(servedPath) === toPathShape(templated));
            expect(candidates, `${step.stepId} -> ${step.request.path}`).not.toHaveLength(0);
            const methods = served.has(candidates[0]!)
                ? Object.keys(openApi.paths[candidates[0]!]!)
                : [];
            expect(methods, `${step.stepId} method`).toContain(step.request.method.toLowerCase());
        }
    });
});

/** Path parameter names differ between the workbench and the spec; shapes do not. */
function toPathShape(value: string): string {
    return value.replaceAll(/\{[^}]+\}/gu, '{}');
}

/** Only the path keys and their method keys are read here. */
interface OpenApiPaths {
    readonly paths: Record<string, object>;
}
