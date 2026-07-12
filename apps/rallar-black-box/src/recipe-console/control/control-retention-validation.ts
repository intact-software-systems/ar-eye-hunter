import {
    CONTROL_RETENTION_PLAN_LIMITS,
    type ControlRetentionCandidate,
} from '@shared-test/rallar-bb-test/control-retention.ts';
import { RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { assertControlRetentionResponseBudget } from './control-retention-validation-budget.ts';

declare const controlRetentionPreviewBrand: unique symbol;
export type ControlRetentionPreview = Readonly<{
    deletedRunIds: readonly string[];
    retainedRuns: number;
    maxRuns: number;
    dryRun: true;
    wouldDeleteRuns: readonly ControlRetentionCandidate[];
    wouldDeleteRunIds: readonly string[];
    wouldDeleteDistributedRunIds: readonly string[];
    wouldDeleteFleetReportIds: readonly string[];
    projectedRetainedRuns: number;
    preserves: Readonly<{
        connectedAgentSockets: true;
        storedArtifactFiles: true;
    }>;
    planToken: string;
    readonly [controlRetentionPreviewBrand]: true;
}>;
export type ControlRetentionConfirmation = Readonly<{
    deletedRunIds: readonly string[];
    retainedRuns: number;
    maxRuns: number;
}>;

const PREVIEW_FIELDS = ['deletedRunIds', 'retainedRuns', 'maxRuns', 'dryRun', 'wouldDeleteRuns', 'wouldDeleteRunIds', 'wouldDeleteDistributedRunIds', 'wouldDeleteFleetReportIds', 'projectedRetainedRuns', 'preserves', 'planToken'] as const;
const CANDIDATE_FIELDS = ['runId', 'createdAtEpochMs', 'updatedAtEpochMs', 'connectedAgentCount', 'issuedRunTokenCount', 'distributedRuns', 'fleetReportIds'] as const;
const DISTRIBUTED_FIELDS = ['distributedRunId', 'state'] as const;
const PRESERVATION_FIELDS = ['connectedAgentSockets', 'storedArtifactFiles'] as const;
const CONFIRMATION_FIELDS = ['deletedRunIds', 'retainedRuns', 'maxRuns'] as const;
const PLAN_TOKEN_MAX_CHARACTERS = 512;

export function parseControlRetentionPreview(value: unknown): ControlRetentionPreview {
    assertControlRetentionResponseBudget(value);
    const root = exactRecord(value, 'preview', PREVIEW_FIELDS);
    const deletedRunIds = stringArray(root.deletedRunIds, 'preview.deletedRunIds');
    if (deletedRunIds.length !== 0) fail('preview.deletedRunIds must be empty');
    const retainedRuns = count(root.retainedRuns, 'preview.retainedRuns');
    const maxRuns = count(root.maxRuns, 'preview.maxRuns');
    if (root.dryRun !== true) fail('preview.dryRun must be true');
    const wouldDeleteRuns = candidateArray(root.wouldDeleteRuns);
    const wouldDeleteRunIds = stringArray(
        root.wouldDeleteRunIds,
        'preview.wouldDeleteRunIds',
        CONTROL_RETENTION_PLAN_LIMITS.candidates,
    );
    const distributedIds = stringArray(
        root.wouldDeleteDistributedRunIds,
        'preview.wouldDeleteDistributedRunIds',
    );
    const fleetIds = stringArray(
        root.wouldDeleteFleetReportIds,
        'preview.wouldDeleteFleetReportIds',
    );
    const projected = count(
        root.projectedRetainedRuns,
        'preview.projectedRetainedRuns',
    );
    const preserves = exactRecord(root.preserves, 'preview.preserves', PRESERVATION_FIELDS);
    if (
        preserves.connectedAgentSockets !== true ||
        preserves.storedArtifactFiles !== true
    ) {
        fail('preview preservation markers must be true');
    }
    const planToken = token(root.planToken);
    assertUnique(wouldDeleteRunIds, 'preview.wouldDeleteRunIds');
    assertUnique(distributedIds, 'preview.wouldDeleteDistributedRunIds');
    assertUnique(fleetIds, 'preview.wouldDeleteFleetReportIds');
    assertEqual(wouldDeleteRuns.map(candidate => candidate.runId), wouldDeleteRunIds, 'preview candidate run order');
    validateLinkedConsequences(wouldDeleteRuns, distributedIds, fleetIds);
    const expectedProjected = maxRuns === 0 ? retainedRuns : Math.min(retainedRuns, maxRuns);
    if (projected !== expectedProjected) {
        fail('preview projected retained count does not match its cap');
    }
    if (wouldDeleteRuns.length !== retainedRuns - projected) {
        fail('preview candidate count does not match its projection');
    }
    return Object.freeze({
        deletedRunIds,
        retainedRuns,
        maxRuns,
        dryRun: true,
        wouldDeleteRuns,
        wouldDeleteRunIds,
        wouldDeleteDistributedRunIds: distributedIds,
        wouldDeleteFleetReportIds: fleetIds,
        projectedRetainedRuns: projected,
        preserves: Object.freeze({
            connectedAgentSockets: true,
            storedArtifactFiles: true,
        }),
        planToken,
    }) as ControlRetentionPreview;
}

export function parseControlRetentionConfirmation(value: unknown, preview: ControlRetentionPreview): ControlRetentionConfirmation {
    assertControlRetentionResponseBudget(value);
    const root = exactRecord(value, 'confirmation', CONFIRMATION_FIELDS);
    const deletedRunIds = stringArray(root.deletedRunIds, 'confirmation.deletedRunIds', CONTROL_RETENTION_PLAN_LIMITS.candidates);
    assertUnique(deletedRunIds, 'confirmation.deletedRunIds');
    const retainedRuns = count(root.retainedRuns, 'confirmation.retainedRuns');
    const maxRuns = count(root.maxRuns, 'confirmation.maxRuns');
    assertEqual(
        deletedRunIds,
        preview.wouldDeleteRunIds,
        'confirmation deleted run order',
    );
    if (
        retainedRuns !== preview.projectedRetainedRuns ||
        maxRuns !== preview.maxRuns
    ) {
        fail('confirmation counts do not match the preview');
    }
    return Object.freeze({ deletedRunIds, retainedRuns, maxRuns });
}

function candidateArray(value: unknown): readonly ControlRetentionCandidate[] {
    const values = exactArray(
        value,
        'preview.wouldDeleteRuns',
        CONTROL_RETENTION_PLAN_LIMITS.candidates,
    );
    const candidates = values.map((item, index) => {
        const path = `preview.wouldDeleteRuns[${index}]`;
        const record = exactRecord(item, path, CANDIDATE_FIELDS);
        const distributedValues = exactArray(
            record.distributedRuns,
            `${path}.distributedRuns`,
        );
        const distributedRuns = Object.freeze(distributedValues.map((run, runIndex) => {
            const runPath = `${path}.distributedRuns[${runIndex}]`;
            const linked = exactRecord(run, runPath, DISTRIBUTED_FIELDS);
            const distributedRunId = identity(linked.distributedRunId, `${runPath}.distributedRunId`);
            if (!(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES as readonly unknown[]).includes(linked.state)) {
                fail(`${runPath}.state must be a known distributed-run state`);
            }
            return Object.freeze({
                distributedRunId,
                state: linked.state,
            }) as ControlRetentionCandidate['distributedRuns'][number];
        }));
        const fleetReportIds = stringArray(
            record.fleetReportIds,
            `${path}.fleetReportIds`,
        );
        const runId = identity(record.runId, `${path}.runId`);
        const candidate = Object.freeze({
            runId,
            createdAtEpochMs: count(record.createdAtEpochMs, `${path}.createdAtEpochMs`),
            updatedAtEpochMs: count(record.updatedAtEpochMs, `${path}.updatedAtEpochMs`),
            connectedAgentCount: count(record.connectedAgentCount, `${path}.connectedAgentCount`),
            issuedRunTokenCount: count(record.issuedRunTokenCount, `${path}.issuedRunTokenCount`),
            distributedRuns,
            fleetReportIds,
        }) satisfies ControlRetentionCandidate;
        assertUnique(
            distributedRuns.map(run => run.distributedRunId),
            `${path}.distributedRuns`,
        );
        assertUnique(fleetReportIds, `${path}.fleetReportIds`);
        return candidate;
    });
    return Object.freeze(candidates);
}

function validateLinkedConsequences(
    candidates: readonly ControlRetentionCandidate[],
    distributedIds: readonly string[],
    fleetIds: readonly string[],
): void {
    const ownerByDistributedId = new Map<string, string>();
    const expectedDistributedByOwner = new Map<string, readonly string[]>();
    const candidateFleetIds: string[] = [];
    for (const candidate of candidates) {
        const candidateDistributedIds = candidate.distributedRuns.map(run => run.distributedRunId);
        const candidateFleetSet = new Set(candidate.fleetReportIds);
        for (const id of candidateDistributedIds) {
            if (ownerByDistributedId.has(id)) fail(`duplicate distributed run ${id}`);
            ownerByDistributedId.set(id, candidate.runId);
        }
        expectedDistributedByOwner.set(candidate.runId, candidateDistributedIds);
        assertEqual(
            candidateDistributedIds.filter(id => candidateFleetSet.has(id)),
            candidate.fleetReportIds,
            `candidate ${candidate.runId} fleet order`,
        );
        for (const id of candidate.fleetReportIds) candidateFleetIds.push(id);
    }
    assertEqualSets(candidateFleetIds, fleetIds, 'fleet consequence union');
    const fleetSet = new Set(fleetIds);
    const actualDistributedByOwner = new Map<string, string[]>();
    const orderedFleetIds: string[] = [];
    for (const id of distributedIds) {
        const owner = ownerByDistributedId.get(id);
        if (!owner) fail(`unknown distributed consequence ${id}`);
        const owned = actualDistributedByOwner.get(owner) ?? [];
        owned.push(id);
        actualDistributedByOwner.set(owner, owned);
        if (fleetSet.has(id)) orderedFleetIds.push(id);
    }
    if (ownerByDistributedId.size !== distributedIds.length) {
        fail('distributed consequence union does not match');
    }
    for (const [owner, expected] of expectedDistributedByOwner) {
        assertEqual(actualDistributedByOwner.get(owner) ?? [], expected, `candidate ${owner} distributed order`);
    }
    assertEqual(orderedFleetIds, fleetIds, 'global fleet order');
}

function exactRecord(
    value: unknown,
    path: string,
    fields: readonly string[],
): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain object`);
    if (Object.getOwnPropertySymbols(value).length > 0) fail(`${path} has unknown fields`);
    const names = Object.getOwnPropertyNames(value).sort();
    if (names.join('\0') !== [...fields].sort().join('\0')) fail(`${path} has invalid fields`);
    const normalized: Record<string, unknown> = {};
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
            fail(`${path}.${field} must be an enumerable data field`);
        }
        normalized[field] = descriptor.value;
    }
    return normalized;
}

function exactArray(
    value: unknown,
    path: string,
    maximum: number = CONTROL_RETENTION_PLAN_LIMITS.collectionItems,
): readonly unknown[] {
    if (!Array.isArray(value)) fail(`${path} must be an array`);
    if (value.length > maximum) fail(`${path} exceeds its ${maximum} item bound`);
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
        fail(`${path} must be a plain array`);
    }
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== value.length + 1) fail(`${path} must be a dense data array`);
    const normalized: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
            fail(`${path}[${index}] must be a data item`);
        }
        normalized.push(descriptor.value);
    }
    return normalized;
}
function stringArray(value: unknown, path: string, maximum?: number): readonly string[] {
    const values = exactArray(value, path, maximum);
    return Object.freeze(values.map((item, index) => identity(item, `${path}[${index}]`)));
}
function identity(value: unknown, path: string): string {
    if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`);
    if (value.length > CONTROL_RETENTION_PLAN_LIMITS.stringCharacters) fail(`${path} is too long`);
    return value;
}
function token(value: unknown): string {
    const planToken = identity(value, 'preview.planToken');
    if (
        planToken.length > PLAN_TOKEN_MAX_CHARACTERS ||
        planToken.trim() !== planToken ||
        /[\u0000-\u001f\u007f]/u.test(planToken)
    ) fail('preview.planToken is malformed');
    return planToken;
}
function count(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail(`${path} must be a non-negative safe integer`);
    }
    return value;
}
function assertUnique(values: readonly string[], path: string): void {
    if (new Set(values).size !== values.length) fail(`${path} must contain unique values`);
}
function assertEqual(left: readonly string[], right: readonly string[], path: string): void {
    if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
        fail(`${path} does not match`);
    }
}
function assertEqualSets(left: readonly string[], right: readonly string[], path: string): void {
    assertUnique(left, path);
    const rightSet = new Set(right);
    if (left.length !== right.length || left.some(value => !rightSet.has(value))) fail(`${path} does not match`);
}
function fail(message: string): never {
    throw new Error(`Control retention ${message}.`);
}
