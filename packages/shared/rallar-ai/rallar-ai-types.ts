export const RALLAR_AI_PROTOCOL_VERSION = 1 as const;

export type RallarAiJsonSource = 'browser' | 'server' | 'mock';

export type RallarAiProviderTarget = 'browser' | 'server' | 'shared';

export type RallarAiGenerationPolicyMode =
    | 'disabled'
    | 'browser-only'
    | 'server-only'
    | 'browser-first'
    | 'server-first';

export type RallarAiErrorCode =
    | 'disabled'
    | 'provider-unavailable'
    | 'provider-target-mismatch'
    | 'provider-timeout'
    | 'provider-cancelled'
    | 'provider-failed'
    | 'invalid-json'
    | 'schema-validation-failed'
    | 'schema-not-registered'
    | 'stale-result'
    | 'quota-exceeded'
    | 'request-too-large'
    | 'unauthorized'
    | 'invalid-lifecycle-transition'
    | 'invalid-configuration';

export type RallarAiJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly RallarAiJsonValue[]
    | { readonly [key: string]: RallarAiJsonValue };

export type RallarAiJsonSchema = Readonly<{
    type?: string | readonly string[];
    enum?: readonly unknown[];
    const?: unknown;
    required?: readonly string[];
    properties?: Readonly<Record<string, RallarAiJsonSchema>>;
    additionalProperties?: boolean | RallarAiJsonSchema;
    items?: RallarAiJsonSchema;
    minItems?: number;
    maxItems?: number;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
}>;

export type RallarAiValidationIssue = Readonly<{
    path: string;
    code: string;
    message: string;
}>;

export type RallarAiValidationResult = Readonly<{
    ok: boolean;
    errors: readonly string[];
    issues: readonly RallarAiValidationIssue[];
}>;

export type RallarAiJsonRequest<TContext = unknown> = Readonly<{
    requestId?: string;
    schemaId: string;
    schemaVersion: string;
    schema: RallarAiJsonSchema | unknown;
    prompt: string;
    context?: TContext;
    baseStateRevision?: string;
    dedupeKey?: string;
    maxOutputTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
}>;

export type RallarAiJsonResult<TValue = unknown> = Readonly<{
    protocolVersion: typeof RALLAR_AI_PROTOCOL_VERSION;
    requestId?: string;
    generationId: string;
    dedupeKey?: string;
    supersedesGenerationId?: string;
    source: RallarAiJsonSource;
    providerId: string;
    modelId?: string;
    schemaId: string;
    schemaVersion: string;
    schemaHash: string;
    promptHash: string;
    baseStateRevision?: string;
    createdAtEpochMs: number;
    value: TValue;
    rawText?: string;
    validation: RallarAiValidationResult;
    timing?: Readonly<{
        startedAtEpochMs: number;
        completedAtEpochMs: number;
    }>;
    lifecycle?: RallarAiResultLifecycleState;
}>;

export type RallarAiProviderCapabilities = Readonly<{
    supportsJsonSchema: boolean;
    supportsStreaming: boolean;
    supportsCancellation: boolean;
    maxContextTokens?: number;
    maxOutputTokens?: number;
    typicalColdStartMs?: number;
    target: RallarAiProviderTarget;
}>;

export type RallarAiJsonProvider = Readonly<{
    providerId: string;
    source: RallarAiJsonSource;
    modelId?: string;
    capabilities: RallarAiProviderCapabilities;
    generateJson<TValue = unknown, TContext = unknown>(
        request: RallarAiJsonRequest<TContext>,
    ): Promise<RallarAiJsonResult<TValue>>;
}>;

export type RallarAiDiagnosticEventKind =
    | 'generation-requested'
    | 'provider-selected'
    | 'provider-started'
    | 'provider-completed'
    | 'provider-failed'
    | 'provider-timed-out'
    | 'provider-cancelled'
    | 'json-parse-failed'
    | 'schema-validation-failed'
    | 'envelope-broadcast-started'
    | 'envelope-broadcast-completed'
    | 'envelope-broadcast-failed'
    | 'envelope-persistence-started'
    | 'envelope-persistence-completed'
    | 'envelope-persistence-failed';

export type RallarAiDiagnosticEvent = Readonly<{
    kind: RallarAiDiagnosticEventKind;
    generationId?: string;
    requestId?: string;
    providerId?: string;
    modelId?: string;
    schemaId?: string;
    schemaVersion?: string;
    schemaHash?: string;
    source?: RallarAiJsonSource;
    validationOk?: boolean;
    elapsedMs?: number;
    errorCode?: RallarAiErrorCode | string;
    message?: string;
    createdAtEpochMs: number;
}>;

export type RallarAiDiagnosticsSink = (
    event: RallarAiDiagnosticEvent,
) => void | Promise<void>;

export type RallarAiGenerationPolicy = Readonly<{
    mode: RallarAiGenerationPolicyMode;
    timeoutMs?: number;
    staleResultMode?: 'allow' | 'reject';
}>;

export type RallarAiTransportPolicy = Readonly<{
    delivery: 'ephemeral' | 'persisted' | 'ephemeral-and-persisted';
    ordering: 'none' | 'per-lane' | 'server-ordered';
    acknowledgement: 'none' | 'sender-only' | 'room-quorum';
    conflictPolicy:
        | 'first-valid-wins'
        | 'latest-valid-wins'
        | 'host-decides'
        | 'server-decides'
        | 'app-defined';
}>;

export type RallarAiResultLifecycleState =
    | 'draft'
    | 'proposed'
    | 'accepted'
    | 'rejected'
    | 'expired'
    | 'superseded';

export type RallarAiAuthorizationAction =
    | 'generate'
    | 'broadcast'
    | 'persist'
    | 'approve'
    | 'reject'
    | 'configure-provider';

export type RallarAiAuthorizationContext = Readonly<{
    actorId?: string;
    roomId?: string;
    action: RallarAiAuthorizationAction;
    source: 'browser' | 'server';
    schemaId: string;
    schemaVersion: string;
}>;

export type RallarAiAuthorize = (
    context: RallarAiAuthorizationContext,
) => boolean | Promise<boolean>;

export type RallarAiProviderGovernanceMetadata = Readonly<{
    providerId: string;
    adapterVersion?: string;
    modelId?: string;
    modelVersion?: string;
    modelDigest?: string;
    target: RallarAiProviderTarget;
    licenseNotes?: string;
    productionAllowed?: boolean;
    structuredOutput: boolean;
    knownLimits?: Readonly<{
        maxContextTokens?: number;
        maxOutputTokens?: number;
        recommendedTimeoutMs?: number;
    }>;
}>;

export type RallarAiSchemaRegistryEntry = Readonly<{
    schemaId: string;
    schemaVersion: string;
    schema: RallarAiJsonSchema | unknown;
    schemaHash?: string;
    compatibleWith?: readonly string[];
    migrationNotes?: string;
}>;

export class RallarAiError extends Error {
    readonly code: RallarAiErrorCode;
    readonly details?: unknown;

    constructor(
        code: RallarAiErrorCode,
        message: string,
        details?: unknown,
    ) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'RallarAiError';
    }
}
