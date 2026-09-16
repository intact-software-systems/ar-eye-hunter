import type { RallarBlackBoxTestHttpRequestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

export type RallarServerRestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type RallarServerResponseBodyMode = 'auto' | 'json' | 'text' | 'none';

export interface RallarServerEndpointPreset {
    readonly presetId: string;
    readonly tag: string;
    readonly label: string;
    readonly method: RallarServerRestMethod;
    readonly pathTemplate: string;
    readonly requiresAuth: boolean;
    /** Absent for a preset that sends no body. */
    readonly body?: RallarBlackBoxTestHttpRequestCommand['request']['body'];
    /** Absent reads the response body by its content type. */
    readonly responseBodyMode?: RallarServerResponseBodyMode;
}

export interface RallarServerEndpointDraft {
    readonly method: RallarServerRestMethod;
    readonly path: string;
    readonly headersText: string;
    readonly queryText: string;
    readonly bodyText: string;
    readonly responseBodyMode: RallarServerResponseBodyMode;
    readonly attachAuth: boolean;
}

export interface RallarServerRestRequestInput extends RallarServerEndpointDraft {
    readonly apiBaseUrl: string;
    readonly timeoutMs: number;
    readonly authSession: AuthSession | undefined;
    readonly forbidPlaceholderBaseUrl: boolean;
}

export interface RallarServerRestRequest {
    readonly url: string;
    readonly method: RallarServerRestMethod;
    readonly headers: Readonly<Record<string, string>>;
    readonly bodyText: string | undefined;
    readonly redactedHeaders: Readonly<Record<string, string>>;
}

export type RallarServerRestErrorKind =
    | 'unauthenticated'
    | 'forbidden'
    | 'timeout'
    | 'network-or-cors'
    | 'invalid-json'
    | 'http-error';

export interface RallarServerRestError {
    readonly kind: RallarServerRestErrorKind;
    readonly message: string;
}

export interface RallarServerRestResponse {
    readonly ok: boolean;
    readonly url: string;
    readonly status: number;
    readonly statusText: string;
    readonly durationMs: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly bodyText: string;
    /** Absent unless the response body was read as JSON. */
    readonly bodyJson?: unknown;
    readonly bodyKind: 'empty' | 'json' | 'text';
    /** Absent for a response without a transport, status or body failure. */
    readonly error?: RallarServerRestError;
}

export interface RallarServerWorkbenchVariables {
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly generationId: string;
    readonly requestId: string;
    readonly clientInstanceId: string;
    readonly groupId: string;
    readonly username: string;
}

export type RallarServerRestCollectionVariables = Readonly<Record<string, unknown>>;

/** Authored collection JSON: an absent check is not evaluated. */
export interface RallarServerRestCollectionValueExpectation {
    readonly equals?: unknown;
    readonly contains?: string;
    readonly exists?: boolean;
}

export interface RallarServerRestCollectionBodyExpectation extends RallarServerRestCollectionValueExpectation {
    readonly path: string;
}

export interface RallarServerRestCollectionHeaderExpectation extends RallarServerRestCollectionValueExpectation {
    readonly name: string;
}

/** Authored collection JSON: an absent check is not evaluated. */
export interface RallarServerRestCollectionExpectation {
    readonly ok?: boolean;
    readonly status?: number | readonly number[];
    readonly body?: readonly RallarServerRestCollectionBodyExpectation[];
    readonly headers?: readonly RallarServerRestCollectionHeaderExpectation[];
}

/** Authored collection JSON: an absent source reads the body, and an absent fallback leaves a missing value unset. */
export interface RallarServerRestCollectionExtraction {
    readonly name: string;
    readonly from?: 'body' | 'headers' | 'status';
    readonly path?: string;
    readonly header?: string;
    readonly fallback?: unknown;
}

/** Authored collection JSON: absent request options take the workbench defaults. */
export interface RallarServerRestCollectionRequest {
    readonly method: RallarServerRestMethod;
    readonly path: string;
    readonly headers?: Readonly<Record<string, unknown>>;
    readonly query?: Readonly<Record<string, unknown>>;
    readonly body?: unknown;
    readonly responseBodyMode?: RallarServerResponseBodyMode;
    readonly attachAuth?: boolean;
    readonly timeoutMs?: number;
}

export interface RallarServerRestCollectionStep {
    readonly stepId: string;
    readonly label: string;
    readonly request: RallarServerRestCollectionRequest;
    /** Absent expects a successful response. */
    readonly expect?: RallarServerRestCollectionExpectation;
    /** Absent extracts no variables. */
    readonly extract?: readonly RallarServerRestCollectionExtraction[];
}

export interface RallarServerRestCollection {
    readonly collectionId: string;
    readonly name: string;
    /** Absent for a collection without a description. */
    readonly description?: string;
    /** Absent for a collection that declares no variables. */
    readonly variables?: RallarServerRestCollectionVariables;
    readonly steps: readonly RallarServerRestCollectionStep[];
}

export interface RallarServerRestAssertionResult {
    readonly label: string;
    readonly ok: boolean;
    /** Absent for the captured-response result, which checks nothing. */
    readonly expected?: unknown;
    /** Absent for the captured-response result, which checks nothing. */
    readonly actual?: unknown;
}

export interface RallarServerRestCollectionStepResult {
    readonly stepId: string;
    readonly label: string;
    readonly ok: boolean;
    readonly response: RallarServerRestResponse;
    readonly assertions: readonly RallarServerRestAssertionResult[];
    readonly extracted: RallarServerRestCollectionVariables;
}
