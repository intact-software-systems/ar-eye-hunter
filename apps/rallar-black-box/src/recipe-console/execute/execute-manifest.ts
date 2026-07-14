import {
    buildDistributedRunManifest,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type {
    DistributedRecipeCatalogEntryProjection,
} from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    validateDistributedRunManifest,
    type DistributedRunManifestValidationResult,
} from '@shared-test/rallar-bb-test/distributed-run-validation.ts';

export const EXECUTE_ACK_TIMEOUT_MS = 15_000;

export type ExecuteManifestDraft = Readonly<{
    manifest: RallarBlackBoxDistributedRunManifest;
    validation: DistributedRunManifestValidationResult;
    rawJson: string;
    fingerprint: string;
}>;

export type ExecuteTargetResolutionIssueCode =
    | 'group-mismatch'
    | 'policy-mismatch'
    | 'duplicate-selected-target'
    | 'duplicate-resolved-target'
    | 'target-mismatch'
    | 'expected-count-mismatch'
    | 'selected-count-mismatch'
    | 'missing-participants'
    | 'selected-target-blocked';

export type ExecuteTargetResolutionIssue = Readonly<{
    code: ExecuteTargetResolutionIssueCode;
    message: string;
    agentId?: string;
}>;

export type ExecuteTargetResolutionComparison = Readonly<{
    ok: boolean;
    issues: readonly ExecuteTargetResolutionIssue[];
}>;

export type ExecuteTargetResolutionEvidence = Readonly<{
    manifestFingerprint: string;
    resolution: RallarBlackBoxDistributedTargetResolution;
    comparison: ExecuteTargetResolutionComparison;
}>;

export function createExecuteDistributedRunId(input: Readonly<{
    controlRunId: string;
    group: RallarBlackBoxDistributedGroupRef;
    recipeId: string;
    requestedAtEpochMs: number;
}>): string {
    if (
        !Number.isSafeInteger(input.requestedAtEpochMs) ||
        input.requestedAtEpochMs < 0
    ) {
        throw new Error('Execute requestedAtEpochMs must be a non-negative safe integer.');
    }
    return [
        'dist',
        idSegment(input.group.groupId, 'group'),
        idSegment(input.recipeId, 'recipe'),
        idSegment(input.controlRunId, 'control'),
        String(input.requestedAtEpochMs),
    ].join('-');
}

export function deriveExecuteManifest(input: Readonly<{
    distributedRunId: string;
    controlRunId: string;
    group: RallarBlackBoxDistributedGroupRef;
    selectedRecipe: DistributedRecipeCatalogEntryProjection;
    selectedAgentIds: readonly string[];
}>): ExecuteManifestDraft {
    const selectedAgentIds = uniqueSorted(input.selectedAgentIds);
    const manifest = buildDistributedRunManifest({
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        displayName: input.selectedRecipe.item.title,
        group: input.group,
        recipes: [input.selectedRecipe.item],
        targetAgentIds: selectedAgentIds,
        targetPolicyMode: 'selected-agents',
        rolePattern: 'all-agents',
        ackTimeoutMs: EXECUTE_ACK_TIMEOUT_MS,
        startMode: 'manual',
        expectedParticipantCount: selectedAgentIds.length,
    });
    return projectExecuteManifest(manifest);
}
export function projectExecuteManifest(
    manifest: RallarBlackBoxDistributedRunManifest,
): ExecuteManifestDraft {
    return {
        manifest,
        validation: validateDistributedRunManifest(manifest),
        rawJson: JSON.stringify(manifest, null, 2),
        fingerprint: executeManifestFingerprint(manifest),
    };
}

export function executeManifestFingerprint(value: unknown): string {
    return canonicalValue(value, new Set<object>());
}

export function compareExecuteTargetResolution(input: Readonly<{
    manifest: RallarBlackBoxDistributedRunManifest;
    resolution: RallarBlackBoxDistributedTargetResolution;
}>): ExecuteTargetResolutionComparison {
    const issues: ExecuteTargetResolutionIssue[] = [];
    const selected = [...(input.manifest.targetPolicy.agentIds ?? [])];
    const resolved = [...input.resolution.targetAgentIds];
    const selectedSet = new Set(selected);

    if (!sameGroup(input.manifest.group, input.resolution.group)) {
        issues.push({
            code: 'group-mismatch',
            message: 'Resolved targets belong to a different application, workspace, or group.',
        });
    }
    if (input.manifest.targetPolicy.mode !== input.resolution.targetPolicyMode) {
        issues.push({
            code: 'policy-mismatch',
            message: 'Resolved target policy no longer matches the manifest.',
        });
    }
    if (selectedSet.size !== selected.length) {
        issues.push({
            code: 'duplicate-selected-target',
            message: 'The manifest contains a duplicate selected agent ID.',
        });
    }
    if (new Set(resolved).size !== resolved.length) {
        issues.push({
            code: 'duplicate-resolved-target',
            message: 'The server resolution contains a duplicate target agent ID.',
        });
    }
    if (!sameStrings(uniqueSorted(selected), uniqueSorted(resolved))) {
        issues.push({
            code: 'target-mismatch',
            message: 'Server-resolved target IDs no longer exactly match the selected safe IDs.',
        });
    }

    const expected = input.manifest.targetPolicy.expectedParticipantCount;
    if (
        expected !== selectedSet.size ||
        input.resolution.summary.expectedParticipantCount !== expected
    ) {
        issues.push({
            code: 'expected-count-mismatch',
            message: 'Resolved expected participant count no longer matches the exact selection.',
        });
    }
    if (input.resolution.summary.selected !== resolved.length) {
        issues.push({
            code: 'selected-count-mismatch',
            message: 'Resolved selected count does not match the returned target IDs.',
        });
    }
    if (input.resolution.summary.missingExpectedParticipants !== 0) {
        issues.push({
            code: 'missing-participants',
            message: 'The server reports missing expected participants.',
        });
    }
    for (const blocker of input.resolution.blockers) {
        if (!selectedSet.has(blocker.agentId)) continue;
        issues.push({
            code: 'selected-target-blocked',
            message: blocker.reason,
            agentId: blocker.agentId,
        });
    }

    return { ok: issues.length === 0, issues };
}

export function createExecuteTargetResolutionEvidence(input: Readonly<{
    manifest: RallarBlackBoxDistributedRunManifest;
    resolution: RallarBlackBoxDistributedTargetResolution;
}>): ExecuteTargetResolutionEvidence {
    return {
        manifestFingerprint: executeManifestFingerprint(input.manifest),
        resolution: input.resolution,
        comparison: compareExecuteTargetResolution(input),
    };
}

export function currentExecuteTargetResolutionEvidence(input: Readonly<{
    manifest: RallarBlackBoxDistributedRunManifest;
    evidence?: ExecuteTargetResolutionEvidence;
}>): ExecuteTargetResolutionEvidence | undefined {
    if (
        !input.evidence ||
        input.evidence.manifestFingerprint !==
            executeManifestFingerprint(input.manifest)
    ) {
        return undefined;
    }
    return input.evidence;
}

function canonicalValue(value: unknown, ancestors: Set<object>): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return `string${frame(value)}`;
    if (typeof value === 'boolean') return value ? 'boolean1' : 'boolean0';
    if (typeof value === 'number') return `number${numberValue(value)}`;
    if (typeof value === 'bigint') return `bigint${value.toString()}`;
    if (typeof value !== 'object') {
        throw new Error(`Execute manifest fingerprint cannot encode ${typeof value}.`);
    }
    if (ancestors.has(value)) {
        throw new Error('Execute manifest fingerprint cannot encode cyclic values.');
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            if (Object.getOwnPropertySymbols(value).length > 0) {
                throw new Error('Execute manifest fingerprint cannot encode symbol keys.');
            }
            const indexedKeys = new Set(
                Array.from({ length: value.length }, (_, index) => String(index)),
            );
            if (Object.keys(value).some((key) => !indexedKeys.has(key))) {
                throw new Error(
                    'Execute manifest fingerprint cannot encode custom array properties.',
                );
            }
            const items = Array.from({ length: value.length }, (_, index) =>
                Object.prototype.hasOwnProperty.call(value, index)
                    ? frame(`present${frame(canonicalValue(value[index], ancestors))}`)
                    : frame('hole')
            ).join('');
            return `array${frame(String(value.length))}${frame(items)}`;
        }
        const prototype = Object.getPrototypeOf(value) as object | null;
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error('Execute manifest fingerprint requires plain JSON objects.');
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
            throw new Error('Execute manifest fingerprint cannot encode symbol keys.');
        }
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        const body = keys.map((key) =>
            frame(canonicalValue(key, ancestors)) +
            frame(canonicalValue(record[key], ancestors))
        ).join('');
        const objectKind = prototype === null ? 'null-object' : 'object';
        return `${objectKind}${frame(String(keys.length))}${frame(body)}`;
    } finally {
        ancestors.delete(value);
    }
}

function numberValue(value: number): string {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Number.POSITIVE_INFINITY) return '+Infinity';
    if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
    if (Object.is(value, -0)) return '-0';
    return String(value);
}

function frame(value: string): string {
    return `${value.length}:${value}`;
}

function idSegment(value: string, fallback: string): string {
    return value.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || fallback;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort();
}

function sameGroup(
    left: RallarBlackBoxDistributedGroupRef,
    right: RallarBlackBoxDistributedGroupRef,
): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length &&
        left.every((value, index) => value === right[index]);
}
