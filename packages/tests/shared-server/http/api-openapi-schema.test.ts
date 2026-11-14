import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { MAX_RTC_REPLACED_LAYOUT_OVERLAP_MS } from '@shared/api/api-config.ts';
import { requireRecord } from '@shared/api/exact-object-decoding.ts';
import { toApiV1PublicConfiguration } from '../../../../apps/api-v1/src/configuration/to-api-v1-public-configuration.ts';

const document = requireRecord(load(readFileSync('apps/api-v1/resources/api-v1-openapi.yaml', 'utf8')), 'OpenAPI');
const components = requireRecord(document.components, 'components');
const schemas = requireRecord(components.schemas, 'schemas');

it('publishes structurally valid JSON Schema constraints for every API component', () => {
    const validator = addFormats(new Ajv({ allErrors: true, strict: false, formats: { int64: true } }));
    const valid = validator.validateSchema({ definitions: schemas });
    expect(validator.errors).toBeNull();
    expect(valid).toBe(true);
});

it('accepts pending room admission and rejects an active membership without a joined stamp', () => {
    const validate = addFormats(new Ajv({ allErrors: true, strict: false, formats: { int64: true } })).compile({
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
    const validate = addFormats(new Ajv({ allErrors: true, strict: false, formats: { int64: true } })).compile({
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

it('requires the replaced-layout overlap on the body api-v1 serves at /api/config', () => {
    const validate = addFormats(new Ajv({ allErrors: true, strict: false, formats: { int64: true } })).compile({
        $ref: '#/components/schemas/ApiConfig',
        components
    });
    const served = {
        ...toApiV1PublicConfiguration({
            apiBaseUrl: 'https://api.example.test',
            wsBaseUrl: 'wss://api.example.test',
            rtcReplacedLayoutOverlapMs: 7_000
        }),
        serverPeerId: 'default-qbox-server'
    };
    const { rtcReplacedLayoutOverlapMs: _rtcReplacedLayoutOverlapMs, ...olderServer } = served;

    expect(validate(served), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(olderServer)).toBe(false);
    expect(validate({ ...served, rtcReplacedLayoutOverlapMs: MAX_RTC_REPLACED_LAYOUT_OVERLAP_MS + 1 })).toBe(false);
    expect(validate({ ...served, rtcReplacedLayoutOverlapMs: -1 })).toBe(false);
});
