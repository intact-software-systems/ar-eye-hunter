import { GROUP_LAYOUT_IDENTITY_KEYS, GROUP_LAYOUT_IDENTITY_STATES } from '../group-layout-identity.ts';
import { GROUP_ACTIVATION_CONDITIONS } from './compute-group-activation-condition.ts';
import { GROUP_ACTIVATION_STATUS_KEYS, GROUP_EVIDENCE_WATERMARK_KEYS } from './group-activation-status.ts';

type WirePayload = Readonly<Record<string, unknown>>;

/**
 * The wire checks for the observed status, shared by the snapshot and delta
 * validators. Both carry the same nested shape and both fail the same way --
 * a `TypeError` naming the path -- so one check serves them and cannot drift
 * between the two surfaces.
 */
export function validateGroupActivationStatusPayload(status: WirePayload, label: string): void {
    exactKeys(status, GROUP_ACTIVATION_STATUS_KEYS, label);
    enumMember(status.condition, GROUP_ACTIVATION_CONDITIONS, `${label}.condition`);
    const rate = status.coverageRate;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
        throw new TypeError(`${label}.coverageRate must be a rate between 0 and 1`);
    }
    nonNegativeInteger(status.formationEpoch, `${label}.formationEpoch`);
    nonNegativeInteger(status.confirmedAtEpochMs, `${label}.confirmedAtEpochMs`);
    validateGroupLayoutIdentityPayload(
        wireObject(status.coverageBasisLayoutIdentity, `${label}.coverageBasisLayoutIdentity`),
        `${label}.coverageBasisLayoutIdentity`
    );
    if (status.evidenceWatermark !== null) {
        const watermark = wireObject(status.evidenceWatermark, `${label}.evidenceWatermark`);
        exactKeys(watermark, GROUP_EVIDENCE_WATERMARK_KEYS, `${label}.evidenceWatermark`);
        for (const key of GROUP_EVIDENCE_WATERMARK_KEYS) {
            nonNegativeInteger(watermark[key], `${label}.evidenceWatermark.${key}`);
        }
    }
}

/** The accepted layout and the coverage basis are the same shape; one check serves both. */
export function validateGroupLayoutIdentityPayload(identity: WirePayload, label: string): void {
    exactKeys(identity, GROUP_LAYOUT_IDENTITY_KEYS, label);
    for (const key of ['groupRevision', 'presenceRevision', 'version'] as const) {
        nonNegativeInteger(identity[key], `${label}.${key}`);
    }
    enumMember(identity.state, GROUP_LAYOUT_IDENTITY_STATES, `${label}.state`);
}

function wireObject(value: unknown, label: string): WirePayload {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value as WirePayload;
}

function exactKeys(value: WirePayload, allowed: readonly string[], label: string): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            throw new TypeError(`${label} has unexpected key: ${key}`);
        }
    }
    for (const key of allowed) {
        if (!(key in value)) {
            throw new TypeError(`${label} is missing key: ${key}`);
        }
    }
}

function enumMember(value: unknown, allowed: readonly string[], label: string): void {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new TypeError(`${label} must be one of: ${allowed.join(', ')}`);
    }
}

function nonNegativeInteger(value: unknown, label: string): void {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} must be a non-negative integer`);
    }
}
