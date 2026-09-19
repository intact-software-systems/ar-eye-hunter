import {
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
    RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA
} from '@shared-test/rallar-bb-test/schema.ts';
import type { JsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { RALLAR_BLACK_BOX_COMMAND_CAPABILITIES } from '@shared-test/rallar-bb-test/schema/rallar-black-box-command-capabilities.ts';
import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

export type DistributedRecipePromptTemplateId =
    | 'live-group-ack'
    | 'ws-send-receive'
    | 'rtc-realtime-position'
    | 'looped-rtc-load'
    | 'parallel-ws-rtc-smoke'
    | 'wait-assert-evidence';

export type DistributedRecipePromptTemplate = Readonly<{
    id: DistributedRecipePromptTemplateId;
    title: string;
    description: string;
    outputTarget: string;
    request: string;
    requiredInputs: readonly string[];
    commandKinds: readonly string[];
}>;

export type DistributedRecipeSchemaSnippet = Readonly<{
    snippetId: 'browser-agent-recipe' | 'distributed-run-manifest';
    title: string;
    description: string;
    text: string;
}>;

/**
 * The prompt variables an author's session offers. A value is absent when the session has no
 * value for that name; redaction drops those names before the prompt is written.
 */
export type DistributedRecipePromptVariables = Readonly<Record<string, ApiJsonValue | undefined>>;

export type DistributedRecipePromptValidationFeedback = Readonly<{
    target: string;
    title: string;
    ok: boolean;
    parseOk: boolean;
    issues: readonly string[];
    /** Absent when the draft raised no schema issue. */
    schemaErrorText?: string;
    preflightWarnings: readonly string[];
    preflightErrors: readonly string[];
}>;

export type DistributedRecipePromptRenderInput = Readonly<{
    variables: DistributedRecipePromptVariables;
    /** The feedback to address, or `undefined` when no draft has been validated yet. */
    validationFeedback: DistributedRecipePromptValidationFeedback | undefined;
}>;

const REDACTED_VALUE = '[REDACTED]';
const SECRET_KEY_PATTERN = /(access|auth|bearer|credential|password|secret|session|ticket|token)/i;
const BEARER_VALUE_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

/** Every prompt template, keyed by the id it carries. */
type PromptTemplatesById = {
    readonly [Id in DistributedRecipePromptTemplateId]: DistributedRecipePromptTemplate & Readonly<{ id: Id; }>;
};

const PROMPT_TEMPLATE_BY_ID: PromptTemplatesById = {
    'live-group-ack': {
        id: 'live-group-ack',
        title: 'Live Group ACK',
        description:
            'Stage a lightweight browser-agent recipe across the live group and require ACK/readiness evidence.',
        outputTarget: 'distributed run manifest with one inline browser-agent recipe',
        request: [
            'Create a distributed run manifest that targets every online browser agent in the current group.',
            'The inline recipe should prove the agent is reachable with a health command and any readiness/ACK evidence that fits the schema.',
            'Use conservative ACK and command timeouts so slow remote browsers can still report readiness.'
        ].join(' '),
        requiredInputs: ['applicationId', 'workspaceId', 'groupId', 'controlRunId', 'expectedParticipantCount'],
        commandKinds: ['health', 'recipe.load', 'recipe.run']
    },
    'ws-send-receive': {
        id: 'ws-send-receive',
        title: 'WS Send/Receive',
        description: 'Generate sender and receiver roles for a room-scoped WebSocket payload and matching evidence.',
        outputTarget: 'distributed run manifest with role-mapped inline recipes',
        request: [
            'Create a distributed run manifest that sends a room-scoped WebSocket payload from one sender browser.',
            'Receivers should wait for evidence that the payload arrived and assert the expected topic or message id.',
            'Use non-reserved room.* or app.* topics, never rallar.* system topics.'
        ].join(' '),
        requiredInputs: [
            'applicationId',
            'workspaceId',
            'groupId',
            'sender role or agent id',
            'receiver roles or agent ids'
        ],
        commandKinds: ['ws.open', 'ws.send', 'wait', 'assert']
    },
    'rtc-realtime-position': {
        id: 'rtc-realtime-position',
        title: 'RTC Position Stream',
        description: 'Connect RTC/realtime peers, send position frames, and validate runtime evidence.',
        outputTarget: 'distributed run manifest with RTC connect and send recipes',
        request: [
            'Create a distributed run manifest that connects RTC/realtime for all online group members.',
            'Then send a realtime position payload from a sender role and have receivers wait for matching runtime evidence.',
            'Include roomRef/application/workspace/group context on RTC commands and use live-friendly timeouts.'
        ].join(' '),
        requiredInputs: [
            'applicationId',
            'workspaceId',
            'groupId',
            'sender role or agent id',
            'expected participant count'
        ],
        commandKinds: ['rtc.connect', 'rtc.send', 'wait', 'assert']
    },
    'looped-rtc-load': {
        id: 'looped-rtc-load',
        title: 'Looped RTC Load',
        description: 'Build a bounded RTC send loop with frame counts, cadence, and load thresholds.',
        outputTarget: 'distributed run manifest with an inline looped RTC recipe',
        request: [
            'Create a distributed run manifest for a bounded RTC load test.',
            'The recipe should connect RTC, then loop rtc.send position frames at a fixed interval with maxCommands or count limits.',
            'Include thresholds for achieved send rate or success ratio when the schema allows it.'
        ].join(' '),
        requiredInputs: ['applicationId', 'workspaceId', 'groupId', 'frame count or duration', 'send rate or interval'],
        commandKinds: ['rtc.connect', 'loop', 'rtc.send', 'wait', 'assert']
    },
    'parallel-ws-rtc-smoke': {
        id: 'parallel-ws-rtc-smoke',
        title: 'Parallel WS/RTC Smoke',
        description: 'Exercise WebSocket and RTC paths in parallel and report comparable evidence.',
        outputTarget: 'distributed run manifest with a parallel browser-agent recipe',
        request: [
            'Create a distributed run manifest that runs WebSocket and RTC smoke checks in parallel.',
            'One branch should send a WS payload, and another branch should connect/send RTC with a comparable payload.',
            'Add waits/asserts so the artifact explains whether each transport produced evidence.'
        ].join(' '),
        requiredInputs: [
            'applicationId',
            'workspaceId',
            'groupId',
            'sender role or agent id',
            'expected receiver count'
        ],
        commandKinds: ['parallel', 'ws.open', 'ws.send', 'rtc.connect', 'rtc.send', 'wait', 'assert']
    },
    'wait-assert-evidence': {
        id: 'wait-assert-evidence',
        title: 'Wait/Assert Evidence',
        description: 'Generate a focused evidence recipe for diagnostics, messages, results, stats, or reports.',
        outputTarget: 'browser-agent recipe or distributed run manifest with inline evidence recipe',
        request: [
            'Create a recipe that waits for runtime evidence and asserts a specific condition.',
            'The evidence can be a message, diagnostic, result, stats sample, or report row.',
            'Prefer clear commandId values and include timeoutMs on waits so failures are actionable.'
        ].join(' '),
        requiredInputs: ['evidence kind', 'topic or source path', 'expected value', 'timeoutMs'],
        commandKinds: ['wait', 'assert']
    }
};

export const DISTRIBUTED_RECIPE_PROMPT_TEMPLATES: readonly DistributedRecipePromptTemplate[] = Object.values(
    PROMPT_TEMPLATE_BY_ID
);

const BROWSER_AGENT_RECIPE_SKELETON = {
    schemaVersion: 1,
    recipeId: '{{recipeId}}',
    description: '{{short purpose}}',
    commands: [
        {
            kind: 'health',
            commandId: '{{stable-command-id}}'
        }
    ]
};

const DISTRIBUTED_RUN_MANIFEST_SKELETON = {
    schemaVersion: 1,
    distributedRunId: '{{distributedRunId}}',
    controlRunId: '{{controlRunId}}',
    displayName: '{{short display name}}',
    group: {
        applicationId: '{{applicationId}}',
        workspaceId: '{{workspaceId}}',
        groupId: '{{groupId}}'
    },
    recipes: [
        {
            recipeId: '{{recipeId}}',
            role: '{{optional-role}}',
            recipe: BROWSER_AGENT_RECIPE_SKELETON,
            variables: {}
        }
    ],
    targetPolicy: {
        mode: 'all-online-group-members',
        expectedParticipantCount: 2
    },
    variables: {},
    roleAssignments: [],
    ackTimeoutMs: 30_000,
    barrier: { enabled: false },
    startMode: 'manual',
    groupAssertions: [],
    metadata: {}
};

export function toDistributedRecipeSchemaSnippets(): readonly DistributedRecipeSchemaSnippet[] {
    return [
        {
            snippetId: 'browser-agent-recipe',
            title: 'Browser-Agent Recipe',
            description:
                'Inline recipes used by browser control agents. Commands must come from the rallar-bb-test command schema.',
            text: toJsonText({
                schema: {
                    constantName: 'RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA',
                    ...toSchemaSnippet(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA)
                },
                skeleton: BROWSER_AGENT_RECIPE_SKELETON
            })
        },
        {
            snippetId: 'distributed-run-manifest',
            title: 'Distributed Run Manifest',
            description: 'Top-level orchestration object accepted by the Distributed Recipes SPA/control server.',
            text: toJsonText({
                schema: {
                    constantName: 'RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA',
                    ...toSchemaSnippet(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA)
                },
                skeleton: DISTRIBUTED_RUN_MANIFEST_SKELETON
            })
        }
    ];
}

export function toDistributedRecipeSchemaContextText(): string {
    const snippets = toDistributedRecipeSchemaSnippets()
        .map((snippet) =>
            [
                `## ${snippet.title}`,
                snippet.description,
                '```json',
                snippet.text,
                '```'
            ].join('\n')
        )
        .join('\n\n');

    return [
        snippets,
        '## Relevant Command Capabilities',
        toCommandCapabilityContextText()
    ].join('\n\n');
}

export function redactDistributedRecipePromptVariables(
    variables: DistributedRecipePromptVariables
): ApiJsonObject {
    const redacted: Record<string, ApiJsonValue> = {};
    for (const [key, value] of Object.entries(variables)) {
        if (value !== undefined) {
            redacted[key] = redactPromptValue(key, value);
        }
    }
    return redacted;
}

export function toDistributedRecipePromptText(
    id: DistributedRecipePromptTemplateId,
    input: DistributedRecipePromptRenderInput
): string {
    const template = PROMPT_TEMPLATE_BY_ID[id];
    const variables = redactDistributedRecipePromptVariables(input.variables);
    const validationFeedback = input.validationFeedback
        ? toDistributedRecipeValidationFeedbackText(input.validationFeedback)
        : 'No generated JSON has been validated yet.';

    return [
        'You are generating JSON for the Rallar black-box Distributed Recipes SPA.',
        '',
        'Return JSON only. Do not wrap the result in Markdown.',
        '',
        `Template: ${template.title}`,
        `Target: ${template.outputTarget}`,
        '',
        'Request:',
        template.request,
        '',
        'Required inputs to preserve or ask for if missing:',
        ...template.requiredInputs.map((inputName) => `- ${inputName}`),
        '',
        'Current optional prompt variables. Use these when they fit the request; do not invent secrets.',
        '```json',
        toJsonText(variables),
        '```',
        '',
        'Schema snippets and capability metadata:',
        toDistributedRecipeSchemaContextText(),
        '',
        'Validation or preflight feedback to address:',
        validationFeedback,
        '',
        'Hard constraints:',
        '- Use schemaVersion 1 for distributed manifests and inline browser-agent recipes.',
        '- Write every manifest author setting explicitly, as the manifest skeleton does: the schema rejects a ' +
        'manifest that omits one.',
        '- Use stable distributedRunId, recipeId, and commandId values.',
        '- Prefer targetPolicy.mode all-online-group-members for whole-group checks and role-map for sender-only commands.',
        '- Include applicationId, workspaceId, groupId, roomRef, and roomId where group-scoped WS or RTC delivery needs them.',
        '- Use room.* or app.* topics for test traffic. Do not use rallar.* system topics.',
        '- Do not include bearer tokens, passwords, session IDs, tickets, or long-lived secrets.'
    ].join('\n');
}

export function toDistributedRecipeValidationFeedbackText(
    feedback: DistributedRecipePromptValidationFeedback
): string {
    const issueLines = [
        ...(feedback.schemaErrorText
            ? feedback.schemaErrorText.split('\n').filter(Boolean)
            : []),
        ...feedback.issues,
        ...feedback.preflightErrors.map((issue) => `Preflight error: ${issue}`),
        ...feedback.preflightWarnings.map((issue) => `Preflight warning: ${issue}`)
    ];
    const status = feedback.ok && issueLines.length === 0 ? 'valid' : 'needs changes';

    return [
        `Target: ${feedback.title}`,
        `JSON parse: ${feedback.parseOk ? 'ok' : 'failed'}`,
        `Validation status: ${status}`,
        issueLines.length > 0
            ? ['Issues to fix:', ...issueLines.map((issue) => `- ${issue}`)].join('\n')
            : 'No schema or preflight issues found.'
    ].join('\n');
}

function toCommandCapabilityContextText(): string {
    const capabilityKinds = new Set(
        DISTRIBUTED_RECIPE_PROMPT_TEMPLATES.flatMap((template) => template.commandKinds)
    );

    return RALLAR_BLACK_BOX_COMMAND_CAPABILITIES
        .filter((capability) => capabilityKinds.has(capability.kind))
        .map((capability) =>
            [
                `- ${capability.kind}: ${capability.title}`,
                `  Description: ${capability.description}`,
                `  Required fields: ${
                    capability.requiredFields.length > 0 ? capability.requiredFields.join(', ') : 'none'
                }`,
                `  Optional fields: ${capability.optionalFields.join(', ')}`,
                `  Runtime surfaces: ${capability.runtimeSurfaces.join(', ')}`,
                `  Live requirements: ${
                    capability.liveServiceRequirements.length > 0
                        ? capability.liveServiceRequirements.join(', ')
                        : 'none'
                }`,
                `  Example: ${toJsonText(capability.example)}`
            ].join('\n')
        )
        .join('\n');
}

/** The schema keys a property summary keeps; a prompt cannot use the nested subschemas. */
const SUMMARIZED_SCHEMA_PROPERTY_KEYS = [
    '$id',
    'title',
    'description',
    'type',
    'const',
    'enum',
    'required',
    'minimum'
] as const;

type SchemaSnippetFact = ApiJsonValue | SchemaSnippetFacts | undefined;

/** Schema facts a prompt shows. A fact the schema does not state is absent from the snippet. */
interface SchemaSnippetFacts {
    readonly [key: string]: SchemaSnippetFact;
}

function toSchemaSnippet(schema: JsonSchema): SchemaSnippetFacts {
    return {
        $id: schema.$id,
        title: schema.title,
        description: schema.description,
        required: schema.required,
        additionalProperties: decodeJsonSnippetValue(schema.additionalProperties),
        properties: toSchemaPropertySummaries(schema.properties)
    };
}

function toSchemaPropertySummaries(
    properties: JsonSchema['properties']
): Readonly<Record<string, SchemaSnippetFacts>> {
    return Object.fromEntries(
        Object.entries(properties ?? {}).map(([key, value]) => [key, toSchemaPropertySummary(value)])
    );
}

function toSchemaPropertySummary(property: JsonSchema): SchemaSnippetFacts {
    return Object.fromEntries(
        Object.entries(property)
            .filter(([key]) => SUMMARIZED_SCHEMA_PROPERTY_KEYS.some((summarized) => summarized === key))
            .map(([key, value]) => [key, decodeJsonSnippetValue(value)])
    );
}

/** The JSON form of a schema fact, or `undefined` when the schema states none. */
function decodeJsonSnippetValue(value: unknown): ApiJsonValue | undefined {
    if (value === undefined) {
        return undefined;
    }
    const json = JSON.stringify(value);
    return json === undefined ? undefined : JSON.parse(json) as ApiJsonValue;
}

function redactPromptValue(key: string, value: ApiJsonValue): ApiJsonValue {
    if (typeof value === 'string') {
        if (!value) {
            return value;
        }
        if (SECRET_KEY_PATTERN.test(key)) {
            return REDACTED_VALUE;
        }
        return value.replace(BEARER_VALUE_PATTERN, 'Bearer [REDACTED]');
    }
    if (Array.isArray(value)) {
        return value.map((entry, index) => redactPromptValue(`${key}[${index}]`, entry));
    }
    if (isJsonObject(value)) {
        return redactDistributedRecipePromptVariables(value);
    }

    return value;
}

function toJsonText(value: object): string {
    return JSON.stringify(value, null, 2);
}

function isJsonObject(value: unknown): value is ApiJsonObject {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
