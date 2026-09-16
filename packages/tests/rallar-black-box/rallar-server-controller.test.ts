// @vitest-environment happy-dom
import { resolveRallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestJsonValue,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { act, createElement, StrictMode, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    useRallarServerController,
    type RallarServerControllerModel,
    type UseRallarServerControllerInput
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/rallar-server/use-rallar-server-controller.ts';

interface RecordedRequest {
    readonly method: string;
    readonly url: string;
    readonly authorization: string | undefined;
}
interface StubResponse {
    readonly status: number;
    readonly body: RallarBlackBoxTestJsonValue;
}

const runtimeEvents = vi.hoisted(() => [] as RallarBlackBoxTestRuntimeEventInput[]);
vi.mock('../../../apps/rallar-black-box/src/runtime-store.ts', () => ({
    rallarBlackBoxRuntimeStore: { recordRuntimeEvent: (event: RallarBlackBoxTestRuntimeEventInput) => runtimeEvents.push(event) },
    rallarBlackBoxProviderModeFromConfig: () => 'browser-rallar'
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const state: RallarBlackBoxTestState = { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
const authSession: AuthSession = { clientId: 'client', sessionId: 'session', username: 'user', accessToken: 'server-secret-token', expiresAtEpochMs: 100_000 };
const input: UseRallarServerControllerInput = {
    state,
    bootstrap: resolveRallarBlackBoxBootstrapConfig('?provider=browser-rallar', {}, ''),
    authSession,
    globalValues: {
        apiBaseUrl: 'http://localhost:18080',
        applicationId: 'app',
        workspaceId: 'workspace',
        clientId: 'client',
        sessionId: 'session',
        roomId: 'room-a'
    },
    control: { state: 'idle', reconnectAttempt: 0, sentCount: 0, receivedCount: 0 },
    onGlobalValueChange: () => {}
};

function RallarServerHarness(props: { input: UseRallarServerControllerInput; capture(view: RallarServerControllerModel): void; }) {
    const view = useRallarServerController(props.input);
    useLayoutEffect(() => props.capture(view), [view, props]);
    return null;
}

describe('Rallar Server controller preservation', () => {
    let root: Root;
    let container: HTMLDivElement;
    let view: RallarServerControllerModel;
    const requests: RecordedRequest[] = [];
    const copied: string[] = [];
    let respond: (url: string) => StubResponse;

    async function render(): Promise<void> {
        await act(async () =>
            root.render(createElement(
                StrictMode,
                null,
                createElement(RallarServerHarness, {
                    input,
                    capture: (captured) => {
                        view = captured;
                    }
                })
            ))
        );
    }

    function feedback(): RallarBlackBoxTestRecord {
        const { atEpochMs: _at, durationMs: _duration, ...rest } = view.requestFeedback;
        return rest;
    }

    beforeEach(() => {
        window.localStorage?.clear();
        requests.length = 0;
        copied.length = 0;
        runtimeEvents.length = 0;
        respond = () => ({ status: 200, body: { ok: true, token: 'server-secret-token' } });
        vi.stubGlobal('fetch', async (url: string, init: RequestInit | undefined) => {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            requests.push({ method: String(init?.method ?? 'GET'), url, authorization: headers.authorization });
            const stub = respond(url);
            return new Response(JSON.stringify(stub.body), {
                status: stub.status,
                statusText: stub.status === 200 ? 'OK' : 'Internal Server Error',
                headers: { 'content-type': 'application/json' }
            });
        });
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => {
            copied.push(text);
        });
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('sends the drafted request and records its redacted start and completion', async () => {
        await render();
        await act(async () => {
            view.setPath('/api/state/apps/app/workspaces/workspace/groups');
            view.setQueryText('{"limit":2}');
        });
        await act(async () => view.sendRequest());

        expect({
            requests,
            feedback: feedback(),
            status: view.response?.status,
            responseBodyLeaksToken: view.responseBodyText.includes('server-secret-token'),
            events: runtimeEvents.map((event) => [event.topic, event.severity]),
            localError: view.localError,
            busy: view.busy
        }).toEqual({
            requests: [{ method: 'GET', url: 'http://localhost:18080/api/state/apps/app/workspaces/workspace/groups?limit=2', authorization: undefined }],
            feedback: {
                state: 'success',
                method: 'GET',
                path: '/api/state/apps/app/workspaces/workspace/groups',
                url: 'http://localhost:18080/api/state/apps/app/workspaces/workspace/groups?limit=2',
                status: 200,
                statusText: 'OK',
                errorKind: undefined,
                message: 'Request completed successfully.'
            },
            status: 200,
            responseBodyLeaksToken: false,
            events: [['rallar.server.rest.request.started', 'info'], ['rallar.server.rest.request.completed', 'info']],
            localError: undefined,
            busy: false
        });
    });

    it.each([
        { name: 'invalid headers', edit: (model: RallarServerControllerModel) => model.setHeadersText('{'), error: 'Headers JSON is invalid' },
        {
            name: 'a missing base URL',
            edit: (model: RallarServerControllerModel) => model.setApiBaseUrl(' '),
            error: 'Rallar Server API base URL is required.'
        },
        { name: 'an empty path', edit: (model: RallarServerControllerModel) => model.setPath(' '), error: 'Rallar Server request path is required.' }
    ])('reports $name as a request-build failure without sending', async ({ edit, error }) => {
        await render();
        await act(async () => edit(view));
        await act(async () => view.sendRequest());

        expect({
            requests: requests.length,
            localError: view.localError?.startsWith(error),
            feedback: [view.requestFeedback.state, view.requestFeedback.errorKind, view.requestFeedback.message?.startsWith(error)],
            events: runtimeEvents.map((event) => [event.topic, (event.payload as RallarBlackBoxTestRecord).error])
        }).toEqual({
            requests: 0,
            localError: true,
            feedback: ['error', 'request-build', true],
            events: [['rallar.server.rest.request.failed', { kind: 'request-build', message: expect.stringContaining(error) }]]
        });
    });

    it('previews and copies the black-box command and cURL, or shows why they cannot be built', async () => {
        await render();
        const preview = JSON.parse(view.commandPreview);
        await act(async () => view.copyCurl());
        await act(async () => view.setQueryText('[]'));
        const invalidPreview = view.commandPreview;
        await act(async () => view.copyCurl());

        expect({
            preview: [preview.kind, preview.commandId, preview.request.method],
            curl: copied[0]?.startsWith('curl -X GET \'http://localhost:18080/api/config\''),
            invalidPreview,
            localError: view.localError,
            copies: copied.length
        }).toEqual({
            preview: ['http.request', 'rallar-server-rest-request', 'GET'],
            curl: true,
            invalidPreview: 'Query JSON must be a JSON object.',
            localError: 'Query JSON must be a JSON object.',
            copies: 1
        });
    });

    it('loads OpenAPI presets and reports a failed OpenAPI request', async () => {
        respond = () => ({ status: 200, body: { paths: { '/api/config': { get: { summary: 'Config', tags: ['Config'] } } } } });
        await render();
        await act(async () => view.refreshOpenApi());
        const loaded = view.serverOpenApiPresets.map((preset) => [preset.presetId, preset.label, preset.method]);
        respond = () => ({ status: 500, body: {} });
        await act(async () => view.refreshOpenApi());

        expect({ loaded, localError: view.localError, busy: view.openApiBusy, url: requests[0]?.url }).toEqual({
            loaded: [['openapi-get--api-config', 'Config', 'GET']],
            localError: 'OpenAPI request failed: 500',
            busy: false,
            url: 'http://localhost:18080/api/openapi.json'
        });
    });

    it('runs a collection step by step, stopping at a failed assertion, and reports a step that cannot be built', async () => {
        respond = (url) => url.endsWith('/api/config') ? { status: 200, body: { build: 'b-1' } } : { status: 500, body: {} };
        await render();
        const collection = {
            collectionId: 'probe',
            name: 'Probe',
            steps: [
                {
                    stepId: 'config',
                    label: 'Config',
                    request: { method: 'GET', path: '/api/config' },
                    expect: { status: 200 },
                    extract: [{ name: 'build', path: '$.build' }]
                },
                { stepId: 'broken', label: 'Broken', request: { method: 'GET', path: '/api/broken/{{build}}' }, expect: { status: 200 } },
                { stepId: 'never', label: 'Never', request: { method: 'GET', path: '/api/never' } }
            ]
        };
        await act(async () => {
            view.setCollectionText(JSON.stringify(collection));
            view.setCollectionVariablesText('{}');
        });
        await act(async () => view.runCollection());
        const ran = {
            urls: requests.map((request) => request.url),
            results: view.collectionResults.map((result) => [result.stepId, result.ok, result.extracted]),
            variables: JSON.parse(view.collectionVariablesText)
        };
        await act(async () =>
            view.setCollectionText(JSON.stringify({ ...collection, steps: [{ stepId: 'auth', label: 'Auth', request: { method: 'GET', path: '' } }] }))
        );
        await act(async () => view.runCollection());

        expect({ ran, error: view.collectionError, results: view.collectionResults.length }).toEqual({
            ran: {
                urls: ['http://localhost:18080/api/config', 'http://localhost:18080/api/broken/b-1'],
                results: [['config', true, { build: 'b-1' }], ['broken', false, {}]],
                variables: { build: 'b-1' }
            },
            error: 'Rallar Server request path is required.',
            results: 0
        });
    });

    it('copies the collection recipe as a strict version-1 recipe and reports invalid collection JSON', async () => {
        await render();
        await act(async () => view.copyCollectionRecipe());
        const recipe = JSON.parse(copied[0] ?? 'null');
        await act(async () => view.setCollectionText('{"name":"no id"}'));
        await act(async () => view.copyCollectionRecipe());

        expect({
            valid: validateRallarBlackBoxTestCommand({ kind: 'recipe.load', recipe }),
            error: view.collectionError,
            copies: copied.length
        }).toEqual({
            valid: { ok: true },
            error: 'Collection JSON requires collectionId, name, and steps.',
            copies: 1
        });
    });
});
