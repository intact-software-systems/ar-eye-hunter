import {
    type JsonSchema,
    type JsonSchemaValidationResult,
    validateJsonSchema,
} from '../rallar-bb-test/schema.ts';

export const BLACK_BOX_RUNNER_SCENARIO_SCHEMA_VERSION = 1;

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const SCHEMA_BASE_ID = 'https://rallar.dev/schemas/black-box';

const stringSchema: JsonSchema = { type: 'string' };
const numberSchema: JsonSchema = { type: 'number' };
const integerSchema: JsonSchema = { type: 'integer' };
const booleanSchema: JsonSchema = { type: 'boolean' };
const recordSchema: JsonSchema = { type: 'object', additionalProperties: true };
const integerOrPlaceholderSchema: JsonSchema = { oneOf: [integerSchema, stringSchema] };
const numberOrPlaceholderSchema: JsonSchema = { oneOf: [numberSchema, stringSchema] };

const variableValueSchema: JsonSchema = {
    anyOf: [
        stringSchema,
        numberSchema,
        integerSchema,
        booleanSchema,
        { type: 'null' },
        { type: 'array', items: {} },
        recordSchema,
    ],
};

const stepSchema: JsonSchema = {
    type: 'object',
    required: ['type'],
    properties: {
        name: stringSchema,
        type: stringSchema,
        connection: stringSchema,
        output: stringSchema,
        outputPath: stringSchema,
        outputs: recordSchema,
        request: recordSchema,
        expect: recordSchema,
        actual: recordSchema,
        value: variableValueSchema,
        variables: recordSchema,
        steps: { type: 'array', items: recordSchema },
        loopSteps: { type: 'array', items: recordSchema },
        loop: { oneOf: [booleanSchema, { type: 'array', items: recordSchema }] },
        count: integerOrPlaceholderSchema,
        iterations: integerOrPlaceholderSchema,
        runs: integerOrPlaceholderSchema,
        messageCount: integerOrPlaceholderSchema,
        messages: integerOrPlaceholderSchema,
        durationMs: integerOrPlaceholderSchema,
        intervalMs: integerOrPlaceholderSchema,
        delayMs: integerOrPlaceholderSchema,
        rateHz: numberOrPlaceholderSchema,
    },
    additionalProperties: true,
};

const trafficPlanSchema: JsonSchema = {
    type: 'object',
    properties: {
        enabled: booleanSchema,
        seed: integerOrPlaceholderSchema,
        count: integerOrPlaceholderSchema,
        iterations: integerOrPlaceholderSchema,
        runs: integerOrPlaceholderSchema,
        messageCount: integerOrPlaceholderSchema,
        messages: integerOrPlaceholderSchema,
        delayMs: integerOrPlaceholderSchema,
        intervalMs: integerOrPlaceholderSchema,
        rateHz: numberOrPlaceholderSchema,
        jitterMs: integerOrPlaceholderSchema,
        burstSize: integerOrPlaceholderSchema,
        maxInFlight: integerOrPlaceholderSchema,
        setupSteps: { type: 'array', items: {} },
        setup: { type: 'array', items: {} },
        cleanupSteps: { type: 'array', items: {} },
        cleanup: { type: 'array', items: {} },
        operations: { type: 'array', items: recordSchema },
        replayFrom: stringSchema,
        replayPath: stringSchema,
        expandedPlan: recordSchema,
        replay: recordSchema,
        plan: recordSchema,
    },
    additionalProperties: true,
};

const executionSchema: JsonSchema = {
    type: 'object',
    properties: {
        failFast: booleanSchema,
        dryRun: booleanSchema,
        artifactDir: stringSchema,
        recordDir: stringSchema,
        iterations: integerOrPlaceholderSchema,
        runs: integerOrPlaceholderSchema,
        delayMs: integerOrPlaceholderSchema,
        scale: recordSchema,
        soak: recordSchema,
        trafficPlan: trafficPlanSchema,
    },
    additionalProperties: true,
};

export const BLACK_BOX_RUNNER_SCENARIO_RECIPE_SCHEMA: JsonSchema = {
    $schema: JSON_SCHEMA_DRAFT,
    $id: `${SCHEMA_BASE_ID}/black-box-runner-scenario.schema.json`,
    title: 'Black-box runner scenario recipe',
    description:
        'Provider-neutral HTTP, WS, RTC, assertion, and set-step recipe consumed by packages/shared-test/black-box-runner.',
    type: 'object',
    required: ['steps'],
    properties: {
        variables: { type: 'object', additionalProperties: variableValueSchema },
        replace: { type: 'object', additionalProperties: variableValueSchema },
        secrets: { oneOf: [{ type: 'array', items: stringSchema }, stringSchema] },
        secretVariables: { oneOf: [{ type: 'array', items: stringSchema }, stringSchema] },
        defaults: recordSchema,
        execution: executionSchema,
        trafficPlan: trafficPlanSchema,
        connections: {
            type: 'object',
            additionalProperties: {
                type: 'object',
                required: ['type'],
                properties: {
                    type: stringSchema,
                    provider: stringSchema,
                    baseUrl: stringSchema,
                    url: stringSchema,
                    timeoutMs: integerOrPlaceholderSchema,
                    headers: recordSchema,
                    resilience: recordSchema,
                },
                additionalProperties: true,
            },
        },
        steps: {
            type: 'array',
            items: stepSchema,
        },
    },
    additionalProperties: true,
};

export const BLACK_BOX_RUNNER_SCHEMA_CATALOG = {
    schemaVersion: BLACK_BOX_RUNNER_SCENARIO_SCHEMA_VERSION,
    scenarioRecipe: BLACK_BOX_RUNNER_SCENARIO_RECIPE_SCHEMA,
} as const;

export function validateBlackBoxRunnerScenarioRecipe(value: unknown): JsonSchemaValidationResult {
    return validateJsonSchema(BLACK_BOX_RUNNER_SCENARIO_RECIPE_SCHEMA, value);
}
