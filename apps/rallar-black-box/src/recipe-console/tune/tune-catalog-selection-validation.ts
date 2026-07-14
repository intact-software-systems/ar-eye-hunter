import {
    distributedRunManifestContractIssues,
} from './tune-run-catalog-safety.ts';
import { deriveDistributedRunSnapshotPerformance } from
    '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import type {
    TuneQuarantinedRun,
    TuneRunCatalog,
    TuneRunOption,
} from './tune-run-catalog.ts';

type SelectionValidation =
    | Readonly<{
        kind: 'valid';
        option: TuneRunOption;
        performanceDerivationCount: 0 | 1;
    }>
    | Readonly<{
        kind: 'invalid';
        quarantine: Omit<TuneQuarantinedRun, 'key'>;
        performanceDerivationCount: 0;
    }>;

type SelectionValidationLookup = Readonly<{
    projection: SelectionValidation;
    reused: boolean;
}>;

const validations = new WeakMap<TuneRunCatalog, Map<string, SelectionValidation>>();

/** Revalidates deferred truth before a directly injected catalog reaches consumers. */
export function validateTuneCatalogSelections(
    catalog: TuneRunCatalog,
    selectedRunIds: readonly string[],
): TuneRunCatalog {
    const selected = [...new Set(selectedRunIds)].slice(0, 2);
    const projections = selected.flatMap(runId => {
        const option = catalog.optionsByDistributedRunId.get(runId);
        return option?.manifestValidation === 'selection-required'
            ? [selectionValidation(catalog, option)]
            : [];
    });
    if (projections.length === 0) return catalog;

    const optionsByDistributedRunId = new Map(catalog.optionsByDistributedRunId);
    const quarantined = new Map<string, Omit<TuneQuarantinedRun, 'key'>>();
    for (const row of catalog.quarantined) {
        quarantined.set(quarantineKey(row), withoutKey(row));
    }
    for (const { projection } of projections) {
        if (projection.kind === 'valid') {
            optionsByDistributedRunId.set(
                projection.option.distributedRunId,
                projection.option,
            );
        } else {
            optionsByDistributedRunId.delete(projection.quarantine.distributedRunId);
            quarantined.set(
                quarantineKey(projection.quarantine),
                projection.quarantine,
            );
        }
    }
    return {
        ...catalog,
        options: catalog.options.flatMap(option => {
            const validated = optionsByDistributedRunId.get(option.distributedRunId);
            return validated ? [validated] : [];
        }),
        optionsByDistributedRunId,
        quarantined: [...quarantined.values()]
            .sort((left, right) =>
                left.distributedRunId.localeCompare(right.distributedRunId) ||
                (left.controlRunId ?? '').localeCompare(right.controlRunId ?? '')
            )
            .map((row, index) => ({
                key: `tune-quarantined:${index}`,
                ...row,
            })),
        work: {
            ...catalog.work,
            selectionBoundaryManifestValidations:
                catalog.work.selectionBoundaryManifestValidations +
                projections.filter(row => !row.reused).length,
            selectionBoundaryPerformanceDerivations:
                catalog.work.selectionBoundaryPerformanceDerivations +
                projections.reduce(
                    (count, row) => count + (row.reused
                        ? 0
                        : row.projection.performanceDerivationCount),
                    0,
                ),
            selectionBoundaryProjectionReuses:
                catalog.work.selectionBoundaryProjectionReuses +
                projections.filter(row => row.reused).length,
        },
    };
}

function selectionValidation(
    catalog: TuneRunCatalog,
    option: TuneRunOption,
): SelectionValidationLookup {
    let byRun = validations.get(catalog);
    if (!byRun) {
        byRun = new Map();
        validations.set(catalog, byRun);
    }
    const cached = byRun.get(option.distributedRunId);
    if (cached) return { projection: cached, reused: true };
    const issues = distributedRunManifestContractIssues(option.distributedRun);
    let projection: SelectionValidation;
    if (issues.length === 0) {
        const controlRun = option.controlEvidence?.controlRun ?? option.controlRun;
        const derivesPerformance = catalog.includePerformanceEvidence &&
            option.performance === undefined &&
            option.pairStatus === 'paired' && controlRun !== undefined;
        const performance = derivesPerformance
            ? deriveDistributedRunSnapshotPerformance({
                distributedRun: option.distributedRun,
                controlRun,
            })
            : option.performance;
        projection = {
            kind: 'valid',
            option: {
                ...option,
                manifestValidation: 'validated',
                ...(performance === undefined ? {} : { performance }),
                ...(option.controlEvidence === undefined
                    ? {}
                    : {
                        controlEvidence: {
                            ...option.controlEvidence,
                            ...(performance === undefined ? {} : { performance }),
                        },
                    }),
            },
            performanceDerivationCount: derivesPerformance ? 1 : 0,
        };
    } else {
        projection = {
            kind: 'invalid',
            quarantine: {
                distributedRunId: option.distributedRunId,
                controlRunId: option.controlRunId,
                codes: ['invalid-manifest'],
                issues,
            },
            performanceDerivationCount: 0,
        };
    }
    byRun.set(option.distributedRunId, projection);
    return { projection, reused: false };
}

function quarantineKey(
    row: Pick<TuneQuarantinedRun, 'distributedRunId' | 'controlRunId'>,
): string {
    return JSON.stringify([row.distributedRunId, row.controlRunId ?? null]);
}

function withoutKey(row: TuneQuarantinedRun): Omit<TuneQuarantinedRun, 'key'> {
    const { key: _key, ...value } = row;
    return value;
}
