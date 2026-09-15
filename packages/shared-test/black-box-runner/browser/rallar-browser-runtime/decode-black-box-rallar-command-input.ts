import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALAckMode } from '@shared/al-contracts/al-contract.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { BlackBoxRallarRoomRef, BlackBoxRallarScope } from './black-box-rallar-operation-contracts.ts';

/** A decoded command envelope whose fields the decoders below narrow one at a time. */
export type BlackBoxRallarCommandRecord = Record<string, unknown>;

/** The first reason a page runtime command input is unusable; the window surface rejects with its message. */
export interface BlackBoxRallarInputIssue {
    readonly message: string;
}

export interface BlackBoxRallarCommandRouting {
    readonly roomRef: BlackBoxRallarRoomRef | undefined;
    readonly ack: ALAckMode | undefined;
}

const AL_ACK_MODES: readonly ALAckMode[] = ['none', 'receiver', 'all-logical-recipients', 'group-leader'];

export function isBlackBoxCommandRecord(value: unknown): value is BlackBoxRallarCommandRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Undefined, functions, symbols and bigints cannot travel as a message payload. */
export function isRallarMessagePayload(value: unknown): value is RallarMessagePayload {
    return value === null || typeof value === 'object' || typeof value === 'string' || typeof value === 'number' ||
        typeof value === 'boolean';
}

export function decodeBlackBoxCommandString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function decodeBlackBoxCommandNumber(value: unknown): number | undefined {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined;
    return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}

export function decodeBlackBoxCommandScope(value: unknown): BlackBoxRallarScope | undefined {
    if (!isBlackBoxCommandRecord(value)) {
        return undefined;
    }
    return {
        applicationId: decodeBlackBoxCommandString(value.applicationId),
        workspaceId: decodeBlackBoxCommandString(value.workspaceId)
    };
}

export function decodeBlackBoxCommandRoomRef(value: unknown): BlackBoxRallarRoomRef | undefined {
    return requireBlackBoxRallarInput(decodeBlackBoxCommandRouting({ roomRef: value })).roomRef;
}

/** The room reference is checked before the acknowledgement mode, so a command naming both reports the room. */
export function decodeBlackBoxCommandRouting(
    record: BlackBoxRallarCommandRecord
): Either<BlackBoxRallarInputIssue, BlackBoxRallarCommandRouting> {
    const roomRef = decodeRoutingRoomRef(record.roomRef);
    if (roomRef !== undefined && 'message' in roomRef) {
        return Either.ofLeft(roomRef);
    }
    const ack = record.ack;
    if (ack !== undefined && !isAlAckMode(ack)) {
        return Either.ofLeft({ message: 'Rallar command ack mode is invalid.' });
    }
    return Either.ofRight({ roomRef, ack });
}

/** The window surface is a promise contract, so an unusable input rejects there with the message of its issue. */
export function requireBlackBoxRallarInput<T>(decoded: Either<BlackBoxRallarInputIssue, T>): T {
    return decoded.fold(
        (issue) => {
            throw new TypeError(issue.message);
        },
        (value) => value
    );
}

function decodeRoutingRoomRef(value: unknown): BlackBoxRallarRoomRef | BlackBoxRallarInputIssue | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isBlackBoxCommandRecord(value)) {
        return { message: 'Rallar command roomRef must be an object.' };
    }
    const applicationId = decodeBlackBoxCommandString(value.applicationId);
    const groupId = decodeBlackBoxCommandString(value.groupId);
    return applicationId && groupId
        ? { applicationId, groupId, workspaceId: decodeBlackBoxCommandString(value.workspaceId) }
        : { message: 'Rallar command roomRef requires applicationId and groupId.' };
}

function isAlAckMode(value: unknown): value is ALAckMode {
    return typeof value === 'string' && AL_ACK_MODES.some((mode) => mode === value);
}
