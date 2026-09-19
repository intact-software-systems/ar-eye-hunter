import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    describe,
    expect,
    it
} from 'vitest';

import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';
import { resolveBlackBoxVariables } from '../../shared-test/black-box-runner/execution/black-box-run-secrets.ts';
import {
    createDefaultExecutionDependencies,
    type BlackBoxFetch
} from '../../shared-test/black-box-runner/execution/black-box-scenario-context.ts';
import {
    isRallarRemoteBrowserRequest,
    toRemoteHttpResponseOptions,
    validateRemoteDestination,
    validateRemotePayloadSize
} from '../../shared-test/black-box-runner/execution/remote-browser-execution.ts';
import { computeBlackBoxRunnerPlanPreflight } from '../../shared-test/black-box-runner/preflight/plan-preflight.ts';
import { computeBlackBoxRunnerEnvRequirements } from '../../shared-test/black-box-runner/preflight/preflight-env-variables.ts';
import type { ScenarioRecipe } from '../../shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts';
import { toExecutableInteractions } from '../../shared-test/black-box-runner/recipes/to-executable-interactions.ts';
import { toRallarRemoteBrowserCommandId } from '../../shared-test/black-box-runner/remote-browser/remote-browser-commands.ts';
import { FakeRemoteBrowserControlServer } from './fake-remote-browser-control-server.ts';

const REMOTE_HTTP_STEP = { provider: 'rallar-remote-browser', path: 'https://api.example.test/widgets', method: 'GET' };
const BLOCKED_URL = 'https://blocked.example.test/widgets';
const DEFAULT_REMOTE_CONFIG = {
    controlBaseUrl: 'http://localhost:5180',
    runId: 'remote-browser-run',
    agentId: 'visible-agent-local',
    pollIntervalMs: 50,
    timeoutMs: 5_000
};
const EXAMPLES_ROOT = fileURLToPath(new URL('../../shared-test/black-box-runner/examples', import.meta.url));
// Every checked-in recipe that runs its RTC connections through rallar-remote-browser addresses the control server
// through a connection control block.
const REMOTE_BROWSER_EXAMPLES = [
    'rtc-rallar-browser-provider-mode-parity.json',
    'rtc-rallar-browser-messages-rtc-parallel-groups.json',
    'rtc-rallar-browser-messages-rtc-same-connection-soak.json',
    'rtc-rallar-browser-messages-rtc-seeded-traffic.json'
];
const EXAMPLE_ENVIRONMENT = {
    RALLAR_BB_RTC_PROVIDER: 'rallar-remote-browser',
    RALLAR_BLACK_BOX_CONTROL_BASE_URL: 'http://control.recipe.test',
    RALLAR_BLACK_BOX_RUN_ID: 'recipe-run',
    RALLAR_BLACK_BOX_AGENT_ID: 'recipe-agent'
};

interface ControlRequest {
    readonly url: string;
    readonly authorization: string | null;
}

function computeProviderModes(request: ApiJsonObject): readonly string[] {
    const recipe = { steps: [] };
    return computeBlackBoxRunnerPlanPreflight({
        rawConfig: recipe,
        expandedConfig: recipe,
        executableInteractions: [{ HTTP: { request, response: {} }, remoteStep: {} }],
        envRequirements: computeBlackBoxRunnerEnvRequirements(recipe, {}),
        profile: 'compat'
    }).providerModes;
}

async function runRemoteHttpStep(request: ApiJsonObject) {
    const server = new FakeRemoteBrowserControlServer();
    const controlRequests: ControlRequest[] = [];
    const fetch: BlackBoxFetch = (input, init) => {
        controlRequests.push({ url: String(input), authorization: new Headers(init?.headers).get('Authorization') });
        return server.fetch(input, init);
    };
    const report = await executeBlackBox(
        [{ HTTP: { request: { ...REMOTE_HTTP_STEP, ...request }, response: {} }, remoteStep: {} }],
        0,
        { dependencies: { ...createDefaultExecutionDependencies(), fetch } }
    );
    return { server, controlRequests, result: report.resultsByName.remoteStep[0] };
}

async function runExampleConnect(exampleFile: string) {
    const recipe: ScenarioRecipe = JSON.parse(readFileSync(path.join(EXAMPLES_ROOT, exampleFile), 'utf8'));
    const { variables } = resolveBlackBoxVariables(recipe.variables, EXAMPLE_ENVIRONMENT);
    const connectAlice = toExecutableInteractions({ ...recipe, variables })
        .filter((interaction) => 'connectAlice' in interaction);
    const server = new FakeRemoteBrowserControlServer();
    const report = await executeBlackBox(connectAlice, 0, {
        dependencies: { ...createDefaultExecutionDependencies(), fetch: server.fetch }
    });
    return report.resultsByName.connectAlice[0];
}

describe('remote-browser step keys', () => {
    it.each<ApiJsonObject>([
        { remoteProvider: 'rallar-remote-browser' },
        { remoteBrowser: true },
        { browser: 'rallar-remote-browser' },
        { control: { provider: 'rallar-remote-browser' } },
        { control: { mode: 'remote-browser' } },
        { control: { remoteBrowser: true } }
    ])('selects the remote browser only through the step provider, not %j', (request) => {
        expect(isRallarRemoteBrowserRequest(request)).toBe(false);
        expect(isRallarRemoteBrowserRequest({ ...request, provider: 'rallar-remote-browser' })).toBe(true);
    });

    it.each<ApiJsonObject>([
        { remoteProvider: 'rallar-remote-browser' },
        { control: { provider: 'rallar-remote-browser' } }
    ])('lists a remote-browser provider in preflight only from the step provider, not %j', (request) => {
        expect(computeProviderModes(request)).not.toContain('rallar-remote-browser');
        expect(computeProviderModes({ ...request, provider: 'rallar-remote-browser' })).toContain('rallar-remote-browser');
    });

    it.each<ApiJsonObject>([
        { remoteResponseBody: 'json' },
        { responseBody: 'json' },
        { bodyMode: 'json' },
        { responseMaxBodyChars: 10 }
    ])('reads the remote response body mode and size only from their step keys, not %j', (request) => {
        expect(toRemoteHttpResponseOptions(request)).toEqual({ body: 'text' });
        expect(toRemoteHttpResponseOptions({ ...request, responseBodyMode: 'json', maxBodyChars: 10 }))
            .toEqual({ body: 'json', maxBodyChars: 10 });
    });

    it.each<ApiJsonObject>([
        { remoteAllowedHosts: ['api.example.test'] },
        { remoteAllowedOrigins: ['https://api.example.test'] },
        { control: { allowedHosts: ['api.example.test'] } },
        { control: { allowedOrigins: ['https://api.example.test'] } }
    ])('restricts remote destinations only through allowedHosts and allowedOrigins, not %j', (request) => {
        const context = { options: {} };
        expect(validateRemoteDestination({ request, context, url: BLOCKED_URL, label: 'HTTP' })).toEqual([]);
        expect(
            validateRemoteDestination({
                request: { ...request, allowedHosts: ['api.example.test'] },
                context,
                url: BLOCKED_URL,
                label: 'HTTP'
            })
        ).toEqual(['HTTP destination is not allowed for remote browser execution: https://blocked.example.test']);
    });

    it.each([
        { request: { maxRemotePayloadBytes: 4 }, runnerOptions: {} },
        { request: { control: { maxPayloadBytes: 4 } }, runnerOptions: {} },
        { request: {}, runnerOptions: { maxRemotePayloadBytes: 4 } }
    ])('limits remote payloads only through maxPayloadBytes, not %j', ({ request, runnerOptions }) => {
        const context = { options: { rallarRemoteBrowser: runnerOptions } };
        const input = { context, value: 'too-large-payload', label: 'HTTP request' };
        expect(validateRemotePayloadSize({ ...input, request })).toEqual([]);
        expect(validateRemotePayloadSize({ ...input, request: { ...request, maxPayloadBytes: 4 } })).toHaveLength(1);
    });

    it('addresses the control server through the step control block', async () => {
        const { server, controlRequests, result } = await runRemoteHttpStep({
            control: {
                baseUrl: 'http://control.example.test',
                runId: 'block-run',
                agentId: 'block-agent',
                token: 'block-token',
                pollIntervalMs: 2,
                timeoutMs: 400
            }
        });

        expect(server.commands.map((command) => command.kind)).toEqual(['http.request']);
        expect(controlRequests).toContainEqual({
            url: 'http://control.example.test/runs/block-run/agents/block-agent/commands',
            authorization: 'Bearer block-token'
        });
        expect(result.actual.remote).toMatchObject({
            controlBaseUrl: 'http://control.example.test',
            runId: 'block-run',
            agentId: 'block-agent',
            pollIntervalMs: 2,
            timeoutMs: 400
        });
    });

    it.each<ApiJsonObject>([
        { controlBaseUrl: 'http://unread.example.test' },
        { controlServerUrl: 'http://unread.example.test' },
        { runId: 'unread-run' },
        { controlRunId: 'unread-run' },
        { agentId: 'unread-agent' },
        { controlAgentId: 'unread-agent' },
        { token: 'unread-token' },
        { controlToken: 'unread-token' },
        { pollIntervalMs: 2 }
    ])('addresses the control server only through the step control block, not %j', async (request) => {
        const { server, controlRequests, result } = await runRemoteHttpStep(request);

        expect(server.commands.map((command) => command.kind)).toEqual(['http.request']);
        expect(controlRequests.map((controlRequest) => controlRequest.authorization)).not.toContain(
            'Bearer unread-token'
        );
        expect(result.actual.remote).toEqual(DEFAULT_REMOTE_CONFIG);
    });

    it('waits for a remote command at least as long as the step timeout the browser runs it under', async () => {
        const { result } = await runRemoteHttpStep({ timeoutMs: 900, control: { timeoutMs: 400 } });

        expect(result.actual.remote).toEqual({ ...DEFAULT_REMOTE_CONFIG, timeoutMs: 900 });
    });

    it.each(REMOTE_BROWSER_EXAMPLES)(
        'connects the example %s through the control server its connection control block names',
        async (exampleFile) => {
            const result = await runExampleConnect(exampleFile);

            expect(result.status).toBe('SUCCESS');
            expect(result.actual.remote).toEqual({
                controlBaseUrl: 'http://control.recipe.test',
                runId: 'recipe-run',
                agentId: 'recipe-agent',
                pollIntervalMs: 50,
                timeoutMs: 15_000
            });
        }
    );

    it('names a remote command from its commandId, not remoteCommandId', () => {
        const request = { remoteCommandId: 'unread-command', repeatIndex: 0 };
        expect(toRallarRemoteBrowserCommandId('http', { request }).right).toBe('rallar-remote-browser-http-r0');
        expect(toRallarRemoteBrowserCommandId('http', { request: { commandId: 'explicit-command' } }).right)
            .toBe('explicit-command');
    });
});
