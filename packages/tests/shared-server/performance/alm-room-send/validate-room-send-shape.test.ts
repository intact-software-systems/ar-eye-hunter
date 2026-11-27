import { describe, expect, it } from 'vitest';

import {
    validateRoomSendShape,
    type RoomSendShape
} from '../../../../../apps/api-v1/scripts/perf/alm-room-send/validate-room-send-shape.ts';

const REFERENCE_SHAPE: RoomSendShape = {
    publishers: 5,
    sendsPerSecond: 2,
    durationS: 20,
    delayMs: 0,
    senderRecovery: 'client-stand-in',
    applicationPoolMaxConnections: 5
};

/** A shape as decoded JSON hands it over, wrong in each field; the validator never repeats a text it was given. */
const SHAPE_WRONG_IN_EACH_FIELD: RoomSendShape = JSON.parse(
    '{"publishers":16,"sendsPerSecond":0,"durationS":2.5,"delayMs":-1,"senderRecovery":"postgres://app:s3cret-pw@db",' +
        '"applicationPoolMaxConnections":0}'
);

describe('validateRoomSendShape', () => {
    it('finds no issue in the reference shape, in one publisher, or in all fifteen sessions publishing', () => {
        expect(validateRoomSendShape(REFERENCE_SHAPE)).toEqual([]);
        expect(validateRoomSendShape({ ...REFERENCE_SHAPE, publishers: 1, delayMs: 5 })).toEqual([]);
        expect(validateRoomSendShape({ ...REFERENCE_SHAPE, publishers: 15, sendsPerSecond: 1, durationS: 1 }))
            .toEqual([]);
        expect(validateRoomSendShape({ ...REFERENCE_SHAPE, senderRecovery: 'none' })).toEqual([]);
        expect(validateRoomSendShape({ ...REFERENCE_SHAPE, applicationPoolMaxConnections: 1 })).toEqual([]);
    });

    it('returns every issue of a shape that is wrong in each field', () => {
        expect(validateRoomSendShape(SHAPE_WRONG_IN_EACH_FIELD)).toEqual([
            {
                code: 'invalid-publishers',
                message: 'publishers must be a whole number from 1 to 15, the sessions of the room; received 16'
            },
            {
                code: 'invalid-sends-per-second',
                message: 'sendsPerSecond must be a whole number of at least 1; received 0'
            },
            { code: 'invalid-duration-s', message: 'durationS must be a whole number of at least 1; received 2.5' },
            { code: 'invalid-delay-ms', message: 'delayMs must be a whole number of at least 0; received -1' },
            { code: 'invalid-sender-recovery', message: 'senderRecovery must be none or client-stand-in' },
            {
                code: 'invalid-application-pool',
                message: 'applicationPoolMaxConnections must be a whole number of at least 1; received 0'
            }
        ]);
    });

    it.each([
        ['no publisher', { ...REFERENCE_SHAPE, publishers: 0 }, 'invalid-publishers'],
        ['a fraction of a publisher', { ...REFERENCE_SHAPE, publishers: 1.5 }, 'invalid-publishers'],
        ['a rate that is not a number', { ...REFERENCE_SHAPE, sendsPerSecond: Number.NaN }, 'invalid-sends-per-second'],
        ['a rate that gives a fraction of a send', { ...REFERENCE_SHAPE, sendsPerSecond: 0.5 }, 'invalid-sends-per-second'],
        ['an endless window', { ...REFERENCE_SHAPE, durationS: Number.POSITIVE_INFINITY }, 'invalid-duration-s'],
        ['no window', { ...REFERENCE_SHAPE, durationS: 0 }, 'invalid-duration-s'],
        ['a fraction of a millisecond of delay', { ...REFERENCE_SHAPE, delayMs: 0.5 }, 'invalid-delay-ms'],
        [
            'a fraction of a connection',
            { ...REFERENCE_SHAPE, applicationPoolMaxConnections: 2.5 },
            'invalid-application-pool'
        ]
    ])('refuses %s', (_name, shape, code) => {
        expect(validateRoomSendShape(shape).map((issue) => issue.code)).toEqual([code]);
    });
});
