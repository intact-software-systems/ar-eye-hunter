import type { RallarCrdtDocumentTypePolicy, RallarCrdtFeatureFlags } from './crdt-hardening.ts';
import type { RallarCrdtQuotaPolicy, RallarCrdtRetentionPolicy } from './crdt-durable-log.ts';

const POLICY_KEYS = new Set([
    'applicationId',
    'workspaceId',
    'scope',
    'documentType',
    'rollout',
    'flags',
    'quota',
    'retention',
    'sensitiveFields',
]);
const FLAG_KEYS = new Set([
    'networkSend',
    'ws',
    'rtc',
    'durableAppend',
    'peerCatchUp',
    'readOnly',
    'appScope',
    'customScope',
    'graphDocuments',
    'sequenceTextDocuments',
    'killSwitchReason',
]);
const QUOTA_KEYS = new Set([
    'maxUpdateBytes',
    'maxDocumentBytes',
    'maxUpdateCount',
    'maxPendingUpdatesPerReplica',
    'maxUpdatesPerMinutePerActor',
]);
const RETENTION_KEYS = new Set([
    'mode',
    'ttlMs',
    'sensitivePayloads',
    'reason',
]);
const SCOPES = new Set(['room', 'principal', 'app', 'custom', 'any']);
const ROLLOUTS = new Set([
    'disabled',
    'experimental-local',
    'experimental-live',
    'durable-beta',
    'production',
]);
const RETENTION_MODES = new Set(['retain', 'redact-after', 'delete-after']);

export function decodeRallarCrdtDocumentTypePolicies(
    value: unknown,
): readonly RallarCrdtDocumentTypePolicy[] {
    if (!Array.isArray(value)) {
        throw new TypeError('CRDT document policies must be an array');
    }
    if (value.length === 0) {
        throw new TypeError('CRDT document policies must not be empty');
    }
    return value.map(decodeRallarCrdtDocumentTypePolicy);
}

export function decodeRallarCrdtDocumentTypePolicy(
    value: unknown,
): RallarCrdtDocumentTypePolicy {
    const policy = exactRecord(value, POLICY_KEYS, 'CRDT document policy');
    const documentType = nonEmptyString(policy.documentType, 'policy.documentType');
    const rollout = nonEmptyString(policy.rollout, 'policy.rollout');
    if (!ROLLOUTS.has(rollout)) {
        throw new TypeError('policy.rollout is invalid');
    }

    const applicationId = optionalNonEmptyString(policy.applicationId, 'policy.applicationId');
    const workspaceId = optionalNonEmptyString(policy.workspaceId, 'policy.workspaceId');
    const scope = optionalNonEmptyString(policy.scope, 'policy.scope');
    if (scope !== undefined && !SCOPES.has(scope)) {
        throw new TypeError('policy.scope is invalid');
    }

    return {
        documentType,
        rollout: rollout as RallarCrdtDocumentTypePolicy['rollout'],
        ...(applicationId === undefined ? {} : { applicationId }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(scope === undefined ? {} : { scope: scope as RallarCrdtDocumentTypePolicy['scope'] }),
        ...(policy.flags === undefined ? {} : { flags: decodeFlags(policy.flags) }),
        ...(policy.quota === undefined ? {} : { quota: decodeQuota(policy.quota) }),
        ...(policy.retention === undefined ? {} : { retention: decodeRetention(policy.retention) }),
        ...(policy.sensitiveFields === undefined
            ? {}
            : { sensitiveFields: decodeSensitiveFields(policy.sensitiveFields) }),
    };
}

function decodeFlags(value: unknown): RallarCrdtFeatureFlags {
    const flags = exactRecord(value, FLAG_KEYS, 'policy.flags');
    const result: Record<string, boolean | string> = {};
    for (const key of FLAG_KEYS) {
        const field = flags[key];
        if (field === undefined) continue;
        if (key === 'killSwitchReason') {
            result[key] = nonEmptyString(field, `policy.flags.${key}`);
        } else if (typeof field === 'boolean') {
            result[key] = field;
        } else {
            throw new TypeError(`policy.flags.${key} must be boolean`);
        }
    }
    return result as RallarCrdtFeatureFlags;
}

function decodeQuota(value: unknown): RallarCrdtQuotaPolicy {
    const quota = exactRecord(value, QUOTA_KEYS, 'policy.quota');
    if (Object.keys(quota).length === 0) {
        throw new TypeError('policy.quota must not be empty');
    }
    const result: Record<string, number> = {};
    for (const key of QUOTA_KEYS) {
        if (quota[key] !== undefined) {
            result[key] = positiveSafeInteger(quota[key], `policy.quota.${key}`);
        }
    }
    return result as RallarCrdtQuotaPolicy;
}

function decodeRetention(value: unknown): RallarCrdtRetentionPolicy {
    const retention = exactRecord(value, RETENTION_KEYS, 'policy.retention');
    const mode = nonEmptyString(retention.mode, 'policy.retention.mode');
    if (!RETENTION_MODES.has(mode)) {
        throw new TypeError('policy.retention.mode is invalid');
    }
    const ttlMs = retention.ttlMs === undefined
        ? undefined
        : positiveSafeInteger(retention.ttlMs, 'policy.retention.ttlMs');
    if (mode !== 'retain' && ttlMs === undefined) {
        throw new TypeError(`policy.retention.ttlMs is required for ${mode}`);
    }
    if (
        retention.sensitivePayloads !== undefined &&
        typeof retention.sensitivePayloads !== 'boolean'
    ) {
        throw new TypeError('policy.retention.sensitivePayloads must be boolean');
    }
    const reason = optionalNonEmptyString(retention.reason, 'policy.retention.reason');
    return {
        mode: mode as RallarCrdtRetentionPolicy['mode'],
        ...(ttlMs === undefined ? {} : { ttlMs }),
        ...(retention.sensitivePayloads === undefined
            ? {}
            : { sensitivePayloads: retention.sensitivePayloads }),
        ...(reason === undefined ? {} : { reason }),
    };
}

function decodeSensitiveFields(value: unknown): readonly string[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new TypeError('policy.sensitiveFields must be a non-empty array');
    }
    const fields = value.map((field, index) =>
        nonEmptyString(field, `policy.sensitiveFields[${index}]`)
    );
    if (new Set(fields).size !== fields.length) {
        throw new TypeError('policy.sensitiveFields must not contain duplicates');
    }
    return fields;
}

function exactRecord(
    value: unknown,
    allowedKeys: ReadonlySet<string>,
    label: string,
): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        if (!allowedKeys.has(key)) {
            throw new TypeError(`${label} has unknown field ${key}`);
        }
    }
    return record;
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
    return value === undefined ? undefined : nonEmptyString(value, label);
}

function nonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError(`${label} must be a non-empty string`);
    }
    return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new TypeError(`${label} must be a positive safe integer`);
    }
    return value as number;
}
