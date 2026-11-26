import { describe, expect, it } from 'vitest';

import {
    computeOrderedSendSchedule,
    type OrderedSendScheduledSend
} from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/compute-ordered-send-schedule.ts';
import {
    ORDERED_SEND_CELL_CONSTANTS,
    ORDERED_SEND_REFERENCE_OBSERVATION_TAIL_MS
} from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/ordered-send-cell-constants.ts';

const ROOM_PEER_IDS = [
    'session-01-a',
    'session-02-b',
    'session-03-c',
    'session-04-a',
    'session-05-b',
    'session-06-c',
    'session-07-a',
    'session-08-b',
    'session-09-c',
    'session-10-a',
    'session-11-b',
    'session-12-c',
    'session-13-a',
    'session-14-b',
    'session-15-c'
];

function toSendsOf(sends: readonly OrderedSendScheduledSend[], publisherPeerId: string): OrderedSendScheduledSend[] {
    return sends.filter((send) => send.publisherPeerId === publisherPeerId);
}

function toRoomWithout(peerId: string): string[] {
    return ROOM_PEER_IDS.filter((roomPeerId) => roomPeerId !== peerId);
}

describe('computeOrderedSendSchedule', () => {
    it('places five publishers on instances a, b, c, a, b and offers 200 sends in 20 s', () => {
        const schedule = computeOrderedSendSchedule({ publishers: 5, sendsPerSecond: 2, durationS: 20, delayMs: 0, senderRecovery: 'none' });

        expect(schedule.sessions.map(({ peerId }) => peerId)).toEqual(ROOM_PEER_IDS);
        expect(schedule.sessions.map(({ instanceIndex }) => instanceIndex)).toEqual(
            [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2]
        );
        expect(schedule.sessions.map(({ role }) => role)).toEqual([
            'publisher',
            'publisher',
            'publisher',
            'publisher',
            'publisher',
            'recipient',
            'recipient',
            'recipient',
            'recipient',
            'recipient',
            'recipient',
            'recipient',
            'recipient',
            'recipient',
            'recipient'
        ]);

        expect(schedule.sends).toHaveLength(200);
        expect(new Set(schedule.sends.map(({ msgId }) => msgId)).size).toBe(200);
        const tracks = [
            ['session-01-a', 0, 0, 19_500],
            ['session-02-b', 1, 100, 19_600],
            ['session-03-c', 2, 200, 19_700],
            ['session-04-a', 0, 300, 19_800],
            ['session-05-b', 1, 400, 19_900]
        ] as const;
        for (const [publisherPeerId, instanceIndex, firstDueOffsetMs, lastDueOffsetMs] of tracks) {
            const track = toSendsOf(schedule.sends, publisherPeerId);
            expect(track.map(({ seq }) => seq)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
            expect(new Set(track.map(({ publisherInstanceIndex }) => publisherInstanceIndex)))
                .toEqual(new Set([instanceIndex]));
            expect(track[0].dueOffsetMs).toBe(firstDueOffsetMs);
            expect(track[39].dueOffsetMs).toBe(lastDueOffsetMs);
            expect(track.map(({ expectedRecipientPeerIds }) => expectedRecipientPeerIds)).toEqual(
                Array.from({ length: 40 }, () => toRoomWithout(publisherPeerId))
            );
        }
    });

    it('lists the sends in the order they fall due and names each after its publisher and its place on the track', () => {
        const schedule = computeOrderedSendSchedule({ publishers: 5, sendsPerSecond: 2, durationS: 20, delayMs: 0, senderRecovery: 'none' });

        expect(schedule.sends.slice(0, 6).map(({ msgId, dueOffsetMs }) => [msgId, dueOffsetMs])).toEqual([
            ['session-01-a-send-1', 0],
            ['session-02-b-send-1', 100],
            ['session-03-c-send-1', 200],
            ['session-04-a-send-1', 300],
            ['session-05-b-send-1', 400],
            ['session-01-a-send-2', 500]
        ]);
        expect(schedule.sends[199]).toEqual({
            msgId: 'session-05-b-send-40',
            publisherPeerId: 'session-05-b',
            publisherInstanceIndex: 1,
            seq: 40,
            dueOffsetMs: 19_900,
            expectedRecipientPeerIds: toRoomWithout('session-05-b')
        });
    });

    it('gives one publisher a track of its own that the fourteen other sessions read', () => {
        const schedule = computeOrderedSendSchedule({ publishers: 1, sendsPerSecond: 5, durationS: 2, delayMs: 5, senderRecovery: 'none' });

        expect(schedule.sessions.filter(({ role }) => role === 'publisher').map(({ peerId }) => peerId)).toEqual([
            'session-01-a'
        ]);
        expect(schedule.sends.map(({ publisherPeerId, seq, dueOffsetMs }) => [publisherPeerId, seq, dueOffsetMs]))
            .toEqual([
                ['session-01-a', 1, 0],
                ['session-01-a', 2, 200],
                ['session-01-a', 3, 400],
                ['session-01-a', 4, 600],
                ['session-01-a', 5, 800],
                ['session-01-a', 6, 1_000],
                ['session-01-a', 7, 1_200],
                ['session-01-a', 8, 1_400],
                ['session-01-a', 9, 1_600],
                ['session-01-a', 10, 1_800]
            ]);
        expect(schedule.sends[0].expectedRecipientPeerIds).toEqual(toRoomWithout('session-01-a'));
    });

    it('lets all fifteen sessions publish: each send still goes to the fourteen others, never to its publisher', () => {
        const schedule = computeOrderedSendSchedule({ publishers: 15, sendsPerSecond: 1, durationS: 2, delayMs: 0, senderRecovery: 'none' });

        expect(schedule.sessions.map(({ role }) => role)).toEqual(Array.from({ length: 15 }, () => 'publisher'));
        expect(schedule.sends).toHaveLength(30);
        for (const send of schedule.sends) {
            expect(send.expectedRecipientPeerIds).toEqual(toRoomWithout(send.publisherPeerId));
        }
        const dueOffsetsMs = schedule.sends.map(({ dueOffsetMs }) => dueOffsetMs);
        expect(dueOffsetsMs).toEqual(dueOffsetsMs.toSorted((left, right) => left - right));
        expect(new Set(dueOffsetsMs).size).toBe(30);
        expect(dueOffsetsMs[29]).toBeLessThan(2_000);
    });

    it('places a send at its own multiple of the period, so a period that is no whole millisecond never drifts', () => {
        const schedule = computeOrderedSendSchedule({ publishers: 1, sendsPerSecond: 3, durationS: 3, delayMs: 0, senderRecovery: 'none' });

        expect(schedule.sends.filter(({ seq }) => [1, 4, 7].includes(seq)).map(({ dueOffsetMs }) => dueOffsetMs))
            .toEqual([0, 1_000, 2_000]);
    });

    it('gives each session one ACK offset inside the spread, the same on every call and under every shape', () => {
        const reference = computeOrderedSendSchedule({ publishers: 5, sendsPerSecond: 2, durationS: 20, delayMs: 0, senderRecovery: 'none' });
        const onePublisher = computeOrderedSendSchedule({ publishers: 1, sendsPerSecond: 5, durationS: 2, delayMs: 5, senderRecovery: 'none' });

        expect(reference.sessions.map(({ ackOffsetMs }) => ackOffsetMs)).toEqual(
            [0, 6, 13, 20, 26, 33, 40, 46, 53, 60, 66, 73, 80, 86, 93]
        );
        expect(onePublisher.sessions.map(({ peerId, ackOffsetMs }) => [peerId, ackOffsetMs])).toEqual(
            reference.sessions.map(({ peerId, ackOffsetMs }) => [peerId, ackOffsetMs])
        );
        expect(computeOrderedSendSchedule({ publishers: 5, sendsPerSecond: 2, durationS: 20, delayMs: 0, senderRecovery: 'none' }))
            .toEqual(reference);
    });
});

describe('ORDERED_SEND_CELL_CONSTANTS', () => {
    it('fixes fifteen sessions on three instances, a 30 s lifetime, a 45 s grace and a 100 ms ACK spread', () => {
        expect(ORDERED_SEND_CELL_CONSTANTS).toEqual({
            sessionCount: 15,
            instanceCount: 3,
            listenerPoolMaxConnections: 1,
            poolIdleTimeoutSeconds: 0,
            sendLifetimeMs: 30_000,
            receiptGraceMs: 45_000,
            ackSpreadMs: 100
        });
    });

    it('observes a reference run for 75 s after its last offer: a send\'s lifetime and a receipt\'s grace', () => {
        expect(ORDERED_SEND_REFERENCE_OBSERVATION_TAIL_MS).toBe(75_000);
    });
});
