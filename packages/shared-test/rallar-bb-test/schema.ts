import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    RALLAR_BLACK_BOX_TEST_COMMAND_KINDS,
    type RallarBlackBoxTestCommand,
} from './types.ts';
import {
    RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_ORDERINGS,
    RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_POLICY_MODES,
    RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_PATTERNS,
    RALLAR_BLACK_BOX_DISTRIBUTED_START_MODES,
    RALLAR_BLACK_BOX_DISTRIBUTED_TARGET_POLICY_MODES,
} from './distributed-run.ts';

export const RALLAR_BLACK_BOX_SCHEMA_VERSION = 1;
export const RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION = RALLAR_BLACK_BOX_SCHEMA_VERSION;
export const RALLAR_BLACK_BOX_SUPPORTED_RECIPE_SCHEMA_VERSIONS = [
    RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION,
] as const;

export type JsonSchema = Readonly<{
    $schema?: string;
    $id?: string;
    title?: string;
    description?: string;
    type?: string | readonly string[];
    enum?: readonly unknown[];
    const?: unknown;
    required?: readonly string[];
    properties?: Readonly<Record<string, JsonSchema>>;
    additionalProperties?: boolean | JsonSchema;
    items?: JsonSchema;
    oneOf?: readonly JsonSchema[];
    anyOf?: readonly JsonSchema[];
    requiredAnyOf?: readonly Readonly<{
        properties: readonly string[];
        message: string;
    }>[];
    minimum?: number;
    exclusiveMinimum?: number;
    maximum?: number;
    minItems?: number;
    examples?: readonly unknown[];
    default?: unknown;
}>;

export type JsonSchemaValidationIssue = Readonly<{
    path: string;
    message: string;
}>;

export type JsonSchemaValidationResult =
    | Readonly<{ ok: true; errors: readonly [] }>
    | Readonly<{ ok: false; errors: readonly JsonSchemaValidationIssue[] }>;

export type RallarBlackBoxRecipeCompatibilityResult =
    | Readonly<{
        ok: true;
        schemaVersion: typeof RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION;
        explicitSchemaVersion?: typeof RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION;
        legacy: boolean;
        warnings: readonly JsonSchemaValidationIssue[];
        errors: readonly [];
    }>
    | Readonly<{
        ok: false;
        schemaVersion?: typeof RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION;
        explicitSchemaVersion?: unknown;
        legacy: boolean;
        warnings: readonly JsonSchemaValidationIssue[];
        errors: readonly JsonSchemaValidationIssue[];
    }>;

export type RallarBlackBoxCommandProviderMode =
    | 'simulated'
    | 'browser-rallar'
    | 'rallar-browser'
    | 'rallar-remote-browser'
    | 'rallar-memory'
    | 'rallar-server'
    | 'mixed';

export type RallarBlackBoxCommandRuntimeSurface =
    | 'spa-local'
    | 'control-agent'
    | 'control-server'
    | 'black-box-runner-adapter';

export type RallarBlackBoxCommandCapability = Readonly<{
    kind: typeof RALLAR_BLACK_BOX_TEST_COMMAND_KINDS[number];
    title: string;
    description: string;
    requiredFields: readonly string[];
    optionalFields: readonly string[];
    supportedProviderModes: readonly RallarBlackBoxCommandProviderMode[];
    runtimeSurfaces: readonly RallarBlackBoxCommandRuntimeSurface[];
    liveServiceRequirements: readonly string[];
    artifactExpectations: readonly string[];
    example: RallarBlackBoxTestCommand;
}>;

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const SCHEMA_BASE_ID = 'https://rallar.dev/schemas/black-box';

const anySchema: JsonSchema = {};

const stringSchema: JsonSchema = { type: 'string' };
const numberSchema: JsonSchema = { type: 'number' };
const integerSchema: JsonSchema = { type: 'integer' };
const booleanSchema: JsonSchema = { type: 'boolean' };
const recordSchema: JsonSchema = { type: 'object', additionalProperties: true };
const stringRecordSchema: JsonSchema = { type: 'object', additionalProperties: stringSchema };
const recursiveCommandSchema = {} as JsonSchema & { oneOf?: readonly JsonSchema[] };

function commandBaseProperties(kind: RallarBlackBoxCommandCapability['kind']): Record<string, JsonSchema> {
    return {
        kind: { const: kind },
        commandId: stringSchema,
        label: stringSchema,
        deadlineEpochMs: integerSchema,
        timeoutMs: integerSchema,
        metadata: recordSchema,
    };
}

function strictCommandSchema(
    kind: RallarBlackBoxCommandCapability['kind'],
    required: readonly string[],
    properties: Readonly<Record<string, JsonSchema>> = {},
): JsonSchema {
    return {
        type: 'object',
        required: ['kind', ...required],
        properties: {
            ...commandBaseProperties(kind),
            ...properties,
        },
        additionalProperties: false,
    };
}

const shallowRecipeSchema: JsonSchema = {
    type: 'object',
    required: ['recipeId', 'commands'],
    properties: {
        schemaVersion: { const: RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION },
        recipeId: stringSchema,
        name: stringSchema,
        description: stringSchema,
        continueOnFailure: booleanSchema,
        metadata: recordSchema,
        commands: {
            type: 'array',
            items: {
                type: 'object',
                required: ['kind'],
                properties: {
                    kind: { type: 'string', enum: RALLAR_BLACK_BOX_TEST_COMMAND_KINDS },
                    commandId: stringSchema,
                    label: stringSchema,
                },
                additionalProperties: true,
            },
        },
    },
    additionalProperties: false,
};

const configSchema: JsonSchema = {
    type: 'object',
    properties: {
        runId: stringSchema,
        agentId: stringSchema,
        environment: stringSchema,
        apiBaseUrl: stringSchema,
        actor: stringSchema,
        sessionId: stringSchema,
        roomId: stringSchema,
        transport: { type: 'string', enum: ['realtime', 'messages.rtc', 'ws', 'http'] },
        rallar: recordSchema,
        browser: recordSchema,
        control: recordSchema,
        defaults: recordSchema,
        redaction: {
            type: 'object',
            properties: {
                keys: { type: 'array', items: stringSchema },
                keySubstrings: { type: 'array', items: stringSchema },
                secretValues: { type: 'array', items: stringSchema },
                replacement: stringSchema,
            },
            additionalProperties: false,
        },
    },
    additionalProperties: false,
};

const rtcTransportSchema: JsonSchema = { type: 'string', enum: ['realtime', 'messages.rtc'] };
const rtcConnectReadinessSchema: JsonSchema = {
    type: 'object',
    properties: {
        minReadyPeers: { type: 'integer', minimum: 1 },
        timeoutMs: { type: 'integer', minimum: 1 },
        intervalMs: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
};
const rtcStreamThresholdsSchema: JsonSchema = {
    type: 'object',
    properties: {
        minSendSuccessRatio: { type: 'number', minimum: 0, maximum: 1 },
        maxDroppedFrames: { type: 'number', minimum: 0 },
        maxBackpressureCount: { type: 'number', minimum: 0 },
        maxP95SendDurationMs: { type: 'number', minimum: 0 },
        maxP99SendDurationMs: { type: 'number', minimum: 0 },
        maxAverageStartDriftMs: { type: 'number', minimum: 0 },
        maxStartDriftMs: { type: 'number', minimum: 0 },
        maxJitterMs: { type: 'number', minimum: 0 },
    },
    additionalProperties: false,
};
const crdtTransportSchema: JsonSchema = {
    type: 'string',
    enum: ['local-only', 'ws', 'rtc', 'ws-then-rtc', 'rtc-with-ws-fallback'],
};
const crdtDurableCatchUpSchema: JsonSchema = {
    oneOf: [
        { const: false },
        { const: 'http' },
    ],
};
const crdtPathSchema: JsonSchema = { type: 'array', items: stringSchema };
const crdtUpdateIdArraySchema: JsonSchema = { type: 'array', items: stringSchema };
const crdtWaitOperatorSchema: JsonSchema = {
    type: 'string',
    enum: ['equals', 'notEquals', 'contains', 'exists', 'gte', 'lte'],
};
const crdtOperationSchema: JsonSchema = {
    oneOf: [
        {
            type: 'object',
            required: ['kind', 'path', 'elementId', 'value'],
            properties: {
                kind: { const: 'orset.add' },
                path: crdtPathSchema,
                elementId: stringSchema,
                value: anySchema,
            },
            additionalProperties: false,
        },
        {
            type: 'object',
            required: ['kind', 'path', 'elementId', 'observedAddUpdateIds'],
            properties: {
                kind: { const: 'orset.remove' },
                path: crdtPathSchema,
                elementId: stringSchema,
                observedAddUpdateIds: crdtUpdateIdArraySchema,
            },
            additionalProperties: false,
        },
        {
            type: 'object',
            required: ['kind', 'path', 'value', 'policy'],
            properties: {
                kind: { const: 'register.set' },
                path: crdtPathSchema,
                value: anySchema,
                policy: { type: 'string', enum: ['lww', 'multi'] },
            },
            additionalProperties: false,
        },
        {
            type: 'object',
            required: ['kind', 'path', 'key', 'value'],
            properties: {
                kind: { const: 'map.set' },
                path: crdtPathSchema,
                key: stringSchema,
                value: anySchema,
            },
            additionalProperties: false,
        },
        {
            type: 'object',
            required: ['kind', 'path', 'key', 'observedUpdateIds'],
            properties: {
                kind: { const: 'map.delete' },
                path: crdtPathSchema,
                key: stringSchema,
                observedUpdateIds: crdtUpdateIdArraySchema,
            },
            additionalProperties: false,
        },
        {
            type: 'object',
            required: ['kind', 'path', 'elementId', 'positionId', 'value'],
            properties: {
                kind: { const: 'sequence.insert' },
                path: crdtPathSchema,
                elementId: stringSchema,
                positionId: stringSchema,
                value: anySchema,
            },
            additionalProperties: false,
        },
        {
            type: 'object',
            required: ['kind', 'path', 'elementId', 'observedUpdateIds'],
            properties: {
                kind: { const: 'sequence.delete' },
                path: crdtPathSchema,
                elementId: stringSchema,
                observedUpdateIds: crdtUpdateIdArraySchema,
            },
            additionalProperties: false,
        },
        {
            type: 'object',
            required: ['kind', 'path', 'elementId', 'positionId', 'observedUpdateIds'],
            properties: {
                kind: { const: 'sequence.move' },
                path: crdtPathSchema,
                elementId: stringSchema,
                positionId: stringSchema,
                observedUpdateIds: crdtUpdateIdArraySchema,
            },
            additionalProperties: false,
        },
        {
            type: 'object',
            required: ['kind', 'path', 'delta'],
            properties: {
                kind: { const: 'counter.add' },
                path: crdtPathSchema,
                delta: numberSchema,
            },
            additionalProperties: false,
        },
        {
            type: 'object',
            required: ['kind', 'path', 'value'],
            properties: {
                kind: { const: 'number.min' },
                path: crdtPathSchema,
                value: numberSchema,
            },
            additionalProperties: false,
        },
        {
            type: 'object',
            required: ['kind', 'path', 'value'],
            properties: {
                kind: { const: 'number.max' },
                path: crdtPathSchema,
                value: numberSchema,
            },
            additionalProperties: false,
        },
    ],
};
const crdtOperationBatchSchema: JsonSchema = {
    type: 'object',
    required: ['kind', 'operations'],
    properties: {
        kind: { const: 'batch' },
        operations: {
            type: 'array',
            minItems: 1,
            items: crdtOperationSchema,
        },
        operationGroupId: stringSchema,
        metadata: recordSchema,
    },
    additionalProperties: false,
};
const crdtOperationArraySchema: JsonSchema = {
    type: 'array',
    items: crdtOperationSchema,
};
const crdtPoliciesSchema: JsonSchema = {
    type: 'array',
    items: recordSchema,
};
const crdtWaitConditionSchema: JsonSchema = {
    type: 'object',
    required: ['source', 'operator'],
    properties: {
        source: { type: 'string', enum: ['value', 'health'] },
        path: stringSchema,
        operator: crdtWaitOperatorSchema,
        expected: anySchema,
    },
    additionalProperties: false,
};

const directorRoomProperties: Readonly<Record<string, JsonSchema>> = {
    roomId: stringSchema,
    applicationId: stringSchema,
    workspaceId: stringSchema,
    scope: recordSchema,
    roomRef: recordSchema,
};

const directorRelayConfigProperties: Readonly<Record<string, JsonSchema>> = {
    handle: stringSchema,
    laneId: stringSchema,
    topicId: stringSchema,
    intentTypeId: stringSchema,
    outputTypeId: stringSchema,
    heartbeatTypeId: stringSchema,
    snapshotTypeId: stringSchema,
    syncRequestTypeId: stringSchema,
    heartbeatIntervalMs: { type: 'integer', minimum: 0 },
    snapshotIntervalMs: { type: 'integer', minimum: 0 },
    snapshot: anySchema,
};
const crdtWaitSyncSchema: JsonSchema = {
    oneOf: [
        { const: false },
        {
            type: 'object',
            properties: {
                reason: stringSchema,
                transport: crdtTransportSchema,
            },
            additionalProperties: false,
        },
    ],
};

const httpRequestSchema: JsonSchema = {
    type: 'object',
    properties: {
        url: stringSchema,
        path: stringSchema,
        method: stringSchema,
        headers: stringRecordSchema,
        body: anySchema,
        credentials: { type: 'string', enum: ['omit', 'same-origin', 'include'] },
        mode: { type: 'string', enum: ['cors', 'navigate', 'no-cors', 'same-origin'] },
    },
    additionalProperties: false,
};

const httpResponseSchema: JsonSchema = {
    type: 'object',
    properties: {
        body: { type: 'string', enum: ['none', 'text', 'json'] },
        maxBodyChars: integerSchema,
        acceptedStatusCodes: {
            type: 'array',
            minItems: 1,
            items: { type: 'integer', minimum: 100, maximum: 599 },
        },
    },
    additionalProperties: false,
};

const waitMatchSchema: JsonSchema = {
    type: 'object',
    properties: {
        kind: { type: 'string', enum: ['event', 'diagnostic', 'message', 'stats', 'report', 'result', 'state'] },
        topic: stringSchema,
        commandId: stringSchema,
        connection: stringSchema,
        transport: { type: 'string', enum: ['realtime', 'messages.rtc', 'ws', 'http'] },
        severity: { type: 'string', enum: ['debug', 'info', 'warning', 'error'] },
        payloadPath: stringSchema,
        equals: anySchema,
        contains: stringSchema,
        exists: booleanSchema,
    },
    additionalProperties: false,
};

const assertOperatorSchema: JsonSchema = {
    type: 'string',
    enum: ['equals', 'notEquals', 'contains', 'exists', 'gte', 'lte'],
};

const parallelGroupSchema: JsonSchema = {
    type: 'object',
    required: ['commands'],
    properties: {
        groupId: stringSchema,
        label: stringSchema,
        commands: {
            type: 'array',
            minItems: 1,
            items: recursiveCommandSchema,
        },
        metadata: recordSchema,
    },
    additionalProperties: false,
};

const loopThresholdsSchema: JsonSchema = {
    type: 'object',
    properties: {
        minAchievedRateHz: { type: 'number', minimum: 0 },
        maxAverageStartDriftMs: { type: 'number', minimum: 0 },
        maxStartDriftMs: { type: 'number', minimum: 0 },
        maxJitterMs: { type: 'number', minimum: 0 },
        minSendSuccessRatio: { type: 'number', minimum: 0, maximum: 1 },
        failOnBackpressure: booleanSchema,
    },
    additionalProperties: false,
};

const COMMAND_SCHEMAS: Readonly<Record<RallarBlackBoxCommandCapability['kind'], JsonSchema>> = {
    configure: strictCommandSchema('configure', ['config'], {
        config: configSchema,
    }),
    'recipe.load': strictCommandSchema('recipe.load', ['recipe'], {
        recipe: shallowRecipeSchema,
    }),
    'recipe.run': strictCommandSchema('recipe.run', [], {
        recipe: shallowRecipeSchema,
    }),
    'recipe.cancel': strictCommandSchema('recipe.cancel', [], {
        reason: stringSchema,
    }),
    loop: strictCommandSchema('loop', ['commands'], {
        commands: {
            type: 'array',
            minItems: 1,
            items: recursiveCommandSchema,
        },
        count: {
            type: 'integer',
            minimum: 1,
            maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount,
        },
        durationMs: {
            type: 'integer',
            minimum: 1,
            maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopDurationMs,
        },
        intervalMs: { type: 'integer', minimum: 0 },
        delayMs: { type: 'integer', minimum: 0 },
        continueOnFailure: booleanSchema,
        maxCommands: {
            type: 'integer',
            minimum: 1,
            maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands,
        },
        thresholds: loopThresholdsSchema,
    }),
    parallel: strictCommandSchema('parallel', ['groups'], {
        groups: {
            type: 'array',
            minItems: 1,
            items: parallelGroupSchema,
        },
        maxConcurrency: {
            type: 'integer',
            minimum: 1,
            maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxParallelConcurrency,
        },
        failFast: booleanSchema,
        continueOnFailure: booleanSchema,
    }),
    wait: strictCommandSchema('wait', ['match'], {
        match: waitMatchSchema,
    }),
    assert: strictCommandSchema('assert', ['source', 'operator'], {
        source: stringSchema,
        operator: assertOperatorSchema,
        expected: anySchema,
    }),
    'rtc.connect': strictCommandSchema('rtc.connect', [], {
        connection: stringSchema,
        actor: stringSchema,
        roomId: stringSchema,
        applicationId: stringSchema,
        workspaceId: stringSchema,
        scope: recordSchema,
        roomRef: recordSchema,
        minSnapshotVersion: numberSchema,
        transport: rtcTransportSchema,
        rallar: recordSchema,
        readiness: rtcConnectReadinessSchema,
    }),
    'rtc.send': strictCommandSchema('rtc.send', [], {
        connection: stringSchema,
        send: anySchema,
        applicationId: stringSchema,
        workspaceId: stringSchema,
        scope: recordSchema,
        roomRef: recordSchema,
        minSnapshotVersion: numberSchema,
        transport: rtcTransportSchema,
    }),
    'rtc.stream': {
        ...strictCommandSchema('rtc.stream', ['send'], {
            connection: stringSchema,
            actor: stringSchema,
            roomId: stringSchema,
            applicationId: stringSchema,
            workspaceId: stringSchema,
            scope: recordSchema,
            roomRef: recordSchema,
            minSnapshotVersion: numberSchema,
            transport: rtcTransportSchema,
            send: anySchema,
            count: { type: 'integer', minimum: 1 },
            durationMs: {
                type: 'integer',
                minimum: 1,
                maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopDurationMs,
            },
            intervalMs: { type: 'integer', minimum: 1 },
            rateHz: { type: 'number', exclusiveMinimum: 0 },
            maxInFlight: { type: 'integer', minimum: 1 },
            drainTimeoutMs: { type: 'integer', minimum: 0 },
            continueOnSendFailure: booleanSchema,
            progressEveryMs: { type: 'integer', minimum: 1 },
            sampleEvery: { type: 'integer', minimum: 1 },
            thresholds: rtcStreamThresholdsSchema,
        }),
        requiredAnyOf: [
            {
                properties: ['count', 'durationMs'],
                message: 'rtc.stream requires count or durationMs.',
            },
            {
                properties: ['intervalMs', 'rateHz'],
                message: 'rtc.stream requires intervalMs or rateHz.',
            },
        ],
    },
    'ws.open': strictCommandSchema('ws.open', [], {
        connection: stringSchema,
        url: stringSchema,
        protocols: {
            oneOf: [
                stringSchema,
                { type: 'array', items: stringSchema },
            ],
        },
        headers: stringRecordSchema,
    }),
    'ws.send': strictCommandSchema('ws.send', [], {
        connection: stringSchema,
        data: anySchema,
    }),
    'ws.close': strictCommandSchema('ws.close', [], {
        connection: stringSchema,
        code: integerSchema,
        reason: stringSchema,
    }),
    'http.request': strictCommandSchema('http.request', ['request'], {
        request: httpRequestSchema,
        response: httpResponseSchema,
    }),
    'crdt.open': strictCommandSchema('crdt.open', ['name'], {
        handle: stringSchema,
        name: stringSchema,
        applicationId: stringSchema,
        workspaceId: stringSchema,
        documentId: stringSchema,
        documentType: stringSchema,
        scope: recordSchema,
        roomRef: recordSchema,
        principalId: stringSchema,
        customScope: stringSchema,
        transport: crdtTransportSchema,
        persist: booleanSchema,
        tabSync: booleanSchema,
        initialValue: anySchema,
        policies: crdtPoliciesSchema,
        validation: recordSchema,
        encryption: recordSchema,
        durableCatchUp: crdtDurableCatchUpSchema,
    }),
    'crdt.apply': strictCommandSchema('crdt.apply', ['handle', 'batch'], {
        handle: stringSchema,
        batch: crdtOperationBatchSchema,
    }),
    'crdt.read': strictCommandSchema('crdt.read', ['handle'], {
        handle: stringSchema,
    }),
    'crdt.sync': strictCommandSchema('crdt.sync', ['handle'], {
        handle: stringSchema,
        reason: stringSchema,
        transport: crdtTransportSchema,
    }),
    'crdt.health': strictCommandSchema('crdt.health', ['handle'], {
        handle: stringSchema,
    }),
    'crdt.wait': strictCommandSchema('crdt.wait', ['handle', 'conditions'], {
        handle: stringSchema,
        intervalMs: { type: 'integer', minimum: 0 },
        stableForMs: { type: 'integer', minimum: 0 },
        sync: crdtWaitSyncSchema,
        conditions: {
            type: 'array',
            minItems: 1,
            items: crdtWaitConditionSchema,
        },
    }),
    'crdt.undo': strictCommandSchema('crdt.undo', ['handle', 'targetOperationGroupId', 'operations'], {
        handle: stringSchema,
        targetOperationGroupId: stringSchema,
        operations: crdtOperationArraySchema,
        operationGroupId: stringSchema,
    }),
    'crdt.redo': strictCommandSchema('crdt.redo', ['handle', 'targetOperationGroupId', 'operations'], {
        handle: stringSchema,
        targetOperationGroupId: stringSchema,
        operations: crdtOperationArraySchema,
        operationGroupId: stringSchema,
    }),
    'crdt.close': strictCommandSchema('crdt.close', ['handle'], {
        handle: stringSchema,
    }),
    'crdt.destroy': strictCommandSchema('crdt.destroy', ['handle'], {
        handle: stringSchema,
    }),
    'director.appoint': strictCommandSchema('director.appoint', [], {
        ...directorRoomProperties,
        heartbeatTtlMs: { type: 'integer', minimum: 1 },
    }),
    'director.resign': strictCommandSchema('director.resign', [], {
        ...directorRoomProperties,
    }),
    'director.status': strictCommandSchema('director.status', [], {
        ...directorRoomProperties,
        refresh: booleanSchema,
        now: numberSchema,
    }),
    'director.relay.start': strictCommandSchema('director.relay.start', ['handle', 'intentTypeId', 'outputTypeId'], {
        ...directorRoomProperties,
        ...directorRelayConfigProperties,
    }),
    'director.intent': strictCommandSchema('director.intent', ['handle', 'intent'], {
        handle: stringSchema,
        intent: anySchema,
    }),
    'director.sync.request': strictCommandSchema('director.sync.request', ['handle'], {
        handle: stringSchema,
        payload: anySchema,
    }),
    'director.relay.stop': strictCommandSchema('director.relay.stop', ['handle'], {
        handle: stringSchema,
    }),
    health: strictCommandSchema('health', [], {
        includeRtcDiagnostics: booleanSchema,
    }),
    stats: strictCommandSchema('stats', []),
    close: strictCommandSchema('close', []),
    reset: strictCommandSchema('reset', []),
};

export const RALLAR_BLACK_BOX_COMMAND_CAPABILITIES: readonly RallarBlackBoxCommandCapability[] = [
    {
        kind: 'configure',
        title: 'Configure Runtime',
        description: 'Sets run, agent, provider, default room, transport, browser, control, and redaction context.',
        requiredFields: ['config'],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'rallar-memory', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: [],
        artifactExpectations: ['runtime configuration snapshot', 'redacted config in reports'],
        example: {
            kind: 'configure',
            commandId: 'configure-local-agent',
            config: {
                runId: 'schema-example-run',
                agentId: 'agent-1',
                environment: 'local',
                apiBaseUrl: 'http://localhost:8080',
                actor: 'alice',
                roomId: 'bb-group',
                transport: 'realtime',
            },
        },
    },
    {
        kind: 'recipe.load',
        title: 'Load Recipe',
        description: 'Stages a recipe in a browser agent without starting unrelated shell execution.',
        requiredFields: ['recipe'],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['loaded recipe metadata', 'readiness/ACK result when used for staging'],
        example: {
            kind: 'recipe.load',
            commandId: 'load-health-recipe',
            recipe: {
                recipeId: 'health-only',
                commands: [{ kind: 'health', commandId: 'loaded-health' }],
            },
        },
    },
    {
        kind: 'recipe.run',
        title: 'Run Recipe',
        description: 'Runs an inline or previously loaded browser-agent recipe and records command results.',
        requiredFields: [],
        optionalFields: ['recipe', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['per-command results', 'events', 'stats', 'final report'],
        example: {
            kind: 'recipe.run',
            commandId: 'run-health-recipe',
            recipe: {
                recipeId: 'health-run',
                commands: [{ kind: 'health', commandId: 'run-health' }],
            },
        },
    },
    {
        kind: 'recipe.cancel',
        title: 'Cancel Recipe',
        description: 'Requests cancellation of the active browser-agent recipe.',
        requiredFields: [],
        optionalFields: ['reason', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['cancel result', 'partial command history'],
        example: {
            kind: 'recipe.cancel',
            commandId: 'cancel-active-recipe',
            reason: 'operator requested cancellation',
        },
    },
    {
        kind: 'loop',
        title: 'Loop Commands',
        description: 'Composite browser-agent command that repeats child commands with bounded count or duration and optional cadence.',
        requiredFields: ['commands'],
        optionalFields: [
            'count',
            'durationMs',
            'intervalMs',
            'delayMs',
            'continueOnFailure',
            'maxCommands',
            'thresholds',
            'commandId',
            'label',
            'timeoutMs',
            'deadlineEpochMs',
            'metadata',
        ],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'rallar-memory', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['same live requirements as its child commands'],
        artifactExpectations: ['parent loop rollup', 'per-child command results', 'iteration metadata'],
        example: {
            kind: 'loop',
            commandId: 'loop-rtc-position',
            count: 3,
            intervalMs: 50,
            thresholds: {
                minAchievedRateHz: 10,
                minSendSuccessRatio: 0.95,
            },
            commands: [
                {
                    kind: 'rtc.send',
                    commandId: 'loop-position-send',
                    connection: 'aliceRtc',
                    transport: 'realtime',
                    send: {
                        roomId: 'bb-group',
                        data: {
                            topic: 'schema.example.loop.position',
                            seq: '{loop.index}',
                        },
                    },
                },
            ],
        },
    },
    {
        kind: 'parallel',
        title: 'Parallel Command Groups',
        description: 'Composite browser-agent command that runs bounded groups concurrently while each group runs its child commands sequentially.',
        requiredFields: ['groups'],
        optionalFields: [
            'maxConcurrency',
            'failFast',
            'continueOnFailure',
            'commandId',
            'label',
            'timeoutMs',
            'deadlineEpochMs',
            'metadata',
        ],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'rallar-memory', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['same live requirements as its child commands'],
        artifactExpectations: ['parent parallel rollup', 'per-group summaries', 'per-child command results'],
        example: {
            kind: 'parallel',
            commandId: 'parallel-room-traffic',
            maxConcurrency: 2,
            failFast: true,
            groups: [
                {
                    groupId: 'alice-sends',
                    commands: [
                        {
                            kind: 'ws.send',
                            commandId: 'alice-ws-send',
                            connection: 'apiWs',
                            data: {
                                typeId: 'schema.example.parallel.alice',
                                payload: {
                                    text: 'alice',
                                },
                            },
                        },
                    ],
                },
                {
                    groupId: 'bob-sends',
                    commands: [
                        {
                            kind: 'health',
                            commandId: 'bob-health',
                        },
                    ],
                },
            ],
        },
    },
    {
        kind: 'wait',
        title: 'Wait For Runtime Evidence',
        description: 'Waits for an existing or future browser-agent runtime event, diagnostic, message, result, stats, or report that matches simple fields.',
        requiredFields: ['match'],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'rallar-memory', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['the matching evidence must be emitted by earlier or concurrent commands, browser adapters, or provider event bridges'],
        artifactExpectations: ['matched event in the command result', 'timeout failure when evidence does not appear'],
        example: {
            kind: 'wait',
            commandId: 'wait-for-room-position',
            timeoutMs: 5_000,
            match: {
                kind: 'message',
                topic: 'rallar.browser.realtime.message',
                transport: 'realtime',
                payloadPath: 'data.topic',
                equals: 'room.position',
            },
        },
    },
    {
        kind: 'assert',
        title: 'Assert Runtime Evidence',
        description: 'Checks a simple read-only browser-agent source such as state, config, last result, events, messages, diagnostics, stats, or failures.',
        requiredFields: ['source', 'operator'],
        optionalFields: ['expected', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'rallar-memory', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['the asserted source must be present in the browser-agent runtime state'],
        artifactExpectations: ['assert result with redacted actual and expected values', 'failed command result when the assertion is false'],
        example: {
            kind: 'assert',
            commandId: 'assert-received-count',
            source: 'state.messages.length',
            operator: 'gte',
            expected: 1,
        },
    },
    {
        kind: 'rtc.connect',
        title: 'RTC Connect',
        description: 'Connects an RTC/realtime provider and can wait for exact-room ready peers.',
        requiredFields: [],
        optionalFields: [
            'connection',
            'actor',
            'roomId',
            'applicationId',
            'workspaceId',
            'scope',
            'roomRef',
            'minSnapshotVersion',
            'transport',
            'rallar',
            'readiness',
            'commandId',
            'label',
            'timeoutMs',
            'deadlineEpochMs',
            'metadata',
        ],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'rallar-memory'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['Rallar API and signaling when provider mode is browser-rallar or rallar-browser'],
        artifactExpectations: ['connect diagnostics', 'readiness diagnostics', 'RTC stats'],
        example: {
            kind: 'rtc.connect',
            commandId: 'connect-alice-rtc',
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'bb-group',
            roomRef: { applicationId: 'rallar-server', groupId: 'bb-group' },
            transport: 'realtime',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 10_000,
                intervalMs: 100,
            },
            timeoutMs: 15_000,
        },
    },
    {
        kind: 'rtc.send',
        title: 'RTC Send',
        description: 'Sends JSON through a connected RTC/realtime provider.',
        requiredFields: [],
        optionalFields: [
            'connection',
            'send',
            'applicationId',
            'workspaceId',
            'scope',
            'roomRef',
            'minSnapshotVersion',
            'transport',
            'commandId',
            'label',
            'timeoutMs',
            'deadlineEpochMs',
            'metadata',
        ],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'rallar-memory'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['active RTC connection', 'Rallar signaling when using browser-rallar or rallar-browser'],
        artifactExpectations: ['send result', 'message events', 'NACK/failure diagnostics when delivery cannot complete'],
        example: {
            kind: 'rtc.send',
            commandId: 'send-rtc-json',
            connection: 'aliceRtc',
            transport: 'realtime',
            send: {
                roomId: 'bb-group',
                data: {
                    topic: 'schema.example.rtc',
                    text: 'hello over RTC',
                },
            },
            timeoutMs: 5_000,
        },
    },
    {
        kind: 'rtc.stream',
        title: 'RTC Stream',
        description: 'Schedules a bounded RTC/realtime frame stream inside one browser-agent command and records aggregate pacing, delivery, and latency metrics.',
        requiredFields: ['send'],
        optionalFields: [
            'connection',
            'actor',
            'roomId',
            'applicationId',
            'workspaceId',
            'scope',
            'roomRef',
            'minSnapshotVersion',
            'transport',
            'count',
            'durationMs',
            'intervalMs',
            'rateHz',
            'maxInFlight',
            'drainTimeoutMs',
            'continueOnSendFailure',
            'progressEveryMs',
            'sampleEvery',
            'thresholds',
            'commandId',
            'label',
            'timeoutMs',
            'deadlineEpochMs',
            'metadata',
        ],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['active RTC connection', 'Rallar signaling when using browser-rallar or rallar-browser'],
        artifactExpectations: ['stream started/progress/completed diagnostics', 'aggregate frame delivery metrics', 'p50/p95/p99/max send duration'],
        example: {
            kind: 'rtc.stream',
            commandId: 'stream-rtc-position',
            connection: 'aliceRtc',
            transport: 'realtime',
            roomId: 'bb-group',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            count: 3,
            intervalMs: 50,
            maxInFlight: 64,
            drainTimeoutMs: 5_000,
            send: {
                roomId: 'bb-group',
                data: {
                    topic: 'schema.example.rtc.stream.position',
                    seq: '{stream.index}',
                    frame: '{stream.iteration}',
                    tMs: '{stream.elapsedMs}',
                },
            },
            thresholds: {
                minSendSuccessRatio: 0.99,
                maxDroppedFrames: 0,
            },
            timeoutMs: 10_000,
        },
    },
    {
        kind: 'ws.open',
        title: 'WebSocket Open',
        description: 'Opens a browser-agent WebSocket connection.',
        requiredFields: [],
        optionalFields: ['connection', 'url', 'protocols', 'headers', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-server', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['WebSocket endpoint and ticket/token when the target server requires auth'],
        artifactExpectations: ['open result', 'socket state events', 'close/error diagnostics'],
        example: {
            kind: 'ws.open',
            commandId: 'open-api-websocket',
            connection: 'apiWs',
            url: 'ws://localhost:8080/api/ws/{auth.sessionId}?ticket={auth.wsTicket}',
            timeoutMs: 10_000,
        },
    },
    {
        kind: 'ws.send',
        title: 'WebSocket Send',
        description: 'Sends JSON or text through an open WebSocket connection.',
        requiredFields: [],
        optionalFields: ['connection', 'data', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-server', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['open WebSocket connection'],
        artifactExpectations: ['send result', 'message events when the server echoes or routes the payload'],
        example: {
            kind: 'ws.send',
            commandId: 'send-ws-json',
            connection: 'apiWs',
            data: {
                typeId: 'schema.example.ws',
                topicId: 'schema.example.ws',
                payload: {
                    text: 'hello over WebSocket',
                },
            },
            timeoutMs: 5_000,
        },
    },
    {
        kind: 'ws.close',
        title: 'WebSocket Close',
        description: 'Closes a named WebSocket connection.',
        requiredFields: [],
        optionalFields: ['connection', 'code', 'reason', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-server', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['open or known WebSocket connection'],
        artifactExpectations: ['close result', 'socket close event'],
        example: {
            kind: 'ws.close',
            commandId: 'close-api-websocket',
            connection: 'apiWs',
            code: 1000,
            reason: 'schema example complete',
        },
    },
    {
        kind: 'http.request',
        title: 'HTTP Request',
        description: 'Runs a fetch-compatible HTTP request and stores response metadata/body according to response options.',
        requiredFields: ['request'],
        optionalFields: ['response', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-server', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['HTTP endpoint', 'access token for protected Rallar Server APIs'],
        artifactExpectations: ['request timing', 'HTTP status', 'redacted response body'],
        example: {
            kind: 'http.request',
            commandId: 'get-rallar-health',
            request: {
                method: 'GET',
                path: '/health',
            },
            response: {
                body: 'json',
            },
            timeoutMs: 5_000,
        },
    },
    {
        kind: 'crdt.open',
        title: 'CRDT Open',
        description: 'Opens a Rallar CRDT document through the browser Rallar facade and stores it under a handle.',
        requiredFields: ['name'],
        optionalFields: [
            'handle',
            'applicationId',
            'workspaceId',
            'documentId',
            'documentType',
            'scope',
            'roomRef',
            'principalId',
            'customScope',
            'transport',
            'persist',
            'tabSync',
            'initialValue',
            'policies',
            'validation',
            'encryption',
            'durableCatchUp',
            'commandId',
            'label',
            'timeoutMs',
            'deadlineEpochMs',
            'metadata',
        ],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['Rallar browser runtime with CRDT facade; live service only when transport is not local-only'],
        artifactExpectations: ['document ref', 'handle', 'transport strategy', 'initial health'],
        example: {
            kind: 'crdt.open',
            commandId: 'open-crdt-checklist',
            handle: 'checklist',
            name: 'checklist',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            documentType: 'checklist',
            documentId: 'room-1',
            scope: {
                kind: 'room',
            },
            roomRef: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'room-1',
            },
            transport: 'ws',
            persist: true,
            tabSync: true,
            durableCatchUp: 'http',
            initialValue: {
                items: [],
            },
            timeoutMs: 10_000,
        },
    },
    {
        kind: 'crdt.apply',
        title: 'CRDT Apply',
        description: 'Applies an existing Rallar CRDT operation batch to an opened document handle.',
        requiredFields: ['handle', 'batch'],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle'],
        artifactExpectations: ['update id', 'materialized value', 'pending counts', 'health'],
        example: {
            kind: 'crdt.apply',
            commandId: 'apply-crdt-title',
            handle: 'checklist',
            batch: {
                kind: 'batch',
                operationGroupId: 'group-title-1',
                operations: [
                    {
                        kind: 'register.set',
                        path: ['title'],
                        value: 'Ready',
                        policy: 'lww',
                    },
                ],
            },
        },
    },
    {
        kind: 'crdt.read',
        title: 'CRDT Read',
        description: 'Reads the materialized value and ref from an opened CRDT document handle.',
        requiredFields: ['handle'],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle'],
        artifactExpectations: ['materialized CRDT value', 'document ref', 'health'],
        example: {
            kind: 'crdt.read',
            commandId: 'read-crdt-checklist',
            handle: 'checklist',
        },
    },
    {
        kind: 'crdt.sync',
        title: 'CRDT Sync',
        description: 'Runs CRDT document sync with an optional transport override.',
        requiredFields: ['handle'],
        optionalFields: ['reason', 'transport', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle; live transport or HTTP catch-up when configured'],
        artifactExpectations: ['sync status', 'transport strategy', 'sent/received counts', 'pending counts'],
        example: {
            kind: 'crdt.sync',
            commandId: 'sync-crdt-checklist',
            handle: 'checklist',
            reason: 'black-box-convergence-check',
            transport: 'ws',
            timeoutMs: 10_000,
        },
    },
    {
        kind: 'crdt.health',
        title: 'CRDT Status',
        description: 'Returns health for an opened CRDT document handle.',
        requiredFields: ['handle'],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle'],
        artifactExpectations: ['pending/failed/dependency counts', 'transport strategy', 'integrity status'],
        example: {
            kind: 'crdt.health',
            commandId: 'health-crdt-checklist',
            handle: 'checklist',
        },
    },
    {
        kind: 'crdt.wait',
        title: 'CRDT Wait',
        description: 'Polls an opened CRDT document until materialized value or health conditions match.',
        requiredFields: ['handle', 'conditions'],
        optionalFields: ['intervalMs', 'stableForMs', 'sync', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle; live transport or HTTP catch-up when sync is requested'],
        artifactExpectations: ['matched materialized value or health', 'attempt count', 'wait duration', 'last sync result'],
        example: {
            kind: 'crdt.wait',
            commandId: 'wait-crdt-checklist-converged',
            handle: 'checklist',
            timeoutMs: 10_000,
            intervalMs: 250,
            stableForMs: 500,
            sync: {
                reason: 'black-box-crdt-wait',
                transport: 'ws',
            },
            conditions: [
                {
                    source: 'value',
                    path: 'title',
                    operator: 'equals',
                    expected: 'Ready',
                },
                {
                    source: 'health',
                    path: 'pendingUpdateCount',
                    operator: 'equals',
                    expected: 0,
                },
                {
                    source: 'health',
                    path: 'dependencyBlockedUpdateCount',
                    operator: 'equals',
                    expected: 0,
                },
            ],
        },
    },
    {
        kind: 'crdt.undo',
        title: 'CRDT Undo',
        description: 'Applies actor-owned CRDT undo operations for a target operation group.',
        requiredFields: ['handle', 'targetOperationGroupId', 'operations'],
        optionalFields: ['operationGroupId', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle and caller-supplied inverse operations'],
        artifactExpectations: ['undo update id', 'materialized value', 'health'],
        example: {
            kind: 'crdt.undo',
            commandId: 'undo-crdt-title',
            handle: 'checklist',
            targetOperationGroupId: 'group-title-1',
            operationGroupId: 'undo-title-1',
            operations: [
                {
                    kind: 'register.set',
                    path: ['title'],
                    value: 'Untitled',
                    policy: 'lww',
                },
            ],
        },
    },
    {
        kind: 'crdt.redo',
        title: 'CRDT Redo',
        description: 'Reapplies actor-owned CRDT redo operations for a target operation group.',
        requiredFields: ['handle', 'targetOperationGroupId', 'operations'],
        optionalFields: ['operationGroupId', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle and caller-supplied redo operations'],
        artifactExpectations: ['redo update id', 'materialized value', 'health'],
        example: {
            kind: 'crdt.redo',
            commandId: 'redo-crdt-title',
            handle: 'checklist',
            targetOperationGroupId: 'group-title-1',
            operationGroupId: 'redo-title-1',
            operations: [
                {
                    kind: 'register.set',
                    path: ['title'],
                    value: 'Ready',
                    policy: 'lww',
                },
            ],
        },
    },
    {
        kind: 'crdt.close',
        title: 'CRDT Close',
        description: 'Closes an opened CRDT document handle without destroying local durable artifacts.',
        requiredFields: ['handle'],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle'],
        artifactExpectations: ['close result and final health snapshot when available'],
        example: {
            kind: 'crdt.close',
            commandId: 'close-crdt-checklist',
            handle: 'checklist',
        },
    },
    {
        kind: 'crdt.destroy',
        title: 'CRDT Destroy',
        description: 'Destroys an opened CRDT document handle and its local browser artifacts.',
        requiredFields: ['handle'],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle'],
        artifactExpectations: ['destroy result and removed handle'],
        example: {
            kind: 'crdt.destroy',
            commandId: 'destroy-crdt-checklist',
            handle: 'checklist',
        },
    },
    {
        kind: 'director.appoint',
        title: 'Appoint SPA Director',
        description: 'Appoints the current browser session as the Rallar group director through the browser facade.',
        requiredFields: [],
        optionalFields: ['roomId', 'applicationId', 'workspaceId', 'scope', 'roomRef', 'heartbeatTtlMs', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['connected browser Rallar session with group update authorization'],
        artifactExpectations: ['director appointment status', 'updated director metadata'],
        example: {
            kind: 'director.appoint',
            commandId: 'appoint-director',
            roomId: 'bb-group',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            heartbeatTtlMs: 1_200,
        },
    },
    {
        kind: 'director.resign',
        title: 'Resign SPA Director',
        description: 'Clears the current browser session director appointment when it is the appointed director.',
        requiredFields: [],
        optionalFields: ['roomId', 'applicationId', 'workspaceId', 'scope', 'roomRef', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['connected browser Rallar session'],
        artifactExpectations: ['director resignation status', 'updated director metadata'],
        example: {
            kind: 'director.resign',
            commandId: 'resign-director',
            roomId: 'bb-group',
            applicationId: 'rallar-server',
            workspaceId: 'default',
        },
    },
    {
        kind: 'director.status',
        title: 'Read SPA Director Status',
        description: 'Reads local director appointment, freshness, and role state, optionally refreshing room metadata first.',
        requiredFields: [],
        optionalFields: ['roomId', 'applicationId', 'workspaceId', 'scope', 'roomRef', 'refresh', 'now', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['connected browser Rallar session; Rallar API when refresh is true'],
        artifactExpectations: ['director role, freshness, appointment epoch, and session id'],
        example: {
            kind: 'director.status',
            commandId: 'director-status',
            roomId: 'bb-group',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            refresh: true,
        },
    },
    {
        kind: 'director.relay.start',
        title: 'Start SPA Director Relay',
        description: 'Starts a deterministic test relay backed by rallar.director.createRelay and stores it under a handle.',
        requiredFields: ['handle', 'intentTypeId', 'outputTypeId'],
        optionalFields: [
            'roomId',
            'applicationId',
            'workspaceId',
            'scope',
            'roomRef',
            'laneId',
            'topicId',
            'heartbeatTypeId',
            'snapshotTypeId',
            'syncRequestTypeId',
            'heartbeatIntervalMs',
            'snapshotIntervalMs',
            'snapshot',
            'commandId',
            'label',
            'timeoutMs',
            'deadlineEpochMs',
            'metadata',
        ],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['connected browser Rallar session with RTC/WS message subscriptions'],
        artifactExpectations: ['relay start diagnostics', 'director intent/output/snapshot events'],
        example: {
            kind: 'director.relay.start',
            commandId: 'start-director-relay',
            handle: 'game-director',
            roomId: 'bb-group',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            topicId: 'app.black-box.director',
            intentTypeId: 'app.black-box.director.intent',
            outputTypeId: 'app.black-box.director.output',
            heartbeatIntervalMs: 300,
            snapshotIntervalMs: 500,
        },
    },
    {
        kind: 'director.intent',
        title: 'Send SPA Director Intent',
        description: 'Sends an intent through a started director relay toward the appointed director.',
        requiredFields: ['handle', 'intent'],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['started director relay and fresh director appointment'],
        artifactExpectations: ['intent send result and downstream director output events'],
        example: {
            kind: 'director.intent',
            commandId: 'send-director-intent',
            handle: 'game-director',
            intent: {
                intentId: 'intent-1',
                action: 'move',
                x: 1,
                y: 0,
            },
        },
    },
    {
        kind: 'director.sync.request',
        title: 'Request SPA Director Sync',
        description: 'Requests a director snapshot through a started director relay.',
        requiredFields: ['handle'],
        optionalFields: ['payload', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['started director relay and fresh director appointment'],
        artifactExpectations: ['sync request send result and snapshot events'],
        example: {
            kind: 'director.sync.request',
            commandId: 'request-director-sync',
            handle: 'game-director',
            payload: {
                reason: 'late-join',
            },
        },
    },
    {
        kind: 'director.relay.stop',
        title: 'Stop SPA Director Relay',
        description: 'Stops a previously started director relay and clears its heartbeat/snapshot timers.',
        requiredFields: ['handle'],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['started director relay handle'],
        artifactExpectations: ['relay stop diagnostics and final relay counters'],
        example: {
            kind: 'director.relay.stop',
            commandId: 'stop-director-relay',
            handle: 'game-director',
        },
    },
    {
        kind: 'health',
        title: 'Health',
        description: 'Returns browser-agent runtime health without network side effects.',
        requiredFields: [],
        optionalFields: ['includeRtcDiagnostics', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'rallar-memory', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['runtime status snapshot'],
        example: {
            kind: 'health',
            commandId: 'health-check',
            label: 'Health check',
        },
    },
    {
        kind: 'stats',
        title: 'Stats',
        description: 'Captures a browser-agent stats snapshot.',
        requiredFields: [],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'rallar-memory', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['command counts', 'event counts', 'latest status'],
        example: {
            kind: 'stats',
            commandId: 'stats-snapshot',
        },
    },
    {
        kind: 'close',
        title: 'Close',
        description: 'Closes active browser-agent transports without clearing the whole runtime state.',
        requiredFields: [],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'rallar-memory', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['transport close events', 'final stats'],
        example: {
            kind: 'close',
            commandId: 'close-transports',
        },
    },
    {
        kind: 'reset',
        title: 'Reset',
        description: 'Resets browser-agent runtime command state and closes active transports.',
        requiredFields: [],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'rallar-memory', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['reset result', 'new idle runtime state'],
        example: {
            kind: 'reset',
            commandId: 'reset-agent',
        },
    },
];

export const RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA: JsonSchema = {
    $schema: JSON_SCHEMA_DRAFT,
    $id: `${SCHEMA_BASE_ID}/rallar-bb-test-command.schema.json`,
    title: 'Rallar black-box browser-agent command',
    description: 'Command JSON accepted by the SPA runtime and browser control agents.',
    oneOf: RALLAR_BLACK_BOX_COMMAND_CAPABILITIES.map(capability => COMMAND_SCHEMAS[capability.kind]),
    examples: RALLAR_BLACK_BOX_COMMAND_CAPABILITIES.map(capability => capability.example),
};

recursiveCommandSchema.oneOf = RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA.oneOf;

export const RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA: JsonSchema = {
    $schema: JSON_SCHEMA_DRAFT,
    $id: `${SCHEMA_BASE_ID}/rallar-bb-test-recipe.schema.json`,
    title: 'Rallar black-box browser-agent recipe',
    description: 'A browser-agent recipe made from rallar-bb-test commands.',
    type: 'object',
    required: ['recipeId', 'commands'],
    properties: {
        schemaVersion: { const: RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION },
        recipeId: stringSchema,
        name: stringSchema,
        description: stringSchema,
        continueOnFailure: booleanSchema,
        metadata: recordSchema,
        commands: {
            type: 'array',
            items: RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
        },
    },
    additionalProperties: false,
};

export const RALLAR_BLACK_BOX_CONTROL_COMMAND_ENVELOPE_SCHEMA: JsonSchema = {
    $schema: JSON_SCHEMA_DRAFT,
    $id: `${SCHEMA_BASE_ID}/rallar-bb-test-control-command-envelope.schema.json`,
    title: 'Rallar black-box control command envelope',
    description: 'Server-to-browser control message that dispatches one command to an agent.',
    type: 'object',
    required: ['kind', 'protocolVersion', 'runId', 'commandId', 'command'],
    properties: {
        kind: { const: 'command' },
        protocolVersion: { const: 1 },
        runId: stringSchema,
        agentId: stringSchema,
        commandId: stringSchema,
        command: RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
        deadlineEpochMs: integerSchema,
    },
    additionalProperties: false,
};

export const RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA: JsonSchema = {
    $schema: JSON_SCHEMA_DRAFT,
    $id: `${SCHEMA_BASE_ID}/rallar-bb-test-distributed-run-manifest.schema.json`,
    title: 'Rallar black-box distributed run manifest',
    description: 'Orchestration manifest for running one or more recipes across selected browser agents.',
    type: 'object',
    required: ['distributedRunId', 'group', 'recipes', 'targetPolicy'],
    properties: {
        schemaVersion: { const: 1 },
        distributedRunId: stringSchema,
        controlRunId: stringSchema,
        displayName: stringSchema,
        description: stringSchema,
        group: {
            type: 'object',
            required: ['applicationId', 'workspaceId', 'groupId'],
            properties: {
                applicationId: stringSchema,
                workspaceId: stringSchema,
                groupId: stringSchema,
            },
            additionalProperties: false,
        },
        recipes: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    recipeId: stringSchema,
                    role: stringSchema,
                    profile: stringSchema,
                    recipe: RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
                    variables: recordSchema,
                    secretRefs: { type: 'array', items: stringSchema },
                    required: booleanSchema,
                },
                additionalProperties: false,
            },
        },
        targetPolicy: {
            type: 'object',
            required: ['mode'],
            properties: {
                mode: {
                    type: 'string',
                    enum: RALLAR_BLACK_BOX_DISTRIBUTED_TARGET_POLICY_MODES,
                },
                expectedParticipantCount: { type: 'integer', minimum: 1 },
                agentIds: { type: 'array', items: stringSchema },
                roles: {
                    type: 'object',
                    additionalProperties: {
                        type: 'array',
                        items: stringSchema,
                    },
                },
                includeOfflineExpectedAgents: booleanSchema,
            },
            additionalProperties: false,
        },
        variables: recordSchema,
        secretRefs: { type: 'array', items: stringSchema },
        roleAssignments: {
            type: 'array',
            items: {
                type: 'object',
                required: ['role', 'agentId'],
                properties: {
                    role: stringSchema,
                    agentId: stringSchema,
                    recipeIds: { type: 'array', items: stringSchema },
                    required: booleanSchema,
                    variables: recordSchema,
                },
                additionalProperties: false,
            },
        },
        roleAssignmentPolicy: {
            type: 'object',
            required: ['mode', 'pattern'],
            properties: {
                mode: {
                    type: 'string',
                    enum: RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_POLICY_MODES,
                },
                pattern: {
                    type: 'string',
                    enum: RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_PATTERNS,
                },
                orderBy: {
                    type: 'string',
                    enum: RALLAR_BLACK_BOX_DISTRIBUTED_ROLE_ASSIGNMENT_ORDERINGS,
                },
            },
            additionalProperties: false,
        },
        ackTimeoutMs: { type: 'integer', minimum: 1 },
        barrier: {
            type: 'object',
            properties: {
                enabled: booleanSchema,
                timeoutMs: { type: 'integer', minimum: 1 },
            },
            additionalProperties: false,
        },
        startMode: {
            type: 'string',
            enum: RALLAR_BLACK_BOX_DISTRIBUTED_START_MODES,
        },
        startDeadlineEpochMs: integerSchema,
        artifactPolicy: {
            type: 'object',
            properties: {
                retainArtifacts: booleanSchema,
                includeEventJsonl: booleanSchema,
                includeResultJsonl: booleanSchema,
                includeFailureBundle: booleanSchema,
                includeDistributedMetadata: booleanSchema,
                retentionDays: { type: 'integer', minimum: 1 },
            },
            additionalProperties: false,
        },
        metadata: recordSchema,
    },
    additionalProperties: false,
};

export const RALLAR_BLACK_BOX_SCHEMA_CATALOG = {
    schemaVersion: RALLAR_BLACK_BOX_SCHEMA_VERSION,
    command: RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
    recipe: RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
    controlCommandEnvelope: RALLAR_BLACK_BOX_CONTROL_COMMAND_ENVELOPE_SCHEMA,
    distributedRunManifest: RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
} as const;

export function validateJsonSchema(schema: JsonSchema, value: unknown): JsonSchemaValidationResult {
    const errors: JsonSchemaValidationIssue[] = [];
    validateNode(schema, value, '$', errors);
    return errors.length === 0
        ? { ok: true, errors: [] }
        : { ok: false, errors };
}

export function formatJsonSchemaValidationErrors(errors: readonly JsonSchemaValidationIssue[]): string {
    return errors.map(error => `${error.path}: ${error.message}`).join('\n');
}

export function validateRallarBlackBoxRecipeCompatibility(
    value: unknown,
): RallarBlackBoxRecipeCompatibilityResult {
    const root = isRecord(value) ? value : {};
    const explicitSchemaVersion = root.schemaVersion;
    const schemaValidation = validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, value);
    const warnings: JsonSchemaValidationIssue[] = explicitSchemaVersion === undefined
        ? [{
            path: '$.schemaVersion',
            message: 'No explicit schemaVersion was found; treating recipe as compatible v1.',
        }]
        : [];

    if (!schemaValidation.ok) {
        return {
            ok: false,
            schemaVersion: explicitSchemaVersion === RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION
                ? RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION
                : undefined,
            explicitSchemaVersion,
            legacy: explicitSchemaVersion === undefined,
            warnings,
            errors: schemaValidation.errors,
        };
    }

    return {
        ok: true,
        schemaVersion: RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION,
        explicitSchemaVersion: explicitSchemaVersion === RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION
            ? RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION
            : undefined,
        legacy: explicitSchemaVersion === undefined,
        warnings,
        errors: [],
    };
}

function validateNode(
    schema: JsonSchema,
    value: unknown,
    path: string,
    errors: JsonSchemaValidationIssue[],
): void {
    if (schema.const !== undefined && !sameJsonValue(schema.const, value)) {
        errors.push({ path, message: `Expected ${JSON.stringify(schema.const)}.` });
        return;
    }

    if (schema.enum && !schema.enum.some(candidate => sameJsonValue(candidate, value))) {
        errors.push({ path, message: `Expected one of ${schema.enum.map(candidate => JSON.stringify(candidate)).join(', ')}.` });
        return;
    }

    if (schema.oneOf) {
        const discriminated = discriminatedOneOfSchema(schema.oneOf, value);
        if (discriminated) {
            validateNode(discriminated, value, path, errors);
            return;
        }

        const matches = schema.oneOf
            .map(candidate => validationErrors(candidate, value, path).length === 0)
            .filter(Boolean).length;
        if (matches !== 1) {
            errors.push({ path, message: `Expected value to match exactly one schema, matched ${matches}.` });
        }
        return;
    }

    if (schema.anyOf) {
        const matches = schema.anyOf.some(candidate => validationErrors(candidate, value, path).length === 0);
        if (!matches) {
            errors.push({ path, message: 'Expected value to match at least one schema.' });
        }
        return;
    }

    if (schema.type && !matchesType(value, schema.type)) {
        errors.push({ path, message: `Expected ${Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type}.` });
        return;
    }

    if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
        errors.push({ path, message: `Expected number >= ${schema.minimum}.` });
    }

    if (
        typeof schema.exclusiveMinimum === 'number' &&
        typeof value === 'number' &&
        value <= schema.exclusiveMinimum
    ) {
        errors.push({ path, message: `Expected number > ${schema.exclusiveMinimum}.` });
    }

    if (typeof schema.maximum === 'number' && typeof value === 'number' && value > schema.maximum) {
        errors.push({ path, message: `Expected number <= ${schema.maximum}.` });
    }

    if (typeof schema.minItems === 'number' && Array.isArray(value) && value.length < schema.minItems) {
        errors.push({ path, message: `Expected at least ${schema.minItems} item(s).` });
    }

    if (schema.items && Array.isArray(value)) {
        value.forEach((entry, index) => {
            validateNode(schema.items as JsonSchema, entry, `${path}[${index}]`, errors);
        });
    }

    if (schema.required && isRecord(value)) {
        for (const property of schema.required) {
            if (value[property] === undefined) {
                errors.push({ path, message: `Missing required property ${property}.` });
            }
        }
    }

    if (schema.requiredAnyOf && isRecord(value)) {
        for (const requirement of schema.requiredAnyOf) {
            if (!requirement.properties.some(property => value[property] !== undefined)) {
                errors.push({ path, message: requirement.message });
            }
        }
    }

    if (!isRecord(value)) {
        return;
    }

    const propertySchemas = schema.properties ?? {};
    for (const [property, propertySchema] of Object.entries(propertySchemas)) {
        if (value[property] !== undefined) {
            validateNode(propertySchema, value[property], childPath(path, property), errors);
        }
    }

    const knownProperties = new Set(Object.keys(propertySchemas));
    for (const [property, propertyValue] of Object.entries(value)) {
        if (knownProperties.has(property)) {
            continue;
        }

        if (schema.additionalProperties === false) {
            errors.push({ path: childPath(path, property), message: 'Unexpected property.' });
            continue;
        }

        if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
            validateNode(schema.additionalProperties, propertyValue, childPath(path, property), errors);
        }
    }
}

function validationErrors(schema: JsonSchema, value: unknown, path: string): JsonSchemaValidationIssue[] {
    const errors: JsonSchemaValidationIssue[] = [];
    validateNode(schema, value, path, errors);
    return errors;
}

function discriminatedOneOfSchema(candidates: readonly JsonSchema[], value: unknown): JsonSchema | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const kind = value.kind;
    if (typeof kind !== 'string') {
        return undefined;
    }

    return candidates.find(candidate => candidate.properties?.kind?.const === kind);
}

function matchesType(value: unknown, expected: string | readonly string[]): boolean {
    if (Array.isArray(expected)) {
        return expected.some(type => matchesType(value, type));
    }

    switch (expected) {
        case 'array':
            return Array.isArray(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'integer':
            return Number.isInteger(value);
        case 'null':
            return value === null;
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'object':
            return isRecord(value);
        case 'string':
            return typeof value === 'string';
        default:
            return true;
    }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function childPath(parent: string, property: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
        ? `${parent}.${property}`
        : `${parent}[${JSON.stringify(property)}]`;
}
