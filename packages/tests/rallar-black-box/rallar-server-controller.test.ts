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
import type { UseRallarServerControllerInput } from '../../../apps/rallar-black-box/src/legacy/diagnostics/rallar-server/rallar-server-contracts.ts';
import {
    useRallarServerController,
    type RallarServerControllerModel
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/rallar-server/use-rallar-server-controller.ts';
import { UI_STORAGE_KEYS } from '../../../apps/rallar-black-box/src/ui-persistence.ts';
import { CLIPBOARD_FAILURES } from './write-text-to-clipboard-fixtures.ts';

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
    }
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
    const stored = new Map<string, string>();
    let respond: (url: string) => StubResponse;

    async function render(next: UseRallarServerControllerInput = input): Promise<void> {
        await act(async () =>
            root.render(createElement(
                StrictMode,
                null,
                createElement(RallarServerHarness, {
                    input: next,
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
        stored.clear();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => stored.get(key) ?? null,
            setItem: (key: string, value: string) => stored.set(key, value),
            removeItem: (key: string) => stored.delete(key)
        });
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
    it('follows the global base URL until the operator edits the draft, persists it redacted, and restores it as edited', async () => {
        const withBaseUrl = (apiBaseUrl: string): UseRallarServerControllerInput => ({
            ...input,
            globalValues: { ...input.globalValues, apiBaseUrl }
        });
        await render(withBaseUrl('http://localhost:18081'));
        const followed = view.apiBaseUrl;
        const preset = view.allPresets.find((entry) => entry.presetId === 'groups-list');
        await act(async () => view.applyPreset(preset!));
        await render(withBaseUrl('http://localhost:18082'));
        const kept = view.apiBaseUrl;
        const persisted = JSON.parse(stored.get(UI_STORAGE_KEYS.rallarServerDraft) ?? 'null');
        await act(async () => root.unmount());
        root = createRoot(container);
        await render(withBaseUrl('http://localhost:18083'));

        expect({
            followed,
            kept,
            persisted: [persisted?.selectedPresetId, persisted?.path, persisted?.apiBaseUrl],
            leaked: [...stored.values()].some((value) => value.includes('server-secret-token')),
            restored: [view.apiBaseUrl, view.selectedPresetId, view.path]
        }).toEqual({
            followed: 'http://localhost:18081',
            kept: 'http://localhost:18081',
            persisted: ['groups-list', '/api/state/apps/app/workspaces/workspace/groups', 'http://localhost:18081'],
            leaked: false,
            restored: ['http://localhost:18081', 'groups-list', '/api/state/apps/app/workspaces/workspace/groups']
        });
    });

    it('persists a decodable collection draft and leaves the stored draft alone for an invalid one', async () => {
        await render();
        await act(async () => view.setCollectionText(JSON.stringify({ collectionId: 'draft', name: 'Draft', steps: [] })));
        const valid = JSON.parse(stored.get(UI_STORAGE_KEYS.rallarServerCollectionDraft) ?? 'null');
        await act(async () => view.setCollectionText('{'));

        expect({
            valid: valid?.collection?.collectionId,
            afterInvalid: JSON.parse(stored.get(UI_STORAGE_KEYS.rallarServerCollectionDraft) ?? 'null')?.collection?.collectionId
        }).toEqual({ valid: 'draft', afterInvalid: 'draft' });
    });

    it('applies a collection template, appends the current request with its last status, and reports invalid collection and body JSON', async () => {
        await render();
        const template = view.collectionTemplates[1];
        await act(async () => view.applyCollectionTemplate(template.collectionId));
        const applied = [view.selectedCollectionId, JSON.parse(view.collectionText).collectionId, JSON.parse(view.collectionVariablesText)];
        await act(async () => view.applyCollectionTemplate('unknown-collection'));
        const unknownKept = view.selectedCollectionId;
        await act(async () => view.sendRequest());
        await act(async () => view.addCurrentRequestToCollection());
        const appended = JSON.parse(view.collectionText).steps.at(-1);
        await act(async () => {
            view.setMethod('POST');
            view.setBodyText('{');
        });
        await act(async () => view.addCurrentRequestToCollection());
        const bodyError = view.collectionError;
        await act(async () => view.setCollectionText('[]'));
        await act(async () => view.addCurrentRequestToCollection());

        expect({ applied, unknownKept, appended, bodyError: typeof bodyError, collectionError: view.collectionError }).toEqual({
            applied: [template.collectionId, template.collectionId, template.variables ?? {}],
            unknownKept: template.collectionId,
            appended: {
                stepId: `request-${template.steps.length + 1}`,
                label: 'Read runtime config',
                request: {
                    method: 'GET',
                    path: '/api/config',
                    headers: {},
                    query: {},
                    responseBodyMode: 'auto',
                    attachAuth: false,
                    timeoutMs: 5_000
                },
                expect: { status: 200 }
            },
            bodyError: 'string',
            collectionError: 'Collection JSON must be an object.'
        });
    });

    it('copies the redacted collection with its variables and the command preview, and derives the response views', async () => {
        respond = () => ({
            status: 200,
            body: { group: { groupId: 'room-z' }, principalId: 'principal-z', sessionId: 'session-z', token: 'server-secret-token' }
        });
        await render();
        await act(async () => view.setCollectionVariablesText('{"extra":"value"}'));
        await act(async () => view.copyCollection());
        await act(async () => view.copyCommand());
        await act(async () => view.sendRequest());

        expect({
            collectionVariables: JSON.parse(copied[0] ?? 'null')?.variables,
            command: copied[1] === view.commandPreview,
            latest: [view.latestGroupId, view.latestClientId, view.latestSessionId],
            bodyLeaks: view.responseBodyText.includes('server-secret-token'),
            headers: JSON.parse(view.responseHeadersText)['content-type']
        }).toEqual({
            collectionVariables: { extra: 'value' },
            command: true,
            latest: ['room-z', 'principal-z', 'session-z'],
            bodyLeaks: false,
            headers: 'application/json'
        });
    });

    it.each(
        CLIPBOARD_FAILURES.flatMap((failure) => [
            { ...failure, copy: 'copyCurl' as const, shown: 'localError' as const },
            { ...failure, copy: 'copyCommand' as const, shown: 'localError' as const },
            { ...failure, copy: 'copyCollection' as const, shown: 'collectionError' as const },
            { ...failure, copy: 'copyCollectionRecipe' as const, shown: 'collectionError' as const }
        ])
    )('shows $name through $shown when $copy cannot write', async ({ arrange, copy, shown, error }) => {
        await render();
        arrange();
        await act(async () => view[copy]());

        expect({ shown: view[shown], copies: copied.length }).toEqual({ shown: error, copies: 0 });
    });
});
