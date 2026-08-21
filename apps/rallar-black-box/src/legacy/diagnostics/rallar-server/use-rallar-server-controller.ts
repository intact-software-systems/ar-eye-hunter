import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { useEffect, useMemo, useState } from 'react';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import {
    applyRallarServerEndpointPreset,
    assertRallarServerRestResponse,
    buildRallarServerCollectionStepRequestInput,
    buildRallarServerRestRequest,
    defaultRallarServerWorkbenchVariables,
    executeRallarServerRestRequest,
    extractRallarServerRestVariables,
    fetchRallarServerOpenApiEndpoints,
    RALLAR_SERVER_ENDPOINT_PRESETS,
    redactRallarServerText,
    redactRallarServerUrl,
    redactRallarServerValue,
    toRallarServerBlackBoxCommand,
    toRallarServerCurl,
    toRallarServerRestCollectionRecipe,
    type RallarServerRestCollectionStepResult,
    type RallarServerRestCollectionVariables,
    type RallarServerRestRequestInput,
    type RallarServerRestResponse
} from '../../../rallar-server-workbench.ts';
import {
    createRallarServerRestCollectionTemplates
} from '../../../rallar-server-workbench/create-rallar-server-rest-collection-templates.ts';
import type {
    RallarServerEndpointPreset,
    RallarServerResponseBodyMode,
    RallarServerRestMethod
} from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
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
import type { RallarServerRequestFeedback } from './rallar-server-contracts.ts';
import { parseRallarServerCollectionText, parseRallarServerCollectionVariablesText } from './rallar-server-parsing.ts';

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
            defaultRallarServerWorkbenchVariables({
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
            applyRallarServerEndpointPreset(
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
    const commandPreview = useMemo(() => {
        try {
            return json(
                redactRallarServerValue(
                    toRallarServerBlackBoxCommand(
                        requestInput,
                        'rallar-server-rest-request'
                    ),
                    authSession
                )
            );
        }
        catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    }, [requestInput]);
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
        try {
            writeRallarServerRestCollectionDraft(
                browserUiStorage(),
                {
                    selectedCollectionId,
                    collection: parseRallarServerCollectionText(collectionText),
                    variables: parseRallarServerCollectionVariablesText(
                        collectionVariablesText
                    )
                },
                uiSecretValues(undefined, authSession)
            );
        }
        catch {
            // Invalid collection drafts remain editable but are not persisted.
        }
    }, [
        authSession?.accessToken,
        collectionText,
        collectionVariablesText,
        selectedCollectionId
    ]);
    const applyPreset = (preset: RallarServerEndpointPreset): void => {
        const draft = applyRallarServerEndpointPreset(preset, variables);
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
            const request = buildRallarServerRestRequest(requestInput);
            requestSummary = {
                state: 'sending',
                method: request.method,
                path,
                url: request.url,
                atEpochMs: Date.now()
            };
            setRequestFeedback(requestSummary);
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

            const nextResponse = await executeRallarServerRestRequest(requestInput);
            setResponse(nextResponse);
            const nextFeedback: RallarServerRequestFeedback = {
                state: nextResponse.ok ? 'success' : 'error',
                method: request.method,
                path,
                url: nextResponse.url,
                status: nextResponse.status,
                statusText: nextResponse.statusText,
                durationMs: nextResponse.durationMs,
                errorKind: nextResponse.error?.kind,
                message: nextResponse.error?.message ??
                    (nextResponse.ok
                        ? 'Request completed successfully.'
                        : 'Request failed.'),
                atEpochMs: Date.now()
            };
            setRequestFeedback(nextFeedback);
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                {
                    kind: nextResponse.ok ? 'event' : 'diagnostic',
                    topic: nextResponse.ok
                        ? 'rallar.server.rest.request.completed'
                        : 'rallar.server.rest.request.failed',
                    severity: nextResponse.ok ? 'info' : 'error',
                    actor: authSession?.username,
                    payload: {
                        method: request.method,
                        path,
                        url: redactRallarServerUrl(
                            nextResponse.url,
                            authSession
                        ),
                        status: nextResponse.status,
                        statusText: nextResponse.statusText,
                        durationMs: nextResponse.durationMs,
                        error: nextResponse.error,
                        bodyKind: nextResponse.bodyKind,
                        bodyText: nextResponse.bodyText
                            ? redactRallarServerText(
                                nextResponse.bodyText,
                                authSession
                            )
                            : undefined,
                        bodyJson: nextResponse.bodyJson === undefined
                            ? undefined
                            : redactRallarServerValue(
                                nextResponse.bodyJson,
                                authSession
                            )
                    }
                },
                nextResponse.ok
                    ? `Rallar Server ${request.method} request completed`
                    : `Rallar Server ${request.method} request failed`
            );
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setRequestFeedback({
                ...requestSummary,
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
                        method: requestSummary.method,
                        path: requestSummary.path,
                        url: requestSummary.url
                            ? redactRallarServerUrl(
                                requestSummary.url,
                                authSession
                            )
                            : undefined,
                        error: {
                            kind: 'request-build',
                            message: redactRallarServerText(
                                message,
                                authSession
                            )
                        }
                    }
                },
                `Rallar Server ${requestSummary.method ?? 'REST'} request failed`
            );
        }
        finally {
            setBusy(false);
        }
    };
    const refreshOpenApi = async (): Promise<void> => {
        setOpenApiBusy(true);
        setLocalError(undefined);
        try {
            setServerOpenApiPresets(
                await fetchRallarServerOpenApiEndpoints(apiBaseUrl)
            );
        }
        catch (error) {
            setLocalError(
                error instanceof Error ? error.message : String(error)
            );
        }
        finally {
            setOpenApiBusy(false);
        }
    };
    const copyCurl = (): void => {
        try {
            void navigator.clipboard?.writeText(
                toRallarServerCurl(requestInput)
            );
        }
        catch (error) {
            setLocalError(
                error instanceof Error ? error.message : String(error)
            );
        }
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
        try {
            const collection = parseRallarServerCollectionText(collectionText);
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
    const runCollection = async (): Promise<void> => {
        setCollectionBusy(true);
        setCollectionError(undefined);
        setCollectionResults([]);
        try {
            const collection = parseRallarServerCollectionText(collectionText);
            let collectionVariables: RallarServerRestCollectionVariables = {
                ...(collection.variables ?? {}),
                ...parseRallarServerCollectionVariablesText(
                    collectionVariablesText
                )
            };
            const nextResults: RallarServerRestCollectionStepResult[] = [];

            for (const step of collection.steps) {
                const stepResponse = await executeRallarServerRestRequest(
                    buildRallarServerCollectionStepRequestInput({
                        step,
                        apiBaseUrl,
                        variables: collectionVariables,
                        authSession,
                        defaultTimeoutMs: timeoutMs,
                        forbidPlaceholderBaseUrl: providerMode === 'browser-rallar'
                    })
                );
                const assertions = assertRallarServerRestResponse(
                    stepResponse,
                    step.expect,
                    collectionVariables
                );
                const extracted = extractRallarServerRestVariables(
                    stepResponse,
                    step.extract
                );
                const ok = assertions.every((assertion) => assertion.ok);
                const result = {
                    stepId: step.stepId,
                    label: step.label,
                    ok,
                    response: stepResponse,
                    assertions,
                    extracted
                };
                nextResults.push(result);
                setCollectionResults([...nextResults]);
                collectionVariables = {
                    ...collectionVariables,
                    ...extracted
                };
                setCollectionVariablesText(json(collectionVariables));
                if (!ok) {
                    break;
                }
            }
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
        try {
            const collection = parseRallarServerCollectionText(collectionText);
            const collectionVariables = parseRallarServerCollectionVariablesText(
                collectionVariablesText
            );
            void navigator.clipboard?.writeText(
                redactedJson(
                    {
                        ...collection,
                        variables: collectionVariables
                    },
                    state,
                    authSession
                )
            );
        }
        catch (error) {
            setCollectionError(
                error instanceof Error ? error.message : String(error)
            );
        }
    };
    const copyCollectionRecipe = (): void => {
        try {
            const collection = parseRallarServerCollectionText(collectionText);
            const collectionVariables = parseRallarServerCollectionVariablesText(
                collectionVariablesText
            );
            const recipe = toRallarServerRestCollectionRecipe({
                collection,
                apiBaseUrl,
                variables: collectionVariables,
                authSession,
                defaultTimeoutMs: timeoutMs,
                forbidPlaceholderBaseUrl: providerMode === 'browser-rallar'
            });
            void navigator.clipboard?.writeText(
                redactedJson(recipe, state, authSession)
            );
        }
        catch (error) {
            setCollectionError(
                error instanceof Error ? error.message : String(error)
            );
        }
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
