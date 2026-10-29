import { readALTargetGroupRef, type ALMessage } from '../al-contracts/al-contract.ts';
import { validateRallarGroupRef } from '../api/rallar-validation.ts';
import { Try } from '../resilience/Either.ts';

/** Reserved read-only game operation; application-specific type names grant no spectator permission. */
export const RALLAR_GAME_SNAPSHOT_REQUEST_TYPE_ID = 'rallar.game.snapshot-request.v1';

/** Validate the complete relay and scoped game request before granting read-only room send permission. */
export function isRallarGameSnapshotRequest(message: ALMessage): boolean {
    const roomRef = readALTargetGroupRef(message);
    if (
        !roomRef || message.payload.typeId !== RALLAR_GAME_SNAPSHOT_REQUEST_TYPE_ID ||
        message.delivery?.ownership === 'exclusive' || message.payload.resource.length > 2_048
    ) {
        return false;
    }
    const relay = Try.compute<unknown>(() => JSON.parse(message.payload.resource)).right;
    if (
        !isObject(relay) ||
        !hasOnlyKeys(relay, ['protocol', 'topicId', 'typeId', 'roomId', 'epoch', 'sentAtEpochMs', 'payload']) ||
        relay.protocol !== 'rallar.director.relay.v1' || relay.topicId !== message.route.topicId ||
        relay.typeId !== RALLAR_GAME_SNAPSHOT_REQUEST_TYPE_ID || relay.roomId !== roomRef.groupId ||
        !isNonnegativeInteger(relay.epoch) || !isTimestamp(relay.sentAtEpochMs)
    ) {
        return false;
    }
    const request = relay.payload;
    if (
        !isObject(request) ||
        !hasOnlyKeys(request, [
            'protocol',
            'kind',
            'roomRef',
            'matchId',
            'senderId',
            'seq',
            'sentAtEpochMs',
            'directorEpoch',
            'payload'
        ]) ||
        typeof request.protocol !== 'string' || request.protocol.length === 0 || request.protocol.length > 128 ||
        request.kind !== 'sync-request' || request.senderId !== message.id.senderId ||
        request.directorEpoch !== relay.epoch || !isNonnegativeInteger(request.seq) ||
        !isTimestamp(request.sentAtEpochMs) ||
        (request.matchId !== undefined && (typeof request.matchId !== 'string' || request.matchId.length > 256))
    ) {
        return false;
    }
    const scope = request.roomRef;
    return isObject(scope) && validateRallarGroupRef(scope).ok &&
        scope.applicationId === roomRef.applicationId && scope.workspaceId === roomRef.workspaceId &&
        scope.groupId === roomRef.groupId && isDiagnosticPayload(request.payload);
}

function isDiagnosticPayload(value: unknown): boolean {
    return isObject(value) && hasOnlyKeys(value, ['reason', 'requestedAtEpochMs']) &&
        (value.reason === undefined || (typeof value.reason === 'string' && value.reason.length <= 128)) &&
        (value.requestedAtEpochMs === undefined || isTimestamp(value.requestedAtEpochMs));
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).every((key) => keys.includes(key));
}

function isNonnegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
