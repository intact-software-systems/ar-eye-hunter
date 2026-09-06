import {
    isGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupTopologyReconfigureLanding } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { BlackBoxRallarFormationCommandInput } from './black-box-rallar-operation-contracts.ts';

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

export interface BlackBoxRallarFormationInputIssue {
    readonly path: string;
    readonly message: string;
}

export type BlackBoxRallarFormationInputDecoding = Either<
    readonly BlackBoxRallarFormationInputIssue[],
    BlackBoxRallarFormationCommandInput
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
    const issues: BlackBoxRallarFormationInputIssue[] = [];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return toLeft([{ path: '$', message: 'Formation command input must be an object.' }]);
    }

    const record = value as Record<string, unknown>;
    const command = readCommand(record, issues);
    readUnknownKeys(record, issues);
    if (command === undefined) {
        return toLeft(issues);
    }

    const layout = readLayout(record, command, issues);
    const landing = readLanding(record, command, issues);
    if (issues.length > 0) {
        return toLeft(issues);
    }

    if (command === 'connect') {
        return Either.ofRight(layout === undefined ? { command } : { command, layout });
    }
    if (command === 'reconfigure') {
        return Either.ofRight(landing === undefined ? { command } : { command, landing });
    }
    return Either.ofRight({ command });
}

function readCommand(
    record: Record<string, unknown>,
    issues: BlackBoxRallarFormationInputIssue[]
): FormationCommand | undefined {
    const command = record['command'];
    const known = FORMATION_COMMANDS.find((candidate) => candidate === command);
    if (known === undefined) {
        issues.push({
            path: '$.command',
            message: 'Formation command must be one of ' + FORMATION_COMMANDS.join(', ') + '.'
        });
    }
    return known;
}

function readLayout(
    record: Record<string, unknown>,
    command: FormationCommand,
    issues: BlackBoxRallarFormationInputIssue[]
): GroupLayoutIdentity | undefined {
    const layout = record['layout'];
    if (layout === undefined) {
        return undefined;
    }
    if (command !== 'connect') {
        issues.push({ path: '$.layout', message: 'Formation command ' + command + ' does not take layout.' });
        return undefined;
    }
    if (!isGroupLayoutIdentity(layout)) {
        issues.push({ path: '$.layout', message: 'Formation connect layout must be a group layout identity.' });
        return undefined;
    }
    return layout;
}

function readLanding(
    record: Record<string, unknown>,
    command: FormationCommand,
    issues: BlackBoxRallarFormationInputIssue[]
): GroupTopologyReconfigureLanding | undefined {
    const landing = record['landing'];
    if (landing === undefined) {
        return undefined;
    }
    if (command !== 'reconfigure') {
        issues.push({ path: '$.landing', message: 'Formation command ' + command + ' does not take landing.' });
        return undefined;
    }
    const known = RECONFIGURE_LANDINGS.find((candidate) => candidate === landing);
    if (known === undefined) {
        issues.push({
            path: '$.landing',
            message: 'Formation reconfigure landing must be one of ' +
                RECONFIGURE_LANDINGS.join(', ') + '.'
        });
    }
    return known;
}

function readUnknownKeys(
    record: Record<string, unknown>,
    issues: BlackBoxRallarFormationInputIssue[]
): void {
    for (const key of Object.keys(record)) {
        if (key !== 'command' && key !== 'layout' && key !== 'landing') {
            issues.push({ path: '$.' + key, message: 'Formation command input does not take ' + key + '.' });
        }
    }
}

function toLeft(issues: readonly BlackBoxRallarFormationInputIssue[]): BlackBoxRallarFormationInputDecoding {
    return Either.ofLeft(issues);
}
