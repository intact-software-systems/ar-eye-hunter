import { describe, expect, it } from 'vitest';

import { validateJsonSchema, type JsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

describe('JSON schema alternative validation', () => {
    it.each(['kind', 'aggregate'])('checks every branch when %s does not uniquely identify an alternative', (discriminator) => {
        const schema: JsonSchema = {
            oneOf: [
                { type: 'object', properties: { [discriminator]: { const: 'message' }, carrier: { const: 'ws' } }, required: ['carrier'] },
                { type: 'object', properties: { [discriminator]: { const: 'message' }, carrier: { const: 'rtc' } }, required: ['carrier'] }
            ]
        };
        expect(validateJsonSchema(schema, { [discriminator]: 'message', carrier: 'rtc' }).ok).toBe(true);
        expect(validateJsonSchema(schema, { [discriminator]: 'message', carrier: 'unknown' }).ok).toBe(false);
    });

    it.each(['kind', 'aggregate'])('rejects overlapping alternatives with the same %s', (discriminator) => {
        const schema: JsonSchema = {
            oneOf: [
                { properties: { [discriminator]: { const: 'message' } } },
                { properties: { [discriminator]: { const: 'message' } } }
            ]
        };
        expect(validateJsonSchema(schema, { [discriminator]: 'message' })).toEqual({
            ok: false,
            errors: [{ path: '$', message: 'Expected value to match exactly one schema, matched 2.' }]
        });
    });

    it('reports the nested value path when duplicate-kind alternatives all reject', () => {
        const schema: JsonSchema = {
            properties: {
                packet: {
                    oneOf: [
                        { properties: { kind: { const: 'message' }, carrier: { const: 'ws' } } },
                        { properties: { kind: { const: 'message' }, carrier: { const: 'rtc' } } }
                    ]
                }
            }
        };
        expect(validateJsonSchema(schema, { packet: { kind: 'message', carrier: 'unknown' } })).toEqual({
            ok: false,
            errors: [{ path: '$.packet', message: 'Expected value to match exactly one schema, matched 0.' }]
        });
    });

    it('counts an unrestricted alternative instead of treating one explicit kind match as unique', () => {
        const schema: JsonSchema = { oneOf: [{ properties: { kind: { const: 'message' } } }, {}] };
        expect(validateJsonSchema(schema, { kind: 'message' }).ok).toBe(false);
        expect(validateJsonSchema(schema, { kind: 'other' }).ok).toBe(true);
    });

    it('accepts the non-discriminated alternative when the explicitly matching branch fails its other fields', () => {
        const schema: JsonSchema = {
            oneOf: [
                { properties: { kind: { const: 'message' }, source: { const: 'server' } }, required: ['source'] },
                { properties: { kind: { enum: ['message'] }, source: { const: 'browser' } }, required: ['source'] }
            ]
        };
        expect(validateJsonSchema(schema, { kind: 'message', source: 'browser' }).ok).toBe(true);
    });

    it('retains field errors after every alternative fails, without bypassing an overlapping branch', () => {
        const schema: JsonSchema = {
            oneOf: [
                { properties: { kind: { const: 'message' } }, required: ['body'] },
                { oneOf: [{ properties: { kind: { const: 'other' } } }] }
            ]
        };
        expect(validateJsonSchema(schema, { kind: 'message' })).toEqual({
            ok: false,
            errors: [{ path: '$', message: 'Missing required property body.' }]
        });
        expect(validateJsonSchema(schema, { kind: 'message', body: 'hello' }).ok).toBe(true);
    });

    it('counts overlapping referenced and composed alternatives', () => {
        const reference: JsonSchema = { $ref: '#/$defs/open' };
        const nested: JsonSchema = { oneOf: [{}] };
        const referencedProperty: JsonSchema = { properties: { kind: { $ref: '#/$defs/messageKind' } } };
        for (const alternative of [reference, nested, referencedProperty]) {
            const schema: JsonSchema = {
                $defs: { open: {}, messageKind: { const: 'message' } },
                oneOf: [{ properties: { kind: { const: 'message' } } }, alternative]
            };
            expect(validateJsonSchema(schema, { kind: 'message' }).ok).toBe(false);
        }
    });

    it.each(['kind', 'aggregate'])('retains validation of the selected unique %s branch', (discriminator) => {
        const schema: JsonSchema = {
            oneOf: [
                { properties: { [discriminator]: { const: 'message' }, count: { type: 'integer', minimum: 1 } }, required: ['count'] },
                { properties: { [discriminator]: { const: 'close' } } }
            ]
        };
        expect(validateJsonSchema(schema, { [discriminator]: 'message', count: 1 }).ok).toBe(true);
        expect(validateJsonSchema(schema, { [discriminator]: 'message', count: 0 }).ok).toBe(false);
        expect(validateJsonSchema(schema, { [discriminator]: 'absent' }).ok).toBe(false);
    });
});
