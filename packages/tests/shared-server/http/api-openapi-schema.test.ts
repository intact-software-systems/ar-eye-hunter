import { requireRecord } from '@shared/api/exact-object-decoding.ts';
import Ajv from 'ajv';
import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const document = requireRecord(load(readFileSync('apps/api-v1/resources/api-v1-openapi.yaml', 'utf8')), 'OpenAPI');
const components = requireRecord(document.components, 'components');
const schemas = requireRecord(components.schemas, 'schemas');

it('publishes structurally valid JSON Schema constraints for every API component', () => {
    const validator = new Ajv({ allErrors: true, unknownFormats: ['int64'] });
    const valid = validator.validateSchema({ definitions: schemas });
    expect(validator.errors).toBeNull();
    expect(valid).toBe(true);
});

it('accepts pending room admission and rejects an active membership without a joined stamp', () => {
    const validate = new Ajv({ allErrors: true, unknownFormats: ['int64'] }).compile({
        $ref: '#/components/schemas/GroupMember',
        components
    });
    const pending = {
        applicationId: 'app',
        workspaceId: 'default',
        groupId: 'room',
        principalId: 'alice',
        role: 'member',
        status: 'pending',
        joined: null,
        left: null,
        removed: null,
        banned: null,
        updated: { atEpochMs: 1000, actor: { kind: 'service', serviceId: 'api' }, reason: null, traceId: null, requestId: null },
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    };
    expect(validate(pending), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...pending, status: 'active' })).toBe(false);
    expect(validate({ ...pending, status: 'active', joined: pending.updated })).toBe(true);
});

it('accepts explicit null failure details while rejecting invalid non-null values', () => {
    const validate = new Ajv({ allErrors: true, unknownFormats: ['int64'] }).compile({
        $ref: '#/components/schemas/ApiMutationFailure',
        components
    });
    const failure = {
        type: 'api-mutation-failure',
        version: 'canonical.v2',
        code: 'refused',
        status: 403,
        message: 'Refused',
        issues: null,
        denial: null,
        retry: null
    };
    expect(validate(failure), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...failure, issues: 'invalid' })).toBe(false);
    expect(validate({ ...failure, retry: 1 })).toBe(false);
});
