import type { ApiJsonObject } from './api-json-value.ts';
import { requireExactOptionalKeys } from './exact-object-decoding.ts';

/** Sparse creation intent; existing rooms and omitted intent remain persistent. */
export type GroupRetentionIntent =
    | Readonly<{ mode: 'persistent'; }>
    | Readonly<{ mode: 'temporary'; reconnectGraceMs?: number; pausedTimelineRetentionMs?: number; }>;

/** Server-owned policy and observation; Group.emptySinceEpochMs owns the idle clock. */
export interface GroupRetentionState {
    readonly mode: 'temporary';
    readonly reconnectGraceMs: number;
    /** Omission selects the platform default for an empty, paused timeline. */
    readonly pausedTimelineRetentionMs?: number;
    readonly emptyPresenceFingerprint: string | null;
}

export const DEFAULT_PAUSED_TIMELINE_RETENTION_MS = 3_600_000;
export const GROUP_RETENTION_METADATA_KEY = 'rallarRetention';

export function assertGroupRetentionIntent(value: unknown): asserts value is GroupRetentionIntent {
    const intent = requireRetentionRecord(value);
    if (intent.mode !== 'persistent' && intent.mode !== 'temporary') {
        throw new TypeError('Group retention must be persistent or temporary creation intent');
    }
    requireExactOptionalKeys({
        value: intent,
        required: ['mode'],
        optional: intent.mode === 'temporary' ? ['reconnectGraceMs', 'pausedTimelineRetentionMs'] : [],
        label: 'Group retention intent'
    });
    if (Object.hasOwn(intent, 'reconnectGraceMs')) {
        assertRetentionDuration(intent.reconnectGraceMs, 1_000, 'reconnectGraceMs');
    }
    if (Object.hasOwn(intent, 'pausedTimelineRetentionMs')) {
        assertRetentionDuration(intent.pausedTimelineRetentionMs, 1, 'pausedTimelineRetentionMs');
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
        : {
            mode: 'temporary',
            reconnectGraceMs: intent.reconnectGraceMs ?? 600_000,
            ...(intent.pausedTimelineRetentionMs === undefined ? {} : { pausedTimelineRetentionMs: intent.pausedTimelineRetentionMs }),
            emptyPresenceFingerprint: null
        };
}

/** Absence is persistent policy; a malformed present value is corruption, never a default. */
export function readGroupRetentionState(metadata: ApiJsonObject): GroupRetentionState | null {
    if (!Object.hasOwn(metadata, GROUP_RETENTION_METADATA_KEY)) {
        return null;
    }
    const state = requireRetentionRecord(metadata[GROUP_RETENTION_METADATA_KEY]);
    requireExactOptionalKeys({
        value: state,
        required: ['mode', 'reconnectGraceMs', 'emptyPresenceFingerprint'],
        optional: ['pausedTimelineRetentionMs'],
        label: 'Stored group retention'
    });
    if (state.mode !== 'temporary') {
        throw new TypeError('Stored group retention must contain a temporary policy');
    }
    assertRetentionDuration(state.reconnectGraceMs, 1_000, 'reconnectGraceMs');
    if (
        state.emptyPresenceFingerprint !== null &&
        (typeof state.emptyPresenceFingerprint !== 'string' || state.emptyPresenceFingerprint.length === 0)
    ) {
        throw new TypeError('Stored group retention fingerprint must be a non-empty string or null');
    }
    const policy: GroupRetentionState = {
        mode: 'temporary',
        reconnectGraceMs: state.reconnectGraceMs,
        emptyPresenceFingerprint: state.emptyPresenceFingerprint
    };
    if (!Object.hasOwn(state, 'pausedTimelineRetentionMs')) {
        return policy;
    }
    assertRetentionDuration(state.pausedTimelineRetentionMs, 1, 'pausedTimelineRetentionMs');
    return { ...policy, pausedTimelineRetentionMs: state.pausedTimelineRetentionMs };
}

function assertRetentionDuration(value: unknown, minimumMs: number, field: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimumMs || value > 86_400_000) {
        throw new TypeError(`Group temporary retention ${field} must be an integer from ${minimumMs} through 86400000`);
    }
}

function requireRetentionRecord(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Group retention must be an object');
    }
    return value as Record<string, unknown>;
}
