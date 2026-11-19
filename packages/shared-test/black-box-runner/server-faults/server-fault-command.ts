import { isApiJsonObject } from '../../../shared/api/api-json-value.ts';
import { Either } from '../../../shared/resilience/Either.ts';

/** The run owner sets it for recipes of a run that manages its API servers; no other run has it. */
export const SERVER_FAULTS_URL_ENVIRONMENT_VARIABLE = 'RALLAR_BB_SERVER_FAULTS_URL';

/** The run's managed API servers in plan order, the order of the `RALLAR_API_BASE_URL` suffixes. */
export const SERVER_FAULT_TARGETS = ['primary', 'secondary', 'tertiary'] as const;

export type ServerFaultTarget = typeof SERVER_FAULT_TARGETS[number];

export const SERVER_FAULT_STOP_MODES = ['crash', 'graceful'] as const;

export type ServerFaultStopMode = typeof SERVER_FAULT_STOP_MODES[number];

const SERVER_FAULT_TARGET_ACTIONS = ['restart', 'suspend', 'resume', 'cut-database-sessions'] as const;

export type ServerFaultCommand =
    | Readonly<{ action: 'stop'; target: ServerFaultTarget; mode: ServerFaultStopMode; }>
    | Readonly<{ action: typeof SERVER_FAULT_TARGET_ACTIONS[number]; target: ServerFaultTarget; }>
    /** Resumes every suspended server and restarts every stopped one. */
    | Readonly<{ action: 'restore'; }>;

export type ServerFaultRefusal =
    | 'unmanaged-target'
    | 'not-running'
    | 'already-running'
    | 'already-suspended'
    | 'not-suspended'
    | 'no-database-sessions';

export type ServerFaultApplied =
    | Readonly<{ action: Exclude<ServerFaultCommand['action'], 'restore' | 'cut-database-sessions'>; }>
    | Readonly<{ action: 'cut-database-sessions'; terminatedSessions: number; }>
    | Readonly<{ action: 'restore'; restored: readonly ServerFaultTarget[]; }>;

export type ServerFaultReply =
    | Readonly<{ outcome: 'applied'; applied: ServerFaultApplied; }>
    | Readonly<{ outcome: 'refused'; refusal: ServerFaultRefusal; }>
    | Readonly<{ outcome: 'invalid'; issue: string; }>;

function decodeMember<Member extends string>(value: unknown, members: readonly Member[]): Member | undefined {
    return typeof value === 'string' ? members.find((candidate) => candidate === value) : undefined;
}

export function decodeServerFaultCommand(value: unknown): Either<string, ServerFaultCommand> {
    if (!isApiJsonObject(value)) {
        return Either.ofLeft('a server fault command must be an object');
    }
    if (value.action === 'restore') {
        return Either.ofRight({ action: 'restore' });
    }
    const target = decodeMember(value.target, SERVER_FAULT_TARGETS);
    if (target === undefined) {
        return Either.ofLeft(`target must be one of ${SERVER_FAULT_TARGETS.join(', ')}`);
    }
    if (value.action === 'stop') {
        const mode = decodeMember(value.mode, SERVER_FAULT_STOP_MODES);
        return mode === undefined
            ? Either.ofLeft(`mode must be one of ${SERVER_FAULT_STOP_MODES.join(', ')}`)
            : Either.ofRight({ action: 'stop', target, mode });
    }
    const action = decodeMember(value.action, SERVER_FAULT_TARGET_ACTIONS);
    return action === undefined
        ? Either.ofLeft(`action must be one of stop, restore, ${SERVER_FAULT_TARGET_ACTIONS.join(', ')}`)
        : Either.ofRight({ action, target });
}

const SERVER_FAULT_REFUSALS: readonly ServerFaultRefusal[] = [
    'unmanaged-target',
    'not-running',
    'already-running',
    'already-suspended',
    'not-suspended',
    'no-database-sessions'
];

function decodeServerFaultApplied(value: unknown): ServerFaultApplied | undefined {
    if (!isApiJsonObject(value)) {
        return undefined;
    }
    if (value.action === 'cut-database-sessions') {
        return typeof value.terminatedSessions === 'number'
            ? { action: value.action, terminatedSessions: value.terminatedSessions }
            : undefined;
    }
    if (value.action === 'restore') {
        const restored = Array.isArray(value.restored)
            ? value.restored.flatMap((target) => decodeMember(target, SERVER_FAULT_TARGETS) ?? [])
            : undefined;
        return restored === undefined ? undefined : { action: value.action, restored };
    }
    const action = decodeMember(value.action, ['stop', 'restart', 'suspend', 'resume'] as const);
    return action === undefined ? undefined : { action };
}

export function decodeServerFaultReply(value: unknown): Either<string, ServerFaultReply> {
    const reply = isApiJsonObject(value) ? value : {};
    const applied = decodeServerFaultApplied(reply.applied);
    if (reply.outcome === 'applied' && applied !== undefined) {
        return Either.ofRight({ outcome: 'applied', applied });
    }
    const refusal = decodeMember(reply.refusal, SERVER_FAULT_REFUSALS);
    if (reply.outcome === 'refused' && refusal !== undefined) {
        return Either.ofRight({ outcome: 'refused', refusal });
    }
    if (reply.outcome === 'invalid' && typeof reply.issue === 'string') {
        return Either.ofRight({ outcome: 'invalid', issue: reply.issue });
    }
    return Either.ofLeft('the server fault endpoint answered no reply this runner knows');
}
