import type { ControlDistributedRunSnapshot } from '../control-snapshots.ts';
import type { DistributedFailureExplanation } from '../distributed-run-analysis/distributed-failure-explanation-contracts.ts';
import { toDistributedFailureExplanation } from '../distributed-run-analysis/to-distributed-failure-explanation.ts';
import { toDistributedRunRecordedFailures } from '../distributed-run-observation/distributed-run-failure-rows.ts';
import { isPayloadRecord } from '../distributed-run-observation/distributed-run-payload-summary.ts';
import type { RallarBlackBoxDistributedRunRecipeSelection } from '../distributed-run.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { toDistributedRunRecipeSelectionId } from './to-distributed-run-recipe-selection-id.ts';

export type DistributedRunHistoryLabels = Readonly<{
    displayName?: string;
    group: Readonly<{
        applicationId?: string;
        workspaceId?: string;
        groupId?: string;
        label: string;
    }>;
    recipes: readonly Readonly<{
        recipeId: string;
        profile?: string;
        role?: string;
        label: string;
    }>[];
    failures: readonly Readonly<{
        category: DistributedFailureExplanation['category'];
        code?: string;
        message: string;
        label: string;
    }>[];
}>;

export function projectDistributedRunHistoryLabels(
    run: ControlDistributedRunSnapshot
): DistributedRunHistoryLabels {
    const manifest = toDistributedRunHistoryManifest(run);
    const applicationId = toOptionalHistoryLabel(manifest.group.applicationId);
    const workspaceId = toOptionalHistoryLabel(manifest.group.workspaceId);
    const groupId = toOptionalHistoryLabel(manifest.group.groupId);
    const recipes = manifest.recipes.map(({ selection, index }) => {
        const recipeId = toDistributedRunRecipeSelectionId(selection, index);
        const profile = toOptionalHistoryLabel(selection.profile);
        const role = toOptionalHistoryLabel(selection.role);
        return {
            recipeId,
            profile,
            role,
            label: profile ? `${recipeId} · ${profile}` : recipeId
        };
    });
    const failures = toDistributedRunRecordedFailures(run).map((failure) => {
        const code = toOptionalHistoryLabel(failure.code);
        const message = toOptionalHistoryLabel(failure.message) ?? 'Recorded failure';
        const category = toDistributedFailureExplanation({
            ...failure,
            code,
            message
        }).category;
        return {
            category,
            code,
            message,
            label: code ? `${code}: ${message}` : message
        };
    });
    return {
        displayName: toOptionalHistoryLabel(manifest.record.displayName),
        group: {
            applicationId,
            workspaceId,
            groupId,
            label: [applicationId, workspaceId, groupId].filter(Boolean).join(' / ') ||
                'Unknown group'
        },
        recipes,
        failures
    };
}

export interface DistributedRunHistoryManifest {
    readonly record: Readonly<Record<string, unknown>>;
    readonly group: Readonly<Record<string, unknown>>;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly recipes: readonly Readonly<{
        selection: Partial<RallarBlackBoxDistributedRunRecipeSelection>;
        index: number;
    }>[];
}

export function toDistributedRunHistoryManifest(
    run: ControlDistributedRunSnapshot
): DistributedRunHistoryManifest {
    const record = decodeRecord(run.manifest);
    const recipes = Array.isArray(record.recipes)
        ? record.recipes.flatMap((selection, index) =>
            isPayloadRecord(selection)
                ? [{
                    selection: selection as Partial<RallarBlackBoxDistributedRunRecipeSelection>,
                    index
                }]
                : []
        )
        : [];
    return {
        record,
        group: decodeRecord(record.group),
        metadata: decodeRecord(record.metadata),
        recipes
    };
}

export function toHistoryManifestText(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

export function toOptionalHistoryLabel(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}
