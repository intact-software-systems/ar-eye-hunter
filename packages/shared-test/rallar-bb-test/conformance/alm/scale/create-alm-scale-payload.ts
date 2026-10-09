import type { RallarBlackBoxTestJsonValue } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmScaleRecipeInput } from './create-alm-scale-recipes.ts';

const STARTED_AT_EPOCH_MS = 1_802_088_000_000;
const ENDED_AT_EPOCH_MS = STARTED_AT_EPOCH_MS + 60_000;

export function createAlmScalePayload(
    input: AlmScaleRecipeInput,
    kind: 'shot' | 'started' | 'ended'
): RallarBlackBoxTestJsonValue {
    const intent = kind === 'shot';
    const payload = intent ? createShotPayload() : createLifecyclePayload(input, kind);
    return {
        protocol: 'rallar.director.relay.v1',
        topicId: 'room.ar-eye-hunter.director',
        typeId: `room.ar-eye-hunter.director.${intent ? 'intent' : 'event'}.v1`,
        roomId: input.group.groupId,
        epoch: 1,
        sentAtEpochMs: kind === 'ended' ? ENDED_AT_EPOCH_MS : STARTED_AT_EPOCH_MS,
        payload: {
            protocol: 'ar-eye-hunter.v1',
            kind: intent ? 'intent' : 'event',
            roomId: input.group.groupId,
            senderId: '{auth.sessionId}',
            seq: intent ? '{loop.iteration}' : kind === 'started' ? 1 : 2,
            sentAtEpochMs: kind === 'ended' ? ENDED_AT_EPOCH_MS : STARTED_AT_EPOCH_MS,
            directorEpoch: 1,
            payload
        }
    };
}

function createShotPayload(): RallarBlackBoxTestJsonValue {
    return {
        protocol: 'ar-eye-hunter.v1',
        kind: 'player-shot-intent',
        shot: {
            sessionId: '{auth.sessionId}',
            username: '{auth.username}',
            color: '#55ccff',
            origin: [0, 1.6, 0],
            direction: [0, 0, 1],
            weaponKind: 'pulse-rifle',
            charged: false,
            overdrive: false,
            seq: '{loop.iteration}',
            sentAtEpochMs: STARTED_AT_EPOCH_MS
        }
    };
}

function createLifecyclePayload(input: AlmScaleRecipeInput, kind: 'started' | 'ended'): RallarBlackBoxTestJsonValue {
    const match = createMatchPayload(input, kind);
    const intent = {
        matchId: `match:${input.group.groupId}:${STARTED_AT_EPOCH_MS}:60000`,
        directorSessionId: '{auth.sessionId}',
        durationMs: 60_000,
        sentAtEpochMs: STARTED_AT_EPOCH_MS
    };
    return {
        protocol: 'ar-eye-hunter.v1',
        kind: kind === 'started' ? 'director-match-started' : 'director-match-ended',
        accepted: {
            ...(kind === 'started' ? { intent } : {}),
            match,
            revision: kind === 'started' ? 1 : 2,
            acceptedAtEpochMs: kind === 'started' ? STARTED_AT_EPOCH_MS : ENDED_AT_EPOCH_MS
        }
    };
}

function createMatchPayload(input: AlmScaleRecipeInput, kind: 'started' | 'ended'): RallarBlackBoxTestJsonValue {
    const identities = Array.from({ length: input.participantCount }, (_, index) => ({
        sessionId: `fixture-player-${index + 1}`,
        username: `Player ${index + 1}`
    }));
    const baseline = Object.fromEntries(identities.map((identity, index) => [identity.sessionId, {
        ...identity,
        score: 0,
        kills: 0,
        deaths: 0,
        joinedOrder: index + 1
    }]));
    return {
        matchId: `match:${input.group.groupId}:${STARTED_AT_EPOCH_MS}:60000`,
        status: kind === 'started' ? 'active' : 'complete',
        durationMs: 60_000,
        directorSessionId: '{auth.sessionId}',
        startedAtEpochMs: STARTED_AT_EPOCH_MS,
        endsAtEpochMs: ENDED_AT_EPOCH_MS,
        baseline,
        ...(kind === 'ended'
            ? {
                results: identities.map((identity, index) => ({
                    ...identity,
                    scoreDelta: 0,
                    killsDelta: 0,
                    deathsDelta: 0,
                    rank: index + 1
                })),
                completedAtEpochMs: ENDED_AT_EPOCH_MS
            }
            : {})
    };
}
