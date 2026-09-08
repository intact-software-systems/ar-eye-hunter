import { assertPersistedALQos } from '../../al-contracts/al-message-persistence/assert-persisted-al-qos.ts';
import {
    requireOptionalPersistedALNonEmptyString,
    requireOptionalPersistedALSafeInteger,
    requireOptionalPersistedALStringArray,
    requirePersistedALFields,
    requirePersistedALNonEmptyString,
    requirePersistedALRecord,
    type PersistedALRecord,
    type PersistedALValue
} from '../../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import {
    decodeALAdmissionArray,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord
} from '../al-admission-value-validation.ts';

const PLAN_FIELDS = [
    'requested',
    'effective',
    'notes',
    'unmetRequirements',
    'dedupKey',
    'localDelivery',
    'forwarding',
    'ack',
    'nack',
    'repair',
    'supersedence',
    'congestion',
    'ownership',
    'orderingRuntime'
] as const;

const EFFECTIVE_OPTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
    delivery: [],
    forwarding: [],
    repair: ['maxRepairs'],
    ack: ['timeoutMs'],
    expiry: [],
    retry: ['maxAttempts'],
    dedup: ['windowMs'],
    supersedence: [],
    fanout: [],
    congestion: ['priority'],
    durability: [],
    ownership: []
};

export function decodeALInboundPlan(value: unknown): ALMessageHandlingPlan {
    const plan = decodeALAdmissionRecord(value, PLAN_FIELDS, ['dropReason']);
    assertPersistedALQos(plan.requested);
    assertEffectivePolicy(plan.effective);
    assertNormalizationNotes(plan.notes);
    requireStringArray(plan.unmetRequirements, 'unmet requirements');
    requirePersistedALNonEmptyString(plan.dedupKey, 'dedup key');
    requireOptionalPersistedALNonEmptyString(plan.dropReason, 'drop reason');
    assertDeliveryAndForwarding(plan);
    assertControlPlan(plan);
    assertSupersedenceAndCongestion(plan);
    assertOrderingObservation(plan.orderingRuntime);
    return value as ALMessageHandlingPlan;
}

function assertEffectivePolicy(value: PersistedALValue): void {
    assertPersistedALQos(value);
    const effective = requirePersistedALRecord(value, 'effective policy');
    const aspects = Object.keys(EFFECTIVE_OPTION_FIELDS);
    requirePersistedALFields(effective, aspects, aspects);
    for (const [aspect, requiredOptions] of Object.entries(EFFECTIVE_OPTION_FIELDS)) {
        const algorithm = requirePersistedALRecord(effective[aspect], `effective ${aspect}`);
        requirePersistedALFields(algorithm, ['algo', 'opts'], ['algo', 'opts']);
        const options = requirePersistedALRecord(algorithm.opts, `effective ${aspect} options`);
        for (const field of requiredOptions) {
            if (options[field] === undefined) {
                throw new TypeError(`Persisted effective ${aspect} is missing ${field}`);
            }
        }
    }
}

function assertNormalizationNotes(value: PersistedALValue): void {
    decodeALAdmissionArray(value, (candidate) => {
        const note = decodeALAdmissionRecord(candidate, ['aspect', 'kind', 'reason'], ['requested', 'effective']);
        requireVariant(note.aspect, Object.keys(EFFECTIVE_OPTION_FIELDS), 'normalization aspect');
        requireVariant(note.kind, ['defaulted', 'downgraded', 'upgraded', 'clamped'], 'normalization kind');
        requirePersistedALNonEmptyString(note.reason, 'normalization reason');
        requireOptionalPersistedALNonEmptyString(note.requested, 'requested algorithm');
        requireOptionalPersistedALNonEmptyString(note.effective, 'effective algorithm');
    });
}

function assertDeliveryAndForwarding(plan: PersistedALRecord): void {
    const local = requirePersistedALRecord(plan.localDelivery, 'local delivery');
    requirePersistedALFields(local, ['enabled', 'persist', 'deferred', 'reason'], ['enabled', 'persist', 'deferred']);
    requireBooleans(local, ['enabled', 'persist', 'deferred']);
    requireOptionalPersistedALNonEmptyString(local.reason, 'local delivery reason');
    const forwarding = requirePersistedALRecord(plan.forwarding, 'forwarding plan');
    requirePersistedALFields(forwarding, ['enabled', 'nextHopPeerIds', 'persist'], [
        'enabled',
        'nextHopPeerIds',
        'persist'
    ]);
    requireBooleans(forwarding, ['enabled', 'persist']);
    requireStringArray(forwarding.nextHopPeerIds, 'next hop peers');
}

function assertControlPlan(plan: PersistedALRecord): void {
    const ack = requirePersistedALRecord(plan.ack, 'ack plan');
    requirePersistedALFields(ack, ['enabled', 'algo', 'toPeerId', 'deferred'], ['enabled', 'algo', 'deferred']);
    requireBooleans(ack, ['enabled', 'deferred']);
    requireVariant(ack.algo, ['none', 'hop', 'subtree'], 'ack algorithm');
    requireOptionalPersistedALNonEmptyString(ack.toPeerId, 'ack peer');
    const nack = requirePersistedALRecord(plan.nack, 'nack plan');
    requirePersistedALFields(nack, ['enabled', 'toPeerId', 'reason', 'missingSeqs'], ['enabled', 'missingSeqs']);
    requireBooleans(nack, ['enabled']);
    requireOptionalPersistedALNonEmptyString(nack.toPeerId, 'nack peer');
    requireOptionalPersistedALNonEmptyString(nack.reason, 'nack reason');
    decodeALAdmissionArray(nack.missingSeqs, decodeALAdmissionNumber);
    const repair = requirePersistedALRecord(plan.repair, 'repair plan');
    requirePersistedALFields(repair, ['enabled', 'algo', 'reason'], ['enabled', 'algo']);
    requireBooleans(repair, ['enabled']);
    requireVariant(repair.algo, ['none', 'retransmit'], 'repair algorithm');
    requireOptionalPersistedALNonEmptyString(repair.reason, 'repair reason');
}

function assertSupersedenceAndCongestion(plan: PersistedALRecord): void {
    const supersedence = requirePersistedALRecord(plan.supersedence, 'supersedence plan');
    requirePersistedALFields(supersedence, ['enabled', 'algo', 'key', 'replacesMsgId', 'status', 'latestMsgId'], [
        'enabled',
        'algo',
        'status'
    ]);
    requireBooleans(supersedence, ['enabled']);
    requireVariant(supersedence.algo, ['none', 'latest-wins'], 'supersedence algorithm');
    requireVariant(
        supersedence.status,
        ['untracked', 'current', 'superseded', 'replaces-current'],
        'supersedence status'
    );
    for (const field of ['key', 'replacesMsgId', 'latestMsgId']) {
        requireOptionalPersistedALNonEmptyString(supersedence[field], `supersedence ${field}`);
    }
    const congestion = requirePersistedALRecord(plan.congestion, 'congestion plan');
    requirePersistedALFields(congestion, ['overloaded', 'action', 'priority'], ['overloaded', 'action', 'priority']);
    requireBooleans(congestion, ['overloaded']);
    requireVariant(congestion.action, ['none', 'drop-low', 'defer', 'reject'], 'congestion action');
    if (typeof congestion.priority !== 'number' || !Number.isFinite(congestion.priority)) {
        throw new TypeError('Persisted congestion priority is invalid');
    }
    const ownership = requirePersistedALRecord(plan.ownership, 'ownership plan');
    requirePersistedALFields(ownership, ['algo', 'exclusive'], ['algo', 'exclusive']);
    requireVariant(ownership.algo, ['shared', 'exclusive'], 'ownership algorithm');
    requireBooleans(ownership, ['exclusive']);
}

function assertOrderingObservation(value: PersistedALValue): void {
    const ordering = requirePersistedALRecord(value, 'ordering observation');
    requirePersistedALFields(ordering, [
        'status',
        'trackKey',
        'seq',
        'expectedSeq',
        'lastContiguousSeq',
        'missingSeqs',
        'releasableSeqs'
    ], ['status', 'missingSeqs', 'releasableSeqs']);
    requireVariant(
        ordering.status,
        ['untracked', 'in-order', 'gap', 'duplicate', 'stale', 'resync-required'],
        'ordering status'
    );
    requireOptionalPersistedALNonEmptyString(ordering.trackKey, 'ordering track key');
    requireOptionalPersistedALSafeInteger(ordering.seq, 0, 'ordering sequence');
    requireOptionalPersistedALSafeInteger(ordering.expectedSeq, 0, 'ordering expected sequence');
    requireOptionalPersistedALSafeInteger(ordering.lastContiguousSeq, -1, 'ordering contiguous sequence');
    decodeALAdmissionArray(ordering.missingSeqs, decodeALAdmissionNumber);
    decodeALAdmissionArray(ordering.releasableSeqs, decodeALAdmissionNumber);
}

function requireStringArray(value: PersistedALValue, label: string): void {
    if (value === undefined) {
        throw new TypeError(`Persisted ${label} is missing`);
    }
    requireOptionalPersistedALStringArray(value, label);
}

function requireBooleans(record: PersistedALRecord, fields: readonly string[]): void {
    for (const field of fields) {
        if (typeof record[field] !== 'boolean') {
            throw new TypeError(`Persisted ${field} must be a boolean`);
        }
    }
}

function requireVariant(value: PersistedALValue, variants: readonly string[], label: string): void {
    if (typeof value !== 'string' || !variants.includes(value)) {
        throw new TypeError(`Persisted ${label} is invalid`);
    }
}
