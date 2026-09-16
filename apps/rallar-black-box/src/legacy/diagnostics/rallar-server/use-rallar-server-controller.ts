import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import { useEffect, useMemo, useState } from 'react';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import { computeRallarServerRestAssertions } from '../../../rallar-server-workbench/compute-rallar-server-rest-assertions.ts';
import {
    createRallarServerRestCollectionTemplates
} from '../../../rallar-server-workbench/create-rallar-server-rest-collection-templates.ts';
import { RALLAR_SERVER_ENDPOINT_PRESETS } from '../../../rallar-server-workbench/rallar-server-endpoint-presets.ts';
import type {
    RallarServerEndpointPreset,
    RallarServerResponseBodyMode,
    RallarServerRestCollection,
    RallarServerRestCollectionStepResult,
    RallarServerRestCollectionVariables,
    RallarServerRestMethod,
    RallarServerRestRequest,
    RallarServerRestRequestInput,
    RallarServerRestResponse
} from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import { readRallarServerOpenApiEndpoints } from '../../../rallar-server-workbench/read-rallar-server-open-api-endpoints.ts';
import {
    redactRallarServerText,
    redactRallarServerUrl,
    redactRallarServerValue
} from '../../../rallar-server-workbench/redact-rallar-server-value.ts';
import { sendRallarServerRestRequest } from '../../../rallar-server-workbench/send-rallar-server-rest-request.ts';
import { toRallarServerBlackBoxCommand } from '../../../rallar-server-workbench/to-rallar-server-black-box-command.ts';
import { toRallarServerCollectionStepRequestInput } from '../../../rallar-server-workbench/to-rallar-server-collection-step-request-input.ts';
import { toRallarServerCurl } from '../../../rallar-server-workbench/to-rallar-server-curl.ts';
import { toRallarServerEndpointDraft } from '../../../rallar-server-workbench/to-rallar-server-endpoint-draft.ts';
import { toRallarServerExtractedVariables } from '../../../rallar-server-workbench/to-rallar-server-extracted-variables.ts';
import { toRallarServerRestCollectionRecipe } from '../../../rallar-server-workbench/to-rallar-server-rest-collection-recipe.ts';
import { toRallarServerRestRequest } from '../../../rallar-server-workbench/to-rallar-server-rest-request.ts';
import { toRallarServerWorkbenchVariables } from '../../../rallar-server-workbench/to-rallar-server-workbench-variables.ts';
import {
    rallarBlackBoxProviderModeFromConfig,
    rallarBlackBoxRuntimeStore,
    type RallarBlackBoxBootstrapConfig
} from '../../../runtime-store.ts';
import {
    readRallarServerRestCollectionDraft,
    readRallarServerWorkbenchDraft,
    writeRallarServerRestCollectionDraft,
    writeRallarServerWorkbenchDraft,
    type RallarServerRestCollectionDraft,
    type RallarServerWorkbenchDraft
} from '../../../ui-persistence.ts';
import { json } from '../../shared/json-presentation.ts';
import { redactedJson, uiSecretValues } from '../../shared/redaction-presentation.ts';
import { browserUiStorage } from '../../shell/browser-ui-storage.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { findStringDeep } from '../shared/deep-string-value.ts';
import {
    decodeRallarServerCollectionText,
    decodeRallarServerCollectionVariablesText
} from './decode-rallar-server-collection-text.ts';
import type { RallarServerRequestFeedback } from './rallar-server-contracts.ts';

export type UseRallarServerControllerInput = Readonly<{
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    control: RallarBlackBoxControlSnapshot;
    onGlobalValueChange?<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K]
    ): void;
}>;

export function useRallarServerController({
    state,
    bootstrap,
    authSession,
    globalValues
}: UseRallarServerControllerInput) {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const providerMode = rallarBlackBoxProviderModeFromConfig(config);
    const variables = useMemo(
        () =>
            toRallarServerWorkbenchVariables({
                hints: {
                    applicationId: globalValues?.applicationId,
                    workspaceId: globalValues?.workspaceId,
                    principalId: globalValues?.clientId ??
                        authSession?.clientId ??
                        config?.actor ??
                        bootstrap.actor,
                    sessionId: globalValues?.sessionId ??
                        authSession?.sessionId ??
                        config?.sessionId ??
                        bootstrap.sessionId,
                    groupId: globalValues?.roomId ?? config?.roomId ?? bootstrap.roomId,
                    username: authSession?.username ?? config?.actor ?? bootstrap.actor
                },
                createOpaqueId: () => crypto.randomUUID()
            }),
        [
            authSession?.clientId,
            authSession?.sessionId,
            authSession?.username,
            bootstrap.actor,
            bootstrap.roomId,
            bootstrap.sessionId,
            config?.actor,
            config?.roomId,
            config?.sessionId,
            globalValues?.applicationId,
            globalValues?.clientId,
            globalValues?.roomId,
            globalValues?.sessionId,
            globalValues?.workspaceId
        ]
    );
    const initialDraft = useMemo(
        () =>
            toRallarServerEndpointDraft(
                RALLAR_SERVER_ENDPOINT_PRESETS[0],
                variables
            ),
        [variables]
    );
    const defaultServerDraft = useMemo<RallarServerWorkbenchDraft>(
        () => ({
            apiBaseUrl: globalValues?.apiBaseUrl ??
                config?.apiBaseUrl ??
                bootstrap.apiBaseUrl,
            selectedPresetId: RALLAR_SERVER_ENDPOINT_PRESETS[0].presetId,
            method: initialDraft.method,
            path: initialDraft.path,
            headersText: initialDraft.headersText,
            queryText: initialDraft.queryText,
            bodyText: initialDraft.bodyText,
            responseBodyMode: initialDraft.responseBodyMode,
            attachAuth: initialDraft.attachAuth,
            timeoutMs: 5_000
        }),
        [
            bootstrap.apiBaseUrl,
            config?.apiBaseUrl,
            globalValues?.apiBaseUrl,
            initialDraft
        ]
    );
    const collectionTemplates = useMemo(
        () => createRallarServerRestCollectionTemplates(variables),
        [variables]
    );
    const defaultCollectionDraft = useMemo<RallarServerRestCollectionDraft>(() => {
        const collection = collectionTemplates[0];
        return {
            selectedCollectionId: collection.collectionId,
            collection,
            variables: collection.variables ?? {}
        };
    }, [collectionTemplates]);
    const [initialServerDraft] = useState(() => {
        const stored = readRallarServerWorkbenchDraft(
            browserUiStorage(),
            defaultServerDraft
        );
        return {
            draft: stored ?? defaultServerDraft,
            restored: Boolean(stored)
        };
    });
    const [initialCollectionDraft] = useState(
        () =>
            readRallarServerRestCollectionDraft(
                browserUiStorage(),
                defaultCollectionDraft
            ) ?? defaultCollectionDraft
    );
    const [serverDraftEdited, setServerDraftEdited] = useState(
        initialServerDraft.restored
    );
    const [apiBaseUrl, setApiBaseUrl] = useState(
        initialServerDraft.draft.apiBaseUrl
    );
    const [selectedPresetId, setSelectedPresetId] = useState(
        initialServerDraft.draft.selectedPresetId
    );
    const [serverOpenApiPresets, setServerOpenApiPresets] = useState<readonly RallarServerEndpointPreset[]>([]);
    const [method, setMethod] = useState<RallarServerRestMethod>(
        initialServerDraft.draft.method
    );
    const [path, setPath] = useState(initialServerDraft.draft.path);
    const [headersText, setHeadersText] = useState(
        initialServerDraft.draft.headersText
    );
    const [queryText, setQueryText] = useState(
        initialServerDraft.draft.queryText
    );
    const [bodyText, setBodyText] = useState(initialServerDraft.draft.bodyText);
    const [responseBodyMode, setResponseBodyMode] = useState<RallarServerResponseBodyMode>(
        initialServerDraft.draft.responseBodyMode
    );
    const [attachAuth, setAttachAuth] = useState(
        initialServerDraft.draft.attachAuth
    );
    const [timeoutMs, setTimeoutMs] = useState(
        initialServerDraft.draft.timeoutMs
    );
    const [busy, setBusy] = useState(false);
    const [openApiBusy, setOpenApiBusy] = useState(false);
    const [localError, setLocalError] = useState<string | undefined>();
    const [response, setResponse] = useState<RallarServerRestResponse | undefined>();
    const [requestFeedback, setRequestFeedback] = useState<RallarServerRequestFeedback>({
        state: 'idle'
    });
    const [selectedCollectionId, setSelectedCollectionId] = useState(
        initialCollectionDraft.selectedCollectionId
    );
    const [collectionText, setCollectionText] = useState(() => json(initialCollectionDraft.collection));
    const [collectionVariablesText, setCollectionVariablesText] = useState(() =>
        json(initialCollectionDraft.variables)
    );
    const [collectionBusy, setCollectionBusy] = useState(false);
    const [collectionError, setCollectionError] = useState<string | undefined>();
    const [collectionResults, setCollectionResults] = useState<readonly RallarServerRestCollectionStepResult[]>([]);
    const allPresets = useMemo(
        () => [...RALLAR_SERVER_ENDPOINT_PRESETS, ...serverOpenApiPresets],
        [serverOpenApiPresets]
    );
    const activePreset = allPresets.find((preset) => preset.presetId === selectedPresetId) ??
        RALLAR_SERVER_ENDPOINT_PRESETS[0];
    const requestInput: RallarServerRestRequestInput = {
        apiBaseUrl,
        method,
        path,
        headersText,
        queryText,
        bodyText,
        responseBodyMode,
        attachAuth,
        timeoutMs,
        authSession,
        forbidPlaceholderBaseUrl: providerMode === 'browser-rallar'
    };
    const commandPreview = useMemo(
        () =>
            toRallarServerBlackBoxCommand({ request: requestInput, commandId: 'rallar-server-rest-request' }).fold(
                (error) => error,
                (command) => json(redactRallarServerValue(command, authSession))
            ),
        [requestInput]
    );
    const responseBodyText = response
        ? response.bodyKind === 'json'
            ? json(redactRallarServerValue(response.bodyJson, authSession))
            : response.bodyText
            ? redactRallarServerText(response.bodyText, authSession)
            : '-'
        : 'No response';
    const responseHeadersText = response
        ? json(redactRallarServerValue(response.headers, authSession))
        : '{}';
    const latestBody = response?.bodyJson;
    const latestGroupId = findStringDeep(latestBody, ['groupId', 'roomId']);
    const latestClientId = findStringDeep(latestBody, [
        'clientId',
        'principalId',
        'username'
    ]);
    const latestSessionId = findStringDeep(latestBody, ['sessionId']);
    useEffect(() => {
        if (!serverDraftEdited) {
            setApiBaseUrl(
                globalValues?.apiBaseUrl ??
                    config?.apiBaseUrl ??
                    bootstrap.apiBaseUrl
            );
        }
    }, [
        bootstrap.apiBaseUrl,
        config?.apiBaseUrl,
        globalValues?.apiBaseUrl,
        serverDraftEdited
    ]);
    useEffect(() => {
        writeRallarServerWorkbenchDraft(
            browserUiStorage(),
            {
                apiBaseUrl,
                selectedPresetId,
                method,
                path,
                headersText,
                queryText,
                bodyText,
                responseBodyMode,
                attachAuth,
                timeoutMs
            },
            uiSecretValues(undefined, authSession)
        );
    }, [
        apiBaseUrl,
        attachAuth,
        authSession?.accessToken,
        bodyText,
        headersText,
        method,
        path,
        queryText,
        responseBodyMode,
        selectedPresetId,
        timeoutMs
    ]);
    useEffect(() => {
        decodeCollectionDraft(collectionText, collectionVariablesText).foldRight(({ collection, variables }) =>
            writeRallarServerRestCollectionDraft(
                browserUiStorage(),
                { selectedCollectionId, collection, variables },
                uiSecretValues(undefined, authSession)
            )
        );
    }, [
        authSession?.accessToken,
        collectionText,
        collectionVariablesText,
        selectedCollectionId
    ]);
    const applyPreset = (preset: RallarServerEndpointPreset): void => {
        const draft = toRallarServerEndpointDraft(preset, variables);
        setServerDraftEdited(true);
        setSelectedPresetId(preset.presetId);
        setMethod(draft.method);
        setPath(draft.path);
        setHeadersText(draft.headersText);
        setQueryText(draft.queryText);
        setBodyText(draft.bodyText);
        setResponseBodyMode(draft.responseBodyMode);
        setAttachAuth(draft.attachAuth);
        setLocalError(undefined);
    };
    const recordRequestFailure = (summary: RallarServerRequestFeedback, message: string): void => {
        setLocalError(message);
        setRequestFeedback({
            ...summary,
            state: 'error',
            errorKind: 'request-build',
            message,
            atEpochMs: Date.now()
        });
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            {
                kind: 'diagnostic',
                topic: 'rallar.server.rest.request.failed',
                severity: 'error',
                actor: authSession?.username,
                payload: {
                    method: summary.method,
                    path: summary.path,
                    url: summary.url ? redactRallarServerUrl(summary.url, authSession) : undefined,
                    error: { kind: 'request-build', message: redactRallarServerText(message, authSession) }
                }
            },
            `Rallar Server ${summary.method ?? 'REST'} request failed`
        );
    };
    const recordRequestStarted = (request: RallarServerRestRequest): RallarServerRequestFeedback => {
        const summary: RallarServerRequestFeedback = {
            state: 'sending',
            method: request.method,
            path,
            url: request.url,
            atEpochMs: Date.now()
        };
        setRequestFeedback(summary);
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            {
                kind: 'event',
                topic: 'rallar.server.rest.request.started',
                severity: 'info',
                actor: authSession?.username,
                payload: {
                    method: request.method,
                    path,
                    url: redactRallarServerUrl(request.url, authSession),
                    attachAuth,
                    responseBodyMode,
                    timeoutMs
                }
            },
            `Rallar Server ${request.method} request started`
        );
        return summary;
    };
    const recordResponse = (request: RallarServerRestRequest, nextResponse: RallarServerRestResponse): void => {
        setResponse(nextResponse);
        setRequestFeedback({
            state: nextResponse.ok ? 'success' : 'error',
            method: request.method,
            path,
            url: nextResponse.url,
            status: nextResponse.status,
            statusText: nextResponse.statusText,
            durationMs: nextResponse.durationMs,
            errorKind: nextResponse.error?.kind,
            message: nextResponse.error?.message ??
                (nextResponse.ok ? 'Request completed successfully.' : 'Request failed.'),
            atEpochMs: Date.now()
        });
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            {
                kind: nextResponse.ok ? 'event' : 'diagnostic',
                topic: nextResponse.ok ? 'rallar.server.rest.request.completed' : 'rallar.server.rest.request.failed',
                severity: nextResponse.ok ? 'info' : 'error',
                actor: authSession?.username,
                payload: { method: request.method, path, ...toRedactedResponsePayload(nextResponse, authSession) }
            },
            `Rallar Server ${request.method} request ${nextResponse.ok ? 'completed' : 'failed'}`
        );
    };
    const sendRequest = async (): Promise<void> => {
        setBusy(true);
        setLocalError(undefined);
        setResponse(undefined);
        let requestSummary: RallarServerRequestFeedback = {
            state: 'sending',
            method,
            path,
            atEpochMs: Date.now()
        };
        try {
            await toRallarServerRestRequest(requestInput).fold(
                async (message) => recordRequestFailure(requestSummary, message),
                async (request) => {
                    requestSummary = recordRequestStarted(request);
                    const sent = await sendRallarServerRestRequest({ request: requestInput, fetch });
                    sent.fold(
                        (message) => recordRequestFailure(requestSummary, message),
                        (nextResponse) => recordResponse(request, nextResponse)
                    );
                }
            );
        }
        catch (error) {
            recordRequestFailure(requestSummary, error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    };
    const refreshOpenApi = async (): Promise<void> => {
        setOpenApiBusy(true);
        setLocalError(undefined);
        try {
            const read = await readRallarServerOpenApiEndpoints({ apiBaseUrl, fetch });
            read.fold(setLocalError, setServerOpenApiPresets);
        }
        finally {
            setOpenApiBusy(false);
        }
    };
    const copyCurl = (): void => {
        toRallarServerCurl(requestInput).fold(setLocalError, (curl) => {
            void navigator.clipboard?.writeText(curl);
        });
    };
    const copyCommand = (): void => {
        void navigator.clipboard?.writeText(commandPreview);
    };
    const applyCollectionTemplate = (collectionId: string): void => {
        const template = collectionTemplates.find(
            (entry) => entry.collectionId === collectionId
        );
        if (!template) {
            return;
        }
        setSelectedCollectionId(template.collectionId);
        setCollectionText(json(template));
        setCollectionVariablesText(json(template.variables ?? {}));
        setCollectionResults([]);
        setCollectionError(undefined);
    };
    const addCurrentRequestToCollection = (): void => {
        decodeRallarServerCollectionText(collectionText).fold(
            setCollectionError,
            (collection) => addRequestToCollection(collection)
        );
    };
    const addRequestToCollection = (collection: RallarServerRestCollection): void => {
        try {
            const bodyValue = bodyText.trim().length === 0 || method === 'GET'
                ? undefined
                : (JSON.parse(bodyText) as unknown);
            const nextStep = {
                stepId: `request-${collection.steps.length + 1}`,
                label: activePreset.label,
                request: {
                    method,
                    path,
                    headers: JSON.parse(headersText || '{}') as Record<string, unknown>,
                    query: JSON.parse(queryText || '{}') as Record<string, unknown>,
                    ...(bodyValue === undefined ? {} : { body: bodyValue }),
                    responseBodyMode,
                    attachAuth,
                    timeoutMs
                },
                expect: {
                    status: response?.status ?? 200
                }
            };
            setCollectionText(
                json({
                    ...collection,
                    steps: [...collection.steps, nextStep]
                })
            );
            setCollectionError(undefined);
        }
        catch (error) {
            setCollectionError(
                error instanceof Error ? error.message : String(error)
            );
        }
    };
    const runCollectionSteps = async (
        collection: RallarServerRestCollection,
        variables: RallarServerRestCollectionVariables
    ): Promise<void> => {
        let collectionVariables = variables;
        const nextResults: RallarServerRestCollectionStepResult[] = [];
        for (const step of collection.steps) {
            const sent = await sendRallarServerRestRequest({
                request: toRallarServerCollectionStepRequestInput({
                    step,
                    apiBaseUrl,
                    variables: collectionVariables,
                    authSession,
                    defaultTimeoutMs: timeoutMs,
                    forbidPlaceholderBaseUrl: providerMode === 'browser-rallar'
                }),
                fetch
            });
            const result = sent.fold(
                (message) => {
                    setCollectionError(message);
                    return undefined;
                },
                (stepResponse) => toCollectionStepResult(step, stepResponse, collectionVariables)
            );
            if (!result) {
                return;
            }
            nextResults.push(result);
            setCollectionResults([...nextResults]);
            collectionVariables = { ...collectionVariables, ...result.extracted };
            setCollectionVariablesText(json(collectionVariables));
            if (!result.ok) {
                return;
            }
        }
    };
    const runCollection = async (): Promise<void> => {
        setCollectionBusy(true);
        setCollectionError(undefined);
        setCollectionResults([]);
        try {
            await decodeCollectionDraft(collectionText, collectionVariablesText).fold(
                async (message) => setCollectionError(message),
                ({ collection, variables }) =>
                    runCollectionSteps(collection, { ...(collection.variables ?? {}), ...variables })
            );
        }
        catch (error) {
            setCollectionError(
                error instanceof Error ? error.message : String(error)
            );
        }
        finally {
            setCollectionBusy(false);
        }
    };
    const copyCollection = (): void => {
        decodeCollectionDraft(collectionText, collectionVariablesText).fold(
            setCollectionError,
            ({ collection, variables }) => {
                void navigator.clipboard?.writeText(redactedJson({ ...collection, variables }, state, authSession));
            }
        );
    };
    const copyCollectionRecipe = (): void => {
        decodeCollectionDraft(collectionText, collectionVariablesText)
            .flatMap(
                (error) => Either.ofLeft(error),
                ({ collection, variables }) =>
                    toRallarServerRestCollectionRecipe({
                        collection,
                        apiBaseUrl,
                        variables,
                        authSession,
                        defaultTimeoutMs: timeoutMs,
                        forbidPlaceholderBaseUrl: providerMode === 'browser-rallar'
                    })
            )
            .fold(setCollectionError, (recipe) => {
                void navigator.clipboard?.writeText(redactedJson(recipe, state, authSession));
            });
    };

    return {
        providerMode,
        apiBaseUrl,
        config,
        serverOpenApiPresets,
        method,
        path,
        selectedPresetId,
        allPresets,
        applyPreset,
        setServerDraftEdited,
        setApiBaseUrl,
        setMethod,
        timeoutMs,
        setTimeoutMs,
        setPath,
        responseBodyMode,
        setResponseBodyMode,
        attachAuth,
        setAttachAuth,
        queryText,
        setQueryText,
        headersText,
        setHeadersText,
        bodyText,
        setBodyText,
        sendRequest,
        busy,
        activePreset,
        refreshOpenApi,
        openApiBusy,
        copyCurl,
        copyCommand,
        latestGroupId,
        latestClientId,
        latestSessionId,
        requestFeedback,
        localError,
        collectionResults,
        selectedCollectionId,
        applyCollectionTemplate,
        collectionTemplates,
        addCurrentRequestToCollection,
        runCollection,
        collectionBusy,
        copyCollection,
        copyCollectionRecipe,
        collectionVariablesText,
        setCollectionVariablesText,
        collectionText,
        setCollectionText,
        collectionError,
        response,
        responseBodyText,
        responseHeadersText,
        commandPreview
    };
}

export type RallarServerControllerModel = ReturnType<typeof useRallarServerController>;

interface RallarServerCollectionDraftValues {
    readonly collection: RallarServerRestCollection;
    readonly variables: RallarServerRestCollectionVariables;
}

function decodeCollectionDraft(
    collectionText: string,
    variablesText: string
): Either<string, RallarServerCollectionDraftValues> {
    return decodeRallarServerCollectionText(collectionText).flatMap(
        (error) => Either.ofLeft(error),
        (collection) =>
            decodeRallarServerCollectionVariablesText(variablesText).mapRight((variables) => ({
                collection,
                variables
            }))
    );
}

function toRedactedResponsePayload(response: RallarServerRestResponse, authSession: AuthSession | undefined) {
    return {
        url: redactRallarServerUrl(response.url, authSession),
        status: response.status,
        statusText: response.statusText,
        durationMs: response.durationMs,
        error: response.error,
        bodyKind: response.bodyKind,
        bodyText: response.bodyText ? redactRallarServerText(response.bodyText, authSession) : undefined,
        bodyJson: response.bodyJson === undefined ? undefined : redactRallarServerValue(response.bodyJson, authSession)
    };
}

function toCollectionStepResult(
    step: RallarServerRestCollection['steps'][number],
    response: RallarServerRestResponse,
    variables: RallarServerRestCollectionVariables
): RallarServerRestCollectionStepResult {
    const assertions = computeRallarServerRestAssertions({ response, expectation: step.expect, variables });
    return {
        stepId: step.stepId,
        label: step.label,
        ok: assertions.every((assertion) => assertion.ok),
        response,
        assertions,
        extracted: toRallarServerExtractedVariables(response, step.extract)
    };
}
