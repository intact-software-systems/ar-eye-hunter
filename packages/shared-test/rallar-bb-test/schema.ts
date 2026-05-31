import {
    RALLAR_BLACK_BOX_TEST_COMMAND_KINDS,
    type RallarBlackBoxTestCommand,
} from './types.ts';
import {
    RALLAR_BLACK_BOX_DISTRIBUTED_START_MODES,
    RALLAR_BLACK_BOX_DISTRIBUTED_TARGET_POLICY_MODES,
} from './distributed-run.ts';

export const RALLAR_BLACK_BOX_SCHEMA_VERSION = 1;

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
    minimum?: number;
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
    }),
    'rtc.send': strictCommandSchema('rtc.send', [], {
        connection: stringSchema,
        send: anySchema,
        expect: anySchema,
        applicationId: stringSchema,
        workspaceId: stringSchema,
        scope: recordSchema,
        roomRef: recordSchema,
        minSnapshotVersion: numberSchema,
        transport: rtcTransportSchema,
    }),
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
    health: strictCommandSchema('health', []),
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
        kind: 'rtc.connect',
        title: 'RTC Connect',
        description: 'Connects an RTC/realtime provider connection for the configured actor and room.',
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
            'commandId',
            'label',
            'timeoutMs',
            'deadlineEpochMs',
            'metadata',
        ],
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'rallar-memory'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['Rallar API and signaling when provider mode is browser-rallar or rallar-browser'],
        artifactExpectations: ['connect diagnostics', 'lane readiness events', 'RTC stats'],
        example: {
            kind: 'rtc.connect',
            commandId: 'connect-alice-rtc',
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'bb-group',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            transport: 'realtime',
            timeoutMs: 10_000,
        },
    },
    {
        kind: 'rtc.send',
        title: 'RTC Send',
        description: 'Sends JSON through a connected RTC/realtime provider and optionally records expectations.',
        requiredFields: [],
        optionalFields: [
            'connection',
            'send',
            'expect',
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
        kind: 'health',
        title: 'Health',
        description: 'Returns browser-agent runtime health without network side effects.',
        requiredFields: [],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
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

export const RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA: JsonSchema = {
    $schema: JSON_SCHEMA_DRAFT,
    $id: `${SCHEMA_BASE_ID}/rallar-bb-test-recipe.schema.json`,
    title: 'Rallar black-box browser-agent recipe',
    description: 'A browser-agent recipe made from rallar-bb-test commands.',
    type: 'object',
    required: ['recipeId', 'commands'],
    properties: {
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
        ackTimeoutMs: { type: 'integer', minimum: 1 },
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
