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
        execution: recordSchema,
        trafficPlan: recordSchema,
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
