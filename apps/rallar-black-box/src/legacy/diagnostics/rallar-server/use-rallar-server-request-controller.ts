import { resolveRallarBlackBoxConfigProviderMode } from '@shared-test/rallar-bb-test/browser-control-agent/validate-rallar-black-box-provider-config.ts';
import type { RallarBlackBoxProviderMode } from '@shared-test/rallar-bb-test/client-defaults.ts';
import type { RallarBlackBoxTestConfig } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type * as React from 'react';
import { useMemo, useState } from 'react';
import { RALLAR_SERVER_ENDPOINT_PRESETS } from '../../../rallar-server-workbench/rallar-server-endpoint-presets.ts';
import type {
    RallarServerEndpointPreset,
    RallarServerRestRequestInput,
    RallarServerRestResponse
} from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import {
    redactRallarServerText,
    redactRallarServerValue
} from '../../../rallar-server-workbench/redact-rallar-server-value.ts';
import { sendRallarServerRestRequest } from '../../../rallar-server-workbench/send-rallar-server-rest-request.ts';
import { toRallarServerBlackBoxCommand } from '../../../rallar-server-workbench/to-rallar-server-black-box-command.ts';
import type { RallarServerWorkbenchDraft } from '../../../ui-persistence.ts';
import { json } from '../../shared/json-presentation.ts';
import { findStringDeep } from '../shared/deep-string-value.ts';
import type {
    RallarServerRequestActivity,
    RallarServerRequestDraftModel,
    RallarServerRequestFeedback,
    RallarServerRequestOperations,
    UseRallarServerControllerInput
} from './rallar-server-contracts.ts';
import { RallarServerRequestActions } from './rallar-server-request-actions.ts';
import type { RallarServerDefaults } from './use-rallar-server-defaults.ts';
import { useRallarServerRequestDraft } from './use-rallar-server-request-draft.ts';

export interface RallarServerRequestController
    extends RallarServerRequestDraftModel, RallarServerRequestActivity, RallarServerRequestOperations {}

interface RallarServerRequestControls {
    readonly serverOpenApiPresets: readonly RallarServerEndpointPreset[];
    readonly setServerOpenApiPresets: React.Dispatch<React.SetStateAction<readonly RallarServerEndpointPreset[]>>;
    readonly allPresets: readonly RallarServerEndpointPreset[];
    readonly busy: boolean;
    readonly setBusy: React.Dispatch<React.SetStateAction<boolean>>;
    readonly openApiBusy: boolean;
    readonly setOpenApiBusy: React.Dispatch<React.SetStateAction<boolean>>;
    /** Absent when the last request, OpenAPI read or copy succeeded. */
    readonly localError: string | undefined;
    readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
    /** Absent until a request receives a response. */
    readonly response: RallarServerRestResponse | undefined;
    readonly setResponse: React.Dispatch<React.SetStateAction<RallarServerRestResponse | undefined>>;
    readonly requestFeedback: RallarServerRequestFeedback;
    readonly setRequestFeedback: React.Dispatch<React.SetStateAction<RallarServerRequestFeedback>>;
}

interface RallarServerRequestActivitySource {
    readonly controls: RallarServerRequestControls;
    /** Absent until a runtime configuration is loaded. */
    readonly config: RallarBlackBoxTestConfig | undefined;
    readonly providerMode: RallarBlackBoxProviderMode;
    readonly selectedPresetId: string;
    readonly requestInput: RallarServerRestRequestInput;
}

export function useRallarServerRequestController(
    input: UseRallarServerControllerInput,
    defaults: RallarServerDefaults
): RallarServerRequestController {
    const providerMode = resolveRallarBlackBoxConfigProviderMode(defaults.config);
    const { draft, setDraft, setters } = useRallarServerRequestDraft(input, defaults);
    const controls = useRallarServerRequestControls();
    const requestInput = toRallarServerRequestInput(draft, input.authSession, providerMode);
    const { selectedPresetId } = draft;
    const activity = toRallarServerRequestActivity({
        controls,
        config: defaults.config,
        providerMode,
        selectedPresetId,
        requestInput
    });
    const actions = new RallarServerRequestActions({
        ...controls,
        authSession: input.authSession,
        variables: defaults.variables,
        draft,
        requestInput,
        commandPreview: activity.commandPreview,
        setDraft,
        setServerDraftEdited: setters.setServerDraftEdited,
        sendRequest: (request) => sendRallarServerRestRequest({ request, fetch }),
        nowMs: Date.now
    });
    return {
        ...draft,
        ...setters,
        ...activity,
        applyPreset: actions.applyPreset,
        sendRequest: actions.sendRequest,
        refreshOpenApi: actions.refreshOpenApi,
        copyCurl: actions.copyCurl,
        copyCommand: actions.copyCommand
    };
}

function useRallarServerRequestControls(): RallarServerRequestControls {
    const [serverOpenApiPresets, setServerOpenApiPresets] = useState<readonly RallarServerEndpointPreset[]>([]);
    const allPresets = useMemo(() => [...RALLAR_SERVER_ENDPOINT_PRESETS, ...serverOpenApiPresets], [
        serverOpenApiPresets
    ]);
    const [busy, setBusy] = useState(false);
    const [openApiBusy, setOpenApiBusy] = useState(false);
    const [localError, setLocalError] = useState<string | undefined>();
    const [response, setResponse] = useState<RallarServerRestResponse | undefined>();
    const [requestFeedback, setRequestFeedback] = useState<RallarServerRequestFeedback>({ state: 'idle' });
    return {
        serverOpenApiPresets,
        setServerOpenApiPresets,
        allPresets,
        busy,
        setBusy,
        openApiBusy,
        setOpenApiBusy,
        localError,
        setLocalError,
        response,
        setResponse,
        requestFeedback,
        setRequestFeedback
    };
}

function toRallarServerRequestInput(
    draft: RallarServerWorkbenchDraft,
    authSession: AuthSession | undefined,
    providerMode: RallarBlackBoxProviderMode
): RallarServerRestRequestInput {
    return {
        apiBaseUrl: draft.apiBaseUrl,
        method: draft.method,
        path: draft.path,
        headersText: draft.headersText,
        queryText: draft.queryText,
        bodyText: draft.bodyText,
        responseBodyMode: draft.responseBodyMode,
        attachAuth: draft.attachAuth,
        timeoutMs: draft.timeoutMs,
        authSession,
        forbidPlaceholderBaseUrl: providerMode === 'browser-rallar'
    };
}

function toRallarServerRequestActivity(source: RallarServerRequestActivitySource): RallarServerRequestActivity {
    const { controls, requestInput } = source;
    const { authSession } = requestInput;
    const command = toRallarServerBlackBoxCommand({ request: requestInput, commandId: 'rallar-server-rest-request' });
    return {
        ...toRallarServerResponseViews(controls.response, authSession),
        providerMode: source.providerMode,
        config: source.config,
        serverOpenApiPresets: controls.serverOpenApiPresets,
        allPresets: controls.allPresets,
        activePreset: controls.allPresets.find((preset) => preset.presetId === source.selectedPresetId) ??
            RALLAR_SERVER_ENDPOINT_PRESETS[0],
        busy: controls.busy,
        openApiBusy: controls.openApiBusy,
        requestFeedback: controls.requestFeedback,
        localError: controls.localError,
        response: controls.response,
        commandPreview: command.fold((error) => error, (valid) => json(redactRallarServerValue(valid, authSession)))
    };
}

function toRallarServerResponseViews(
    response: RallarServerRestResponse | undefined,
    authSession: AuthSession | undefined
): Pick<
    RallarServerRequestActivity,
    'responseBodyText' | 'responseHeadersText' | 'latestGroupId' | 'latestClientId' | 'latestSessionId'
> {
    return {
        responseBodyText: toResponseBodyText(response, authSession),
        responseHeadersText: response ? json(redactRallarServerValue(response.headers, authSession)) : '{}',
        latestGroupId: findStringDeep(response?.bodyJson, ['groupId', 'roomId']),
        latestClientId: findStringDeep(response?.bodyJson, ['clientId', 'principalId', 'username']),
        latestSessionId: findStringDeep(response?.bodyJson, ['sessionId'])
    };
}

function toResponseBodyText(
    response: RallarServerRestResponse | undefined,
    authSession: AuthSession | undefined
): string {
    if (!response) {
        return 'No response';
    }
    if (response.bodyKind === 'json') {
        return json(redactRallarServerValue(response.bodyJson, authSession));
    }
    return response.bodyText ? redactRallarServerText(response.bodyText, authSession) : '-';
}
