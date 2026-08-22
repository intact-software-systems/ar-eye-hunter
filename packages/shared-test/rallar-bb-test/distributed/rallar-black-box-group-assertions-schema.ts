import { RALLAR_BLACK_BOX_ASSERT_OPERATORS } from '../assert/assert-value-operators.ts';
import type { JsonSchema } from '../schema/json-schema-validation.ts';

const stringSchema: JsonSchema = { type: 'string' };
const anyValueSchema: JsonSchema = {};

const groupAssertionSourceSchema: JsonSchema = {
    type: 'object',
    required: ['recipeId', 'commandId', 'path'],
    properties: {
        recipeId: stringSchema,
        commandId: stringSchema,
        path: stringSchema
    },
    additionalProperties: false
};

const groupAssertionScopeSchema: JsonSchema = {
    type: 'object',
    required: ['role'],
    properties: {
        role: stringSchema
    },
    additionalProperties: false
};

const groupAssertionPredicateSchema: JsonSchema = {
    type: 'object',
    required: ['operator'],
    properties: {
        operator: {
            type: 'string',
            enum: RALLAR_BLACK_BOX_ASSERT_OPERATORS
        },
        expected: anyValueSchema
    },
    additionalProperties: false
};

const groupAssertionCountSchema: JsonSchema = {
    type: 'object',
    requiredAnyOf: [
        {
            properties: ['equals', 'gte', 'lte'],
            message: 'countMatching requires at least one of equals, gte, lte.'
        }
    ],
    properties: {
        equals: { type: 'integer', minimum: 0 },
        gte: { type: 'integer', minimum: 0 },
        lte: { type: 'integer', minimum: 0 }
    },
    additionalProperties: false
};

const groupAssertionCommonProperties: Readonly<Record<string, JsonSchema>> = {
    groupAssertionId: stringSchema,
    description: stringSchema,
    source: groupAssertionSourceSchema,
    scope: groupAssertionScopeSchema,
    minParticipants: { type: 'integer', minimum: 1 }
};

const allMatchSchema: JsonSchema = {
    type: 'object',
    required: ['groupAssertionId', 'aggregate', 'source', 'predicate'],
    properties: {
        ...groupAssertionCommonProperties,
        aggregate: { const: 'allMatch' },
        predicate: groupAssertionPredicateSchema
    },
    additionalProperties: false
};

const noneMatchSchema: JsonSchema = {
    type: 'object',
    required: ['groupAssertionId', 'aggregate', 'source', 'predicate'],
    properties: {
        ...groupAssertionCommonProperties,
        aggregate: { const: 'noneMatch' },
        predicate: groupAssertionPredicateSchema
    },
    additionalProperties: false
};

const countMatchingSchema: JsonSchema = {
    type: 'object',
    required: ['groupAssertionId', 'aggregate', 'source', 'predicate', 'count'],
    properties: {
        ...groupAssertionCommonProperties,
        aggregate: { const: 'countMatching' },
        predicate: groupAssertionPredicateSchema,
        count: groupAssertionCountSchema
    },
    additionalProperties: false
};

const allEqualSchema: JsonSchema = {
    type: 'object',
    required: ['groupAssertionId', 'aggregate', 'source'],
    properties: {
        ...groupAssertionCommonProperties,
        aggregate: { const: 'allEqual' }
    },
    additionalProperties: false
};

const allEqualWithinSchema: JsonSchema = {
    type: 'object',
    required: ['groupAssertionId', 'aggregate', 'source', 'tolerance'],
    properties: {
        ...groupAssertionCommonProperties,
        aggregate: { const: 'allEqualWithin' },
        tolerance: { type: 'number', minimum: 0 }
    },
    additionalProperties: false
};

export const RALLAR_BLACK_BOX_GROUP_ASSERTIONS_SCHEMA: JsonSchema = {
    type: 'array',
    items: {
        oneOf: [
            allMatchSchema,
            noneMatchSchema,
            countMatchingSchema,
            allEqualSchema,
            allEqualWithinSchema
        ]
    }
};
