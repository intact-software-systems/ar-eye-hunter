import {
    compareDistributedRuns,
    type DistributedRunCompareSummary
} from '@shared-test/rallar-bb-test/distributed-run-history/compare-distributed-runs.ts';
import {
    compareDistributedRunTuningPerformance,
    type DistributedRunTuningPerformanceComparison
} from '@shared-test/rallar-bb-test/distributed-run-tuning-decisions.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { validateTuneCatalogSelections } from './tune-catalog-selection-validation.ts';
import { tunePerformanceRunIds } from './tune-performance-run-ids.ts';
import type {
    TuneQuarantineCode,
    TuneQuarantinedRun,
    TuneRunCatalog,
    TuneRunOption
} from './tune-run-catalog.ts';

export type TuneComparisonIssue = Readonly<{
    field: 'compareLeft' | 'compareRight';
    code:
        | 'missing'
        | 'unavailable'
        | 'unsafe'
        | 'same-run'
        | 'invalid-manifest'
        | 'ambiguous-run'
        | 'identity-conflict'
        | 'missing-control'
        | 'ambiguous-control';
    message: string;
    /** Absent when the issue is a missing selection, so there is no rejected run ID to show. */
    value?: string;
}>;

export type TuneCompatibilityWarning = Readonly<{
    code: 'group-mismatch' | 'no-shared-recipe';
    message: string;
}>;

export type TuneSelectionModel = Readonly<{
    options: readonly TuneRunOption[];
    optionsByDistributedRunId: ReadonlyMap<string, TuneRunOption>;
    quarantined: readonly TuneQuarantinedRun[];
    /** Absent until the URL selects a candidate or distributed run to focus. */
    focusRunId?: string;
    /** Absent when the focused run ID matches no catalog option. */
    focus?: TuneRunOption;
    /** Absent until compareLeft selects an available baseline run. */
    left?: TuneRunOption;
    /** Absent until compareRight selects an available candidate run. */
    right?: TuneRunOption;
    comparison: Readonly<{
        state: 'incomplete' | 'invalid' | 'same-run' | 'ready';
        issues: readonly TuneComparisonIssue[];
        compatibilityWarnings: readonly TuneCompatibilityWarning[];
        /** Absent unless the comparison is ready, which is the only state that compares run structure. */
        structural?: DistributedRunCompareSummary;
        /** Absent unless the comparison is ready, which is the only state that compares performance. */
        performance?: DistributedRunTuningPerformanceComparison;
    }>;
}>;

export function computeTuneSelectionModel(
    input: Readonly<{
        urlState: RecipeConsoleUrlState;
        catalog: TuneRunCatalog;
    }>
): TuneSelectionModel {
    const focusRunId = input.urlState.compareRight ?? input.urlState.distributedRunId;
    const catalog = validateTuneCatalogSelections(
        input.catalog,
        tunePerformanceRunIds(input.urlState)
    );
    const issues: TuneComparisonIssue[] = [];
    const left = resolveSelection({
        field: 'compareLeft',
        distributedRunId: input.urlState.compareLeft,
        catalog,
        issues
    });
    const right = resolveSelection({
        field: 'compareRight',
        distributedRunId: input.urlState.compareRight,
        catalog,
        issues
    });
    const focus = focusRunId
        ? catalog.optionsByDistributedRunId.get(focusRunId)
        : undefined;
    const comparison = computeTuneComparison({
        urlState: input.urlState,
        left,
        right,
        issues
    });
    return {
        options: catalog.options,
        optionsByDistributedRunId: catalog.optionsByDistributedRunId,
        quarantined: catalog.quarantined,
        focusRunId,
        focus,
        left,
        right,
        comparison
    };
}

function resolveSelection(
    input: Readonly<{
        field: TuneComparisonIssue['field'];
        /** Absent while the URL selects no run for this side of the comparison. */
        distributedRunId?: string;
        catalog: TuneRunCatalog;
        issues: TuneComparisonIssue[];
    }>
): TuneRunOption | undefined {
    const field = input.field;
    const distributedRunId = input.distributedRunId;
    if (!distributedRunId) {
        input.issues.push({
            field,
            code: 'missing',
            message: `${field} must be selected explicitly.`
        });
        return undefined;
    }
    const option = input.catalog.optionsByDistributedRunId.get(distributedRunId);
    if (option) {
        return option;
    }
    const quarantinedRun = input.catalog.quarantined.find((candidate) =>
        candidate.distributedRunId === distributedRunId
    );
    const quarantineCode = resolveComparisonQuarantineCode(quarantinedRun?.codes);
    input.issues.push({
        field,
        code: quarantineCode ?? 'unavailable',
        value: distributedRunId,
        message: quarantinedRun
            ? toQuarantineMessage(field, quarantineCode ?? 'unsafe')
            : `${field} is not available in retained artifact or control evidence.`
    });
    return undefined;
}

function computeTuneComparison(
    input: Readonly<{
        urlState: RecipeConsoleUrlState;
        /** Absent when compareLeft selects no available baseline run. */
        left?: TuneRunOption;
        /** Absent when compareRight selects no available candidate run. */
        right?: TuneRunOption;
        issues: readonly TuneComparisonIssue[];
    }>
): TuneSelectionModel['comparison'] {
    const { left, right, issues } = input;
    if (!left || !right) {
        const invalid = issues.some((issue) => issue.code !== 'missing');
        return {
            state: invalid ? 'invalid' : 'incomplete',
            issues,
            compatibilityWarnings: []
        };
    }
    if (left.distributedRunId === right.distributedRunId) {
        return {
            state: 'same-run',
            issues: [...issues, {
                field: 'compareRight',
                code: 'same-run',
                value: right.distributedRunId,
                message: 'Baseline and candidate must be different runs.'
            }],
            compatibilityWarnings: []
        };
    }
    const unpaired = ([['compareLeft', left], ['compareRight', right]] as const)
        .filter((entry): entry is readonly [TuneComparisonIssue['field'], TuneRunOption] =>
            entry[1].pairStatus !== 'paired'
        )
        .map(([field, option]): TuneComparisonIssue => ({
            field,
            code: option.pairStatus === 'ambiguous' ? 'ambiguous-control' : 'missing-control',
            value: option.distributedRunId,
            message: option.pairStatus === 'ambiguous'
                ? `${field} has an ambiguous control-run identity.`
                : `${field} has no paired control-run evidence.`
        }));
    if (unpaired.length > 0) {
        return {
            state: 'invalid',
            issues: [...issues, ...unpaired],
            compatibilityWarnings: computeCompatibilityWarnings(left, right)
        };
    }
    return {
        state: 'ready',
        issues,
        compatibilityWarnings: computeCompatibilityWarnings(left, right),
        structural: compareDistributedRuns({
            left: left.distributedRun,
            right: right.distributedRun,
            leftControlRun: left.controlRun,
            rightControlRun: right.controlRun
        }),
        performance: compareDistributedRunTuningPerformance({
            timingMetric: input.urlState.timingMetric ?? 'command-duration',
            left: left.performance,
            right: right.performance
        })
    };
}

function resolveComparisonQuarantineCode(
    codes: readonly TuneQuarantineCode[] | undefined
):
    | Extract<TuneComparisonIssue['code'], 'invalid-manifest' | 'ambiguous-run' | 'identity-conflict' | 'unsafe'>
    | undefined {
    if (!codes) {
        return undefined;
    }
    if (codes.includes('invalid-manifest')) {
        return 'invalid-manifest';
    }
    if (codes.includes('ambiguous-run')) {
        return 'ambiguous-run';
    }
    if (codes.includes('identity-conflict')) {
        return 'identity-conflict';
    }
    return 'unsafe';
}

function toQuarantineMessage(
    field: TuneComparisonIssue['field'],
    code: ReturnType<typeof resolveComparisonQuarantineCode> & string
): string {
    if (code === 'invalid-manifest') {
        return `${field} has an invalid run manifest.`;
    }
    if (code === 'ambiguous-run') {
        return `${field} has an ambiguous distributed-run identity.`;
    }
    if (code === 'identity-conflict') {
        return `${field} has conflicting run identities.`;
    }
    return `${field} is quarantined because its run identity is unsafe.`;
}

function computeCompatibilityWarnings(
    left: TuneRunOption,
    right: TuneRunOption
): TuneCompatibilityWarning[] {
    const warnings: TuneCompatibilityWarning[] = [];
    if (toGroupKey(left) !== toGroupKey(right)) {
        warnings.push({
            code: 'group-mismatch',
            message: 'The selected runs target different application/workspace/group scopes.'
        });
    }
    const leftRecipes = new Set(toRecipeIds(left));
    const recipeIdentitiesComplete = left.recipeIdentityComplete !== false &&
        right.recipeIdentityComplete !== false;
    if (
        recipeIdentitiesComplete &&
        !toRecipeIds(right).some((recipeId) => leftRecipes.has(recipeId))
    ) {
        warnings.push({
            code: 'no-shared-recipe',
            message: 'The selected runs have no shared recipe identity.'
        });
    }
    return warnings;
}

function toGroupKey(option: TuneRunOption): string {
    const group = option.distributedRun.manifest.group;
    return `${group.applicationId}\u0000${group.workspaceId}\u0000${group.groupId}`;
}

function toRecipeIds(option: TuneRunOption): string[] {
    return option.distributedRun.manifest.recipes
        .map((selection) => selection.recipe?.recipeId ?? selection.recipeId)
        .filter((value): value is string => Boolean(value));
}
