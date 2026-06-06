import type { AuthSession } from './api-config.ts';
import type { GroupRef, GroupSnapshot } from './group-types.ts';

export const RALLAR_GROUP_DIRECTOR_METADATA_KEY = 'rallarDirector';
export const RALLAR_GROUP_DIRECTOR_VERSION = 1;
export const DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS = 5_000;

export type RallarGroupDirectorMode = 'appointed-spa';

export type RallarGroupDirectorAppointment = Readonly<{
    version: typeof RALLAR_GROUP_DIRECTOR_VERSION;
    mode: RallarGroupDirectorMode;
    sessionId: string;
    principalId: string;
    epoch: number;
    appointedAtEpochMs: number;
    heartbeatTtlMs: number;
}>;

export type RallarGroupDirectorFreshness = 'none' | 'fresh' | 'stale';

export type RallarGroupDirectorMetadataPatch = Readonly<{
    rallarDirector?: RallarGroupDirectorAppointment;
}>;

export function readRallarGroupDirectorAppointment(
    metadata: Readonly<Record<string, unknown>> | undefined,
): RallarGroupDirectorAppointment | undefined {
    const value = metadata?.[RALLAR_GROUP_DIRECTOR_METADATA_KEY];
    if (!isRecord(value)) {
        return undefined;
    }

    if (
        value.version !== RALLAR_GROUP_DIRECTOR_VERSION ||
        value.mode !== 'appointed-spa' ||
        typeof value.sessionId !== 'string' ||
        typeof value.principalId !== 'string' ||
        typeof value.epoch !== 'number' ||
        typeof value.appointedAtEpochMs !== 'number' ||
        typeof value.heartbeatTtlMs !== 'number'
    ) {
        return undefined;
    }

    return {
        version: RALLAR_GROUP_DIRECTOR_VERSION,
        mode: 'appointed-spa',
        sessionId: value.sessionId,
        principalId: value.principalId,
        epoch: Math.max(0, Math.floor(value.epoch)),
        appointedAtEpochMs: value.appointedAtEpochMs,
        heartbeatTtlMs: Math.max(1, Math.floor(value.heartbeatTtlMs)),
    };
}

export function readRallarGroupDirectorFromSnapshot(
    snapshot: GroupSnapshot | undefined,
): RallarGroupDirectorAppointment | undefined {
    return readRallarGroupDirectorAppointment(snapshot?.group.metadata);
}

export function createRallarGroupDirectorAppointment(
    input: Readonly<{
        session: Pick<AuthSession, 'clientId' | 'sessionId'>;
        previous?: RallarGroupDirectorAppointment;
        now?: number;
        heartbeatTtlMs?: number;
    }>,
): RallarGroupDirectorAppointment {
    return {
        version: RALLAR_GROUP_DIRECTOR_VERSION,
        mode: 'appointed-spa',
        sessionId: input.session.sessionId,
        principalId: input.session.clientId,
        epoch: (input.previous?.epoch ?? 0) + 1,
        appointedAtEpochMs: input.now ?? Date.now(),
        heartbeatTtlMs: input.heartbeatTtlMs ??
            input.previous?.heartbeatTtlMs ??
            DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS,
    };
}

export function mergeRallarGroupDirectorMetadata(
    metadata: Readonly<Record<string, unknown>> | undefined,
    appointment: RallarGroupDirectorAppointment | undefined,
): Record<string, unknown> {
    const next: Record<string, unknown> = { ...(metadata ?? {}) };
    if (appointment) {
        next[RALLAR_GROUP_DIRECTOR_METADATA_KEY] = appointment;
    } else {
        delete next[RALLAR_GROUP_DIRECTOR_METADATA_KEY];
    }
    return next;
}

export function isRallarGroupDirectorSessionActive(
    snapshot: GroupSnapshot | undefined,
    appointment: RallarGroupDirectorAppointment | undefined,
): boolean {
    if (!snapshot || !appointment) {
        return false;
    }

    return snapshot.activeSessions.some((session) =>
        session.sessionId === appointment.sessionId &&
        session.principalId === appointment.principalId
    );
}

export function isRallarGroupDirectorForSession(
    appointment: RallarGroupDirectorAppointment | undefined,
    session: Pick<AuthSession, 'clientId' | 'sessionId'> | undefined,
): boolean {
    return Boolean(
        appointment &&
            session &&
            appointment.sessionId === session.sessionId &&
            appointment.principalId === session.clientId,
    );
}

export function compareRallarGroupDirectorEpoch(
    left: RallarGroupDirectorAppointment | undefined,
    right: RallarGroupDirectorAppointment | undefined,
): number {
    return (left?.epoch ?? 0) - (right?.epoch ?? 0);
}

export function readRallarGroupDirectorFreshness(
    appointment: RallarGroupDirectorAppointment | undefined,
    lastHeartbeatAtEpochMs: number | undefined,
    now: number = Date.now(),
): RallarGroupDirectorFreshness {
    if (!appointment) {
        return 'none';
    }

    const heartbeatAt = lastHeartbeatAtEpochMs ?? appointment.appointedAtEpochMs;
    return now - heartbeatAt <= appointment.heartbeatTtlMs ? 'fresh' : 'stale';
}

export function toRallarGroupDirectorRoomRef(
    snapshot: GroupSnapshot | undefined,
): GroupRef | undefined {
    return snapshot?.group;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
