import {
    describe,
    expect,
    it
} from 'vitest';

import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';
import { createDefaultExecutionDependencies } from '../../shared-test/black-box-runner/execution/black-box-scenario-context.ts';
import {
    isRallarRemoteBrowserRequest,
    toRemoteHttpResponseOptions,
    validateRemoteDestination,
    validateRemotePayloadSize
} from '../../shared-test/black-box-runner/execution/remote-browser-execution.ts';
import { computeBlackBoxRunnerPlanPreflight } from '../../shared-test/black-box-runner/preflight/plan-preflight.ts';
import { computeBlackBoxRunnerEnvRequirements } from '../../shared-test/black-box-runner/preflight/preflight-env-variables.ts';
import { toRallarRemoteBrowserCommandId } from '../../shared-test/black-box-runner/remote-browser/remote-browser-commands.ts';
import { FakeRemoteBrowserControlServer } from './fake-remote-browser-control-server.ts';

const REMOTE_HTTP_STEP = { provider: 'rallar-remote-browser', path: 'https://api.example.test/widgets', method: 'GET' };
const BLOCKED_URL = 'https://blocked.example.test/widgets';

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
    const report = await executeBlackBox(
        [{ HTTP: { request: { ...REMOTE_HTTP_STEP, ...request }, response: {} }, remoteStep: {} }],
        0,
        { dependencies: { ...createDefaultExecutionDependencies(), fetch: server.fetch } }
    );
    return { server, result: report.resultsByName.remoteStep[0] };
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

    it.each<ApiJsonObject>([
        { controlServerUrl: 'http://unread.example.test' },
        { controlRunId: 'unread-run' },
        { controlAgentId: 'unread-agent' },
        { controlToken: 'unread-token' },
        {
            control: {
                baseUrl: 'http://unread.example.test',
                runId: 'unread-run',
                agentId: 'unread-agent',
                token: 'unread-token',
                pollIntervalMs: 2,
                timeoutMs: 400
            }
        }
    ])('addresses the control server only from its canonical step keys, not %j', async (request) => {
        const { server, result } = await runRemoteHttpStep(request);

        expect(server.commands.map((command) => command.kind)).toEqual(['http.request']);
        expect(result.actual.remote).toEqual({
            controlBaseUrl: 'http://localhost:5180',
            runId: 'remote-browser-run',
            agentId: 'visible-agent-local',
            pollIntervalMs: 50,
            timeoutMs: 5_000
        });
    });

    it('names a remote command from its commandId, not remoteCommandId', () => {
        const request = { remoteCommandId: 'unread-command', repeatIndex: 0 };
        expect(toRallarRemoteBrowserCommandId('http', { request }).right).toBe('rallar-remote-browser-http-r0');
        expect(toRallarRemoteBrowserCommandId('http', { request: { commandId: 'explicit-command' } }).right)
            .toBe('explicit-command');
    });
});
