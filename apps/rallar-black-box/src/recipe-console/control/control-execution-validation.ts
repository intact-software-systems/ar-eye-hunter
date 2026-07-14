import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    RALLAR_BLACK_BOX_DISTRIBUTED_TARGET_POLICY_MODES,
    type RallarBlackBoxDistributedTargetResolution,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import { validateControlDistributedRuns } from './control-snapshot-validation.ts';

export function validateControlExecutionRun(
    value: unknown,
): asserts value is ControlDistributedRunSnapshot {
    validateControlDistributedRuns([value]);
}

export function validateControlExecutionTargetResolution(
    value: unknown,
): asserts value is RallarBlackBoxDistributedTargetResolution {
    const resolution = record(value, 'target resolution');
    const group = record(resolution.group, 'target resolution.group');
    for (const field of ['applicationId', 'workspaceId', 'groupId'] as const) {
        stringField(group, field, `target resolution.group.${field}`);
    }
    numberField(resolution, 'resolvedAtEpochMs', 'target resolution.resolvedAtEpochMs');
    numberField(resolution, 'staleAfterMs', 'target resolution.staleAfterMs');
    stringField(resolution, 'targetPolicyMode', 'target resolution.targetPolicyMode');
    if (
        !(RALLAR_BLACK_BOX_DISTRIBUTED_TARGET_POLICY_MODES as readonly unknown[])
            .includes(resolution.targetPolicyMode)
    ) {
        fail('target resolution.targetPolicyMode must be a known target-policy mode');
    }

    const targetAgentIds = arrayField(
        resolution,
        'targetAgentIds',
        'target resolution.targetAgentIds',
    );
    stringArray(targetAgentIds, 'target resolution.targetAgentIds');
    uniqueStrings(targetAgentIds, 'target resolution.targetAgentIds');

    const roleAssignments = arrayField(
        resolution,
        'roleAssignments',
        'target resolution.roleAssignments',
    );
    roleAssignments.forEach((value, index) => {
        const assignment = record(
            value,
            `target resolution.roleAssignments[${index}]`,
        );
        stringField(
            assignment,
            'agentId',
            `target resolution.roleAssignments[${index}].agentId`,
        );
        stringField(
            assignment,
            'role',
            `target resolution.roleAssignments[${index}].role`,
        );
    });

    const blockers = arrayField(
        resolution,
        'blockers',
        'target resolution.blockers',
    );
    blockers.forEach((value, index) => {
        const blocker = record(value, `target resolution.blockers[${index}]`);
        for (const field of ['agentId', 'status', 'reason'] as const) {
            stringField(
                blocker,
                field,
                `target resolution.blockers[${index}].${field}`,
            );
        }
    });

    const summary = record(resolution.summary, 'target resolution.summary');
    for (
        const field of [
            'agents',
            'targetable',
            'selected',
            'missingExpectedParticipants',
            'staleAgents',
            'offlineAgents',
            'wrongGroupAgents',
            'agentsWithoutIdentity',
        ] as const
    ) {
        numberField(summary, field, `target resolution.summary.${field}`);
    }
    if (summary.expectedParticipantCount !== undefined) {
        numberField(
            summary,
            'expectedParticipantCount',
            'target resolution.summary.expectedParticipantCount',
        );
    }
    for (const field of ['roleCounts', 'regions', 'providers'] as const) {
        numericRecord(summary[field], `target resolution.summary.${field}`);
    }
}

export function validateControlExecutionArtifactBundle(
    value: unknown,
): asserts value is ControlDistributedRunArtifactBundle {
    const artifact = record(value, 'artifact');
    if (artifact.artifactSchemaVersion !== 2) {
        fail('artifact.artifactSchemaVersion must be 2');
    }
    stringField(artifact, 'distributedRunId', 'artifact.distributedRunId');
    numberField(artifact, 'generatedAtEpochMs', 'artifact.generatedAtEpochMs');
    const files = record(artifact.files, 'artifact.files');
    for (
        const file of [
            'distributed-run.json',
            'manifest.json',
            'control-run.json',
        ]
    ) {
        stringField(files, file, `artifact.files.${file}`);
    }
    for (const [file, content] of Object.entries(files)) {
        if (typeof content !== 'string') {
            fail(`artifact.files.${file} must be a string`);
        }
    }
}

function record(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(`${path} must be an object`);
    }
    return value as Record<string, unknown>;
}

function arrayField(
    value: Record<string, unknown>,
    field: string,
    path: string,
): readonly unknown[] {
    if (!Array.isArray(value[field])) fail(`${path} must be an array`);
    return value[field] as readonly unknown[];
}

function stringField(
    value: Record<string, unknown>,
    field: string,
    path: string,
): void {
    if (typeof value[field] !== 'string') fail(`${path} must be a string`);
}

function numberField(
    value: Record<string, unknown>,
    field: string,
    path: string,
): void {
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) {
        fail(`${path} must be a finite number`);
    }
}

function stringArray(values: readonly unknown[], path: string): void {
    values.forEach((value, index) => {
        if (typeof value !== 'string') fail(`${path}[${index}] must be a string`);
    });
}

function uniqueStrings(values: readonly unknown[], path: string): void {
    if (new Set(values).size !== values.length) {
        fail(`${path} must contain unique values`);
    }
}

function numericRecord(value: unknown, path: string): void {
    const counts = record(value, path);
    for (const [key, count] of Object.entries(counts)) {
        if (typeof count !== 'number' || !Number.isFinite(count)) {
            fail(`${path}.${key} must be a finite number`);
        }
    }
}

function fail(message: string): never {
    throw new Error(`Control execution ${message}.`);
}
