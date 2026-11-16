import Ajv from 'ajv';

import type { RallarDirectorStatus } from '@shared-web/browser/director/rallar-director-facade.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { validateJsonMessageSize } from '@shared/api/json-message-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { TownMatchIdentity } from './town-match.ts';

export const TOWN_MATCH_PROTOCOL = 'cca.match.v1';
export const TOWN_MATCH_BUILD = 'grumpy-town-v5';
export interface TownMatchPose {
    readonly id: string;
    readonly x: number;
    readonly z: number;
    readonly vx: number;
    readonly vz: number;
    readonly elapsed: number;
}
export type TownMatchAction =
    | { readonly kind: 'poses'; readonly tick: number; readonly players: readonly TownMatchPose[]; }
    | { readonly kind: 'controls'; readonly x: number; readonly z: number; readonly dash: number; }
    | { readonly kind: 'ready'; readonly ready: boolean; readonly displayName: string; }
    | { readonly kind: 'start'; }
    | { readonly kind: 'rematch'; readonly nextMatchId: string; }
    | { readonly kind: 'proposal'; readonly digest: string; readonly snapshot: string; }
    | { readonly kind: 'ack' | 'commit'; readonly digest: string; readonly proposalSequence: number; }
    | {
        readonly kind: 'recover';
        readonly digest: string;
        readonly proposalSequence: number;
        readonly checkpointEpoch: number;
        readonly committed: boolean;
    };
export interface TownMatchFrame {
    readonly protocol: typeof TOWN_MATCH_PROTOCOL;
    readonly build: typeof TOWN_MATCH_BUILD;
    readonly roomRef: GroupRef;
    readonly epoch: number;
    readonly matchId: string;
    readonly sequence: number;
    readonly action: TownMatchAction;
}
export interface TownMatchReception {
    readonly roomRef: GroupRef;
    readonly targetRoomRef: GroupRef | undefined;
    readonly director: RallarDirectorStatus;
    readonly members: readonly TownMatchIdentity[];
    readonly senderId: string;
    readonly matchId: string | undefined;
}

const identity = { type: 'string', minLength: 1, maxLength: 128 };
const sequence = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const matchesFrame = new Ajv({ strict: true }).compile<TownMatchFrame>({
    type: 'object',
    additionalProperties: false,
    required: ['protocol', 'build', 'roomRef', 'epoch', 'matchId', 'sequence', 'action'],
    properties: {
        protocol: { const: TOWN_MATCH_PROTOCOL },
        build: { const: TOWN_MATCH_BUILD },
        roomRef: {
            type: 'object',
            additionalProperties: false,
            required: ['applicationId', 'workspaceId', 'groupId'],
            properties: { applicationId: identity, workspaceId: identity, groupId: identity }
        },
        epoch: sequence,
        matchId: identity,
        sequence,
        action: {
            oneOf: [
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'tick', 'players'],
                    properties: {
                        kind: { const: 'poses' },
                        tick: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                        players: {
                            type: 'array',
                            minItems: 1,
                            maxItems: 4,
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['id', 'x', 'z', 'vx', 'vz', 'elapsed'],
                                properties: {
                                    id: identity,
                                    x: { type: 'number', minimum: -24, maximum: 24 },
                                    z: { type: 'number', minimum: -24, maximum: 24 },
                                    vx: { type: 'number', minimum: -50, maximum: 50 },
                                    vz: { type: 'number', minimum: -50, maximum: 50 },
                                    elapsed: { type: 'number', minimum: 0, maximum: 1000 }
                                }
                            }
                        }
                    }
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'x', 'z', 'dash'],
                    properties: {
                        kind: { const: 'controls' },
                        x: { type: 'number', minimum: -1, maximum: 1 },
                        z: { type: 'number', minimum: -1, maximum: 1 },
                        dash: { type: 'integer', minimum: 0, maximum: 1_000_000 }
                    }
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'ready', 'displayName'],
                    properties: { kind: { const: 'ready' }, ready: { type: 'boolean' }, displayName: identity }
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind'],
                    properties: { kind: { const: 'start' } }
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'nextMatchId'],
                    properties: { kind: { const: 'rematch' }, nextMatchId: identity }
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'digest', 'snapshot'],
                    properties: {
                        kind: { const: 'proposal' },
                        digest,
                        snapshot: { type: 'string', maxLength: 196_608 }
                    }
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'digest', 'proposalSequence'],
                    properties: { kind: { enum: ['ack', 'commit'] }, digest, proposalSequence: sequence }
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'digest', 'proposalSequence', 'checkpointEpoch', 'committed'],
                    properties: {
                        kind: { const: 'recover' },
                        digest,
                        proposalSequence: sequence,
                        checkpointEpoch: sequence,
                        committed: { type: 'boolean' }
                    }
                }
            ]
        }
    }
});

export function decodeTownMatchFrame(serialized: unknown): Either<readonly string[], TownMatchFrame> {
    if (typeof serialized !== 'string' || validateJsonMessageSize(serialized, 262_144).left) {
        return Either.ofLeft(['The match message is not bounded wire text.']);
    }
    let value: unknown;
    try {
        value = JSON.parse(serialized);
    }
    catch {
        return Either.ofLeft(['The match message is not JSON.']);
    }
    return matchesFrame(value)
        ? Either.ofRight(value)
        : Either.ofLeft(['The match message is invalid or uses an incompatible build. Refresh before playing.']);
}

export function validateTownMatchFrame(frame: TownMatchFrame, reception: TownMatchReception): readonly string[] {
    const { director, senderId, roomRef, targetRoomRef } = reception;
    const issues: string[] = [];
    if (!targetRoomRef || !isSameGroupRef(roomRef, targetRoomRef) || !isSameGroupRef(roomRef, frame.roomRef)) {
        issues.push('The message does not target this complete room scope.');
    }
    if (
        !director.isFresh || !director.active || !director.roomRef || !isSameGroupRef(roomRef, director.roomRef) ||
        !director.appointment || director.appointment.epoch !== frame.epoch
    ) {
        issues.push('The server appointment is unavailable, stale or belongs to another epoch.');
    }
    if (!reception.members.some((member) => member.sessionId === senderId)) {
        issues.push('The authenticated sender is not a current player session.');
    }
    const directorOnly = ['proposal', 'commit', 'start', 'rematch', 'poses'].includes(frame.action.kind);
    if (directorOnly && senderId !== director.appointment?.sessionId) {
        issues.push('Only the appointed session may send this match action.');
    }
    if (reception.matchId === undefined ? frame.action.kind !== 'proposal' : frame.matchId !== reception.matchId) {
        issues.push('The message does not belong to the current match.');
    }
    return issues;
}
