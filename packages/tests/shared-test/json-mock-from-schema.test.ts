import {describe, expect, it} from 'vitest';
import {SchemaType, toJsonMock, toSchemaType} from '../../shared-test/black-box-runner/json-mock-from-schema.ts';

describe('toSchemaType', () => {
    it('detects OpenAPI documents', () => {
        const document = {
            openapi: '3.0.0',
            components: {},
        };

        expect(toSchemaType(document)).toBe(SchemaType.OPENAPI);
    });

    it('detects Swagger documents', () => {
        const document = {
            swagger: '2.0',
            definitions: {},
        };

        expect(toSchemaType(document)).toBe(SchemaType.SWAGGER);
    });

    it('defaults to JSON schema', () => {
        const schema = {
            type: 'object',
            properties: {},
        };

        expect(toSchemaType(schema)).toBe(SchemaType.JSON);
    });
});

describe('toJsonMock', () => {
    it('creates object mock from JSON schema', () => {
        const schema = {
            type: 'object',
            properties: {
                id: {
                    type: 'integer',
                },
                name: {
                    type: 'string',
                },
                active: {
                    type: 'boolean',
                },
            },
        };

        expect(toJsonMock(SchemaType.JSON, schema)).toEqual({
            id: 1,
            name: 'string',
            active: true,
        });
    });

    it('uses enum first value', () => {
        const schema = {
            type: 'string',
            enum: ['A', 'B', 'C'],
        };

        expect(toJsonMock(SchemaType.JSON, schema)).toBe('A');
    });

    it('uses const before generated type mock', () => {
        const schema = {
            type: 'string',
            const: 'fixed-value',
        };

        expect(toJsonMock(SchemaType.JSON, schema)).toBe('fixed-value');
    });

    it('uses example before generated type mock', () => {
        const schema = {
            type: 'string',
            example: 'example-value',
        };

        expect(toJsonMock(SchemaType.JSON, schema)).toBe('example-value');
    });

    it('supports array schemas', () => {
        const schema = {
            type: 'array',
            items: {
                type: 'string',
            },
        };

        expect(toJsonMock(SchemaType.JSON, schema)).toEqual(['string']);
    });

    it('supports string formats', () => {
        expect(toJsonMock(SchemaType.JSON, {
            type: 'string',
            format: 'uuid',
        })).toBe('00000000-0000-4000-8000-000000000000');

        expect(toJsonMock(SchemaType.JSON, {
            type: 'string',
            format: 'date',
        })).toBe('2026-05-11');

        expect(toJsonMock(SchemaType.JSON, {
            type: 'string',
            format: 'date-time',
        })).toBe('2026-05-11T00:00:00.000Z');
    });

    it('resolves OpenAPI $ref schemas', () => {
        const document = {
            openapi: '3.0.0',
            components: {
                schemas: {
                    User: {
                        type: 'object',
                        properties: {
                            id: {
                                type: 'integer',
                            },
                            name: {
                                type: 'string',
                            },
                        },
                    },
                },
            },
        };

        const schema = {
            $ref: '#/components/schemas/User',
        };

        expect(toJsonMock(toSchemaType(document), schema, document)).toEqual({
            id: 1,
            name: 'string',
        });
    });
});
