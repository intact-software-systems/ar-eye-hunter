import { Either } from '@shared/resilience/Either.ts';

import type {
    ControlDistributedRunCommandLink,
    ControlDistributedRunCommandPhase,
    ControlDistributedRunSnapshot
} from '../control-snapshots.ts';
import { decodeDistributedRunManifest, toDistributedRunManifestValidationText } from '../distributed-run-validation.ts';
import {
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES,
    RALLAR_BLACK_BOX_DISTRIBUTED_TARGET_POLICY_MODES,
    type RallarBlackBoxDistributedResolvedRoleAssignment,
    type RallarBlackBoxDistributedRunItemState,
    type RallarBlackBoxDistributedTargetBlocker,
    type RallarBlackBoxDistributedTargetBlockerStatus,
    type RallarBlackBoxDistributedTargetResolution
} from '../distributed-run.ts';
import { decodeControlAgentIdentity } from '../distributed/decode-control-agent-identity.ts';
import type {
    RallarBlackBoxDistributedRunRollup,
    RallarBlackBoxDistributedRunRollupFailure
} from '../distributed/distributed-run-rollup.ts';
import {
    RALLAR_BLACK_BOX_GROUP_ASSERTION_AGGREGATES,
    type RallarBlackBoxDistributedGroupAssertionResult,
    type RallarBlackBoxGroupAssertionAgentRow
} from '../distributed/group-assertions.ts';
import type { RallarBlackBoxTestError } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    decodeArrayItems,
    isAbsentOrFiniteNumber,
    isAbsentOrNonEmptyText,
    isFiniteNumber,
    isFiniteNumberRecord,
    isNonEmptyText,
    isOneOf,
    isTextArray,
    toFirstDecodeIssue
} from './artifact-json-value-guards.ts';

/** A target resolution that may be unrecorded. */
export interface OptionalTargetResolution {
    /** Absent when the snapshot carries none or target-resolution.json records null. */
    readonly targetResolution?: RallarBlackBoxDistributedTargetResolution;
}

const COMMAND_LINK_PHASES = Object.keys(
    { stage: true, barrier: true, start: true, cancel: true } satisfies Record<ControlDistributedRunCommandPhase, true>
) as readonly ControlDistributedRunCommandPhase[];

const RUN_ITEM_STATES = Object.keys(
    {
        pending: true,
        targeted: true,
        acknowledged: true,
        ready: true,
        running: true,
        passed: true,
        failed: true,
        cancelled: true,
        'timed-out': true,
        disconnected: true,
        skipped: true
    } satisfies Record<RallarBlackBoxDistributedRunItemState, true>
) as readonly RallarBlackBoxDistributedRunItemState[];

const ROLLUP_FAILURE_KINDS = Object.keys(
    {
        participant: true,
        recipe: true,
        'group-assertion': true
    } satisfies Record<RallarBlackBoxDistributedRunRollupFailure['kind'], true>
) as readonly RallarBlackBoxDistributedRunRollupFailure['kind'][];

const ROLLUP_SUMMARY_COUNTERS = Object.keys(
    {
        participants: true,
        requiredParticipants: true,
        readyParticipants: true,
        passedParticipants: true,
        failedParticipants: true,
        recipes: true,
        requiredRecipes: true,
        passedRecipes: true,
        failedRecipes: true,
        groupAssertions: true,
        passedGroupAssertions: true,
        failedGroupAssertions: true,
        blockingFailures: true
    } satisfies Record<keyof RallarBlackBoxDistributedRunRollup['summary'], true>
);

const TARGET_BLOCKER_STATUSES = Object.keys(
    {
        'offline-agent': true,
        'stale-agent': true,
        'different-group': true,
        'missing-assertion-capability': true,
        'agent-without-identity': true
    } satisfies Record<RallarBlackBoxDistributedTargetBlockerStatus, true>
) as readonly RallarBlackBoxDistributedTargetBlockerStatus[];

const TARGET_SUMMARY_COUNTERS = [
    'agents',
    'targetable',
    'selected',
    'missingExpectedParticipants',
    'staleAgents',
    'offlineAgents',
    'wrongGroupAgents',
    'agentsWithoutIdentity'
] as const;

const GROUP_ASSERTION_EVIDENCE_STATUSES = Object.keys(
    {
        resolved: true,
        missing: true,
        duplicate: true,
        unresolved: true
    } satisfies Record<RallarBlackBoxGroupAssertionAgentRow['evidence'], true>
) as readonly RallarBlackBoxGroupAssertionAgentRow['evidence'][];

const GROUP_ASSERTION_VERDICTS = Object.keys(
    {
        matching: true,
        'not-matching': true,
        violating: true,
        agreeing: true
    } satisfies Record<NonNullable<RallarBlackBoxGroupAssertionAgentRow['verdict']>, true>
) as readonly NonNullable<RallarBlackBoxGroupAssertionAgentRow['verdict']>[];

const OPTIONAL_PHASE_TIMESTAMPS = [
    'stagedAtEpochMs',
    'barrierStartedAtEpochMs',
    'barrierCompletedAtEpochMs',
    'startedAtEpochMs',
    'cancelledAtEpochMs',
    'completedAtEpochMs'
] as const;

export function decodeControlDistributedRunSnapshot(
    value: unknown
): Either<string, ControlDistributedRunSnapshot> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('the snapshot must be a JSON object');
    }
    const issue = toFirstDecodeIssue([
        [isNonEmptyText(value.distributedRunId), 'distributedRunId must be a non-empty string'],
        [isNonEmptyText(value.controlRunId), 'controlRunId must be a non-empty string'],
        [isOneOf(value.state, RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES), 'state must be a distributed run state'],
        [isFiniteNumber(value.createdAtEpochMs), 'createdAtEpochMs must be a finite number'],
        [isFiniteNumber(value.updatedAtEpochMs), 'updatedAtEpochMs must be a finite number'],
        ...OPTIONAL_PHASE_TIMESTAMPS.map((key) =>
            [isAbsentOrFiniteNumber(value[key]), `${key} must be a finite number when present`] as const
        ),
        [isTextArray(value.targetAgentIds), 'targetAgentIds must be an array of strings']
    ]);
    if (issue !== undefined) {
        return Either.ofLeft(issue);
    }
    if (!isAbsentOrRunError(value.error)) {
        return Either.ofLeft('error must carry a code and message when present');
    }
    const manifest = decodeDistributedRunManifest(value.manifest)
        .mapLeft((issues) =>
            `manifest is not a valid distributed run manifest:\n${toDistributedRunManifestValidationText(issues)}`
        );
    const targetResolution = decodeOptionalTargetResolution(value.targetResolution);
    const entryIssue = [
        manifest,
        decodeArrayItems(value.commandLinks, 'commandLinks', decodeCommandLink),
        decodeDistributedRunRollup(value.rollup),
        targetResolution
    ].find((decoded) => decoded.left !== undefined)?.left;
    if (entryIssue !== undefined) {
        return Either.ofLeft(entryIssue);
    }
    return Either.ofRight({
        ...value,
        manifest: manifest.right,
        ...targetResolution.right
    } as ControlDistributedRunSnapshot);
}

/** The target resolution a distributed run snapshot carries and target-resolution.json records. */
export function decodeTargetResolution(value: unknown): Either<string, RallarBlackBoxDistributedTargetResolution> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('targetResolution must be a JSON object');
    }
    const group = value.group;
    const issue = toFirstDecodeIssue([
        [
            isJsonRecordValue(group) &&
            isNonEmptyText(group.applicationId) &&
            isNonEmptyText(group.workspaceId) &&
            isNonEmptyText(group.groupId),
            'targetResolution.group must name applicationId, workspaceId and groupId'
        ],
        [isFiniteNumber(value.resolvedAtEpochMs), 'targetResolution.resolvedAtEpochMs must be a finite number'],
        [isFiniteNumber(value.staleAfterMs), 'targetResolution.staleAfterMs must be a finite number'],
        [
            isOneOf(value.targetPolicyMode, RALLAR_BLACK_BOX_DISTRIBUTED_TARGET_POLICY_MODES),
            'targetResolution.targetPolicyMode must be a target policy mode'
        ],
        [isTextArray(value.targetAgentIds), 'targetResolution.targetAgentIds must be an array of strings'],
        ...decodeTargetResolutionSummaryChecks(value.summary)
    ]);
    if (issue !== undefined) {
        return Either.ofLeft(issue);
    }
    const blockers = decodeArrayItems(value.blockers, 'targetResolution.blockers', decodeTargetBlocker);
    const entryIssue = [
        decodeArrayItems(value.roleAssignments, 'targetResolution.roleAssignments', decodeRoleAssignment),
        blockers
    ].find((decoded) => decoded.left !== undefined)?.left;
    return entryIssue === undefined
        ? Either.ofRight({ ...value, blockers: blockers.right } as RallarBlackBoxDistributedTargetResolution)
        : Either.ofLeft(entryIssue);
}

function decodeCommandLink(
    value: unknown,
    path: string
): Either<string, ControlDistributedRunCommandLink> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft(`${path} must be a JSON object`);
    }
    const issue = toFirstDecodeIssue([
        [isOneOf(value.phase, COMMAND_LINK_PHASES), `${path}.phase must be stage, barrier, start or cancel`],
        [isNonEmptyText(value.agentId), `${path}.agentId must be a non-empty string`],
        [isNonEmptyText(value.commandId), `${path}.commandId must be a non-empty string`],
        [isAbsentOrNonEmptyText(value.recipeId), `${path}.recipeId must be a non-empty string when present`],
        [isAbsentOrNonEmptyText(value.role), `${path}.role must be a non-empty string when present`],
        [isFiniteNumber(value.queuedAtEpochMs), `${path}.queuedAtEpochMs must be a finite number`]
    ]);
    return issue === undefined
        ? Either.ofRight(value as ControlDistributedRunCommandLink)
        : Either.ofLeft(issue);
}

function decodeDistributedRunRollup(value: unknown): Either<string, RallarBlackBoxDistributedRunRollup> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('rollup must be a JSON object');
    }
    const summary = value.summary;
    const issue = toFirstDecodeIssue([
        [isOneOf(value.state, RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES), 'rollup.state must be a distributed run state'],
        [typeof value.ok === 'boolean', 'rollup.ok must be a boolean'],
        [isJsonRecordValue(summary), 'rollup.summary must be a JSON object'],
        ...ROLLUP_SUMMARY_COUNTERS.map((key) =>
            [
                isJsonRecordValue(summary) && isFiniteNumber(summary[key]),
                `rollup.summary.${key} must be a finite number`
            ] as const
        )
    ]);
    if (issue !== undefined) {
        return Either.ofLeft(issue);
    }
    const entryIssue = [
        decodeArrayItems(value.failures, 'rollup.failures', decodeRollupFailure),
        ...(value.groupAssertions === undefined
            ? []
            : [decodeArrayItems(value.groupAssertions, 'rollup.groupAssertions', decodeGroupAssertionResult)])
    ].find((decoded) => decoded.left !== undefined)?.left;
    return entryIssue === undefined
        ? Either.ofRight(value as RallarBlackBoxDistributedRunRollup)
        : Either.ofLeft(entryIssue);
}

function decodeRollupFailure(
    value: unknown,
    path: string
): Either<string, RallarBlackBoxDistributedRunRollupFailure> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft(`${path} must be a JSON object`);
    }
    const issue = toFirstDecodeIssue([
        [isOneOf(value.kind, ROLLUP_FAILURE_KINDS), `${path}.kind must be participant, recipe or group-assertion`],
        [isNonEmptyText(value.key), `${path}.key must be a non-empty string`],
        [isOneOf(value.state, RUN_ITEM_STATES), `${path}.state must be a distributed run item state`],
        [typeof value.required === 'boolean', `${path}.required must be a boolean`],
        [isAbsentOrRunError(value.error), `${path}.error must carry a code and message when present`]
    ]);
    return issue === undefined
        ? Either.ofRight(value as RallarBlackBoxDistributedRunRollupFailure)
        : Either.ofLeft(issue);
}

function decodeGroupAssertionResult(
    value: unknown,
    path: string
): Either<string, RallarBlackBoxDistributedGroupAssertionResult> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft(`${path} must be a JSON object`);
    }
    const participants = value.participants;
    const issue = toFirstDecodeIssue([
        [isNonEmptyText(value.groupAssertionId), `${path}.groupAssertionId must be a non-empty string`],
        [
            isOneOf(value.aggregate, RALLAR_BLACK_BOX_GROUP_ASSERTION_AGGREGATES),
            `${path}.aggregate must be a group assertion aggregate`
        ],
        [typeof value.ok === 'boolean', `${path}.ok must be a boolean`],
        [
            isJsonRecordValue(participants) &&
            isFiniteNumber(participants.expected) &&
            isFiniteNumber(participants.required) &&
            isFiniteNumber(participants.withEvidence) &&
            isAbsentOrFiniteNumber(participants.matching),
            `${path}.participants must count expected, required and withEvidence participants`
        ],
        [isTextArray(value.missingAgentIds), `${path}.missingAgentIds must be an array of strings`],
        [isTextArray(value.violatingAgentIds), `${path}.violatingAgentIds must be an array of strings`],
        [isAbsentOrRunError(value.error), `${path}.error must carry a code and message when present`]
    ]);
    if (issue !== undefined) {
        return Either.ofLeft(issue);
    }
    return decodeArrayItems(value.perAgent, `${path}.perAgent`, decodeGroupAssertionAgentRow)
        .mapRight(() => value as RallarBlackBoxDistributedGroupAssertionResult);
}

function decodeGroupAssertionAgentRow(
    value: unknown,
    path: string
): Either<string, RallarBlackBoxGroupAssertionAgentRow> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft(`${path} must be a JSON object`);
    }
    const issue = toFirstDecodeIssue([
        [isNonEmptyText(value.agentId), `${path}.agentId must be a non-empty string`],
        [isAbsentOrNonEmptyText(value.role), `${path}.role must be a non-empty string when present`],
        [
            isOneOf(value.evidence, GROUP_ASSERTION_EVIDENCE_STATUSES),
            `${path}.evidence must be a group assertion evidence status`
        ],
        [
            value.verdict === undefined || isOneOf(value.verdict, GROUP_ASSERTION_VERDICTS),
            `${path}.verdict must be a group assertion verdict when present`
        ]
    ]);
    return issue === undefined
        ? Either.ofRight(value as RallarBlackBoxGroupAssertionAgentRow)
        : Either.ofLeft(issue);
}

function decodeOptionalTargetResolution(value: unknown): Either<string, OptionalTargetResolution> {
    if (value === undefined) {
        return Either.ofRight({});
    }
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('targetResolution must be a JSON object when present');
    }
    return decodeTargetResolution(value).mapRight((targetResolution) => ({ targetResolution }));
}

function decodeTargetResolutionSummaryChecks(summary: unknown): readonly (readonly [boolean, string])[] {
    if (!isJsonRecordValue(summary)) {
        return [[false, 'targetResolution.summary must be a JSON object']];
    }
    return [
        ...TARGET_SUMMARY_COUNTERS.map((key) =>
            [isFiniteNumber(summary[key]), `targetResolution.summary.${key} must be a finite number`] as const
        ),
        [
            isAbsentOrFiniteNumber(summary.expectedParticipantCount) &&
            isAbsentOrFiniteNumber(summary.assertionCapabilityBlockedAgents),
            'targetResolution.summary optional counters must be finite numbers when present'
        ],
        [
            isFiniteNumberRecord(summary.roleCounts) &&
            isFiniteNumberRecord(summary.regions) &&
            isFiniteNumberRecord(summary.providers),
            'targetResolution.summary roleCounts, regions and providers must map names to counts'
        ]
    ];
}

function decodeRoleAssignment(
    value: unknown,
    path: string
): Either<string, RallarBlackBoxDistributedResolvedRoleAssignment> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft(`${path} must be a JSON object`);
    }
    const { role, agentId, required, recipeIds, variables } = value;
    if (!isNonEmptyText(role)) {
        return Either.ofLeft(`${path}.role must be a non-empty string`);
    }
    if (!isNonEmptyText(agentId)) {
        return Either.ofLeft(`${path}.agentId must be a non-empty string`);
    }
    if (recipeIds !== undefined && !isTextArray(recipeIds)) {
        return Either.ofLeft(`${path}.recipeIds must be an array of strings when present`);
    }
    if (typeof required !== 'boolean') {
        return Either.ofLeft(`${path}.required must be a boolean`);
    }
    if (variables !== undefined && !isJsonRecordValue(variables)) {
        return Either.ofLeft(`${path}.variables must be a JSON object when present`);
    }
    return Either.ofRight({
        role,
        agentId,
        required,
        ...(recipeIds === undefined ? {} : { recipeIds }),
        ...(variables === undefined ? {} : { variables })
    });
}

function decodeTargetBlocker(
    value: unknown,
    path: string
): Either<string, RallarBlackBoxDistributedTargetBlocker> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft(`${path} must be a JSON object`);
    }
    const { agentId, status, reason } = value;
    if (!isNonEmptyText(agentId)) {
        return Either.ofLeft(`${path}.agentId must be a non-empty string`);
    }
    if (!isOneOf(status, TARGET_BLOCKER_STATUSES)) {
        return Either.ofLeft(`${path}.status must be a target blocker status`);
    }
    if (typeof reason !== 'string') {
        return Either.ofLeft(`${path}.reason must be a string`);
    }
    if (status === 'agent-without-identity') {
        return value.identity === undefined
            ? Either.ofRight({ agentId, status, reason })
            : Either.ofLeft(`${path}.identity must be absent for an agent without identity`);
    }
    const identity = decodeControlAgentIdentity(value.identity);
    return identity === undefined
        ? Either.ofLeft(`${path}.identity must be a control agent identity`)
        : Either.ofRight({ agentId, status, reason, identity });
}

function isAbsentOrRunError(value: unknown): value is RallarBlackBoxTestError | undefined {
    return value === undefined ||
        (isJsonRecordValue(value) && typeof value.code === 'string' && typeof value.message === 'string');
}
