import type {
    ControlDistributedRunSnapshot,
    ControlServerSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES } from '@shared-test/rallar-bb-test/distributed-run.ts';

export function validateControlServerCoreSnapshot(value: unknown): void {
    const snapshot = rootSnapshotRecord(value);
    const runs = requiredArray(snapshot, 'runs', 'runs');
    optionalArray(snapshot, 'fleetReports', 'fleetReports');
    runs.forEach((run, index) => validateControlRun(run, `runs[${index}]`));
    requireUniqueStringField(runs, 'runId', 'runs');
}

export function validateControlRunSnapshot(value: unknown): void {
    validateControlServerCoreSnapshot({ runs: [value] });
}

export function validateControlDistributedRuns(
    value: unknown
): asserts value is readonly ControlDistributedRunSnapshot[] {
    if (!Array.isArray(value)) {
        throw new Error(
            'Control server snapshot distributedRuns must be an array.'
        );
    }
    value.forEach((run, index) => validateDistributedRun(run, `distributedRuns[${index}]`));
    requireUniqueStringField(value, 'distributedRunId', 'distributedRuns');
}

export function withoutDistributedRuns(
    snapshot: ControlServerSnapshot
): ControlServerSnapshot {
    const { distributedRuns: _ignored, ...core } = snapshot;
    return core;
}

function validateControlRun(value: unknown, path: string): void {
    const run = requiredRecord(value, path);
    requiredString(run, 'runId', `${path}.runId`);
    const agents = requiredArray(run, 'agents', `${path}.agents`);
    const commands = requiredArray(run, 'commands', `${path}.commands`);
    agents.forEach((agent, index) => validateControlAgent(agent, `${path}.agents[${index}]`));
    requireUniqueStringField(agents, 'agentId', `${path}.agents`);
    commands.forEach((command, index) => {
        const commandRecord = requiredRecord(
            command,
            `${path}.commands[${index}]`
        );
        requiredRecord(
            commandRecord.envelope,
            `${path}.commands[${index}].envelope`
        );
    });
}

function validateControlAgent(value: unknown, path: string): void {
    const agent = requiredRecord(value, path);
    requiredString(agent, 'agentId', `${path}.agentId`);
    requiredBoolean(agent, 'connected', `${path}.connected`);
    requiredArray(
        agent,
        'completedCommandIds',
        `${path}.completedCommandIds`
    );
    for (
        const field of [
            'receivedResultCount',
            'receivedEventCount',
            'reconnectCount'
        ] as const
    ) {
        requiredNumber(agent, field, `${path}.${field}`);
    }
    for (
        const field of [
            'lastHeartbeatAtEpochMs',
            'lastSeenAtEpochMs'
        ] as const
    ) {
        optionalNumber(agent, field, `${path}.${field}`);
    }
    if (agent.identity !== undefined) {
        const identity = requiredRecord(agent.identity, `${path}.identity`);
        for (
            const field of [
                'principalId',
                'clientId',
                'username',
                'sessionId',
                'clientInstanceId',
                'applicationId',
                'workspaceId',
                'groupId',
                'providerMode',
                'browserLabel',
                'sessionLabel',
                'region',
                'provider',
                'datacenter',
                'hostId',
                'agentPoolId',
                'deploymentId',
                'browserName',
                'browserVersion',
                'os'
            ] as const
        ) {
            optionalString(identity, field, `${path}.identity.${field}`);
        }
        optionalNumber(
            identity,
            'updatedAtEpochMs',
            `${path}.identity.updatedAtEpochMs`
        );
    }
}

function validateDistributedRun(value: unknown, path: string): void {
    const run = requiredRecord(value, path);
    for (const field of ['distributedRunId', 'controlRunId'] as const) {
        requiredString(run, field, `${path}.${field}`);
    }
    requiredString(run, 'state', `${path}.state`);
    if (
        !(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES as readonly unknown[]).includes(
            run.state
        )
    ) {
        throw new Error(
            `Control server snapshot ${path}.state must be a known distributed-run state.`
        );
    }
    requiredNumber(run, 'updatedAtEpochMs', `${path}.updatedAtEpochMs`);
    const targetAgentIds = requiredArray(
        run,
        'targetAgentIds',
        `${path}.targetAgentIds`
    );
    targetAgentIds.forEach((agentId, index) => {
        if (typeof agentId !== 'string') {
            throw new Error(
                `Control server snapshot ${path}.targetAgentIds[${index}] must be a string.`
            );
        }
    });
    requireUniqueStrings(targetAgentIds, `${path}.targetAgentIds`);
    const commandLinks = requiredArray(
        run,
        'commandLinks',
        `${path}.commandLinks`
    );
    commandLinks.forEach((link, index) => {
        const linkRecord = requiredRecord(
            link,
            `${path}.commandLinks[${index}]`
        );
        requiredString(
            linkRecord,
            'agentId',
            `${path}.commandLinks[${index}].agentId`
        );
    });

    const manifest = requiredRecord(run.manifest, `${path}.manifest`);
    const group = requiredRecord(manifest.group, `${path}.manifest.group`);
    for (const field of ['applicationId', 'workspaceId', 'groupId'] as const) {
        requiredString(group, field, `${path}.manifest.group.${field}`);
    }
    validateRoleAssignments(
        manifest.roleAssignments,
        `${path}.manifest.roleAssignments`
    );

    const rollup = requiredRecord(run.rollup, `${path}.rollup`);
    const summary = requiredRecord(rollup.summary, `${path}.rollup.summary`);
    requiredNumber(
        summary,
        'blockingFailures',
        `${path}.rollup.summary.blockingFailures`
    );

    if (run.targetResolution !== undefined) {
        const resolution = requiredRecord(
            run.targetResolution,
            `${path}.targetResolution`
        );
        const roleAssignments = requiredArray(
            resolution,
            'roleAssignments',
            `${path}.targetResolution.roleAssignments`
        );
        validateRoleAssignments(
            roleAssignments,
            `${path}.targetResolution.roleAssignments`
        );
    }
}

function validateRoleAssignments(value: unknown, path: string): void {
    if (value === undefined) {
        return;
    }
    if (!Array.isArray(value)) {
        throw new Error(`Control server snapshot ${path} must be an array.`);
    }
    value.forEach((assignment, index) => {
        const record = requiredRecord(assignment, `${path}[${index}]`);
        requiredString(record, 'agentId', `${path}[${index}].agentId`);
    });
}

function rootSnapshotRecord(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new Error('Control server snapshot runs must be an array.');
    }
    return value;
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new Error(`Control server snapshot ${path} must be an object.`);
    }
    return value;
}

function requiredArray(
    record: Record<string, unknown>,
    field: string,
    path: string
): readonly unknown[] {
    const value = record[field];
    if (!Array.isArray(value)) {
        throw new Error(`Control server snapshot ${path} must be an array.`);
    }
    return value;
}

function optionalArray(
    record: Record<string, unknown>,
    field: string,
    path: string
): void {
    if (record[field] !== undefined) {
        requiredArray(record, field, path);
    }
}

function requiredString(
    record: Record<string, unknown>,
    field: string,
    path: string
): void {
    if (typeof record[field] !== 'string') {
        throw new Error(`Control server snapshot ${path} must be a string.`);
    }
}

function optionalString(
    record: Record<string, unknown>,
    field: string,
    path: string
): void {
    if (record[field] !== undefined) {
        requiredString(record, field, path);
    }
}

function requiredBoolean(
    record: Record<string, unknown>,
    field: string,
    path: string
): void {
    if (typeof record[field] !== 'boolean') {
        throw new Error(`Control server snapshot ${path} must be a boolean.`);
    }
}

function requiredNumber(
    record: Record<string, unknown>,
    field: string,
    path: string
): void {
    if (typeof record[field] !== 'number' || !Number.isFinite(record[field])) {
        throw new Error(`Control server snapshot ${path} must be a finite number.`);
    }
}

function optionalNumber(
    record: Record<string, unknown>,
    field: string,
    path: string
): void {
    if (record[field] !== undefined) {
        requiredNumber(record, field, path);
    }
}

function requireUniqueStringField(
    values: readonly unknown[],
    field: string,
    path: string
): void {
    const strings = values.map((value) => {
        const record = requiredRecord(value, path);
        return record[field];
    });
    if (new Set(strings).size !== strings.length) {
        throw new Error(
            `Control server snapshot ${path} must contain unique ${field} values.`
        );
    }
}

function requireUniqueStrings(values: readonly unknown[], path: string): void {
    if (new Set(values).size !== values.length) {
        throw new Error(
            `Control server snapshot ${path} must contain unique values.`
        );
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
