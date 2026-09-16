import type { AuthSession } from '@shared/api/api-config.ts';
import type { Either } from '@shared/resilience/Either.ts';
import type * as React from 'react';
import type {
    RallarServerEndpointPreset,
    RallarServerRestRequest,
    RallarServerRestRequestInput,
    RallarServerRestResponse,
    RallarServerWorkbenchVariables
} from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import { readRallarServerOpenApiEndpoints } from '../../../rallar-server-workbench/read-rallar-server-open-api-endpoints.ts';
import {
    redactRallarServerText,
    redactRallarServerUrl,
    redactRallarServerValue
} from '../../../rallar-server-workbench/redact-rallar-server-value.ts';
import { toRallarServerCurl } from '../../../rallar-server-workbench/to-rallar-server-curl.ts';
import { toRallarServerEndpointDraft } from '../../../rallar-server-workbench/to-rallar-server-endpoint-draft.ts';
import { toRallarServerRestRequest } from '../../../rallar-server-workbench/to-rallar-server-rest-request.ts';
import { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import type { RallarServerWorkbenchDraft } from '../../../ui-persistence.ts';
import { writeTextToClipboard } from '../../shared/write-text-to-clipboard.ts';
import type { RallarServerRequestFeedback, RallarServerRequestOperations } from './rallar-server-contracts.ts';

export namespace RallarServerRequestActions {
    export interface Input {
        /** Absent until the browser signs in; events then carry no actor. */
        readonly authSession: AuthSession | undefined;
        readonly variables: RallarServerWorkbenchVariables;
        readonly draft: RallarServerWorkbenchDraft;
        readonly requestInput: RallarServerRestRequestInput;
        readonly commandPreview: string;
        readonly setDraft: React.Dispatch<React.SetStateAction<RallarServerWorkbenchDraft>>;
        setServerDraftEdited(value: boolean): void;
        readonly setBusy: React.Dispatch<React.SetStateAction<boolean>>;
        readonly setOpenApiBusy: React.Dispatch<React.SetStateAction<boolean>>;
        readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly setResponse: React.Dispatch<React.SetStateAction<RallarServerRestResponse | undefined>>;
        readonly setRequestFeedback: React.Dispatch<React.SetStateAction<RallarServerRequestFeedback>>;
        readonly setServerOpenApiPresets: React.Dispatch<React.SetStateAction<readonly RallarServerEndpointPreset[]>>;
        sendRequest(request: RallarServerRestRequestInput): Promise<Either<string, RallarServerRestResponse>>;
        nowMs(): number;
    }
}

export class RallarServerRequestActions implements RallarServerRequestOperations {
    private readonly input: RallarServerRequestActions.Input;

    constructor(input: RallarServerRequestActions.Input) {
        this.input = input;
    }

    readonly applyPreset = (preset: RallarServerEndpointPreset): void => {
        const endpointDraft = toRallarServerEndpointDraft(preset, this.input.variables);
        this.input.setServerDraftEdited(true);
        this.input.setDraft((current) => ({ ...current, ...endpointDraft, selectedPresetId: preset.presetId }));
        this.input.setLocalError(undefined);
    };

    readonly sendRequest = async (): Promise<void> => {
        const { draft, requestInput } = this.input;
        this.input.setBusy(true);
        this.input.setLocalError(undefined);
        this.input.setResponse(undefined);
        let summary: RallarServerRequestFeedback = {
            state: 'sending',
            method: draft.method,
            path: draft.path,
            atEpochMs: this.input.nowMs()
        };
        try {
            await toRallarServerRestRequest(requestInput).fold(
                async (message) => this.recordRequestFailure(summary, message),
                async (request) => {
                    summary = this.recordRequestStarted(request);
                    const sent = await this.input.sendRequest(requestInput);
                    sent.fold(
                        (message) => this.recordRequestFailure(summary, message),
                        (response) => this.recordResponse(request, response)
                    );
                }
            );
        }
        catch (error) {
            this.recordRequestFailure(summary, error instanceof Error ? error.message : String(error));
        }
        finally {
            this.input.setBusy(false);
        }
    };

    readonly refreshOpenApi = async (): Promise<void> => {
        this.input.setOpenApiBusy(true);
        this.input.setLocalError(undefined);
        try {
            const read = await readRallarServerOpenApiEndpoints({ apiBaseUrl: this.input.draft.apiBaseUrl, fetch });
            read.fold(this.input.setLocalError, this.input.setServerOpenApiPresets);
        }
        finally {
            this.input.setOpenApiBusy(false);
        }
    };

    readonly copyCurl = async (): Promise<void> => {
        await toRallarServerCurl(this.input.requestInput).fold(
            async (message) => this.input.setLocalError(message),
            (curl) => this.copyText(curl)
        );
    };

    readonly copyCommand = (): Promise<void> => this.copyText(this.input.commandPreview);

    private async copyText(text: string): Promise<void> {
        this.input.setLocalError(undefined);
        const written = await writeTextToClipboard(text);
        written.foldLeft(this.input.setLocalError);
    }

    private recordRequestFailure(summary: RallarServerRequestFeedback, message: string): void {
        const { authSession } = this.input;
        this.input.setLocalError(message);
        this.input.setRequestFeedback({
            ...summary,
            state: 'error',
            errorKind: 'request-build',
            message,
            atEpochMs: this.input.nowMs()
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
    }

    private recordRequestStarted(request: RallarServerRestRequest): RallarServerRequestFeedback {
        const { authSession, draft } = this.input;
        const summary: RallarServerRequestFeedback = {
            state: 'sending',
            method: request.method,
            path: draft.path,
            url: request.url,
            atEpochMs: this.input.nowMs()
        };
        this.input.setRequestFeedback(summary);
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            {
                kind: 'event',
                topic: 'rallar.server.rest.request.started',
                severity: 'info',
                actor: authSession?.username,
                payload: {
                    method: request.method,
                    path: draft.path,
                    url: redactRallarServerUrl(request.url, authSession),
                    attachAuth: draft.attachAuth,
                    responseBodyMode: draft.responseBodyMode,
                    timeoutMs: draft.timeoutMs
                }
            },
            `Rallar Server ${request.method} request started`
        );
        return summary;
    }

    private recordResponse(request: RallarServerRestRequest, response: RallarServerRestResponse): void {
        const { authSession, draft } = this.input;
        this.input.setResponse(response);
        this.input.setRequestFeedback({
            state: response.ok ? 'success' : 'error',
            method: request.method,
            path: draft.path,
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            durationMs: response.durationMs,
            errorKind: response.error?.kind,
            message: response.error?.message ?? (response.ok ? 'Request completed successfully.' : 'Request failed.'),
            atEpochMs: this.input.nowMs()
        });
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            {
                kind: response.ok ? 'event' : 'diagnostic',
                topic: response.ok ? 'rallar.server.rest.request.completed' : 'rallar.server.rest.request.failed',
                severity: response.ok ? 'info' : 'error',
                actor: authSession?.username,
                payload: {
                    method: request.method,
                    path: draft.path,
                    ...toRedactedResponsePayload(response, authSession)
                }
            },
            `Rallar Server ${request.method} request ${response.ok ? 'completed' : 'failed'}`
        );
    }
}

interface RedactedResponsePayload {
    readonly url: string;
    readonly status: number;
    readonly statusText: string;
    readonly durationMs: number;
    readonly error: RallarServerRestResponse['error'];
    readonly bodyKind: RallarServerRestResponse['bodyKind'];
    /** Absent when the response carried no text body. */
    readonly bodyText: string | undefined;
    readonly bodyJson: RallarServerRestResponse['bodyJson'];
}

function toRedactedResponsePayload(
    response: RallarServerRestResponse,
    authSession: AuthSession | undefined
): RedactedResponsePayload {
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
