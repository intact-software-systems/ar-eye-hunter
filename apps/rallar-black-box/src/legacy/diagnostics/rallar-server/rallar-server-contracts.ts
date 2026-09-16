import type { RallarBlackBoxProviderMode } from '@shared-test/rallar-bb-test/client-defaults.ts';
import type {
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    RallarServerEndpointPreset,
    RallarServerResponseBodyMode,
    RallarServerRestCollection,
    RallarServerRestCollectionStepResult,
    RallarServerRestMethod,
    RallarServerRestResponse
} from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { RallarServerWorkbenchDraft } from '../../../ui-persistence.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';

/** The last request outcome; each detail is absent until the request stage that produces it has run. */
export interface RallarServerRequestFeedback {
    readonly state: 'idle' | 'sending' | 'success' | 'error';
    readonly method?: RallarServerRestMethod;
    readonly path?: string;
    readonly url?: string;
    readonly status?: number;
    readonly statusText?: string;
    readonly durationMs?: number;
    readonly errorKind?: string;
    readonly message?: string;
    readonly atEpochMs?: number;
}

export interface UseRallarServerControllerInput {
    readonly state: RallarBlackBoxTestState;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    /** Absent until the browser signs in. */
    readonly authSession?: AuthSession;
    readonly globalValues: CommandCenterGlobalValues;
}

export interface RallarServerRequestDraftModel extends RallarServerWorkbenchDraft {
    setApiBaseUrl(value: string): void;
    setServerDraftEdited(value: boolean): void;
    setMethod(value: RallarServerRestMethod): void;
    setPath(value: string): void;
    setHeadersText(value: string): void;
    setQueryText(value: string): void;
    setBodyText(value: string): void;
    setResponseBodyMode(value: RallarServerResponseBodyMode): void;
    setAttachAuth(value: boolean): void;
    setTimeoutMs(value: number): void;
}

export interface RallarServerRequestActivity {
    readonly providerMode: RallarBlackBoxProviderMode;
    /** Absent until a runtime configuration is loaded. */
    readonly config: RallarBlackBoxTestConfig | undefined;
    readonly serverOpenApiPresets: readonly RallarServerEndpointPreset[];
    readonly allPresets: readonly RallarServerEndpointPreset[];
    readonly activePreset: RallarServerEndpointPreset;
    readonly busy: boolean;
    readonly openApiBusy: boolean;
    readonly requestFeedback: RallarServerRequestFeedback;
    /** Absent when the last request, OpenAPI read or copy succeeded. */
    readonly localError: string | undefined;
    /** Absent until a request receives a response. */
    readonly response: RallarServerRestResponse | undefined;
    readonly responseBodyText: string;
    readonly responseHeadersText: string;
    /** Absent while the last response body names no group, client or session. */
    readonly latestGroupId: string | undefined;
    readonly latestClientId: string | undefined;
    readonly latestSessionId: string | undefined;
    readonly commandPreview: string;
}

export interface RallarServerCollectionModel {
    readonly collectionTemplates: readonly RallarServerRestCollection[];
    readonly selectedCollectionId: string;
    readonly collectionText: string;
    setCollectionText(value: string): void;
    readonly collectionVariablesText: string;
    setCollectionVariablesText(value: string): void;
    readonly collectionBusy: boolean;
    /** Absent when the last collection edit, run or copy succeeded. */
    readonly collectionError: string | undefined;
    readonly collectionResults: readonly RallarServerRestCollectionStepResult[];
}

export interface RallarServerRequestOperations {
    applyPreset(preset: RallarServerEndpointPreset): void;
    sendRequest(): Promise<void>;
    refreshOpenApi(): Promise<void>;
    copyCurl(): Promise<void>;
    copyCommand(): Promise<void>;
}

export interface RallarServerCollectionOperations {
    applyCollectionTemplate(collectionId: string): void;
    addCurrentRequestToCollection(): void;
    runCollection(): Promise<void>;
    copyCollection(): Promise<void>;
    copyCollectionRecipe(): Promise<void>;
}
