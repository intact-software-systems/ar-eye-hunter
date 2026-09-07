import {
    isGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupTopologyReconfigureLanding } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import type {
    BlackBoxRallarFormationCommandInput,
    BlackBoxRallarFormationRoomInput
} from '../black-box-rallar-operation-contracts.ts';
import { DEFAULT_WORKSPACE_ID } from '../black-box-rallar-operation-policy.ts';
import { isBlackBoxCommandRecord } from '../decode-black-box-rallar-command-input.ts';

/** The eight commands the shipped `RallarRoomFormation` handle exposes. */
const FORMATION_COMMANDS = [
    'plan',
    'connect',
    'activate',
    'reconfigure',
    'pause',
    'resume',
    'reset',
    'start'
] as const satisfies readonly BlackBoxRallarFormationCommandInput['command'][];

/** The landing union has no shipped registry array; `satisfies` keeps this one from drifting. */
const RECONFIGURE_LANDINGS = [
    'apply',
    'hold'
] as const satisfies readonly GroupTopologyReconfigureLanding[];

type FormationCommand = typeof FORMATION_COMMANDS[number];

const FORMATION_INPUT_KEYS = ['command', 'layout', 'landing'];

const DEFAULT_FORMATION_TIMEOUT_MS = 15_000;
const ADAPTER_DEADLINE_MARGIN_MS = 3_000;

export interface BlackBoxRallarFormationInputIssue {
    readonly path: string;
    readonly message: string;
}

export type BlackBoxRallarFormationInputDecoding = Either<
    readonly BlackBoxRallarFormationInputIssue[],
    BlackBoxRallarFormationCommandInput
>;

export type BlackBoxRallarFormationRoomDecoding = Either<
    readonly BlackBoxRallarFormationInputIssue[],
    BlackBoxRallarFormationRoomInput
>;

/**
 * The boundary decoder for a `formation.command` payload. `layout` belongs to `connect` and
 * `landing` to `reconfigure`, so naming either on any other command is refused rather than
 * dropped: a recipe that mis-addresses a field should learn about it, not watch the command
 * succeed without the fence or the landing it asked for.
 */
export function decodeBlackBoxRallarFormationCommandInput(
    value: unknown
): BlackBoxRallarFormationInputDecoding {
    if (!isBlackBoxCommandRecord(value)) {
        return Either.ofLeft([{ path: '$', message: 'Formation command input must be an object.' }]);
    }

    const issues: BlackBoxRallarFormationInputIssue[] = [];
    for (const key of Object.keys(value)) {
        if (!FORMATION_INPUT_KEYS.includes(key)) {
            issues.push({ path: '$.' + key, message: 'Formation command input does not take ' + key + '.' });
        }
    }

    const command = decodeFormationCommandName(value.command, issues);
    if (command === undefined) {
        return Either.ofLeft(issues);
    }

    const layout = decodeFormationLayout(value.layout, command, issues);
    const landing = decodeFormationLanding(value.landing, command, issues);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }

    if (command === 'connect') {
        return Either.ofRight(layout === undefined ? { command } : { command, layout });
    }
    if (command === 'reconfigure') {
        return Either.ofRight(landing === undefined ? { command } : { command, landing });
    }
    return Either.ofRight({ command });
}

/**
 * The room a `formation.*` command addresses, taken from an exact `roomRef` or from the
 * `applicationId` and `roomId` the adapter has already merged with the connection's defaults.
 */
export function decodeBlackBoxRallarFormationRoom(value: unknown): BlackBoxRallarFormationRoomDecoding {
    if (!isBlackBoxCommandRecord(value)) {
        return Either.ofLeft([{ path: '$', message: 'Formation command must be an object.' }]);
    }

    const timeoutMs = decodeFormationTimeout(value.timeoutMs);
    if (timeoutMs === undefined) {
        return Either.ofLeft([{
            path: '$.timeoutMs',
            message: 'Formation timeoutMs must be a positive number.'
        }]);
    }

    const roomRef = decodeFormationRoomRef(value);
    if (roomRef === undefined) {
        return Either.ofLeft([{
            path: '$.roomRef',
            message: 'Formation command must name its room with roomRef, or with applicationId and roomId.'
        }]);
    }

    return Either.ofRight({ roomRef, timeoutMs });
}

function decodeFormationCommandName(
    value: unknown,
    issues: BlackBoxRallarFormationInputIssue[]
): FormationCommand | undefined {
    const known = FORMATION_COMMANDS.find((candidate) => candidate === value);
    if (known === undefined) {
        issues.push({
            path: '$.command',
            message: 'Formation command must be one of ' + FORMATION_COMMANDS.join(', ') + '.'
        });
    }
    return known;
}

function decodeFormationLayout(
    value: unknown,
    command: FormationCommand,
    issues: BlackBoxRallarFormationInputIssue[]
): GroupLayoutIdentity | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (command !== 'connect') {
        issues.push({ path: '$.layout', message: 'Formation command ' + command + ' does not take layout.' });
        return undefined;
    }
    if (!isGroupLayoutIdentity(value)) {
        issues.push({ path: '$.layout', message: 'Formation connect layout must be a group layout identity.' });
        return undefined;
    }
    return value;
}

function decodeFormationLanding(
    value: unknown,
    command: FormationCommand,
    issues: BlackBoxRallarFormationInputIssue[]
): GroupTopologyReconfigureLanding | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (command !== 'reconfigure') {
        issues.push({ path: '$.landing', message: 'Formation command ' + command + ' does not take landing.' });
        return undefined;
    }
    const known = RECONFIGURE_LANDINGS.find((candidate) => candidate === value);
    if (known === undefined) {
        issues.push({
            path: '$.landing',
            message: 'Formation reconfigure landing must be one of ' + RECONFIGURE_LANDINGS.join(', ') + '.'
        });
    }
    return known;
}

/**
 * The in-browser wait must expire before the adapter abandons the command, or the adapter's generic
 * timeout replaces the diagnosis the wait would have reported: which state the room was actually in.
 */
function decodeFormationTimeout(value: unknown): number | undefined {
    if (value === undefined) {
        return DEFAULT_FORMATION_TIMEOUT_MS;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    return Math.max(1_000, value - ADAPTER_DEADLINE_MARGIN_MS);
}

function decodeFormationRoomRef(value: unknown): GroupRef | undefined {
    if (!isBlackBoxCommandRecord(value)) {
        return undefined;
    }
    const record = value;
    const explicit = record.roomRef;
    if (
        isBlackBoxCommandRecord(explicit) &&
        typeof explicit.applicationId === 'string' &&
        typeof explicit.groupId === 'string'
    ) {
        return {
            applicationId: explicit.applicationId,
            workspaceId: typeof explicit.workspaceId === 'string' ? explicit.workspaceId : DEFAULT_WORKSPACE_ID,
            groupId: explicit.groupId
        };
    }
    if (typeof record.applicationId === 'string' && typeof record.roomId === 'string') {
        return {
            applicationId: record.applicationId,
            workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : DEFAULT_WORKSPACE_ID,
            groupId: record.roomId
        };
    }
    return undefined;
}
