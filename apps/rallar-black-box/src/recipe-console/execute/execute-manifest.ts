import type {
    DistributedRecipeCatalogEntryProjection
} from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import { createDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-recipe-targeting/create-distributed-run-manifest.ts';
import {
    validateDistributedRunManifest,
    type DistributedRunManifestValidationIssue
} from '@shared-test/rallar-bb-test/distributed-run-validation.ts';
import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';

export const EXECUTE_ACK_TIMEOUT_MS = 15_000;

export type ExecuteManifestDraft = Readonly<{
    manifest: RallarBlackBoxDistributedRunManifest;
    validationIssues: readonly DistributedRunManifestValidationIssue[];
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
    /** Absent when the issue is about the whole resolution rather than one named agent. */
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

export function createExecuteDistributedRunId(
    input: Readonly<{
        controlRunId: string;
        group: RallarBlackBoxDistributedGroupRef;
        recipeId: string;
        requestedAtEpochMs: number;
    }>
): Either<string, string> {
    if (
        !Number.isSafeInteger(input.requestedAtEpochMs) ||
        input.requestedAtEpochMs < 0
    ) {
        return Either.ofLeft('Execute requestedAtEpochMs must be a non-negative safe integer.');
    }
    return Either.ofRight([
        'dist',
        toIdSegment(input.group.groupId, 'group'),
        toIdSegment(input.recipeId, 'recipe'),
        toIdSegment(input.controlRunId, 'control'),
        String(input.requestedAtEpochMs)
    ].join('-'));
}

export function createExecuteManifestDraft(
    input: Readonly<{
        distributedRunId: string;
        controlRunId: string;
        group: RallarBlackBoxDistributedGroupRef;
        selectedRecipe: DistributedRecipeCatalogEntryProjection;
        selectedAgentIds: readonly string[];
    }>
): Either<string, ExecuteManifestDraft> {
    const selectedAgentIds = toSortedUniqueIds(input.selectedAgentIds);
    return toExecuteManifestDraft(createDistributedRunManifest({
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        displayName: input.selectedRecipe.item.title,
        group: input.group,
        recipes: [input.selectedRecipe.item],
        targetAgentIds: selectedAgentIds,
        targetPolicyMode: 'selected-agents',
        rolePattern: 'all-agents',
        ackTimeoutMs: EXECUTE_ACK_TIMEOUT_MS,
        barrier: { enabled: false },
        startMode: 'manual',
        expectedParticipantCount: selectedAgentIds.length,
        groupAssertions: [],
        createdBy: 'rallar-black-box-spa'
    }));
}

export function toExecuteManifestDraft(
    manifest: RallarBlackBoxDistributedRunManifest
): Either<string, ExecuteManifestDraft> {
    return computeExecuteManifestFingerprint(manifest).mapRight((fingerprint) => ({
        manifest,
        validationIssues: validateDistributedRunManifest(manifest),
        rawJson: JSON.stringify(manifest, null, 2),
        fingerprint
    }));
}

export function computeExecuteManifestFingerprint(
    manifest: RallarBlackBoxDistributedRunManifest
): Either<string, string> {
    return decodeCanonicalValueText(manifest, new Set<object>());
}

export function computeExecuteTargetResolutionComparison(
    input: Readonly<{
        manifest: RallarBlackBoxDistributedRunManifest;
        resolution: RallarBlackBoxDistributedTargetResolution;
    }>
): ExecuteTargetResolutionComparison {
    const issues: ExecuteTargetResolutionIssue[] = [];
    const selected = input.manifest.targetPolicy.mode === 'selected-agents'
        ? [...input.manifest.targetPolicy.agentIds]
        : [];
    const resolved = [...input.resolution.targetAgentIds];
    const selectedSet = new Set(selected);

    if (!isSameGroup(input.manifest.group, input.resolution.group)) {
        issues.push({
            code: 'group-mismatch',
            message: 'Resolved targets belong to a different application, workspace, or group.'
        });
    }
    if (input.manifest.targetPolicy.mode !== input.resolution.targetPolicyMode) {
        issues.push({
            code: 'policy-mismatch',
            message: 'Resolved target policy no longer matches the manifest.'
        });
    }
    if (selectedSet.size !== selected.length) {
        issues.push({
            code: 'duplicate-selected-target',
            message: 'The manifest contains a duplicate selected agent ID.'
        });
    }
    if (new Set(resolved).size !== resolved.length) {
        issues.push({
            code: 'duplicate-resolved-target',
            message: 'The server resolution contains a duplicate target agent ID.'
        });
    }
    if (!isSameIdList(toSortedUniqueIds(selected), toSortedUniqueIds(resolved))) {
        issues.push({
            code: 'target-mismatch',
            message: 'Server-resolved target IDs no longer exactly match the selected safe IDs.'
        });
    }
    issues.push(...computeExecuteResolutionCountIssues(input, selectedSet, resolved));
    for (const blocker of input.resolution.blockers) {
        if (!selectedSet.has(blocker.agentId)) {
            continue;
        }
        issues.push({
            code: 'selected-target-blocked',
            message: blocker.reason,
            agentId: blocker.agentId
        });
    }

    return { ok: issues.length === 0, issues };
}

export function createExecuteTargetResolutionEvidence(
    input: Readonly<{
        manifest: RallarBlackBoxDistributedRunManifest;
        manifestFingerprint: string;
        resolution: RallarBlackBoxDistributedTargetResolution;
    }>
): ExecuteTargetResolutionEvidence {
    return {
        manifestFingerprint: input.manifestFingerprint,
        resolution: input.resolution,
        comparison: computeExecuteTargetResolutionComparison({
            manifest: input.manifest,
            resolution: input.resolution
        })
    };
}

export function resolveExecuteTargetResolutionEvidence(
    input: Readonly<{
        manifestFingerprint: string;
        evidence: ExecuteTargetResolutionEvidence;
    }>
): ExecuteTargetResolutionEvidence | undefined {
    return input.evidence.manifestFingerprint === input.manifestFingerprint
        ? input.evidence
        : undefined;
}

function computeExecuteResolutionCountIssues(
    input: Readonly<{
        manifest: RallarBlackBoxDistributedRunManifest;
        resolution: RallarBlackBoxDistributedTargetResolution;
    }>,
    selected: ReadonlySet<string>,
    resolved: readonly string[]
): readonly ExecuteTargetResolutionIssue[] {
    const issues: ExecuteTargetResolutionIssue[] = [];
    const expected = input.manifest.targetPolicy.expectedParticipantCount;
    if (
        expected !== selected.size ||
        input.resolution.summary.expectedParticipantCount !== expected
    ) {
        issues.push({
            code: 'expected-count-mismatch',
            message: 'Resolved expected participant count no longer matches the exact selection.'
        });
    }
    if (input.resolution.summary.selected !== resolved.length) {
        issues.push({
            code: 'selected-count-mismatch',
            message: 'Resolved selected count does not match the returned target IDs.'
        });
    }
    if (input.resolution.summary.missingExpectedParticipants !== 0) {
        issues.push({
            code: 'missing-participants',
            message: 'The server reports missing expected participants.'
        });
    }
    return issues;
}

function decodeCanonicalValueText(
    value: unknown,
    ancestors: Set<object>
): Either<string, string> {
    if (value === null) {
        return Either.ofRight('null');
    }
    if (value === undefined) {
        return Either.ofRight('undefined');
    }
    if (typeof value === 'string') {
        return Either.ofRight(`string${toFramedText(value)}`);
    }
    if (typeof value === 'boolean') {
        return Either.ofRight(value ? 'boolean1' : 'boolean0');
    }
    if (typeof value === 'number') {
        return Either.ofRight(`number${toNumberText(value)}`);
    }
    if (typeof value === 'bigint') {
        return Either.ofRight(`bigint${value.toString()}`);
    }
    if (typeof value !== 'object') {
        return Either.ofLeft(`Execute manifest fingerprint cannot encode ${typeof value}.`);
    }
    if (ancestors.has(value)) {
        return Either.ofLeft('Execute manifest fingerprint cannot encode cyclic values.');
    }
    ancestors.add(value);
    try {
        return Array.isArray(value)
            ? decodeCanonicalArrayText(value, ancestors)
            : decodeCanonicalObjectText(value, ancestors);
    }
    finally {
        ancestors.delete(value);
    }
}

function decodeCanonicalArrayText(
    value: readonly ApiJsonValue[],
    ancestors: Set<object>
): Either<string, string> {
    if (Object.getOwnPropertySymbols(value).length > 0) {
        return Either.ofLeft('Execute manifest fingerprint cannot encode symbol keys.');
    }
    const indexedKeys = new Set(
        Array.from({ length: value.length }, (_, index) => String(index))
    );
    if (Object.keys(value).some((key) => !indexedKeys.has(key))) {
        return Either.ofLeft('Execute manifest fingerprint cannot encode custom array properties.');
    }
    let items = '';
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
            items += toFramedText('hole');
            continue;
        }
        const item = decodeCanonicalValueText(value[index], ancestors);
        if (item.right === undefined) {
            return item;
        }
        items += toFramedText(`present${toFramedText(item.right)}`);
    }
    return Either.ofRight(
        `array${toFramedText(String(value.length))}${toFramedText(items)}`
    );
}

function decodeCanonicalObjectText(
    value: object,
    ancestors: Set<object>
): Either<string, string> {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
        return Either.ofLeft('Execute manifest fingerprint requires plain JSON objects.');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        return Either.ofLeft('Execute manifest fingerprint cannot encode symbol keys.');
    }
    const record = value as Readonly<Record<string, ApiJsonValue>>;
    const keys = Object.keys(record).sort();
    let body = '';
    for (const key of keys) {
        const member = decodeCanonicalValueText(record[key], ancestors);
        if (member.right === undefined) {
            return member;
        }
        body += toFramedText(`string${toFramedText(key)}`) + toFramedText(member.right);
    }
    const objectKind = prototype === null ? 'null-object' : 'object';
    return Either.ofRight(
        `${objectKind}${toFramedText(String(keys.length))}${toFramedText(body)}`
    );
}

function toNumberText(value: number): string {
    if (Number.isNaN(value)) {
        return 'NaN';
    }
    if (value === Number.POSITIVE_INFINITY) {
        return '+Infinity';
    }
    if (value === Number.NEGATIVE_INFINITY) {
        return '-Infinity';
    }
    if (Object.is(value, -0)) {
        return '-0';
    }
    return String(value);
}

function toFramedText(value: string): string {
    return `${value.length}:${value}`;
}

function toIdSegment(value: string, emptySegment: string): string {
    return value.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || emptySegment;
}

function toSortedUniqueIds(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort();
}

function isSameGroup(
    left: RallarBlackBoxDistributedGroupRef,
    right: RallarBlackBoxDistributedGroupRef
): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId;
}

function isSameIdList(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length &&
        left.every((value, index) => value === right[index]);
}
