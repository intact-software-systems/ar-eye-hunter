import {
    compareDistributedRuns,
    type DistributedRunCompareSummary,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import {
    compareDistributedRunTuningPerformance,
    type DistributedRunTuningPerformanceComparison,
} from '@shared-test/rallar-bb-test/distributed-run-tuning-decisions.ts';
import type { ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { AnalyzeArtifactModel } from '../analyze/analyze-artifact-model.ts';
import type { AnalyzeTuneArtifactFacade } from
    '../analyze/analyze-worker-contract.ts';
import type { ControlQuerySnapshot } from '../control/control-query.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import {
    buildTuneRunCatalog,
    type TuneRunCatalog,
    type TuneQuarantineCode,
    type TuneQuarantinedRun,
    type TuneRunOption,
} from './tune-run-catalog.ts';

export type TuneComparisonIssue = Readonly<{
    field: 'compareLeft' | 'compareRight';
    code: 'missing' | 'unavailable' | 'unsafe' | 'same-run'
        | 'invalid-manifest' | 'ambiguous-run' | 'identity-conflict'
        | 'missing-control' | 'ambiguous-control';
    message: string;
    value?: string;
}>;

export type TuneCompatibilityWarning = Readonly<{
    code: 'group-mismatch' | 'no-shared-recipe';
    message: string;
}>;

export type TuneSelectionModel = Readonly<{
    options: readonly TuneRunOption[];
    quarantined: readonly TuneQuarantinedRun[];
    focusRunId?: string;
    focus?: TuneRunOption;
    left?: TuneRunOption;
    right?: TuneRunOption;
    comparison: Readonly<{
        state: 'incomplete' | 'invalid' | 'same-run' | 'ready';
        issues: readonly TuneComparisonIssue[];
        compatibilityWarnings: readonly TuneCompatibilityWarning[];
        structural?: DistributedRunCompareSummary;
        performance?: DistributedRunTuningPerformanceComparison;
    }>;
}>;

export function deriveTuneSelectionModel(input: Readonly<{
    urlState: RecipeConsoleUrlState;
    query: ControlQuerySnapshot<ControlServerSnapshot>;
    retainedArtifact?: AnalyzeArtifactModel;
    retainedArtifactStatus?: 'idle' | 'pending' | 'ready' | 'error';
    retainedFacade?: AnalyzeTuneArtifactFacade;
    catalog?: TuneRunCatalog;
}>): TuneSelectionModel {
    const focusRunId = input.urlState.compareRight ?? input.urlState.distributedRunId;
    const catalog = input.catalog ?? buildTuneRunCatalog({
        distributedRuns: input.query.snapshot?.distributedRuns ?? [],
        controlRuns: input.query.snapshot?.runs ?? [],
        retainedArtifact: input.retainedArtifact,
        retainedArtifactStatus: input.retainedArtifactStatus,
        retainedArtifactFocusRunId: focusRunId,
        retainedFacade: input.retainedFacade,
    });
    const issues: TuneComparisonIssue[] = [];
    const left = resolveSelection(
        'compareLeft', input.urlState.compareLeft, catalog.options,
        catalog.quarantined, issues,
    );
    const right = resolveSelection(
        'compareRight', input.urlState.compareRight, catalog.options,
        catalog.quarantined, issues,
    );
    const focus = focusRunId
        ? catalog.options.find(option => option.distributedRunId === focusRunId)
        : undefined;
    const comparison = comparisonModel(input.urlState, left, right, issues);
    return {
        options: catalog.options,
        quarantined: catalog.quarantined,
        focusRunId,
        focus,
        left,
        right,
        comparison,
    };
}

function resolveSelection(
    field: TuneComparisonIssue['field'],
    value: string | undefined,
    options: readonly TuneRunOption[],
    quarantined: readonly TuneQuarantinedRun[],
    issues: TuneComparisonIssue[],
): TuneRunOption | undefined {
    if (!value) {
        issues.push({
            field, code: 'missing',
            message: `${field} must be selected explicitly.`,
        });
        return undefined;
    }
    const option = options.find(candidate => candidate.distributedRunId === value);
    if (option) return option;
    const quarantinedRun = quarantined.find(candidate =>
        candidate.distributedRunId === value
    );
    const quarantineCode = comparisonQuarantineCode(quarantinedRun?.codes);
    issues.push({
        field,
        code: quarantineCode ?? 'unavailable',
        value,
        message: quarantinedRun
            ? quarantineMessage(field, quarantineCode ?? 'unsafe')
            : `${field} is not available in retained artifact or control evidence.`,
    });
    return undefined;
}

function comparisonModel(
    state: RecipeConsoleUrlState,
    left: TuneRunOption | undefined,
    right: TuneRunOption | undefined,
    issues: readonly TuneComparisonIssue[],
): TuneSelectionModel['comparison'] {
    if (!left || !right) {
        const invalid = issues.some(issue => issue.code !== 'missing');
        return {
            state: invalid ? 'invalid' : 'incomplete',
            issues,
            compatibilityWarnings: [],
        };
    }
    if (left.distributedRunId === right.distributedRunId) {
        return {
            state: 'same-run',
            issues: [...issues, {
                field: 'compareRight', code: 'same-run',
                value: right.distributedRunId,
                message: 'Baseline and candidate must be different runs.',
            }],
            compatibilityWarnings: [],
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
                : `${field} has no paired control-run evidence.`,
        }));
    if (unpaired.length > 0) {
        return {
            state: 'invalid',
            issues: [...issues, ...unpaired],
            compatibilityWarnings: compatibilityWarnings(left, right),
        };
    }
    return {
        state: 'ready',
        issues,
        compatibilityWarnings: compatibilityWarnings(left, right),
        structural: compareDistributedRuns({
            left: left.distributedRun,
            right: right.distributedRun,
            leftControlRun: left.controlRun,
            rightControlRun: right.controlRun,
        }),
        performance: compareDistributedRunTuningPerformance({
            timingMetric: state.timingMetric ?? 'command-duration',
            left: left.performance,
            right: right.performance,
        }),
    };
}

function comparisonQuarantineCode(
    codes: readonly TuneQuarantineCode[] | undefined,
): Extract<TuneComparisonIssue['code'],
    'invalid-manifest' | 'ambiguous-run' | 'identity-conflict' | 'unsafe'> | undefined {
    if (!codes) return undefined;
    if (codes.includes('invalid-manifest')) return 'invalid-manifest';
    if (codes.includes('ambiguous-run')) return 'ambiguous-run';
    if (codes.includes('identity-conflict')) return 'identity-conflict';
    return 'unsafe';
}

function quarantineMessage(
    field: TuneComparisonIssue['field'],
    code: ReturnType<typeof comparisonQuarantineCode> & string,
): string {
    if (code === 'invalid-manifest') return `${field} has an invalid run manifest.`;
    if (code === 'ambiguous-run') return `${field} has an ambiguous distributed-run identity.`;
    if (code === 'identity-conflict') return `${field} has conflicting run identities.`;
    return `${field} is quarantined because its run identity is unsafe.`;
}

function compatibilityWarnings(
    left: TuneRunOption,
    right: TuneRunOption,
): TuneCompatibilityWarning[] {
    const warnings: TuneCompatibilityWarning[] = [];
    if (groupKey(left) !== groupKey(right)) {
        warnings.push({
            code: 'group-mismatch',
            message: 'The selected runs target different application/workspace/group scopes.',
        });
    }
    const leftRecipes = new Set(recipeIds(left));
    const recipeIdentitiesComplete = left.recipeIdentityComplete !== false &&
        right.recipeIdentityComplete !== false;
    if (
        recipeIdentitiesComplete &&
        !recipeIds(right).some(recipeId => leftRecipes.has(recipeId))
    ) {
        warnings.push({
            code: 'no-shared-recipe',
            message: 'The selected runs have no shared recipe identity.',
        });
    }
    return warnings;
}

function groupKey(option: TuneRunOption): string {
    const group = option.distributedRun.manifest.group;
    return `${group.applicationId}\u0000${group.workspaceId}\u0000${group.groupId}`;
}

function recipeIds(option: TuneRunOption): string[] {
    return option.distributedRun.manifest.recipes
        .map(selection => selection.recipe?.recipeId ?? selection.recipeId)
        .filter((value): value is string => Boolean(value));
}
