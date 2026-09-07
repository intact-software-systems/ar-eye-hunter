import { evaluateScenarioTransform } from '@shared-test/black-box-runner/execution/black-box-output-transform.ts';
import { toRunnerCorrelationConfig } from '@shared-test/black-box-runner/execution/black-box-run-correlation.ts';
import { resolveBlackBoxVariables } from '@shared-test/black-box-runner/execution/black-box-run-secrets.ts';
import { resolvePlaceholders } from '@shared-test/black-box-runner/execution/black-box-value-resolution.ts';
import { closeWs, openWs, type LocalWsContext } from '@shared-test/black-box-runner/execution/local-websocket-session.ts';
import { readScenarioRecipeIncludes, type ScenarioRecipe } from '@shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts';
import { toExecutableInteractions } from '@shared-test/black-box-runner/recipes/to-executable-interactions.ts';
import { waitForWsMessages, type WsInteraction } from '@shared-test/black-box-runner/ws/ws-wait-expectations.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestWebSocket } from '../shared/websocket/test-web-socket.ts';
import { readApiV1Recipe } from './api-v1-recipe-test-fixture.ts';

interface CompiledWebSocketInteraction {
    readonly SET?: { readonly request: { readonly transform?: { readonly concat?: readonly unknown[]; }; }; };
    readonly WS?: WsInteraction;
    readonly PARALLEL?: { readonly request: { readonly groups: readonly { readonly steps: readonly CompiledWebSocketInteraction[]; }[]; }; };
}

function flattenInteractions(interactions: readonly CompiledWebSocketInteraction[]): CompiledWebSocketInteraction[] {
    return interactions.flatMap((interaction) => [
        interaction,
        ...(interaction.PARALLEL?.request.groups.flatMap((group) => flattenInteractions(group.steps)) ?? [])
    ]);
}

const recipes = [
    { name: 'group-formation-burst-small', applicationId: 'formation-small-scope-run', workspaceId: 'default' },
    { name: 'group-formation-burst-medium', applicationId: 'formation-medium-scope-run', workspaceId: 'default' },
    { name: 'group-formation-burst-large', applicationId: 'formation-large-scope-run', workspaceId: 'default' },
    { name: 'group-formation-churn-large', applicationId: 'formation-churn-large-scope-run', workspaceId: 'default' },
    { name: 'group-state-reconnect-resync', applicationId: 'api-v1-black-box-scope-run-reconnect', workspaceId: 'workspace-reconnect-scope-run' },
    { name: 'cross-principal-client-state-isolation', applicationId: 'api-v1-black-box-scope-run-cpi', workspaceId: 'workspace-cpi-scope-run' },
    { name: 'rtc-topology-convergence', applicationId: 'api-v1-topology-scope-run', workspaceId: 'cluster-scope-run' },
    { name: 'group-topology-late-joiner', applicationId: 'api-v1-black-box-scope-run-latejoin', workspaceId: 'workspace-latejoin-scope-run' },
    { name: 'group-lifecycle-transitions', applicationId: 'group-transitions-scope-run', workspaceId: 'default-scope-run' },
    { name: 'crdt-app-inbox', applicationId: 'rallar-server', workspaceId: 'default' },
    { name: 'crdt-append-history', applicationId: 'rallar-server', workspaceId: 'default' }
] as const;

let sockets: LocalWsContext;
const socketConfig = { interactionName: 'scope-open', interaction: { request: {} } };
const socketConnection = { request: { connection: 'scope-test' } };

beforeEach(() => {
    TestWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', TestWebSocket);
    sockets = { wsConnections: {}, wsMessages: {}, wsCloseEvents: {} };
});

afterEach(async () => {
    await closeWs(socketConnection, socketConfig, sockets);
    vi.unstubAllGlobals();
});

describe.each(['default', 'override'] as const)('%s recipe WebSocket scope', (scopeSource) => {
    it.each(recipes)('opens $name with its expanded and encoded authenticated scope', async (recipeCase) => {
        const recipe = readApiV1Recipe(`tests/api-v1/api-v1-${recipeCase.name}.json`) as ScenarioRecipe;
        const recipePath = fileURLToPath(new URL(`../../shared-test/black-box-runner/tests/api-v1/api-v1-${recipeCase.name}.json`, import.meta.url));
        const expanded = readScenarioRecipeIncludes(recipe, recipePath, process.cwd()).config;
        const resolved = resolveBlackBoxVariables(expanded.variables, {
            RALLAR_BB_RUN_ID: 'scope-run',
            RALLAR_CRDT_HISTORY_SIZE: '1',
            RALLAR_CRDT_FINAL_HISTORY_SIZE: '2',
            RALLAR_CRDT_FINAL_PREVIOUS_SEQUENCE: '1'
        });
        const scope = scopeSource === 'default'
            ? { applicationId: recipeCase.applicationId, workspaceId: recipeCase.workspaceId }
            : { applicationId: 'app:branch-one', workspaceId: 'workspace:two.three' };
        const variables = scopeSource === 'default' ? resolved.variables : { ...resolved.variables, ...scope };
        const interactions = flattenInteractions(toExecutableInteractions({ ...expanded, variables }) as CompiledWebSocketInteraction[]);
        const urlTransform = interactions.find((interaction) => interaction.SET?.request.transform?.concat?.includes('&applicationId='))?.SET?.request
            .transform;
        const openRequest = interactions.find((interaction) => interaction.WS?.request.action === 'open')?.WS?.request;
        expect(urlTransform).toBeDefined();
        expect(openRequest).toBeDefined();
        const context = {
            variables,
            correlation: toRunnerCorrelationConfig({}),
            outputs: {
                aliceSessionId: 'session',
                alphaSessionId: 'session',
                founderSessionId: 'session',
                client1SessionId: 'session',
                crdtSessionId: 'session',
                crdtWriterSessionId: 'session',
                aliceWsTicket: 'ticket+value&encoded=yes',
                alphaWsTicketFirst: 'ticket+value&encoded=yes',
                founderWsTicket: 'ticket+value&encoded=yes',
                primaryCrdtWsTicket: 'ticket+value&encoded=yes',
                primaryCrdtHistoryTicket: 'ticket+value&encoded=yes'
            },
            resultsByName: { createClient1WsTicket: [{ actual: { body: { ticket: 'ticket+value&encoded=yes' } } }] }
        };
        const url = new URL(evaluateScenarioTransform({ transform: urlTransform, context }));
        const snapshotScope = resolvePlaceholders(openRequest?.snapshotScope, context);

        expect(url.pathname).toBe('/api/ws/session');
        expect([...url.searchParams.entries()]).toEqual([
            ['ticket', 'ticket+value&encoded=yes'],
            ['applicationId', scope.applicationId],
            ['workspaceId', scope.workspaceId]
        ]);
        expect(snapshotScope).toEqual(scope);
        const opening = openWs({ request: { ...socketConnection.request, url: url.href, snapshotScope } }, socketConfig, sockets);
        const socket = TestWebSocket.instances.at(-1);
        expect(socket).toBeDefined();
        socket?.open();
        expect(await opening).toMatchObject({ status: 'SUCCESS' });
    });
});

it.each([
    { name: 'group-formation-burst-small', waitName: 'waitClient1OverlayAttempt1' },
    { name: 'group-formation-burst-medium', waitName: 'waitClient1OverlayAttempt1' },
    { name: 'group-formation-burst-large', waitName: 'waitClient1OverlayAttempt1' },
    { name: 'group-formation-churn-large', waitName: 'waitClient1OverlayFormedAttempt1' },
    { name: 'rtc-topology-convergence', waitName: 'consumeBaselineCurrentTopologyOnPrimary' }
])('$name matches the complete group scope when transport routing keys are shortened', async ({ name, waitName }) => {
    const recipe = readApiV1Recipe(`tests/api-v1/api-v1-${name}.json`) as ScenarioRecipe;
    const recipePath = fileURLToPath(new URL(`../../shared-test/black-box-runner/tests/api-v1/api-v1-${name}.json`, import.meta.url));
    const expanded = readScenarioRecipeIncludes(recipe, recipePath, process.cwd()).config;
    const variables = {
        ...resolveBlackBoxVariables(expanded.variables, {}).variables,
        applicationId: 'application',
        workspaceId: 'workspace',
        groupId: 'group-with-an-identifier-longer-than-the-queue-key-limit'
    };
    const interactions = flattenInteractions(toExecutableInteractions({ ...expanded, variables }) as CompiledWebSocketInteraction[]);
    const wait = interactions.find((interaction) => waitName in interaction)?.WS;
    if (wait === undefined) {
        throw new Error(`Missing recipe wait: ${waitName}`);
    }
    const scope = { kind: 'group', applicationId: variables.applicationId, workspaceId: variables.workspaceId, resourceId: variables.groupId };
    const route = toAppQueueKey({ topicId: 'overlay.topology', contextId: variables.groupId, resourceId: 'version-1' });
    expect(route.contextId).not.toBe(variables.groupId);
    const unrelated = [
        { ...scope, applicationId: 'another-application' },
        { ...scope, workspaceId: 'another-workspace' },
        { ...scope, resourceId: 'another-group' }
    ].map((otherScope) => ({ data: { completedSnapshot: { route, typeId: 'overlay.topology', scope: otherScope } } }));
    const context = { wsMessages: { 'scope-test': [...unrelated, { data: { completedSnapshot: { route, typeId: 'overlay.topology', scope } } }] } };

    const result = await waitForWsMessages({
        interaction: {
            request: { connection: 'scope-test' },
            response: { ...wait.response, connection: 'scope-test', withinMs: 1, consume: true }
        },
        config: socketConfig,
        context
    });

    expect(result.status).toBe('SUCCESS');
    expect(context.wsMessages['scope-test']).toEqual(unrelated);
});
