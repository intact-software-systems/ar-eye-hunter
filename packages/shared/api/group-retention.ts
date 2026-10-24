import type { ApiJsonObject } from './api-json-value.ts';

/** Sparse creation intent; existing rooms and omitted intent remain persistent. */
export type GroupRetentionIntent =
    | Readonly<{ mode: 'persistent'; }>
    | Readonly<{ mode: 'temporary'; reconnectGraceMs?: number; }>;

/** Server-owned policy and observation; Group.emptySinceEpochMs owns the idle clock. */
export interface GroupRetentionState {
    readonly mode: 'temporary';
    readonly reconnectGraceMs: number;
    readonly emptyPresenceFingerprint: string | null;
}

export const GROUP_RETENTION_METADATA_KEY = 'rallarRetention';

export function assertGroupRetentionIntent(value: unknown): asserts value is GroupRetentionIntent {
    const intent = requireRetentionRecord(value);
    const keys = intent.mode === 'temporary' ? ['mode', 'reconnectGraceMs'] : ['mode'];
    if (
        !Object.hasOwn(intent, 'mode') ||
        Object.keys(intent).some((key) => !keys.includes(key)) ||
        (intent.mode !== 'persistent' && intent.mode !== 'temporary')
    ) {
        throw new TypeError('Group retention must be persistent or temporary creation intent');
    }
    if (intent.mode === 'temporary' && Object.hasOwn(intent, 'reconnectGraceMs')) {
        assertReconnectGrace(intent.reconnectGraceMs);
    }
}

export function toInitialGroupRetentionState(
    intent: GroupRetentionIntent | undefined
): GroupRetentionState | null {
    if (intent === undefined) {
        return null;
    }
    assertGroupRetentionIntent(intent);
    return intent.mode === 'persistent'
        ? null
        : { mode: 'temporary', reconnectGraceMs: intent.reconnectGraceMs ?? 600_000, emptyPresenceFingerprint: null };
}

/** Absence is persistent policy; a malformed present value is corruption, never a default. */
export function readGroupRetentionState(metadata: ApiJsonObject): GroupRetentionState | null {
    if (!Object.hasOwn(metadata, GROUP_RETENTION_METADATA_KEY)) {
        return null;
    }
    const state = requireRetentionRecord(metadata[GROUP_RETENTION_METADATA_KEY]);
    const keys = ['mode', 'reconnectGraceMs', 'emptyPresenceFingerprint'];
    if (
        Object.keys(state).length !== keys.length || !keys.every((key) => Object.hasOwn(state, key)) ||
        state.mode !== 'temporary'
    ) {
        throw new TypeError('Stored group retention must contain its complete temporary policy and observation');
    }
    assertReconnectGrace(state.reconnectGraceMs);
    if (
        state.emptyPresenceFingerprint !== null &&
        (typeof state.emptyPresenceFingerprint !== 'string' || state.emptyPresenceFingerprint.length === 0)
    ) {
        throw new TypeError('Stored group retention fingerprint must be a non-empty string or null');
    }
    return {
        mode: 'temporary',
        reconnectGraceMs: state.reconnectGraceMs,
        emptyPresenceFingerprint: state.emptyPresenceFingerprint
    };
}

function assertReconnectGrace(value: unknown): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1_000 || value > 86_400_000) {
        throw new TypeError('Group temporary retention reconnectGraceMs must be an integer from 1000 through 86400000');
    }
}

function requireRetentionRecord(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Group retention must be an object');
    }
    return value as Record<string, unknown>;
}
