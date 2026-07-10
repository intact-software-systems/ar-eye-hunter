import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const appSourcePath = 'apps/rallar-black-box/src/App.tsx';
const recipeConsoleSourcePath = 'apps/rallar-black-box/src/recipe-console';
const extractedModulePaths = [
    'apps/rallar-black-box/src/legacy/shell/browser-ui-storage.ts',
    'apps/rallar-black-box/src/legacy/shell/navigation.ts',
    'apps/rallar-black-box/src/legacy/shell/global-context-model.ts',
    'apps/rallar-black-box/src/legacy/runner/runner-contracts.ts',
    'apps/rallar-black-box/src/legacy/rallar/load-browser-rallar-facade.ts',
] as const;
const extractedModuleImports = [
    './legacy/shell/browser-ui-storage.ts',
    './legacy/shell/navigation.ts',
    './legacy/shell/global-context-model.ts',
    './legacy/runner/runner-contracts.ts',
    './legacy/rallar/load-browser-rallar-facade.ts',
] as const;
const presentationModules = [
    {
        path: 'apps/rallar-black-box/src/legacy/shared/Metric.tsx',
        moduleImport: './legacy/shared/Metric.tsx',
        seams: ['Metric'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shared/FilterSelect.tsx',
        moduleImport: './legacy/shared/FilterSelect.tsx',
        seams: ['FilterSelect'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shared/CollapsiblePanelSection.tsx',
        moduleImport: './legacy/shared/CollapsiblePanelSection.tsx',
        seams: ['CollapsiblePanelSection'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shared/time-format.ts',
        moduleImport: './legacy/shared/time-format.ts',
        seams: [
            'formatTime',
            'formatDuration',
            'formatRelativeDuration',
        ],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shared/json-presentation.ts',
        moduleImport: './legacy/shared/json-presentation.ts',
        seams: ['json', 'parseJsonText', 'splitCsvValues'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shared/redaction-presentation.ts',
        moduleImport: './legacy/shared/redaction-presentation.ts',
        seams: ['uiSecretValues', 'uiRedactionOptions', 'redactedJson'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shared/command-presentation.ts',
        moduleImport: './legacy/shared/command-presentation.ts',
        seams: ['commandId', 'statusTone', 'resultSummary'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shared/schema/SchemaAuthoringPanel.tsx',
        moduleImport: './legacy/shared/schema/SchemaAuthoringPanel.tsx',
        seams: ['SchemaAuthoringPanel', 'SchemaCapabilitySummary'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shared/schema/CommandExamplePicker.tsx',
        moduleImport: './legacy/shared/schema/CommandExamplePicker.tsx',
        seams: ['CommandExamplePicker'],
    },
] as const;
const runAnalysisModules = [
    {
        path: 'apps/rallar-black-box/src/legacy/runner/runs/distributed-artifact-import.ts',
        moduleImport: './legacy/runner/runs/distributed-artifact-import.ts',
        seams: [
            'DISTRIBUTED_ARTIFACT_REQUIRED_FILES',
            'DistributedArtifactImportStatus',
            'distributedArtifactImportStatus',
        ],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/runner/runs/distributed-run-seed-url.ts',
        moduleImport: './legacy/runner/runs/distributed-run-seed-url.ts',
        seams: [
            'readDistributedRunSeedFromUrl',
            'writeDistributedRunSeedToUrl',
        ],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/runner/runs/DistributedRunAnalysisReportPanel.tsx',
        moduleImport:
            './legacy/runner/runs/DistributedRunAnalysisReportPanel.tsx',
        seams: ['DistributedRunAnalysisReportPanel'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/runner/runs/ImportedDistributedArtifactAnalysisPanel.tsx',
        moduleImport:
            './legacy/runner/runs/ImportedDistributedArtifactAnalysisPanel.tsx',
        seams: ['ImportedDistributedArtifactAnalysisPanel'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/runner/shared/performance-format.ts',
        moduleImport: './legacy/runner/shared/performance-format.ts',
        seams: ['formatPercent', 'formatFleetDuration'],
    },
] as const;

function repositorySource(path: string): string {
    return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

function sourceFilesUnder(path: string): readonly string[] {
    const absolutePath = resolve(repositoryRoot, path);
    if (!existsSync(absolutePath)) {
        return [];
    }

    return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = join(absolutePath, entry.name);
        if (entry.isDirectory()) {
            return sourceFilesUnder(relative(repositoryRoot, entryPath));
        }
        return ['.ts', '.tsx'].includes(extname(entry.name))
            ? [relative(repositoryRoot, entryPath)]
            : [];
    });
}

describe('rallar-black-box app source ownership', () => {
    it('documents the Recipe Console and legacy extraction ownership boundary', () => {
        const source = repositorySource(appSourcePath).replace(/\s+/g, ' ');

        expect(source).toContain(
            'Recipe Console work belongs under `src/recipe-console/**`; legacy extraction belongs under `src/legacy/**`; no new feature panel belongs in `App.tsx`.',
        );
    });

    it('keeps extracted legacy contracts in their focused modules', () => {
        for (const modulePath of extractedModulePaths) {
            expect(existsSync(resolve(repositoryRoot, modulePath)), modulePath).toBe(true);
        }
    });

    it('imports every extracted legacy contract directly from App.tsx', () => {
        const source = repositorySource(appSourcePath);

        for (const moduleImport of extractedModuleImports) {
            expect(source, moduleImport).toContain(`from '${moduleImport}';`);
        }
    });

    it('does not duplicate extracted legacy declarations in App.tsx', () => {
        const source = repositorySource(appSourcePath);
        const extractedDeclarations = [
            /^\s*type\s+AppNavigationState\s*=/m,
            /\bfunction\s+advancedSurfaceFromValue\b/,
            /\bfunction\s+normalizeAppNavigation\b/,
            /\bfunction\s+readInitialAppNavigation\b/,
            /\bfunction\s+writeAppNavigationToUrl\b/,
            /\bfunction\s+browserUiStorage\b/,
            /^\s*type\s+CommandCenterGlobalValues\s*=/m,
            /^\s*type\s+CommandQueueRow\s*=/m,
            /^\s*type\s+RunnerDistributedRunSelection\s*=/m,
            /\basync\s+function\s+loadBrowserRallarFacade\b/,
        ];

        for (const declaration of extractedDeclarations) {
            expect(source, declaration.source).not.toMatch(declaration);
        }
    });

    it('keeps shared legacy presentation seams in focused modules', () => {
        const source = repositorySource(appSourcePath);
        const movedDeclarations = [
            /\bfunction\s+Metric\s*\(/,
            /\bfunction\s+FilterSelect\s*\(/,
            /\bfunction\s+CollapsiblePanelSection\s*\(/,
            /\bfunction\s+formatTime\s*\(/,
            /\bfunction\s+formatDuration\s*\(/,
            /\bfunction\s+formatRelativeDuration\s*\(/,
            /\bfunction\s+formatSignedDuration\s*\(/,
            /\bfunction\s+formatSignedNumber\s*\(/,
            /\bfunction\s+json\s*\(/,
            /\bfunction\s+parseJsonText\s*\(/,
            /\bfunction\s+splitCsvValues\s*\(/,
            /\bfunction\s+uiSecretValues\s*\(/,
            /\bfunction\s+uiRedactionOptions\s*\(/,
            /\bfunction\s+redactedJson\s*\(/,
            /\bfunction\s+commandId\s*\(/,
            /\bfunction\s+statusTone\s*\(/,
            /\bfunction\s+resultSummary\s*\(/,
            /\bfunction\s+SchemaAuthoringPanel\s*\(/,
            /\bfunction\s+SchemaCapabilitySummary\s*\(/,
            /\bfunction\s+SchemaCapabilityList\s*\(/,
            /\bfunction\s+CommandExamplePicker\s*\(/,
        ];

        for (const presentationModule of presentationModules) {
            expect.soft(
                existsSync(resolve(repositoryRoot, presentationModule.path)),
                presentationModule.path,
            ).toBe(true);

            const escapedModuleImport = presentationModule.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const importedSeams = source.match(
                new RegExp(
                    `import\\s*{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                ),
            )?.[1];

            expect.soft(importedSeams, presentationModule.moduleImport).toBeDefined();
            for (const seam of presentationModule.seams) {
                expect
                    .soft(importedSeams ?? '', `${presentationModule.moduleImport}: ${seam}`)
                    .toMatch(new RegExp(`\\b${seam}\\b`));
            }
        }

        for (const declaration of movedDeclarations) {
            expect.soft(declaration.test(source), declaration.source).toBe(false);
        }
    });

    it('keeps legacy runner evidence components in focused modules', () => {
        const appSource = repositorySource(appSourcePath);
        const evidenceModules = [
            {
                path: 'apps/rallar-black-box/src/legacy/runner/evidence/RunVerdictPanel.tsx',
                importerPath: appSourcePath,
                moduleImport: './legacy/runner/evidence/RunVerdictPanel.tsx',
                seams: ['RunVerdictPanel'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/evidence/CausalTrailPanel.tsx',
                importerPath: appSourcePath,
                moduleImport: './legacy/runner/evidence/CausalTrailPanel.tsx',
                seams: ['CausalTrailPanel'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/agents/ControlAgentBoardPanel.tsx',
                importerPath: appSourcePath,
                moduleImport: './legacy/runner/agents/ControlAgentBoardPanel.tsx',
                seams: ['ControlAgentBoardPanel'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/agents/ControlAgentBoardRowView.tsx',
                importerPath: 'apps/rallar-black-box/src/legacy/runner/agents/ControlAgentBoardPanel.tsx',
                moduleImport: './ControlAgentBoardRowView.tsx',
                seams: ['ControlAgentBoardRowView'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/agents/control-agent-board-presentation.ts',
                importerPath: 'apps/rallar-black-box/src/legacy/runner/agents/ControlAgentBoardRowView.tsx',
                moduleImport: './control-agent-board-presentation.ts',
                seams: [
                    'controlAgentVisibleParticipations',
                    'controlAgentConnectionTone',
                    'controlAgentTargetTone',
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/shared/run-id-presentation.ts',
                importerPath: appSourcePath,
                moduleImport: './legacy/runner/shared/run-id-presentation.ts',
                seams: ['shortRunId'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed/status-presentation.ts',
                importerPath:
                    'apps/rallar-black-box/src/legacy/runner/runs/DistributedRunAnalysisReportPanel.tsx',
                moduleImport: '../distributed/status-presentation.ts',
                seams: [
                    'distributedProgressTone',
                    'distributedFailureCategoryTone',
                    'distributedDiagnosticTone',
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/evidence/rtc/RtcDiagnosticsTimeseriesPanel.tsx',
                importerPath: appSourcePath,
                moduleImport: './legacy/runner/evidence/rtc/RtcDiagnosticsTimeseriesPanel.tsx',
                seams: ['RtcDiagnosticsTimeseriesPanel'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/evidence/rtc/RtcLatencyCharts.tsx',
                importerPath: 'apps/rallar-black-box/src/legacy/runner/evidence/rtc/RtcPerformancePanel.tsx',
                moduleImport: './RtcLatencyCharts.tsx',
                seams: ['RtcLatencyScatterChart', 'RtcLatencyHistogram'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/evidence/rtc/RtcPhaseWaterfall.tsx',
                importerPath: 'apps/rallar-black-box/src/legacy/runner/evidence/rtc/RtcPerformancePanel.tsx',
                moduleImport: './RtcPhaseWaterfall.tsx',
                seams: ['RtcPhaseWaterfall'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/evidence/rtc/RtcAgentMatrix.tsx',
                importerPath: 'apps/rallar-black-box/src/legacy/runner/evidence/rtc/RtcPerformancePanel.tsx',
                moduleImport: './RtcAgentMatrix.tsx',
                seams: ['RtcAgentMatrix'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/evidence/rtc/RtcPerformancePanel.tsx',
                importerPath: appSourcePath,
                moduleImport: './legacy/runner/evidence/rtc/RtcPerformancePanel.tsx',
                seams: ['RtcPerformancePanel'],
            },
        ] as const;
        const movedDeclarations = [
            /\bfunction\s+RunVerdictPanel\s*\(/,
            /\bfunction\s+CausalTrailPanel\s*\(/,
            /\bfunction\s+ControlAgentBoardPanel\s*\(/,
            /\bfunction\s+ControlAgentBoardRowView\s*\(/,
            /\bfunction\s+ControlAgentRunParticipationChip\s*\(/,
            /\bfunction\s+controlAgentVisibleParticipations\s*\(/,
            /\bfunction\s+controlAgentConnectionTone\s*\(/,
            /\bfunction\s+controlAgentTargetTone\s*\(/,
            /\bfunction\s+shortRunId\s*\(/,
            /\bfunction\s+distributedProgressTone\s*\(/,
            /\bfunction\s+timeseriesPolyline\s*\(/,
            /\bfunction\s+RtcDiagnosticsTimeseriesPanel\s*\(/,
            /\bfunction\s+scatterCircleClass\s*\(/,
            /\bfunction\s+rtcPercentileMarkerEntries\s*\(/,
            /\bfunction\s+RtcLatencyScatterChart\s*\(/,
            /\bfunction\s+RtcLatencyHistogram\s*\(/,
            /\bfunction\s+RtcPhaseWaterfall\s*\(/,
            /\bfunction\s+RtcAgentMatrix\s*\(/,
            /\bfunction\s+RtcPerformancePanel\s*\(/,
        ];

        for (const evidenceModule of evidenceModules) {
            const moduleExists = existsSync(
                resolve(repositoryRoot, evidenceModule.path),
            );
            expect.soft(moduleExists, evidenceModule.path).toBe(true);

            const importerExists = existsSync(
                resolve(repositoryRoot, evidenceModule.importerPath),
            );
            const importerSource = importerExists
                ? repositorySource(evidenceModule.importerPath)
                : '';
            const escapedModuleImport = evidenceModule.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const importedSeams = importerSource.match(
                new RegExp(
                    `import\\s*{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                ),
            )?.[1];

            expect.soft(importedSeams, evidenceModule.moduleImport).toBeDefined();
            for (const seam of evidenceModule.seams) {
                expect
                    .soft(importedSeams ?? '', `${evidenceModule.moduleImport}: ${seam}`)
                    .toMatch(new RegExp(`\\b${seam}\\b`));
            }
        }

        for (const declaration of movedDeclarations) {
            expect.soft(declaration.test(appSource), declaration.source).toBe(false);
        }
    });

    it('keeps legacy run analysis seams in focused modules', () => {
        const source = repositorySource(appSourcePath);
        const movedDeclarations = [
            /\bconst\s+DISTRIBUTED_ARTIFACT_REQUIRED_FILES\s*=/,
            /\btype\s+DistributedArtifactImportStatus\s*=/,
            /\bfunction\s+distributedArtifactImportStatus\s*\(/,
            /\bfunction\s+readDistributedRunSeedFromUrl\s*\(/,
            /\bfunction\s+writeDistributedRunSeedToUrl\s*\(/,
            /\bfunction\s+DistributedRunAnalysisReportPanel\s*\(/,
            /\bfunction\s+ImportedDistributedArtifactAnalysisPanel\s*\(/,
            /\bfunction\s+formatPercent\s*\(/,
            /\bfunction\s+formatFleetDuration\s*\(/,
            /\bfunction\s+formatStreamRate\s*\(/,
            /\bfunction\s+distributedFailureCategoryTone\s*\(/,
            /\bfunction\s+distributedDiagnosticTone\s*\(/,
        ];

        for (const runAnalysisModule of runAnalysisModules) {
            expect.soft(
                existsSync(resolve(repositoryRoot, runAnalysisModule.path)),
                runAnalysisModule.path,
            ).toBe(true);

            const escapedModuleImport = runAnalysisModule.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const importedSeams = source.match(
                new RegExp(
                    `import\\s*{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                ),
            )?.[1];

            expect.soft(importedSeams, runAnalysisModule.moduleImport).toBeDefined();
            for (const seam of runAnalysisModule.seams) {
                expect
                    .soft(importedSeams ?? '', `${runAnalysisModule.moduleImport}: ${seam}`)
                    .toMatch(new RegExp(`\\b${seam}\\b`));
            }
        }

        for (const declaration of movedDeclarations) {
            expect.soft(declaration.test(source), declaration.source).toBe(false);
        }
    });

    it('keeps legacy distributed monitor views and helpers in focused modules', () => {
        const appSource = repositorySource(appSourcePath);
        const monitorPath =
            'apps/rallar-black-box/src/legacy/runner/distributed/DistributedRunMonitorPanel.tsx';
        const distributedMonitorModules = [
            {
                path: 'apps/rallar-black-box/src/legacy/shared/unique-values.ts',
                importerPath: appSourcePath,
                moduleImport: './legacy/shared/unique-values.ts',
                seams: ['uniqueValues'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed/distributed-diagnostics.ts',
                importerPath: monitorPath,
                moduleImport: './distributed-diagnostics.ts',
                seams: [
                    'DistributedRuntimeDiagnostic',
                    'distributedDiagnosticGroupValue',
                    'distributedDiagnosticSearchText',
                ],
            },
            {
                path: monitorPath,
                importerPath: appSourcePath,
                moduleImport:
                    './legacy/runner/distributed/DistributedRunMonitorPanel.tsx',
                seams: ['DistributedRunMonitorPanel'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed/DistributedRunComparePanel.tsx',
                importerPath: appSourcePath,
                moduleImport:
                    './legacy/runner/distributed/DistributedRunComparePanel.tsx',
                seams: ['DistributedRunComparePanel'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed/DistributedRunSummary.tsx',
                importerPath: appSourcePath,
                moduleImport:
                    './legacy/runner/distributed/DistributedRunSummary.tsx',
                seams: ['DistributedRunSummary'],
            },
        ] as const;

        for (const distributedMonitorModule of distributedMonitorModules) {
            expect.soft(
                existsSync(resolve(repositoryRoot, distributedMonitorModule.path)),
                distributedMonitorModule.path,
            ).toBe(true);

            const importerExists = existsSync(
                resolve(repositoryRoot, distributedMonitorModule.importerPath),
            );
            const importerSource = importerExists
                ? repositorySource(distributedMonitorModule.importerPath)
                : '';
            const escapedModuleImport =
                distributedMonitorModule.moduleImport.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    '\\$&',
                );
            const importedSeams = importerSource.match(
                new RegExp(
                    `import\\s*{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                ),
            )?.[1];

            expect.soft(
                importedSeams,
                distributedMonitorModule.moduleImport,
            ).toBeDefined();
            for (const seam of distributedMonitorModule.seams) {
                expect
                    .soft(
                        importedSeams ?? '',
                        `${distributedMonitorModule.moduleImport}: ${seam}`,
                    )
                    .toMatch(new RegExp(`\\b${seam}\\b`));
            }
        }

        const distributedOwnerModules = [
            {
                path: 'apps/rallar-black-box/src/legacy/shared/unique-values.ts',
                declarations: [
                    {
                        seam: 'uniqueValues',
                        pattern: /^\s*export\s+function\s+uniqueValues\s*</m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed/distributed-diagnostics.ts',
                declarations: [
                    {
                        seam: 'DistributedRuntimeDiagnostic',
                        pattern:
                            /^\s*export\s+type\s+DistributedRuntimeDiagnostic\s*=/m,
                    },
                    {
                        seam: 'distributedDiagnosticGroupValue',
                        pattern:
                            /^\s*export\s+function\s+distributedDiagnosticGroupValue\s*\(/m,
                    },
                    {
                        seam: 'distributedDiagnosticSearchText',
                        pattern:
                            /^\s*export\s+function\s+distributedDiagnosticSearchText\s*\(/m,
                    },
                ],
            },
            {
                path: monitorPath,
                declarations: [
                    {
                        seam: 'DistributedRunMonitorPanel',
                        pattern:
                            /^\s*export\s+function\s+DistributedRunMonitorPanel\s*\(/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed/DistributedRunComparePanel.tsx',
                declarations: [
                    {
                        seam: 'DistributedRunComparePanel',
                        pattern:
                            /^\s*export\s+function\s+DistributedRunComparePanel\s*\(/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed/DistributedRunSummary.tsx',
                declarations: [
                    {
                        seam: 'DistributedRunSummary',
                        pattern:
                            /^\s*export\s+function\s+DistributedRunSummary\s*\(/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed/status-presentation.ts',
                declarations: [
                    {
                        seam: 'distributedCompositeStatusTone',
                        pattern:
                            /^\s*export\s+function\s+distributedCompositeStatusTone\s*\(/m,
                    },
                    {
                        seam: 'distributedDiagnosticTone',
                        pattern:
                            /^\s*export\s+function\s+distributedDiagnosticTone\s*\(/m,
                    },
                    {
                        seam: 'distributedProgressTone',
                        pattern:
                            /^\s*export\s+function\s+distributedProgressTone\s*\(/m,
                    },
                ],
            },
        ] as const;

        for (const ownerModule of distributedOwnerModules) {
            const ownerExists = existsSync(resolve(repositoryRoot, ownerModule.path));
            const ownerSource = ownerExists
                ? repositorySource(ownerModule.path)
                : '';

            expect.soft(ownerExists, ownerModule.path).toBe(true);
            expect
                .soft(ownerSource, `${ownerModule.path}: export-star barrel`)
                .not.toMatch(/^\s*export\s*\*(?:\s+as\s+\w+)?\s+from\b/m);
            for (const declaration of ownerModule.declarations) {
                expect
                    .soft(
                        ownerSource,
                        `${ownerModule.path}: ${declaration.seam} declaration`,
                    )
                    .toMatch(declaration.pattern);
                expect
                    .soft(
                        ownerSource,
                        `${ownerModule.path}: ${declaration.seam} re-export`,
                    )
                    .not.toMatch(
                        new RegExp(
                            `^\\s*export\\s+(?:type\\s+)?{[^}]*\\b${declaration.seam}\\b[^}]*}\\s*from\\s*['\"]`,
                            'm',
                        ),
                    );
            }
        }

        const compareSource = repositorySource(
            'apps/rallar-black-box/src/legacy/runner/distributed/DistributedRunComparePanel.tsx',
        );
        expect(compareSource, 'private DistributedCompareList declaration').toMatch(
            /^\s*function\s+DistributedCompareList\s*\(/m,
        );
        expect(compareSource, 'exported DistributedCompareList declaration').not.toMatch(
            /^\s*export\s+(?:default\s+)?function\s+DistributedCompareList\s*\(/m,
        );
        expect(compareSource, 'exported DistributedCompareList binding').not.toMatch(
            /^\s*export\s+(?:type\s+)?{[^}]*\bDistributedCompareList\b[^}]*}/m,
        );
        expect(compareSource, 'default DistributedCompareList export').not.toMatch(
            /^\s*export\s+default\s+DistributedCompareList\b/m,
        );

        const monitorSource = existsSync(resolve(repositoryRoot, monitorPath))
            ? repositorySource(monitorPath)
            : '';
        const monitorCanonicalImports = [
            {
                moduleImport: '../../shared/unique-values.ts',
                seams: ['uniqueValues'],
            },
            {
                moduleImport: './distributed-diagnostics.ts',
                seams: [
                    'DistributedRuntimeDiagnostic',
                    'distributedDiagnosticGroupValue',
                    'distributedDiagnosticSearchText',
                ],
            },
            {
                moduleImport: './status-presentation.ts',
                seams: [
                    'distributedCompositeStatusTone',
                    'distributedDiagnosticTone',
                    'distributedProgressTone',
                ],
            },
        ] as const;

        for (const canonicalImport of monitorCanonicalImports) {
            const escapedModuleImport = canonicalImport.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const importedSeams = monitorSource.match(
                new RegExp(
                    `import\\s*{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                ),
            )?.[1];

            expect.soft(importedSeams, canonicalImport.moduleImport).toBeDefined();
            for (const seam of canonicalImport.seams) {
                expect
                    .soft(
                        importedSeams ?? '',
                        `${canonicalImport.moduleImport}: ${seam}`,
                    )
                    .toMatch(new RegExp(`\\b${seam}\\b`));
            }
        }

        const monitorLocalDuplicates = [
            /^\s*(?:export\s+)?(?:const|let|var|function)\s+uniqueValues\b/m,
            /^\s*(?:export\s+)?type\s+DistributedRuntimeDiagnostic\s*=/m,
            /^\s*(?:export\s+)?(?:const|let|var|function)\s+distributedDiagnosticGroupValue\b/m,
            /^\s*(?:export\s+)?(?:const|let|var|function)\s+distributedDiagnosticSearchText\b/m,
            /^\s*(?:export\s+)?(?:const|let|var|function)\s+distributedCompositeStatusTone\b/m,
            /^\s*(?:export\s+)?(?:const|let|var|function)\s+distributedDiagnosticTone\b/m,
            /^\s*(?:export\s+)?(?:const|let|var|function)\s+distributedProgressTone\b/m,
        ];

        for (const localDuplicate of monitorLocalDuplicates) {
            expect
                .soft(monitorSource, `monitor-local ${localDuplicate.source}`)
                .not.toMatch(localDuplicate);
        }

        const movedDeclarations = [
            /\bfunction\s+uniqueValues\s*</,
            /\bfunction\s+DistributedRunMonitorPanel\s*\(/,
            /\bfunction\s+DistributedRunComparePanel\s*\(/,
            /\bfunction\s+DistributedCompareList\s*\(/,
            /\bfunction\s+distributedCompositeStatusTone\s*\(/,
            /\btype\s+DistributedRuntimeDiagnostic\s*=/,
            /\bfunction\s+distributedDiagnosticGroupValue\s*\(/,
            /\bfunction\s+distributedDiagnosticSearchText\s*\(/,
            /\bfunction\s+DistributedRunSummary\s*\(/,
        ];

        for (const declaration of movedDeclarations) {
            expect.soft(declaration.test(appSource), declaration.source).toBe(false);
        }
    });

    it('keeps the legacy run manager and its dependencies in focused modules', () => {
        const appSource = repositorySource(appSourcePath);
        const runManagerPath =
            'apps/rallar-black-box/src/legacy/runner/run-manager/RunManagerPanel.tsx';
        const runManagerModules = [
            {
                path: runManagerPath,
                importerPath: appSourcePath,
                moduleImport:
                    './legacy/runner/run-manager/RunManagerPanel.tsx',
                seams: ['RunManagerPanel'],
                declarations: [
                    {
                        seam: 'RunManagerPanel',
                        pattern:
                            /^\s*export\s+function\s+RunManagerPanel\s*\(/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/run-manager/RunManagerAgentRow.tsx',
                importerPath: runManagerPath,
                moduleImport: './RunManagerAgentRow.tsx',
                seams: ['RunManagerAgentRow'],
                declarations: [
                    {
                        seam: 'RunManagerAgentRow',
                        pattern:
                            /^\s*export\s+function\s+RunManagerAgentRow\s*\(/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/run-manager/RunManagerCommandList.tsx',
                importerPath: runManagerPath,
                moduleImport: './RunManagerCommandList.tsx',
                seams: ['RunManagerCommandList'],
                declarations: [
                    {
                        seam: 'RunManagerCommandList',
                        pattern:
                            /^\s*export\s+function\s+RunManagerCommandList\s*\(/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/run-manager/run-manager-command.ts',
                importerPath: runManagerPath,
                moduleImport: './run-manager-command.ts',
                seams: [
                    'parseRunManagerCommandText',
                    'runManagerCommandPrefix',
                ],
                declarations: [
                    {
                        seam: 'parseRunManagerCommandText',
                        pattern:
                            /^\s*export\s+function\s+parseRunManagerCommandText\s*\(/m,
                    },
                    {
                        seam: 'runManagerCommandPrefix',
                        pattern:
                            /^\s*export\s+function\s+runManagerCommandPrefix\s*\(/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/shared/control-snapshot-bounds.ts',
                importerPath: runManagerPath,
                moduleImport: '../shared/control-snapshot-bounds.ts',
                seams: ['RUN_MANAGER_SNAPSHOT_BOUNDS'],
                declarations: [
                    {
                        seam: 'RUN_MANAGER_SNAPSHOT_BOUNDS',
                        pattern:
                            /^\s*export\s+const\s+RUN_MANAGER_SNAPSHOT_BOUNDS\s*=/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/shared/same-string-array.ts',
                importerPath: runManagerPath,
                moduleImport: '../../shared/same-string-array.ts',
                seams: ['sameStringArray'],
                declarations: [
                    {
                        seam: 'sameStringArray',
                        pattern:
                            /^\s*export\s+function\s+sameStringArray\s*\(/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/shared/artifact-issue-presentation.ts',
                importerPath: runManagerPath,
                moduleImport: '../shared/artifact-issue-presentation.ts',
                seams: ['artifactIssueText'],
                declarations: [
                    {
                        seam: 'artifactIssueText',
                        pattern:
                            /^\s*export\s+function\s+artifactIssueText\s*\(/m,
                    },
                ],
            },
        ] as const;

        for (const runManagerModule of runManagerModules) {
            const ownerExists = existsSync(
                resolve(repositoryRoot, runManagerModule.path),
            );
            const ownerSource = ownerExists
                ? repositorySource(runManagerModule.path)
                : '';
            const importerExists = existsSync(
                resolve(repositoryRoot, runManagerModule.importerPath),
            );
            const importerSource = importerExists
                ? repositorySource(runManagerModule.importerPath)
                : '';
            const escapedModuleImport = runManagerModule.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const importedSeams = importerSource.match(
                new RegExp(
                    `import\\s*{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                ),
            )?.[1];

            expect.soft(ownerExists, runManagerModule.path).toBe(true);
            expect
                .soft(ownerSource, `${runManagerModule.path}: export-star barrel`)
                .not.toMatch(/^\s*export\s*\*(?:\s+as\s+\w+)?\s+from\b/m);
            expect.soft(importedSeams, runManagerModule.moduleImport).toBeDefined();
            for (const seam of runManagerModule.seams) {
                expect
                    .soft(
                        importedSeams ?? '',
                        `${runManagerModule.moduleImport}: ${seam}`,
                    )
                    .toMatch(new RegExp(`\\b${seam}\\b`));
            }
            for (const declaration of runManagerModule.declarations) {
                expect
                    .soft(
                        ownerSource,
                        `${runManagerModule.path}: ${declaration.seam} declaration`,
                    )
                    .toMatch(declaration.pattern);
                expect
                    .soft(
                        ownerSource,
                        `${runManagerModule.path}: ${declaration.seam} re-export`,
                    )
                    .not.toMatch(
                        new RegExp(
                            `^\\s*export\\s+(?:type\\s+)?{[^}]*\\b${declaration.seam}\\b[^}]*}\\s*from\\s*['\"]`,
                            'm',
                        ),
                    );
            }
        }

        const appSharedImports = [
            {
                moduleImport:
                    './legacy/runner/shared/control-snapshot-bounds.ts',
                seam: 'RUN_MANAGER_SNAPSHOT_BOUNDS',
            },
            {
                moduleImport: './legacy/shared/same-string-array.ts',
                seam: 'sameStringArray',
            },
            {
                moduleImport:
                    './legacy/runner/shared/artifact-issue-presentation.ts',
                seam: 'artifactIssueText',
            },
        ] as const;

        for (const appSharedImport of appSharedImports) {
            const escapedModuleImport = appSharedImport.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const importedSeams = appSource.match(
                new RegExp(
                    `import\\s*{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                ),
            )?.[1];

            expect.soft(importedSeams, appSharedImport.moduleImport).toBeDefined();
            expect
                .soft(
                    importedSeams ?? '',
                    `${appSharedImport.moduleImport}: ${appSharedImport.seam}`,
                )
                .toMatch(new RegExp(`\\b${appSharedImport.seam}\\b`));
        }

        const runManagerSource = existsSync(resolve(repositoryRoot, runManagerPath))
            ? repositorySource(runManagerPath)
            : '';
        const importedLocalDuplicates = [
            'RunManagerAgentRow',
            'RunManagerCommandList',
            'parseRunManagerCommandText',
            'runManagerCommandPrefix',
            'RUN_MANAGER_SNAPSHOT_BOUNDS',
            'sameStringArray',
            'artifactIssueText',
        ] as const;

        for (const localDuplicate of importedLocalDuplicates) {
            expect
                .soft(runManagerSource, `run-manager-local ${localDuplicate}`)
                .not.toMatch(
                    new RegExp(
                        `^\\s*(?:export\\s+)?(?:const|let|var|function)\\s+${localDuplicate}\\b`,
                        'm',
                    ),
                );
        }

        const movedDeclarations = [
            'RunManagerPanel',
            'RunManagerAgentRow',
            'RunManagerCommandList',
            'parseRunManagerCommandText',
            'runManagerCommandPrefix',
            'RUN_MANAGER_SNAPSHOT_BOUNDS',
            'sameStringArray',
            'artifactIssueText',
        ] as const;

        for (const movedDeclaration of movedDeclarations) {
            expect
                .soft(appSource, `App.tsx: ${movedDeclaration}`)
                .not.toMatch(
                    new RegExp(
                        `^\\s*(?:export\\s+)?(?:const|let|var|function)\\s+${movedDeclaration}\\b`,
                        'm',
                    ),
                );
        }
    });

    it('keeps distributed compare formatters in the canonical time module', () => {
        const panelSource = repositorySource(
            'apps/rallar-black-box/src/legacy/runner/distributed/DistributedRunComparePanel.tsx',
        );
        const moduleImport = '../../shared/time-format.ts';
        const formatterNames = [
            'formatSignedDuration',
            'formatSignedNumber',
        ] as const;
        const escapedModuleImport = moduleImport.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&',
        );
        const importedFormatters = panelSource.match(
            new RegExp(
                `import\\s*{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
            ),
        )?.[1];

        expect(importedFormatters, moduleImport).toBeDefined();
        for (const formatterName of formatterNames) {
            expect(importedFormatters ?? '', `${moduleImport}: ${formatterName}`).toMatch(
                new RegExp(`(?:^|,)\\s*${formatterName}\\s*(?=,|$)`),
            );
            expect(panelSource, `panel-local ${formatterName}`).not.toMatch(
                new RegExp(
                    `^\\s*(?:export\\s+)?(?:const|let|var|function)\\s+${formatterName}\\b`,
                    'm',
                ),
            );
        }
    });

    it('keeps imported artifact performance formatters in their canonical module', () => {
        const panelSource = repositorySource(
            'apps/rallar-black-box/src/legacy/runner/runs/ImportedDistributedArtifactAnalysisPanel.tsx',
        );
        const moduleImport = '../shared/performance-format.ts';
        const formatterNames = [
            'formatPercent',
            'formatFleetDuration',
            'formatStreamRate',
        ] as const;
        const escapedModuleImport = moduleImport.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&',
        );
        const importedFormatters = panelSource.match(
            new RegExp(
                `import\\s*{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
            ),
        )?.[1];

        expect(importedFormatters, moduleImport).toBeDefined();
        for (const formatterName of formatterNames) {
            expect(importedFormatters ?? '', `${moduleImport}: ${formatterName}`).toMatch(
                new RegExp(`(?:^|,)\\s*${formatterName}\\s*(?=,|$)`),
            );
            expect(panelSource, `panel-local ${formatterName}`).not.toMatch(
                new RegExp(`\\b(?:const|let|var|function)\\s+${formatterName}\\b`),
            );
        }
    });

    it('does not declare Recipe Console panels in App.tsx', () => {
        const source = repositorySource(appSourcePath);

        expect(source).not.toMatch(/\bRecipeConsole\w*Panel\b/);
        expect(source).not.toMatch(/\bfunction\s+RecipeConsole\w*/);
    });

    it('keeps future Recipe Console features behind the legacy compatibility router', () => {
        const forbiddenImports = sourceFilesUnder(recipeConsoleSourcePath).flatMap((sourcePath) => {
            const source = repositorySource(sourcePath);
            const imports = source.matchAll(
                /(?:\bfrom\s+|\bimport\s*\(\s*)['"]([^'"]*legacy\/[^'"]*)['"]/g,
            );

            return [...imports]
                .map((match) => match[1])
                .filter((moduleImport) => !moduleImport.includes('LegacySurfaceRouter'))
                .map((moduleImport) => `${sourcePath}: ${moduleImport}`);
        });

        expect(forbiddenImports).toEqual([]);
    });
});
