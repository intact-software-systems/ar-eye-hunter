import { describe, expect, it } from 'vitest';
import { AppTopics } from '@shared/api/api-config.ts';
import {
    RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES,
    RallarValidationError,
    assertValidRallarGroupRef,
    formatRallarValidation,
    isRallarValidationError,
    toRallarRoomId,
    toRallarTopicId,
    toRallarTypeId,
    toRallarWsUserTopicId,
    validateRallarGroupRef,
    validateRallarJsonPayload,
    validateRallarNonNegativeInteger,
    validateRallarRouteId,
    validateRallarWsUserTopicId,
} from '@shared/api/rallar-validation.ts';

describe('Rallar shared validation', () => {
    it('accepts route-safe identifiers and returns branded strings', () => {
        expect(validateRallarRouteId('lobby-1.room:blue', '$.roomId').ok).toBe(true);
        expect(toRallarRoomId('lobby-1')).toBe('lobby-1');
        expect(toRallarTopicId('room.chat')).toBe('room.chat');
        expect(toRallarTypeId('chat.message.v1')).toBe('chat.message.v1');
    });

    it.each([
        ['', 'required'],
        [' lobby', 'not-trimmed'],
        ['lobby ', 'not-trimmed'],
        ['room/name', 'invalid-route-id'],
        ['room?name', 'invalid-route-id'],
        ['room#name', 'invalid-route-id'],
        ['room%name', 'invalid-route-id'],
        ['.', 'reserved-route-id'],
        ['..', 'reserved-route-id'],
        ['a'.repeat(129), 'max-length'],
    ])('rejects invalid route id %j', (value, code) => {
        const result = validateRallarRouteId(value, '$.roomId');

        expect(result.ok).toBe(false);
        expect(result.issues[0]?.code).toBe(code);
    });

    it('validates WS user topics with server-compatible prefixes and reservations', () => {
        expect(toRallarWsUserTopicId('room.chat')).toBe('room.chat');
        expect(toRallarWsUserTopicId('app.presence')).toBe('app.presence');

        expect(validateRallarWsUserTopicId('manual.chat', '$.topicId').issues[0]?.code)
            .toBe('invalid-ws-user-topic');
        expect(validateRallarWsUserTopicId('rallar.internal', '$.topicId').issues[0]?.code)
            .toBe('reserved-ws-topic');
        expect(validateRallarWsUserTopicId(AppTopics.chat, '$.topicId').issues[0]?.code)
            .toBe('reserved-ws-topic');
    });

    it('validates scoped group refs', () => {
        const valid = {
            applicationId: 'game',
            workspaceId: 'default',
            groupId: 'lobby',
        };

        expect(validateRallarGroupRef(valid, '$.roomRef').ok).toBe(true);
        expect(() => assertValidRallarGroupRef(valid, '$.roomRef')).not.toThrow();

        const invalid = validateRallarGroupRef({
            applicationId: 'game',
            workspaceId: 'default workspace',
            groupId: 'bad/room',
        }, '$.roomRef');

        expect(invalid.ok).toBe(false);
        expect(invalid.issues.map((issue) => issue.path)).toEqual([
            '$.roomRef.workspaceId',
            '$.roomRef.groupId',
        ]);
    });

    it('validates JSON payload compatibility and byte limits', () => {
        const accepted = validateRallarJsonPayload(
            { text: 'hello' },
            { path: '$.payload', maxBytes: RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES },
        );

        expect(accepted.ok).toBe(true);
        expect(accepted.serialized).toBe('{"text":"hello"}');
        expect(accepted.byteLength).toBeGreaterThan(0);

        const withUndefinedProperties = validateRallarJsonPayload(
            {
                text: 'hello',
                omitted: undefined,
                nested: {
                    kept: true,
                    alsoOmitted: undefined,
                },
            },
            { path: '$.payload' },
        );
        expect(withUndefinedProperties.ok).toBe(true);
        expect(withUndefinedProperties.serialized).toBe('{"text":"hello","nested":{"kept":true}}');

        const withUndefinedArrayItems = validateRallarJsonPayload(
            ['hello', undefined, { value: undefined }],
            { path: '$.payload' },
        );
        expect(withUndefinedArrayItems.ok).toBe(true);
        expect(withUndefinedArrayItems.serialized).toBe('["hello",null,{}]');

        expect(validateRallarJsonPayload(undefined, { path: '$.payload' }).issues[0]?.code)
            .toBe('invalid-json-payload');
        expect(validateRallarJsonPayload(1 / 0, { path: '$.payload' }).issues[0]?.code)
            .toBe('invalid-json-number');
        expect(validateRallarJsonPayload(1n, { path: '$.payload' }).issues[0]?.code)
            .toBe('invalid-json-payload');
        expect(validateRallarJsonPayload({ text: 'hello' }, {
            path: '$.payload',
            maxBytes: 3,
        }).issues[0]?.code).toBe('payload-too-large');

        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(validateRallarJsonPayload(cyclic, { path: '$.payload' }).issues[0]?.code)
            .toBe('invalid-json-payload');
    });

    it('validates finite non-negative integer routing options', () => {
        expect(validateRallarNonNegativeInteger(0, '$.ttlHops').ok).toBe(true);
        expect(validateRallarNonNegativeInteger(42, '$.ttlHops').ok).toBe(true);
        expect(validateRallarNonNegativeInteger(-1, '$.ttlHops').issues[0]?.code)
            .toBe('invalid-non-negative-integer');
        expect(validateRallarNonNegativeInteger(1.5, '$.ttlHops').issues[0]?.code)
            .toBe('invalid-non-negative-integer');
        expect(validateRallarNonNegativeInteger(Number.POSITIVE_INFINITY, '$.ttlHops').issues[0]?.code)
            .toBe('invalid-non-negative-integer');
    });

    it('formats and exposes structured validation errors', () => {
        const result = validateRallarRouteId('bad room', '$.roomId');
        const message = formatRallarValidation(result);

        expect(message).toContain('$.roomId');
        expect(message).toContain('Route ID');

        expect(() => toRallarRoomId('bad room')).toThrow(RallarValidationError);
        try {
            toRallarRoomId('bad room');
        } catch (error) {
            expect(isRallarValidationError(error)).toBe(true);
            expect((error as RallarValidationError).issues[0]?.path).toBe('$');
        }
    });
});
