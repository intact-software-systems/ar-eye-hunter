import { requireExactOptionalKeys, requirePositiveInteger, requireRecord } from '../exact-object-decoding.ts';
import { assertGroupRetentionIntent } from '../group-retention.ts';
import { ROOM_GUEST_LIFETIME_MS } from './invitation.ts';

export interface TemporaryRoomPolicy {
    readonly defaultCapacity: number;
    readonly maximumCapacity: number;
    readonly lifetimeMs: number;
    readonly emptyReturnWindowMs: number;
    readonly creationLimit: number;
    readonly creationWindowMs: number;
}

const DEFAULT_TEMPORARY_ROOM_POLICY: TemporaryRoomPolicy = {
    defaultCapacity: 4,
    maximumCapacity: 4,
    lifetimeMs: ROOM_GUEST_LIFETIME_MS,
    emptyReturnWindowMs: 900_000,
    creationLimit: 10,
    creationWindowMs: 60_000
};

export function decodeTemporaryRoomPolicy(value: unknown): TemporaryRoomPolicy {
    const overrides = requireRecord(value, 'Temporary room policy');
    requireExactOptionalKeys({
        value: overrides, required: [], optional: Object.keys(DEFAULT_TEMPORARY_ROOM_POLICY), label: 'Temporary room policy'
    });
    const policy = { ...DEFAULT_TEMPORARY_ROOM_POLICY, ...overrides };
    for (const [field, setting] of Object.entries(policy)) requirePositiveInteger(setting, field);
    resolveTemporaryRoomCapacity(policy);
    assertGroupRetentionIntent({ mode: 'temporary', reconnectGraceMs: policy.emptyReturnWindowMs });
    if (policy.lifetimeMs > ROOM_GUEST_LIFETIME_MS || policy.emptyReturnWindowMs > policy.lifetimeMs) {
        throw new TypeError('Temporary room recovery must fit within the room lifetime and its creator lease.');
    }
    return policy;
}

export function resolveTemporaryRoomCapacity(
    policy: Pick<TemporaryRoomPolicy, 'defaultCapacity' | 'maximumCapacity'>,
    requested: number = policy.defaultCapacity
): number {
    requirePositiveInteger(requested, 'Temporary room capacity');
    if (requested > policy.maximumCapacity) throw new TypeError('Temporary room capacity exceeds the app maximum.');
    return requested;
}
