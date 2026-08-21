import { newALRoute } from '@shared/al-contracts/al-contract.ts';
import { assertValidALMessageInput, validateALMessageInput } from '@shared/al-contracts/al-validation.ts';
import { isRallarValidationError, RallarValidationError } from '@shared/api/rallar-validation.ts';
import { describe, expect, it } from 'vitest';

describe('AL message validation', () => {
    it('accepts valid AL message builder input', () => {
        const result = validateALMessageInput({
            senderId: 'peer-a',
            route: newALRoute('room.chat', 'lobby', 'msg-1'),
            typeId: 'chat.message.v1',
            payload: { text: 'hello' }
        });

        expect(result.ok).toBe(true);
        expect(result.payload?.serialized).toBe('{"text":"hello"}');
    });

    it('rejects invalid route and sender ids before builders serialize payloads', () => {
        const result = validateALMessageInput({
            senderId: 'peer/a',
            route: newALRoute('room chat', 'lobby', 'msg-1'),
            typeId: 'chat.message.v1',
            payload: { text: 'hello' }
        });

        expect(result.ok).toBe(false);
        expect(result.issues.map((issue) => issue.path)).toEqual([
            '$.senderId',
            '$.route.topicId'
        ]);
    });

    it('rejects corrupt JSON payloads before builders produce malformed messages', () => {
        expect(() =>
            assertValidALMessageInput({
                senderId: 'peer-a',
                route: newALRoute('room.chat', 'lobby', 'msg-1'),
                typeId: 'chat.message.v1',
                payload: undefined
            })
        ).toThrow(RallarValidationError);

        try {
            assertValidALMessageInput({
                senderId: 'peer-a',
                route: newALRoute('room.chat', 'lobby', 'msg-1'),
                typeId: 'chat.message.v1',
                payload: 1n
            });
        }
        catch (error) {
            expect(isRallarValidationError(error)).toBe(true);
            expect((error as RallarValidationError).issues[0]?.code)
                .toBe('invalid-json-payload');
        }
    });

    it('rejects payloads larger than the configured byte limit', () => {
        const result = validateALMessageInput({
            senderId: 'peer-a',
            route: newALRoute('room.chat', 'lobby', 'msg-1'),
            typeId: 'chat.message.v1',
            payload: { text: 'hello' },
            maxPayloadBytes: 3
        });

        expect(result.ok).toBe(false);
        expect(result.issues[0]?.code).toBe('payload-too-large');
    });
});
