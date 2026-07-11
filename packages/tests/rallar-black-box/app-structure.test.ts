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
        seams: ['SchemaAuthoringPanel'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shared/schema/SchemaAuthoringPanel.tsx',
        importerPath:
            'apps/rallar-black-box/src/legacy/runner/distributed-recipes/views/DistributedRecipeCatalogPanel.tsx',
        moduleImport: '../../../shared/schema/SchemaAuthoringPanel.tsx',
        seams: ['SchemaCapabilitySummary'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/shared/schema/CommandExamplePicker.tsx',
        importerPath:
            'apps/rallar-black-box/src/legacy/runner/workbench/WorkbenchPanel.tsx',
        moduleImport: '../../shared/schema/CommandExamplePicker.tsx',
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
            const importerSource = 'importerPath' in presentationModule
                ? repositorySource(presentationModule.importerPath)
                : source;
            const importedSeams = importerSource.match(
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

    it('keeps distributed recipe leaves in their direct focused owners', () => {
        const appSource = repositorySource(appSourcePath);
        const distributedLeafModules = [
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed-recipes/distributed-recipe-catalog.ts',
                appImport:
                    './legacy/runner/distributed-recipes/distributed-recipe-catalog.ts',
                appSeams: [
                    'DISTRIBUTED_RECIPE_CATALOG',
                    'configuredDistributedRecipeCatalogItem',
                ],
                declarations: [
                    {
                        seam: 'RTC_REALTIME_STABILITY_CATALOG_TITLE',
                        pattern:
                            /^\s*const\s+RTC_REALTIME_STABILITY_CATALOG_TITLE\s*=/m,
                    },
                    {
                        seam: 'DISTRIBUTED_RECIPE_CATALOG',
                        pattern:
                            /^\s*export\s+const\s+DISTRIBUTED_RECIPE_CATALOG\s*:/m,
                    },
                    {
                        seam: 'configuredDistributedRecipeCatalogItem',
                        pattern:
                            /^\s*export\s+function\s+configuredDistributedRecipeCatalogItem\s*\(/m,
                    },
                    {
                        seam: 'distributedRecipeMatches',
                        pattern:
                            /^\s*export\s+function\s+distributedRecipeMatches\s*\(/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed-recipes/distributed-manifest-validation.ts',
                appImport:
                    './legacy/runner/distributed-recipes/distributed-manifest-validation.ts',
                appSeams: ['validateDistributedRecipeManifest'],
                declarations: [
                    {
                        seam: 'validateDistributedRecipeManifest',
                        pattern:
                            /^\s*export\s+function\s+validateDistributedRecipeManifest\s*\(/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/shared/safe-id-segment.ts',
                appImport: './legacy/shared/safe-id-segment.ts',
                appSeams: ['safeIdSegment'],
                declarations: [
                    {
                        seam: 'safeIdSegment',
                        pattern: /^\s*export\s+function\s+safeIdSegment\s*\(/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/shared/record-value.ts',
                appImport: './legacy/shared/record-value.ts',
                appSeams: ['recordValue'],
                declarations: [
                    {
                        seam: 'recordValue',
                        pattern: /^\s*export\s+function\s+recordValue\s*\(/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed-recipes/authoring/distributed-recipe-authoring.ts',
                importerPath:
                    'apps/rallar-black-box/src/legacy/runner/distributed-recipes/authoring/DistributedRecipeAuthoringSection.tsx',
                appImport: './distributed-recipe-authoring.ts',
                appSeams: [
                    'DistributedAuthoringDraftTarget',
                    'distributedAuthoringDraftPreflights',
                    'distributedPromptFeedbackFromValidation',
                ],
                declarations: [
                    {
                        seam: 'DistributedAuthoringDraftTarget',
                        pattern:
                            /^\s*export\s+type\s+DistributedAuthoringDraftTarget\s*=/m,
                    },
                    {
                        seam: 'DistributedAuthoringDraftPreflightEntry',
                        pattern:
                            /^\s*export\s+type\s+DistributedAuthoringDraftPreflightEntry\s*=/m,
                    },
                    {
                        seam: 'distributedAuthoringDraftPreflights',
                        pattern:
                            /^\s*export\s+function\s+distributedAuthoringDraftPreflights\s*\(/m,
                    },
                    {
                        seam: 'distributedPromptFeedbackFromValidation',
                        pattern:
                            /^\s*export\s+function\s+distributedPromptFeedbackFromValidation\s*\(/m,
                    },
                    {
                        seam: 'isRallarBlackBoxRecipeValue',
                        pattern:
                            /^\s*function\s+isRallarBlackBoxRecipeValue\s*\(/m,
                    },
                    {
                        seam: 'isDistributedManifestValue',
                        pattern:
                            /^\s*function\s+isDistributedManifestValue\s*\(/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed-recipes/authoring/DistributedRecipeAuthoringPanel.tsx',
                importerPath:
                    'apps/rallar-black-box/src/legacy/runner/distributed-recipes/authoring/DistributedRecipeAuthoringSection.tsx',
                appImport: './DistributedRecipeAuthoringPanel.tsx',
                appSeams: ['DistributedRecipeAuthoringPanel'],
                declarations: [
                    {
                        seam: 'DistributedRecipeAuthoringPanel',
                        pattern:
                            /^\s*export\s+function\s+DistributedRecipeAuthoringPanel\s*\(/m,
                    },
                    {
                        seam: 'promptVariableVisible',
                        pattern: /^\s*function\s+promptVariableVisible\s*\(/m,
                    },
                    {
                        seam: 'formatPromptVariableValue',
                        pattern:
                            /^\s*function\s+formatPromptVariableValue\s*\(/m,
                    },
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed-recipes/DistributedRecipePreflightPanel.tsx',
                appImport:
                    './legacy/runner/distributed-recipes/DistributedRecipePreflightPanel.tsx',
                appSeams: ['DistributedRecipePreflightPanel'],
                declarations: [
                    {
                        seam: 'DistributedRecipePreflightPanel',
                        pattern:
                            /^\s*export\s+function\s+DistributedRecipePreflightPanel\s*\(/m,
                    },
                ],
            },
        ] as const;

        const importedSeams = (source: string, moduleImport: string): string => {
            const escapedModuleImport = moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            return [
                ...source.matchAll(
                    new RegExp(
                        `import(?:\\s+type)?\\s*{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                        'g',
                    ),
                ),
            ]
                .map((match) => match[1])
                .join('\n');
        };

        const sourceByPath = new Map<string, string>();
        for (const owner of distributedLeafModules) {
            const ownerExists = existsSync(resolve(repositoryRoot, owner.path));
            const ownerSource = ownerExists ? repositorySource(owner.path) : '';
            sourceByPath.set(owner.path, ownerSource);

            expect.soft(ownerExists, owner.path).toBe(true);
            expect
                .soft(ownerSource, `${owner.path}: export-star facade`)
                .not.toMatch(/^\s*export\s*\*(?:\s+as\s+\w+)?\s+from\b/m);
            expect
                .soft(ownerSource, `${owner.path}: named re-export facade`)
                .not.toMatch(
                    /^\s*export\s+(?:type\s+)?{[^}]+}\s*from\s*['"]/m,
                );
            expect.soft(ownerSource, `${owner.path}: App.tsx import`).not.toMatch(
                /\b(?:from\s+|import\s*\(\s*)['"][^'"]*App\.tsx['"]/,
            );
            expect.soft(
                ownerSource === ''
                    ? 0
                    : ownerSource.trimEnd().split(/\r?\n/).length,
                `${owner.path}: line count`,
            ).toBeLessThanOrEqual(320);

            for (const declaration of owner.declarations) {
                expect
                    .soft(
                        ownerSource,
                        `${owner.path}: ${declaration.seam} declaration`,
                    )
                    .toMatch(declaration.pattern);
                expect
                    .soft(
                        ownerSource,
                        `${owner.path}: ${declaration.seam} re-export`,
                    )
                    .not.toMatch(
                        new RegExp(
                            `^\\s*export\\s+(?:type\\s+)?{[^}]*\\b${declaration.seam}\\b[^}]*}\\s*from\\s*['"]`,
                            'm',
                        ),
                    );
            }

            const importerSource =
                'importerPath' in owner
                    ? repositorySource(owner.importerPath)
                    : appSource;
            const appImportedSeams = importedSeams(
                importerSource,
                owner.appImport,
            );
            expect.soft(appImportedSeams, owner.appImport).not.toBe('');
            for (const seam of owner.appSeams) {
                expect
                    .soft(appImportedSeams, `${owner.appImport}: ${seam}`)
                    .toMatch(new RegExp(`\\b${seam}\\b`));
            }
        }

        const authoringPanelPath =
            'apps/rallar-black-box/src/legacy/runner/distributed-recipes/authoring/DistributedRecipeAuthoringPanel.tsx';
        const authoringSupportPath =
            'apps/rallar-black-box/src/legacy/runner/distributed-recipes/authoring/distributed-recipe-authoring.ts';
        const authoringPanelSource = sourceByPath.get(authoringPanelPath) ?? '';
        const authoringSupportSource = sourceByPath.get(authoringSupportPath) ?? '';
        const authoringTypeImports = importedSeams(
            authoringPanelSource,
            './distributed-recipe-authoring.ts',
        );
        for (const authoringType of [
            'DistributedAuthoringDraftTarget',
            'DistributedAuthoringDraftPreflightEntry',
        ]) {
            expect
                .soft(
                    authoringTypeImports,
                    `authoring panel: ${authoringType}`,
                )
                .toMatch(new RegExp(`\\b${authoringType}\\b`));
        }
        expect(
            importedSeams(
                authoringPanelSource,
                '../DistributedRecipePreflightPanel.tsx',
            ),
            'authoring panel: DistributedRecipePreflightPanel',
        ).toMatch(/\bDistributedRecipePreflightPanel\b/);
        expect(
            importedSeams(authoringSupportSource, '../../../shared/record-value.ts'),
            'authoring support: recordValue',
        ).toMatch(/\brecordValue\b/);
        expect(
            importedSeams(
                repositorySource(
                    'apps/rallar-black-box/src/legacy/runner/distributed-recipes/use-distributed-recipe-builder.ts',
                ),
                './distributed-recipe-catalog.ts',
            ),
            'recipe builder: distributedRecipeMatches',
        ).toMatch(/\bdistributedRecipeMatches\b/);

        const targetPaths = new Set(
            distributedLeafModules.map((owner) => owner.path),
        );
        const targetDependencies = new Map<string, readonly string[]>();
        for (const owner of distributedLeafModules) {
            const dependencies = [
                ...(sourceByPath.get(owner.path) ?? '').matchAll(
                    /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g,
                ),
            ]
                .map((match) => match[1] ?? match[2])
                .filter((moduleImport) => moduleImport.startsWith('.'))
                .map((moduleImport) =>
                    relative(
                        repositoryRoot,
                        resolve(
                            resolve(repositoryRoot, owner.path),
                            '..',
                            moduleImport,
                        ),
                    ),
                )
                .filter((dependency) => targetPaths.has(dependency));
            targetDependencies.set(owner.path, dependencies);
        }

        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) {
                cycles.push(path);
                return;
            }
            if (visited.has(path)) {
                return;
            }
            active.add(path);
            for (const dependency of targetDependencies.get(path) ?? []) {
                visit(dependency);
            }
            active.delete(path);
            visited.add(path);
        };
        for (const targetPath of targetPaths) {
            visit(targetPath);
        }
        expect(cycles, 'distributed recipe leaf import cycles').toEqual([]);

        const movedDeclarations = [
            'RTC_REALTIME_STABILITY_CATALOG_TITLE',
            'DISTRIBUTED_RECIPE_CATALOG',
            'configuredDistributedRecipeCatalogItem',
            'distributedRecipeMatches',
            'validateDistributedRecipeManifest',
            'safeIdSegment',
            'recordValue',
            'DistributedAuthoringDraftTarget',
            'DistributedAuthoringDraftPreflightEntry',
            'distributedAuthoringDraftPreflights',
            'distributedPromptFeedbackFromValidation',
            'isRallarBlackBoxRecipeValue',
            'isDistributedManifestValue',
            'DistributedRecipeAuthoringPanel',
            'promptVariableVisible',
            'formatPromptVariableValue',
            'DistributedRecipePreflightPanel',
        ] as const;
        for (const movedDeclaration of movedDeclarations) {
            expect
                .soft(appSource, `App.tsx: ${movedDeclaration}`)
                .not.toMatch(
                    new RegExp(
                        `^\\s*(?:export\\s+)?(?:(?:const|let|var|function|interface|class)\\s+${movedDeclaration}\\b|type\\s+${movedDeclaration}\\s*=)`,
                        'm',
                    ),
                );
        }
    });

    it('keeps distributed recipe controlled views in their exact direct owners', () => {
        const appSource = repositorySource(appSourcePath);
        const panelPath =
            'apps/rallar-black-box/src/legacy/runner/distributed-recipes/DistributedRecipesPanel.tsx';
        const panelSource = existsSync(resolve(repositoryRoot, panelPath))
            ? repositorySource(panelPath)
            : '';
        const distributedRecipeViews = [
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed-recipes/views/DistributedRecipesHeader.tsx',
                moduleImport: './views/DistributedRecipesHeader.tsx',
                declaration: 'DistributedRecipesHeader',
                lineCap: 150,
                markers: [
                    '<h2>Distributed Recipes</h2>',
                    'className="distributed-toolbar"',
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed-recipes/views/DistributedRecipeCatalogPanel.tsx',
                moduleImport: './views/DistributedRecipeCatalogPanel.tsx',
                declaration: 'DistributedRecipeCatalogPanel',
                lineCap: 240,
                markers: [
                    '<h3>Recipe Catalog</h3>',
                    'distributed-recipes-catalog',
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed-recipes/views/DistributedTargetResolutionPanel.tsx',
                moduleImport: './views/DistributedTargetResolutionPanel.tsx',
                declaration: 'DistributedTargetResolutionPanel',
                lineCap: 240,
                markers: ['<h3>Target Resolution</h3>'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed-recipes/views/DistributedRunControlPanel.tsx',
                moduleImport: './views/DistributedRunControlPanel.tsx',
                declaration: 'DistributedRunControlPanel',
                lineCap: 220,
                markers: [
                    '<h3>Run Control</h3>',
                    'className="distributed-run-id-row"',
                ],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed-recipes/views/DistributedManifestPreviewPanel.tsx',
                moduleImport: './views/DistributedManifestPreviewPanel.tsx',
                declaration: 'DistributedManifestPreviewPanel',
                lineCap: 120,
                markers: [
                    '<h3>Manifest Preview</h3>',
                    'distributed-manifest-panel',
                ],
            },
        ] as const;

        const sourceByPath = new Map<string, string>();
        for (const view of distributedRecipeViews) {
            const ownerExists = existsSync(resolve(repositoryRoot, view.path));
            const ownerSource = ownerExists ? repositorySource(view.path) : '';
            sourceByPath.set(view.path, ownerSource);

            expect.soft(ownerExists, view.path).toBe(true);
            expect
                .soft(ownerSource, `${view.path}: direct declaration`)
                .toMatch(
                    new RegExp(
                        `^\\s*export\\s+function\\s+${view.declaration}\\s*\\(`,
                        'm',
                    ),
                );
            expect
                .soft(ownerSource, `${view.path}: export-star facade`)
                .not.toMatch(/^\s*export\s*\*(?:\s+as\s+\w+)?\s+from\b/m);
            expect
                .soft(ownerSource, `${view.path}: named re-export facade`)
                .not.toMatch(/^\s*export\s+(?:type\s+)?{[^}]+}\s*from\s*['"]/m);
            expect.soft(ownerSource, `${view.path}: App.tsx import`).not.toMatch(
                /\b(?:from\s+|import\s*\(\s*)['"][^'"]*App\.tsx['"]/,
            );
            expect.soft(ownerSource, `${view.path}: React hooks`).not.toMatch(
                /\buse[A-Z]\w*\b/,
            );
            expect.soft(ownerSource, `${view.path}: fetch`).not.toMatch(
                /\bfetch\s*\(/,
            );
            expect
                .soft(ownerSource, `${view.path}: control-run-manager runtime import`)
                .not.toMatch(
                    /import(?!\s+type\b)\s*{[^}]*}\s*from\s*['"][^'"]*control-run-manager\.ts['"];/s,
                );
            expect.soft(
                ownerSource === ''
                    ? 0
                    : ownerSource.trimEnd().split(/\r?\n/).length,
                `${view.path}: line count`,
            ).toBeLessThanOrEqual(view.lineCap);

            for (const marker of view.markers) {
                expect.soft(ownerSource, `${view.path}: ${marker}`).toContain(marker);
                expect.soft(appSource, `App.tsx: ${marker}`).not.toContain(marker);
            }

            const escapedModuleImport = view.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const importedSeams = panelSource.match(
                new RegExp(
                    `import\\s*{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                ),
            )?.[1];
            expect.soft(importedSeams, view.moduleImport).toBeDefined();
            expect
                .soft(importedSeams ?? '', `${view.moduleImport}: ${view.declaration}`)
                .toMatch(new RegExp(`\\b${view.declaration}\\b`));
        }

        expect(panelSource, 'parent owner').toMatch(
            /^\s*export\s+function\s+DistributedRecipesPanel\s*\(/m,
        );
        const orderedCalls = [
            '<DistributedRecipesHeader',
            '<DistributedRecipeAuthoringSection',
            '<DistributedRecipeCatalogPanel',
            '<DistributedTargetResolutionPanel',
            '<DistributedRunControlPanel',
            '<DistributedManifestPreviewPanel',
            '<DistributedRunMonitorPanel',
            '<DistributedRunHistorySection',
        ].map((marker) => panelSource.indexOf(marker));
        expect.soft(orderedCalls.every((position) => position >= 0), 'render calls').toBe(
            true,
        );
        expect.soft(orderedCalls, 'render order').toEqual(
            [...orderedCalls].sort((left, right) => left - right),
        );

        const targetPaths = new Set(distributedRecipeViews.map((view) => view.path));
        const dependencies = new Map<string, readonly string[]>();
        for (const view of distributedRecipeViews) {
            dependencies.set(
                view.path,
                [...(sourceByPath.get(view.path) ?? '').matchAll(
                    /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g,
                )]
                    .map((match) => match[1] ?? match[2])
                    .filter((moduleImport) => moduleImport.startsWith('.'))
                    .map((moduleImport) =>
                        relative(
                            repositoryRoot,
                            resolve(
                                resolve(repositoryRoot, view.path),
                                '..',
                                moduleImport,
                            ),
                        ),
                    )
                    .filter((dependency) => targetPaths.has(dependency)),
            );
        }
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) {
                cycles.push(path);
                return;
            }
            if (visited.has(path)) {
                return;
            }
            active.add(path);
            for (const dependency of dependencies.get(path) ?? []) {
                visit(dependency);
            }
            active.delete(path);
            visited.add(path);
        };
        for (const targetPath of targetPaths) {
            visit(targetPath);
        }
        expect(cycles, 'distributed recipe view import cycles').toEqual([]);
    });

    it('keeps distributed recipe core in exact one-way controller owners', () => {
        const appSource = repositorySource(appSourcePath);
        const panelPath =
            'apps/rallar-black-box/src/legacy/runner/distributed-recipes/DistributedRecipesPanel.tsx';
        const remotePath =
            'apps/rallar-black-box/src/legacy/runner/distributed-recipes/use-distributed-recipes-remote-state.ts';
        const builderPath =
            'apps/rallar-black-box/src/legacy/runner/distributed-recipes/use-distributed-recipe-builder.ts';
        const actionsPath =
            'apps/rallar-black-box/src/legacy/runner/distributed-recipes/use-distributed-recipes-actions.ts';
        const coreOwners = [
            {
                path: panelPath,
                declaration: 'DistributedRecipesPanel',
                lineCap: 200,
            },
            {
                path: remotePath,
                declaration: 'useDistributedRecipesRemoteState',
                typeAlias: 'DistributedRecipesRemoteStateModel',
                lineCap: 240,
            },
            {
                path: builderPath,
                declaration: 'useDistributedRecipeBuilder',
                typeAlias: 'DistributedRecipeBuilderModel',
                lineCap: 430,
            },
            {
                path: actionsPath,
                declaration: 'useDistributedRecipesActions',
                lineCap: 450,
            },
        ] as const;
        const sourceByPath = new Map<string, string>();

        for (const owner of coreOwners) {
            const ownerExists = existsSync(resolve(repositoryRoot, owner.path));
            const ownerSource = ownerExists ? repositorySource(owner.path) : '';
            sourceByPath.set(owner.path, ownerSource);

            expect.soft(ownerExists, owner.path).toBe(true);
            expect
                .soft(ownerSource, `${owner.path}: direct export`)
                .toMatch(
                    new RegExp(
                        `^\\s*export\\s+function\\s+${owner.declaration}\\s*\\(`,
                        'm',
                    ),
                );
            if ('typeAlias' in owner) {
                expect
                    .soft(ownerSource, `${owner.path}: inferred model alias`)
                    .toMatch(
                        new RegExp(
                            `^\\s*export\\s+type\\s+${owner.typeAlias}\\s*=\\s*\\n?\\s*ReturnType<\\s*typeof\\s+${owner.declaration}\\s*>;`,
                            'm',
                        ),
                    );
            }
            expect
                .soft(ownerSource, `${owner.path}: export-star facade`)
                .not.toMatch(/^\s*export\s*\*(?:\s+as\s+\w+)?\s+from\b/m);
            expect
                .soft(ownerSource, `${owner.path}: named re-export facade`)
                .not.toMatch(/^\s*export\s+(?:type\s+)?{[^}]+}\s*from\s*['"]/m);
            expect.soft(ownerSource, `${owner.path}: CSS import`).not.toMatch(
                /\b(?:from\s+|import\s*)['"][^'"]+\.css['"]/,
            );
            expect.soft(ownerSource, `${owner.path}: App.tsx import`).not.toMatch(
                /\b(?:from\s+|import\s*\(\s*)['"][^'"]*App\.tsx['"]/,
            );
            expect.soft(ownerSource, `${owner.path}: useCallback`).not.toMatch(
                /\buseCallback\b/,
            );
            expect.soft(
                ownerSource === ''
                    ? 0
                    : ownerSource.trimEnd().split(/\r?\n/).length,
                `${owner.path}: line count`,
            ).toBeLessThanOrEqual(owner.lineCap);
        }

        const panelSource = sourceByPath.get(panelPath) ?? '';
        const remoteSource = sourceByPath.get(remotePath) ?? '';
        const builderSource = sourceByPath.get(builderPath) ?? '';
        const actionsSource = sourceByPath.get(actionsPath) ?? '';

        expect.soft(appSource, 'App.tsx local panel owner').not.toMatch(
            /^\s*function\s+DistributedRecipesPanel\s*\(/m,
        );
        expect.soft(appSource, 'direct panel import').toMatch(
            /import\s*{\s*DistributedRecipesPanel\s*}\s*from\s*'\.\/legacy\/runner\/distributed-recipes\/DistributedRecipesPanel\.tsx';/,
        );
        const panelCalls = [
            ...appSource.matchAll(/<DistributedRecipesPanel\b([\s\S]*?)\/>/g),
        ];
        expect(panelCalls, 'App.tsx panel calls').toHaveLength(2);
        for (const panelCall of panelCalls) {
            const props = [
                ...panelCall[1].matchAll(/\b(\w+)=\{([^}]+)}/g),
            ].map((match) => [match[1], match[2]]);
            expect.soft(props, 'unchanged four panel props').toEqual([
                ['state', 'state'],
                ['bootstrap', 'bootstrap'],
                ['control', 'control'],
                ['globalValues', 'globalValues'],
            ]);
        }
        expect(appSource, 'Advanced distributed mount guard').toContain(
            `{surface === 'distributed' && (\n                    <div\n                        id="panel-distributed-recipes"\n                        className="workspace-grid tab-workspace distributed-recipes-tab-grid"\n                    >\n                        <DistributedRecipesPanel\n                            state={state}\n                            bootstrap={bootstrap}\n                            control={control}\n                            globalValues={globalValues}\n                        />\n                    </div>\n                )}`,
        );
        expect(appSource, 'legacy runner distributed mount guard').toContain(
            `{activeMode === 'black-box-runner' &&\n                        activeTab === 'distributed-recipes' && (\n                            <DistributedRecipesPanel\n                                state={state}\n                                bootstrap={bootstrap}\n                                control={control}\n                                globalValues={globalValues}\n                            />\n                        )}`,
        );

        const hookCalls = [
            'useDistributedRecipesRemoteState',
            'useDistributedRecipeBuilder',
            'useDistributedRecipesActions',
        ] as const;
        const hookCallPositions = hookCalls.map((hook) => {
            const calls = [...panelSource.matchAll(new RegExp(`\\b${hook}\\s*\\(`, 'g'))];
            expect.soft(calls, `${hook}: exact call count`).toHaveLength(1);
            return calls[0]?.index ?? -1;
        });
        expect.soft(hookCallPositions, 'remote -> builder -> actions call order').toEqual(
            [...hookCallPositions].sort((left, right) => left - right),
        );
        expect(panelSource, 'direct monitor progress input').toContain(
            'monitorAgentProgress: remote.selectedMonitor?.agentProgress,',
        );
        expect(panelSource, 'built-in React hook').not.toMatch(
            /\buse(?:State|Memo|Effect|Ref|Callback|Reducer|Context|LayoutEffect)\b/,
        );
        expect(panelSource, 'network manager runtime import').not.toMatch(
            /\bfrom\s*['"][^'"]*control-run-manager\.ts['"];/,
        );
        for (const action of [
            'refresh',
            'loadRun',
            'resolveTargets',
            'ensureCreatedDistributedRun',
            'createRun',
            'stageRun',
            'startRun',
            'cancelRun',
            'loadArtifact',
            'copyArtifact',
            'loadDistributedRun',
            'toggleRecipe',
            'toggleAgent',
            'selectRolePattern',
            'generateNewRunId',
            'changeDistributedRunId',
        ] as const) {
            expect.soft(panelSource, `composition-local action: ${action}`).not.toMatch(
                new RegExp(`\\b(?:const|function)\\s+${action}\\b`),
            );
        }

        const remoteStates = [
            ['baseUrl', 'setBaseUrl'],
            ['token', 'setToken'],
            ['selectedRunId', 'setSelectedRunId'],
            ['snapshot', 'setSnapshot'],
            ['run', 'setRun'],
            ['distributedRuns', 'setDistributedRuns'],
            ['selectedDistributedRun', 'setSelectedDistributedRun'],
            ['targetResolutionPreview', 'setTargetResolutionPreview'],
            ['artifactBundle', 'setArtifactBundle'],
            ['busyAction', 'setBusyAction'],
            ['error', 'setError'],
            ['lastAction', 'setLastAction'],
        ] as const;
        const builderStates = [
            ['distributedRunId', 'setDistributedRunId'],
            ['query', 'setQuery'],
            ['profile', 'setProfile'],
            ['selectedRecipeIds', 'setSelectedRecipeIds'],
            ['rtcRealtimeDurationSeconds', 'setRtcRealtimeDurationSeconds'],
            ['targetPolicyMode', 'setTargetPolicyMode'],
            ['rolePattern', 'setRolePattern'],
            ['expectedParticipantCount', 'setExpectedParticipantCount'],
            ['ackTimeoutMs', 'setAckTimeoutMs'],
            ['barrierEnabled', 'setBarrierEnabled'],
            ['barrierTimeoutMs', 'setBarrierTimeoutMs'],
            ['startMode', 'setStartMode'],
            ['startDelayMs', 'setStartDelayMs'],
            ['selectedAgentIds', 'setSelectedAgentIds'],
        ] as const;
        for (const [stateName, setterName] of remoteStates) {
            expect.soft(remoteSource, `remote state: ${stateName}`).toMatch(
                new RegExp(
                    `const\\s*\\[\\s*${stateName}\\s*,\\s*${setterName}\\s*]\\s*=\\s*useState\\b`,
                ),
            );
        }
        expect(
            [...remoteSource.matchAll(/]\s*=\s*useState\b/g)],
            'remote exact state count',
        ).toHaveLength(remoteStates.length);
        for (const memo of ['runOptions', 'currentDistributedRuns', 'selectedMonitor']) {
            expect.soft(remoteSource, `remote memo: ${memo}`).toMatch(
                new RegExp(`const\\s+${memo}\\s*=\\s*useMemo\\s*\\(`),
            );
        }
        expect(remoteSource, 'remote redacted error').toMatch(
            /const\s+redactedError\s*=\s*error\b/,
        );
        expect(remoteSource, 'remote effect/ref').not.toMatch(/\buse(?:Effect|Ref)\b/);
        expect(remoteSource, 'remote builder import').not.toMatch(
            /\bfrom\s*['"][^'"]*use-distributed-recipe-builder\.ts['"];/,
        );
        for (const request of [
            'fetchControlServerSnapshot',
            'fetchControlRunSnapshot',
            'fetchDistributedRuns',
            'fetchDistributedRun',
            'fetchDistributedRunArtifactBundle',
            'resolveDistributedTargets',
            'createDistributedRun',
            'stageDistributedRun',
            'startDistributedRun',
            'cancelDistributedRun',
        ] as const) {
            expect.soft(remoteSource, `remote request: ${request}`).not.toMatch(
                new RegExp(`\\b${request}\\b`),
            );
        }

        for (const [stateName, setterName] of builderStates) {
            expect.soft(builderSource, `builder state: ${stateName}`).toMatch(
                new RegExp(
                    `const\\s*\\[\\s*${stateName}\\s*,\\s*${setterName}\\s*]\\s*=\\s*useState\\b`,
                ),
            );
        }
        expect(
            [...builderSource.matchAll(/]\s*=\s*useState\b/g)],
            'builder exact state count',
        ).toHaveLength(builderStates.length);
        for (const derivation of [
            'groupRef',
            'recipeCatalog',
            'profileOptions',
            'filteredRecipes',
            'selectedRecipes',
            'selectedRecipePreflights',
            'selectedPreflightEffectiveOperations',
            'selectedPreflightWarnings',
            'selectedPreflightErrors',
            'selectedPreflightCommandKinds',
            'targetRows',
            'selectedAgentSet',
            'targetableRows',
            'usesWorldFleetTargets',
            'manifest',
            'manifestValidation',
            'worldFleetTargetGate',
            'activeTargetResolution',
            'worldFleetPreviewSelected',
            'worldFleetStageStartBlocked',
            'worldFleetBlockReason',
            'manifestAuthoringValidation',
            'distributedTargetAgentRows',
            'distributedTargetAgentSummary',
            'liveSelectedRecipeCount',
            'rtcRealtimeSelected',
            'rtcRealtimeFrameCount',
        ] as const) {
            expect.soft(builderSource, `builder derivation: ${derivation}`).toMatch(
                new RegExp(`\\bconst\\s+${derivation}\\b`),
            );
        }
        expect(builderSource, 'monitor progress fallback').toContain(
            'monitorAgentProgress: monitorAgentProgress ?? [],',
        );
        expect(builderSource, 'monitor progress dependency').toMatch(
            /\[\s*distributedRuns,\s*groupRef,\s*run,\s*selectedDistributedRun,\s*monitorAgentProgress,\s*selectedPreflightCommandKinds,\s*]/,
        );
        expect(builderSource, 'builder effect/ref').not.toMatch(/\buse(?:Effect|Ref)\b/);
        expect(builderSource, 'builder API action import').not.toMatch(
            /import(?!\s+type\b)\s*{[^}]*}\s*from\s*['"][^'"]*control-run-manager\.ts['"];/s,
        );

        expect(actionsSource, 'actions remote model type-only import').toMatch(
            /import\s+type\s*{\s*DistributedRecipesRemoteStateModel\s*}\s*from\s*'\.\/use-distributed-recipes-remote-state\.ts';/,
        );
        expect(actionsSource, 'actions builder model type-only import').toMatch(
            /import\s+type\s*{\s*DistributedRecipeBuilderModel\s*}\s*from\s*'\.\/use-distributed-recipe-builder\.ts';/,
        );
        expect(actionsSource, 'actions runtime model import').not.toMatch(
            /import(?!\s+type\b)[^;]*?from\s*['"]\.\/use-distributed-recipe(?:s-remote-state|-builder)\.ts['"];/,
        );
        expect(actionsSource, 'initial refresh ref owner').toMatch(
            /const\s+didInitialRefresh\s*=\s*useRef\(false\);/,
        );
        expect(
            [...actionsSource.matchAll(/\buseEffect\s*\(/g)],
            'actions exact effect count',
        ).toHaveLength(3);
        const effectMarkers = [
            'if (didInitialRefresh.current)',
            'setTargetResolutionPreview(undefined);',
            'const defaults = defaultDistributedRecipeTargetIds(targetRows);',
        ].map((marker) => actionsSource.indexOf(marker));
        expect.soft(effectMarkers.every((position) => position >= 0), 'effect markers').toBe(
            true,
        );
        expect.soft(effectMarkers, 'effect registration order').toEqual(
            [...effectMarkers].sort((left, right) => left - right),
        );
        expect(actionsSource, 'initial effect comment and suppression').toContain(
            `// The initial refresh intentionally uses the first rendered form values.\n        // eslint-disable-next-line react-hooks/exhaustive-deps\n    }, []);`,
        );
        expect(actionsSource, 'preview invalidation dependencies').toMatch(
            /}, \[\s*distributedRunId,\s*expectedParticipantCount,\s*groupRef\.applicationId,\s*groupRef\.groupId,\s*groupRef\.workspaceId,\s*rolePattern,\s*selectedRunId,\s*targetPolicyMode,\s*]\);/,
        );
        expect(actionsSource, 'target reconciliation dependencies').toContain(
            '}, [targetRows]);',
        );
        expect(actionsSource, 'canonical sameStringArray').toMatch(
            /import\s*{\s*sameStringArray\s*}\s*from\s*'\.\.\/\.\.\/shared\/same-string-array\.ts';/,
        );
        for (const action of [
            'refresh',
            'loadRun',
            'resolveTargets',
            'ensureCreatedDistributedRun',
            'createRun',
            'stageRun',
            'startRun',
            'cancelRun',
            'loadArtifact',
            'copyArtifact',
            'loadDistributedRun',
            'toggleRecipe',
            'toggleAgent',
            'selectRolePattern',
            'generateNewRunId',
            'changeDistributedRunId',
        ] as const) {
            expect.soft(actionsSource, `actions owner: ${action}`).toMatch(
                new RegExp(`\\bconst\\s+${action}\\b`),
            );
        }
        expect(actionsSource, 'change ID clear/set order').toMatch(
            /const changeDistributedRunId[\s\S]*?setDistributedRunId\(value\);[\s\S]*?setSelectedDistributedRun\(undefined\);[\s\S]*?setArtifactBundle\(undefined\);/,
        );
        expect(actionsSource, 'whole remote model effect dependency').not.toMatch(
            /},\s*\[[^\]]*(?:^|[,\s])remote(?:[,\s]|$)[^\]]*]\);/m,
        );
        expect(actionsSource, 'whole builder model effect dependency').not.toMatch(
            /},\s*\[[^\]]*(?:^|[,\s])builder(?:[,\s]|$)[^\]]*]\);/m,
        );

        expect([...builderSource.matchAll(/\bDate\.now\(\)/g)]).toHaveLength(4);
        expect([...actionsSource.matchAll(/\bDate\.now\(\)/g)]).toHaveLength(1);
        expect(remoteSource).not.toMatch(/\bDate\.now\(\)/);

        const targetPaths = new Set(coreOwners.map((owner) => owner.path));
        const dependencies = new Map<string, readonly string[]>();
        for (const owner of coreOwners) {
            dependencies.set(
                owner.path,
                [...(sourceByPath.get(owner.path) ?? '').matchAll(
                    /import(?!\s+type\b)[^;]*?\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g,
                )]
                    .map((match) => match[1] ?? match[2])
                    .filter((moduleImport) => moduleImport.startsWith('.'))
                    .map((moduleImport) =>
                        relative(
                            repositoryRoot,
                            resolve(
                                resolve(repositoryRoot, owner.path),
                                '..',
                                moduleImport,
                            ),
                        ),
                    )
                    .filter((dependency) => targetPaths.has(dependency)),
            );
        }
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) {
                cycles.push(path);
                return;
            }
            if (visited.has(path)) {
                return;
            }
            active.add(path);
            for (const dependency of dependencies.get(path) ?? []) {
                visit(dependency);
            }
            active.delete(path);
            visited.add(path);
        };
        for (const targetPath of targetPaths) {
            visit(targetPath);
        }
        expect(cycles, 'distributed recipe core runtime import cycles').toEqual([]);
    });

    it('keeps distributed recipe secondary state in exact focused section owners', () => {
        const appSource = repositorySource(appSourcePath);
        const panelPath =
            'apps/rallar-black-box/src/legacy/runner/distributed-recipes/DistributedRecipesPanel.tsx';
        const panelSource = existsSync(resolve(repositoryRoot, panelPath))
            ? repositorySource(panelPath)
            : '';
        const authoringSectionPath =
            'apps/rallar-black-box/src/legacy/runner/distributed-recipes/authoring/DistributedRecipeAuthoringSection.tsx';
        const historySectionPath =
            'apps/rallar-black-box/src/legacy/runner/distributed-recipes/history/DistributedRunHistorySection.tsx';
        const dateHelperPath =
            'apps/rallar-black-box/src/legacy/runner/distributed-recipes/history/date-input-epoch.ts';
        const sectionOwners = [
            {
                path: authoringSectionPath,
                importerPath: panelPath,
                moduleImport:
                    './authoring/DistributedRecipeAuthoringSection.tsx',
                declarations: ['DistributedRecipeAuthoringSection'],
                lineCap: 300,
            },
            {
                path: historySectionPath,
                importerPath: panelPath,
                moduleImport:
                    './history/DistributedRunHistorySection.tsx',
                declarations: ['DistributedRunHistorySection'],
                lineCap: 380,
            },
            {
                path: dateHelperPath,
                importerPath: historySectionPath,
                moduleImport: './date-input-epoch.ts',
                declarations: ['dateInputStartEpoch', 'dateInputEndEpoch'],
                lineCap: 30,
            },
        ] as const;

        const sourceByPath = new Map<string, string>();
        for (const owner of sectionOwners) {
            const ownerExists = existsSync(resolve(repositoryRoot, owner.path));
            const ownerSource = ownerExists ? repositorySource(owner.path) : '';
            sourceByPath.set(owner.path, ownerSource);

            expect.soft(ownerExists, owner.path).toBe(true);
            expect
                .soft(ownerSource, `${owner.path}: export-star facade`)
                .not.toMatch(/^\s*export\s*\*(?:\s+as\s+\w+)?\s+from\b/m);
            expect
                .soft(ownerSource, `${owner.path}: named re-export facade`)
                .not.toMatch(/^\s*export\s+(?:type\s+)?{[^}]+}\s*from\s*['"]/m);
            expect.soft(ownerSource, `${owner.path}: App.tsx import`).not.toMatch(
                /\b(?:from\s+|import\s*\(\s*)['"][^'"]*App\.tsx['"]/,
            );
            expect.soft(ownerSource, `${owner.path}: CSS import`).not.toMatch(
                /\b(?:from\s+|import\s*)['"][^'"]+\.css['"]/,
            );
            expect.soft(
                ownerSource === ''
                    ? 0
                    : ownerSource.trimEnd().split(/\r?\n/).length,
                `${owner.path}: line count`,
            ).toBeLessThanOrEqual(owner.lineCap);

            for (const declaration of owner.declarations) {
                expect
                    .soft(ownerSource, `${owner.path}: ${declaration} declaration`)
                    .toMatch(
                        new RegExp(
                            `^\\s*export\\s+function\\s+${declaration}\\s*\\(`,
                            'm',
                        ),
                    );
                expect
                    .soft(ownerSource, `${owner.path}: ${declaration} re-export`)
                    .not.toMatch(
                        new RegExp(
                            `^\\s*export\\s+(?:type\\s+)?{[^}]*\\b${declaration}\\b[^}]*}\\s*from\\s*['"]`,
                            'm',
                        ),
                    );
            }

            const importerSource =
                owner.importerPath === appSourcePath
                    ? appSource
                    : sourceByPath.get(owner.importerPath) ??
                      (existsSync(resolve(repositoryRoot, owner.importerPath))
                          ? repositorySource(owner.importerPath)
                          : '');
            const escapedModuleImport = owner.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const directImports = [
                ...importerSource.matchAll(
                    new RegExp(
                        `import\\s+(?:type\\s+)?{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                        'g',
                    ),
                ),
            ];
            expect.soft(directImports, `${owner.moduleImport}: direct import`).toHaveLength(
                1,
            );
            const importedSeams = directImports[0]?.[1] ?? '';
            for (const declaration of owner.declarations) {
                expect
                    .soft(importedSeams, `${owner.moduleImport}: ${declaration}`)
                    .toMatch(new RegExp(`\\b${declaration}\\b`));
            }
        }

        const targetPaths = new Set(sectionOwners.map((owner) => owner.path));
        const dependencies = new Map<string, readonly string[]>();
        for (const owner of sectionOwners) {
            dependencies.set(
                owner.path,
                [...(sourceByPath.get(owner.path) ?? '').matchAll(
                    /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g,
                )]
                    .map((match) => match[1] ?? match[2])
                    .filter((moduleImport) => moduleImport.startsWith('.'))
                    .map((moduleImport) =>
                        relative(
                            repositoryRoot,
                            resolve(
                                resolve(repositoryRoot, owner.path),
                                '..',
                                moduleImport,
                            ),
                        ),
                    )
                    .filter((dependency) => targetPaths.has(dependency)),
            );
        }
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) {
                cycles.push(path);
                return;
            }
            if (visited.has(path)) {
                return;
            }
            active.add(path);
            for (const dependency of dependencies.get(path) ?? []) {
                visit(dependency);
            }
            active.delete(path);
            visited.add(path);
        };
        for (const targetPath of targetPaths) {
            visit(targetPath);
        }
        expect(cycles, 'distributed recipe section import cycles').toEqual([]);

        for (const movedState of [
            'authoringTemplateId',
            'authoringDraftTarget',
            'authoringDraftText',
            'historyQuery',
            'historyStatus',
            'historyGroup',
            'historyRecipe',
            'historyProfile',
            'historyUser',
            'historyFailureType',
            'historyFromDate',
            'historyToDate',
            'compareLeftId',
            'compareRightId',
            'dateInputStartEpoch',
            'dateInputEndEpoch',
        ] as const) {
            expect.soft(panelSource, `parent-local ${movedState}`).not.toMatch(
                new RegExp(`\\b${movedState}\\b`),
            );
        }

        for (const helper of ['dateInputStartEpoch', 'dateInputEndEpoch'] as const) {
            const declarationOwners = sourceFilesUnder(
                'apps/rallar-black-box/src',
            ).filter((sourcePath) =>
                new RegExp(
                    `^\\s*(?:export\\s+)?function\\s+${helper}\\s*\\(`,
                    'm',
                ).test(repositorySource(sourcePath)),
            );
            expect(declarationOwners, `${helper}: exact owner`).toEqual([
                dateHelperPath,
            ]);
        }

        const authoringSource = sourceByPath.get(authoringSectionPath) ?? '';
        expect(
            authoringSource,
            'authoring section composes the existing authoring panel',
        ).toContain('<DistributedRecipeAuthoringPanel');
        for (const authoringSeam of [
            'distributedAuthoringDraftPreflights',
            'distributedPromptFeedbackFromValidation',
            'distributedRecipeSchemaContextText',
            'redactDistributedRecipePromptVariables',
            'renderDistributedRecipePromptTemplate',
            'renderDistributedRecipeValidationFeedback',
            'validateSchemaAuthoringText',
        ] as const) {
            expect.soft(authoringSource, `authoring helper: ${authoringSeam}`).toMatch(
                new RegExp(`\\b${authoringSeam}\\b`),
            );
        }
        expect(authoringSource, 'authoring panel declaration').not.toMatch(
            /^\s*export\s+function\s+DistributedRecipeAuthoringPanel\s*\(/m,
        );

        const historySource = sourceByPath.get(historySectionPath) ?? '';
        expect(
            historySource,
            'history section composes the existing compare panel',
        ).toContain('<DistributedRunComparePanel');
        expect(historySource, 'history compare panel declaration').not.toMatch(
            /^\s*export\s+function\s+DistributedRunComparePanel\s*\(/m,
        );
        expect(historySource, 'control snapshots type-only import').toMatch(
            /import\s+type\s*{(?=[^}]*\bControlDistributedRunSnapshot\b)(?=[^}]*\bControlRunSnapshot\b)[^}]*}\s*from\s*'\.\.\/\.\.\/\.\.\/\.\.\/control-run-manager\.ts';/s,
        );
        expect(historySource, 'control-run-manager runtime import').not.toMatch(
            /import(?!\s+type\b)\s*{[^}]*}\s*from\s*['"][^'"]*control-run-manager\.ts['"];/s,
        );
        expect(historySource, 'control-client runtime import').not.toMatch(
            /\bfrom\s*['"][^'"]*control-client\.ts['"];/,
        );
        for (const forbiddenHistoryBehavior of [
            /\buseEffect\b/,
            /\bfetch\s*\(/,
            /\bsetInterval\s*\(/,
            /\bsetTimeout\s*\(/,
            /\bRUNNER_DISTRIBUTED_POLL_MS\b/,
        ]) {
            expect
                .soft(historySource, `history behavior: ${forbiddenHistoryBehavior.source}`)
                .not.toMatch(forbiddenHistoryBehavior);
        }
        const historyPanelPosition = historySource.indexOf(
            'distributed-history-panel',
        );
        const comparePanelPosition = historySource.indexOf(
            '<DistributedRunComparePanel',
        );
        expect.soft(historyPanelPosition, 'history fragment first child').toBeGreaterThan(
            -1,
        );
        expect.soft(comparePanelPosition, 'history fragment second child').toBeGreaterThan(
            historyPanelPosition,
        );

        expect(appSource).not.toContain(
            "from './legacy/runner/distributed-recipes/authoring/DistributedRecipeAuthoringPanel.tsx';",
        );
        for (const sectionCall of [
            'DistributedRecipeAuthoringSection',
            'DistributedRunHistorySection',
        ] as const) {
            expect(
                [...panelSource.matchAll(new RegExp(`<${sectionCall}\\b`, 'g'))],
                `${sectionCall}: exact call count`,
            ).toHaveLength(1);
            const callSource = panelSource.match(
                new RegExp(`<${sectionCall}\\b[\\s\\S]*?\\/>`),
            )?.[0];
            expect.soft(callSource, `${sectionCall}: call`).toBeDefined();
            expect.soft(callSource ?? '', `${sectionCall}: no key reset`).not.toMatch(
                /\bkey\s*=/,
            );
        }
        expect(panelSource, 'unconditional authoring section child').toMatch(
            /^ {12}<DistributedRecipeAuthoringSection\b/m,
        );
        expect(panelSource, 'unconditional history section child').toMatch(
            /^ {16}<DistributedRunHistorySection\b/m,
        );

        const orderedCalls = [
            '<DistributedRecipesHeader',
            '<DistributedRecipeAuthoringSection',
            '<div className="distributed-layout">',
            '<DistributedRecipeCatalogPanel',
            '<DistributedTargetResolutionPanel',
            '<DistributedRunControlPanel',
            '<DistributedManifestPreviewPanel',
            '<DistributedRunMonitorPanel',
            '<DistributedRunHistorySection',
        ].map((marker) => panelSource.indexOf(marker));
        expect.soft(orderedCalls.every((position) => position >= 0), 'render calls').toBe(
            true,
        );
        expect.soft(orderedCalls, 'render order').toEqual(
            [...orderedCalls].sort((left, right) => left - right),
        );
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

    it('keeps the advanced workbench leaves in exact focused owners', () => {
        const appSource = repositorySource(appSourcePath);
        const manualRallarSectionPath =
            'apps/rallar-black-box/src/legacy/runner/manual/ManualRallarSection.tsx';
        const manualRallarSectionSource = existsSync(
            resolve(repositoryRoot, manualRallarSectionPath),
        )
            ? repositorySource(manualRallarSectionPath)
            : '';
        const localWorkbenchPath =
            'apps/rallar-black-box/src/legacy/runner/workbench/LocalWorkbenchSection.tsx';
        const workbenchOwners = [
            {
                path: 'apps/rallar-black-box/src/legacy/runner/workbench/WorkbenchPanel.tsx',
                seam: 'WorkbenchPanel',
                lineCap: 230,
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/workbench/ControlPanel.tsx',
                seam: 'ControlPanel',
                lineCap: 150,
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/workbench/BootstrapPanel.tsx',
                seam: 'BootstrapPanel',
                lineCap: 80,
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/workbench/ConfigurationPanel.tsx',
                seam: 'ConfigurationPanel',
                lineCap: 75,
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/workbench/CommandQueuePanel.tsx',
                seam: 'CommandQueuePanel',
                lineCap: 90,
            },
            {
                path: localWorkbenchPath,
                seam: 'LocalWorkbenchSection',
                lineCap: 100,
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/advanced/CommandHistoryPanel.tsx',
                seam: 'CommandHistoryPanel',
                lineCap: 90,
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/advanced/ReportPanel.tsx',
                seam: 'ReportPanel',
                lineCap: 120,
            },
        ] as const;
        const sourceByPath = new Map<string, string>();

        for (const owner of workbenchOwners) {
            const ownerExists = existsSync(resolve(repositoryRoot, owner.path));
            const ownerSource = ownerExists ? repositorySource(owner.path) : '';
            sourceByPath.set(owner.path, ownerSource);

            expect.soft(ownerExists, `${owner.path}: missing owner`).toBe(true);
            expect
                .soft(ownerSource, `${owner.path}: direct export`)
                .toMatch(
                    new RegExp(
                        `^\\s*export\\s+function\\s+${owner.seam}\\s*\\(`,
                        'm',
                    ),
                );
            expect
                .soft(ownerSource, `${owner.path}: export-star barrel`)
                .not.toMatch(/^\s*export\s*\*(?:\s+as\s+\w+)?\s+from\b/m);
            expect
                .soft(ownerSource, `${owner.path}: named re-export facade`)
                .not.toMatch(/^\s*export\s+(?:type\s+)?{[^}]+}\s*from\s*['"]/m);
            expect.soft(ownerSource, `${owner.path}: App.tsx import`).not.toMatch(
                /\b(?:from\s+|import\s*\(\s*)['"][^'"]*App\.tsx['"]/,
            );
            expect.soft(ownerSource, `${owner.path}: CSS import`).not.toMatch(
                /\b(?:from\s+|import\s*)['"][^'"]+\.css['"]/,
            );
            expect.soft(
                ownerSource === ''
                    ? 0
                    : ownerSource.trimEnd().split(/\r?\n/).length,
                `${owner.path}: line count`,
            ).toBeLessThanOrEqual(owner.lineCap);

            const declarationOwners = sourceFilesUnder(
                'apps/rallar-black-box/src',
            ).filter((sourcePath) =>
                new RegExp(
                    `^\\s*(?:export\\s+)?function\\s+${owner.seam}\\s*\\(`,
                    'm',
                ).test(repositorySource(sourcePath)),
            );
            expect.soft(declarationOwners, `${owner.seam}: exact owner`).toEqual([
                owner.path,
            ]);
        }

        const directImports = [
            {
                importerPath: appSourcePath,
                moduleImport:
                    './legacy/runner/workbench/LocalWorkbenchSection.tsx',
                seam: 'LocalWorkbenchSection',
            },
            {
                importerPath: appSourcePath,
                moduleImport:
                    './legacy/runner/advanced/CommandHistoryPanel.tsx',
                seam: 'CommandHistoryPanel',
            },
            {
                importerPath: appSourcePath,
                moduleImport: './legacy/runner/advanced/ReportPanel.tsx',
                seam: 'ReportPanel',
            },
            {
                importerPath: localWorkbenchPath,
                moduleImport: './WorkbenchPanel.tsx',
                seam: 'WorkbenchPanel',
            },
            {
                importerPath: localWorkbenchPath,
                moduleImport: './ControlPanel.tsx',
                seam: 'ControlPanel',
            },
            {
                importerPath: localWorkbenchPath,
                moduleImport: './BootstrapPanel.tsx',
                seam: 'BootstrapPanel',
            },
            {
                importerPath: localWorkbenchPath,
                moduleImport: './ConfigurationPanel.tsx',
                seam: 'ConfigurationPanel',
            },
            {
                importerPath: localWorkbenchPath,
                moduleImport: './CommandQueuePanel.tsx',
                seam: 'CommandQueuePanel',
            },
            {
                importerPath: localWorkbenchPath,
                moduleImport: '../advanced/ReportPanel.tsx',
                seam: 'ReportPanel',
            },
        ] as const;

        for (const directImport of directImports) {
            const importerSource =
                directImport.importerPath === appSourcePath
                    ? appSource
                    : sourceByPath.get(directImport.importerPath) ?? '';
            const escapedModuleImport = directImport.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const importMatches = [
                ...importerSource.matchAll(
                    new RegExp(
                        `import\\s*{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                        'g',
                    ),
                ),
            ];

            expect.soft(
                importMatches,
                `${directImport.importerPath}: ${directImport.moduleImport}`,
            ).toHaveLength(1);
            expect
                .soft(
                    importMatches[0]?.[1] ?? '',
                    `${directImport.moduleImport}: ${directImport.seam}`,
                )
                .toMatch(new RegExp(`\\b${directImport.seam}\\b`));
        }

        for (const movedDeclaration of [
            'WorkbenchPanel',
            'ControlPanel',
            'BootstrapPanel',
            'ConfigurationPanel',
            'CommandQueuePanel',
            'CommandHistoryPanel',
            'ReportPanel',
            'createReportSnapshot',
        ] as const) {
            expect
                .soft(appSource, `App.tsx local ${movedDeclaration}`)
                .not.toMatch(
                    new RegExp(
                        `^\\s*(?:export\\s+)?function\\s+${movedDeclaration}\\s*\\(`,
                        'm',
                    ),
                );
        }

        const localWorkbenchSource = sourceByPath.get(localWorkbenchPath) ?? '';
        const childMarkers = [
            '<WorkbenchPanel',
            '<ControlPanel',
            '<BootstrapPanel',
            '<ConfigurationPanel',
            '<CommandQueuePanel',
            '<ReportPanel',
        ] as const;
        const childPositions = childMarkers.map((marker) =>
            localWorkbenchSource.indexOf(marker),
        );
        expect.soft(
            childPositions.every((position) => position >= 0),
            'LocalWorkbenchSection: six children',
        ).toBe(true);
        expect.soft(childPositions, 'LocalWorkbenchSection: child order').toEqual(
            [...childPositions].sort((left, right) => left - right),
        );
        for (const childMarker of childMarkers) {
            expect.soft(
                [...localWorkbenchSource.matchAll(new RegExp(childMarker, 'g'))],
                `LocalWorkbenchSection: ${childMarker}`,
            ).toHaveLength(1);
        }
        expect(localWorkbenchSource, 'LocalWorkbenchSection: fragment return').toMatch(
            /return\s*\(\s*<>[\s\S]*<\/\>\s*\);/,
        );
        expect(localWorkbenchSource, 'LocalWorkbenchSection: no wrapper').not.toMatch(
            /<(?:section|div)\b/,
        );
        expect(
            [...localWorkbenchSource.matchAll(/\buseState(?:<[^>]+>)?\s*\(/g)],
            'LocalWorkbenchSection: no local state',
        ).toHaveLength(0);
        expect(localWorkbenchSource, 'LocalWorkbenchSection: no key').not.toMatch(
            /\bkey\s*=/,
        );

        const sectionCalls = [
            ...appSource.matchAll(/<LocalWorkbenchSection\b[\s\S]*?\/>/g),
        ].map((match) => match[0]);
        expect(sectionCalls, 'App.tsx: two live workbench instances').toHaveLength(2);
        for (const sectionCall of sectionCalls) {
            for (const prop of [
                'state',
                'bootstrap',
                'control',
                'authSession',
                'busy',
                'runState',
                'loadedFixtureId',
                'lastError',
                'queueRows',
                'selectedCommandId',
                'onSelectCommand',
            ] as const) {
                expect.soft(sectionCall, `LocalWorkbenchSection prop: ${prop}`).toMatch(
                    new RegExp(`\\b${prop}\\s*=`),
                );
            }
            expect.soft(sectionCall, 'LocalWorkbenchSection call: no key').not.toMatch(
                /\bkey\s*=/,
            );
        }
        expect(
            [...appSource.matchAll(/^ {20}<LocalWorkbenchSection\b/gm)],
            'App.tsx: both workbenches mount as unconditional direct children',
        ).toHaveLength(2);

        const runnerWrapper = appSource.match(
            /<div\s+id="panel-local-workbench"[\s\S]*?<\/div>/,
        )?.[0] ?? '';
        expect(runnerWrapper, 'RunnerAdvanced local workbench wrapper').toContain(
            'className="workspace-grid tab-workspace workbench-tab-grid"',
        );
        expect(runnerWrapper, 'RunnerAdvanced hidden ownership').toContain(
            "hidden={surface !== 'workbench'}",
        );
        expect(
            [...runnerWrapper.matchAll(/<LocalWorkbenchSection\b/g)],
            'RunnerAdvanced local instance',
        ).toHaveLength(1);

        const legacyWrapper = appSource.match(
            /<section\s+id="legacy-panel-local-workbench"[\s\S]*?<\/section>/,
        )?.[0] ?? '';
        for (const wrapperMarker of [
            'className="workspace-grid tab-workspace workbench-tab-grid"',
            'role="tabpanel"',
            'aria-labelledby="tab-local-workbench"',
            "hidden={activeTab !== 'local-workbench'}",
        ] as const) {
            expect.soft(
                legacyWrapper,
                `legacy local workbench wrapper: ${wrapperMarker}`,
            ).toContain(wrapperMarker);
        }
        expect(
            [...legacyWrapper.matchAll(/<LocalWorkbenchSection\b/g)],
            'legacy local workbench instance',
        ).toHaveLength(1);

        const workbenchSource =
            sourceByPath.get(workbenchOwners[0].path) ?? '';
        const controlSource = sourceByPath.get(workbenchOwners[1].path) ?? '';
        const reportSource = sourceByPath.get(workbenchOwners[7].path) ?? '';
        expect(
            [...workbenchSource.matchAll(/\buseState(?:<[^>]+>)?\s*\(/g)],
            'WorkbenchPanel: exact state count',
        ).toHaveLength(4);
        expect(
            [...workbenchSource.matchAll(/\buseMemo\s*\(/g)],
            'WorkbenchPanel: exact validation memo count',
        ).toHaveLength(2);
        expect(
            [...workbenchSource.matchAll(/\buseEffect\s*\(/g)],
            'WorkbenchPanel: no effects',
        ).toHaveLength(0);
        expect(workbenchSource, 'WorkbenchPanel: no loaded fixture sync').not.toMatch(
            /useEffect[\s\S]*loadedFixtureId/,
        );
        const runtimeOperations = [
            'loadRecipeFromJson',
            'runLoadedRecipe',
            'cancelRecipe',
            'resetWorkbench',
            'executeCommandFromJson',
        ] as const;
        const operationPositions = runtimeOperations.map((operation) =>
            workbenchSource.indexOf(`rallarBlackBoxRuntimeStore.${operation}`),
        );
        expect.soft(
            operationPositions.every((position) => position >= 0),
            'WorkbenchPanel: runtime-store operations',
        ).toBe(true);
        expect.soft(operationPositions, 'WorkbenchPanel: runtime-store call order').toEqual(
            [...operationPositions].sort((left, right) => left - right),
        );

        expect(
            [...controlSource.matchAll(/\buseState(?:<[^>]+>)?\s*\(/g)],
            'ControlPanel: exact state count',
        ).toHaveLength(3);
        expect(
            [...controlSource.matchAll(/\buseEffect\s*\(/g)],
            'ControlPanel: exact effect count',
        ).toHaveLength(2);
        expect(controlSource, 'ControlPanel: config backfill dependencies').toMatch(
            /}, \[agentId, config\?\.agentId, config\?\.runId, runId\]\);/,
        );
        expect(controlSource, 'ControlPanel: URL backfill dependencies').toMatch(
            /}, \[control\.url, url\.length\]\);/,
        );

        expect(reportSource, 'ReportPanel: private snapshot helper').toMatch(
            /^\s*function\s+createReportSnapshot\s*\(/m,
        );
        expect(reportSource, 'ReportPanel: snapshot helper is not exported').not.toMatch(
            /^\s*export\s+function\s+createReportSnapshot\s*\(/m,
        );
        expect(
            [...reportSource.matchAll(/\bDate\.now\(\)/g)],
            'ReportPanel: exact snapshot clock call',
        ).toHaveLength(1);
        expect(
            [...reportSource.matchAll(/\buseState(?:<[^>]+>)?\s*\(/g)],
            'ReportPanel: visibility state',
        ).toHaveLength(1);
        expect(reportSource, 'ReportPanel: snapshot recomputation site').toMatch(
            /useMemo\(\s*\(\) => redactedJson\(createReportSnapshot\(state\), state, authSession\),\s*\[authSession, state],\s*\)/,
        );

        for (const owner of workbenchOwners) {
            const ownerSource = sourceByPath.get(owner.path) ?? '';
            expect.soft(ownerSource, `${owner.path}: no useCallback`).not.toMatch(
                /\buseCallback\b/,
            );
            expect.soft(ownerSource, `${owner.path}: no polling`).not.toMatch(
                /\b(?:setInterval|setTimeout)\s*\(/,
            );
            expect.soft(ownerSource, `${owner.path}: no native fetch`).not.toMatch(
                /\bfetch\s*\(/,
            );
        }
        for (const ownerIndex of [2, 3, 4, 6] as const) {
            const owner = workbenchOwners[ownerIndex];
            const ownerSource = sourceByPath.get(owner.path) ?? '';
            expect.soft(ownerSource, `${owner.path}: no effects`).not.toMatch(
                /\buseEffect\b/,
            );
            expect.soft(ownerSource, `${owner.path}: no runtime API`).not.toMatch(
                /\brallarBlackBoxRuntimeStore\b/,
            );
        }

        expect(
            [...appSource.matchAll(/<CommandHistoryPanel\b/g)],
            'App.tsx: non-manual command history consumer',
        ).toHaveLength(1);
        expect(
            [...manualRallarSectionSource.matchAll(/<CommandHistoryPanel\b/g)],
            'ManualRallarSection: canonical manual command history composition',
        ).toHaveLength(1);
        expect(
            [...appSource.matchAll(/<ReportPanel\b/g)],
            'App.tsx: non-workbench report consumer',
        ).toHaveLength(1);

        const targetPaths = new Set(workbenchOwners.map((owner) => owner.path));
        const dependencies = new Map<string, readonly string[]>();
        for (const owner of workbenchOwners) {
            dependencies.set(
                owner.path,
                [...(sourceByPath.get(owner.path) ?? '').matchAll(
                    /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g,
                )]
                    .map((match) => match[1] ?? match[2])
                    .filter((moduleImport) => moduleImport.startsWith('.'))
                    .map((moduleImport) =>
                        relative(
                            repositoryRoot,
                            resolve(
                                resolve(repositoryRoot, owner.path),
                                '..',
                                moduleImport,
                            ),
                        ),
                    )
                    .filter((dependency) => targetPaths.has(dependency)),
            );
        }
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) {
                cycles.push(path);
                return;
            }
            if (visited.has(path)) {
                return;
            }
            active.add(path);
            for (const dependency of dependencies.get(path) ?? []) {
                visit(dependency);
            }
            active.delete(path);
            visited.add(path);
        };
        for (const targetPath of targetPaths) {
            visit(targetPath);
        }
        expect(cycles, 'advanced workbench import cycles').toEqual([]);
    });

    it('keeps the manual Rallar domain in exact controlled owners', () => {
        const appSource = repositorySource(appSourcePath);
        const stringValuePath =
            'apps/rallar-black-box/src/legacy/shared/string-value.ts';
        const defaultsPath =
            'apps/rallar-black-box/src/legacy/runner/manual/manual-workbench-defaults.ts';
        const hookPath =
            'apps/rallar-black-box/src/legacy/runner/manual/use-manual-rallar-workbench.ts';
        const inputsPath =
            'apps/rallar-black-box/src/legacy/runner/manual/ManualRallarInputsPanel.tsx';
        const executionPath =
            'apps/rallar-black-box/src/legacy/runner/manual/ManualRallarExecutionPanel.tsx';
        const workbenchPath =
            'apps/rallar-black-box/src/legacy/runner/manual/ManualRallarWorkbenchPanel.tsx';
        const inboxPath =
            'apps/rallar-black-box/src/legacy/runner/manual/ReceivedDataInboxPanel.tsx';
        const sectionPath =
            'apps/rallar-black-box/src/legacy/runner/manual/ManualRallarSection.tsx';
        const manualOwners = [
            {
                path: stringValuePath,
                declarations: ['stringValue'],
                lineCap: 15,
            },
            {
                path: defaultsPath,
                declarations: ['manualValuesFromState', 'actionLabel'],
                lineCap: 180,
            },
            {
                path: hookPath,
                declarations: ['useManualRallarWorkbench'],
                lineCap: 450,
            },
            {
                path: inputsPath,
                declarations: ['ManualRallarInputsPanel'],
                lineCap: 350,
            },
            {
                path: executionPath,
                declarations: ['ManualRallarExecutionPanel'],
                lineCap: 300,
            },
            {
                path: workbenchPath,
                declarations: ['ManualRallarWorkbenchPanel'],
                lineCap: 140,
            },
            {
                path: inboxPath,
                declarations: ['ReceivedDataInboxPanel'],
                lineCap: 100,
            },
            {
                path: sectionPath,
                declarations: ['ManualRallarSection'],
                lineCap: 100,
            },
        ] as const;
        const sourceByPath = new Map<string, string>();

        for (const owner of manualOwners) {
            const ownerExists = existsSync(resolve(repositoryRoot, owner.path));
            const ownerSource = ownerExists ? repositorySource(owner.path) : '';
            sourceByPath.set(owner.path, ownerSource);

            expect.soft(ownerExists, `${owner.path}: missing owner`).toBe(true);
            expect
                .soft(ownerSource, `${owner.path}: export-star barrel`)
                .not.toMatch(/^\s*export\s*\*(?:\s+as\s+\w+)?\s+from\b/m);
            expect
                .soft(ownerSource, `${owner.path}: named re-export facade`)
                .not.toMatch(/^\s*export\s+(?:type\s+)?{[^}]+}\s*from\s*['"]/m);
            expect.soft(ownerSource, `${owner.path}: App.tsx import`).not.toMatch(
                /\b(?:from\s+|import\s*\(\s*)['"][^'"]*App\.tsx['"]/,
            );
            expect.soft(ownerSource, `${owner.path}: CSS import`).not.toMatch(
                /\b(?:from\s+|import\s*)['"][^'"]+\.css['"]/,
            );
            expect.soft(ownerSource, `${owner.path}: routes or runner contracts`).not.toMatch(
                /\bfrom\s*['"][^'"]*(?:app-tabs|runner-contracts)\.ts['"]/,
            );
            expect.soft(
                ownerSource === ''
                    ? 0
                    : ownerSource.trimEnd().split(/\r?\n/).length,
                `${owner.path}: line count`,
            ).toBeLessThanOrEqual(owner.lineCap);

            for (const declaration of owner.declarations) {
                expect
                    .soft(ownerSource, `${owner.path}: direct ${declaration} export`)
                    .toMatch(
                        new RegExp(
                            `^\\s*export\\s+function\\s+${declaration}\\s*(?:<[^>]+>)?\\s*\\(`,
                            'm',
                        ),
                    );
            }
        }

        for (const owner of manualOwners.slice(1)) {
            for (const declaration of owner.declarations) {
                const declarationOwners = sourceFilesUnder(
                    'apps/rallar-black-box/src',
                ).filter((sourcePath) =>
                    new RegExp(
                        `^\\s*(?:export\\s+)?function\\s+${declaration}\\s*(?:<[^>]+>)?\\s*\\(`,
                        'm',
                    ).test(repositorySource(sourcePath)),
                );
                expect.soft(
                    declarationOwners,
                    `${declaration}: exact declaration owner`,
                ).toEqual([owner.path]);
            }
        }

        const sourceFor = (path: string): string =>
            path === appSourcePath
                ? appSource
                : sourceByPath.get(path) ??
                  (existsSync(resolve(repositoryRoot, path))
                      ? repositorySource(path)
                      : '');
        const directImports = [
            {
                importerPath: appSourcePath,
                moduleImport: './legacy/shared/string-value.ts',
                seams: ['stringValue'],
            },
            {
                importerPath: appSourcePath,
                moduleImport:
                    './legacy/runner/manual/ManualRallarSection.tsx',
                seams: ['ManualRallarSection'],
            },
            {
                importerPath: defaultsPath,
                moduleImport: '../../shared/string-value.ts',
                seams: ['stringValue'],
            },
            {
                importerPath: hookPath,
                moduleImport: './manual-workbench-defaults.ts',
                seams: ['manualValuesFromState', 'actionLabel'],
            },
            {
                importerPath: workbenchPath,
                moduleImport: './use-manual-rallar-workbench.ts',
                seams: ['useManualRallarWorkbench'],
            },
            {
                importerPath: workbenchPath,
                moduleImport: './ManualRallarInputsPanel.tsx',
                seams: ['ManualRallarInputsPanel'],
            },
            {
                importerPath: workbenchPath,
                moduleImport: './ManualRallarExecutionPanel.tsx',
                seams: ['ManualRallarExecutionPanel'],
            },
            {
                importerPath: sectionPath,
                moduleImport: './ManualRallarWorkbenchPanel.tsx',
                seams: ['ManualRallarWorkbenchPanel'],
            },
            {
                importerPath: sectionPath,
                moduleImport: './ReceivedDataInboxPanel.tsx',
                seams: ['ReceivedDataInboxPanel'],
            },
            {
                importerPath: sectionPath,
                moduleImport: '../advanced/CommandHistoryPanel.tsx',
                seams: ['CommandHistoryPanel'],
            },
        ] as const;

        for (const directImport of directImports) {
            const importerSource = sourceFor(directImport.importerPath);
            const escapedModuleImport = directImport.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const importMatches = [
                ...importerSource.matchAll(
                    new RegExp(
                        `import\\s*(?:type\\s*)?{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                        'g',
                    ),
                ),
            ];
            expect.soft(
                importMatches,
                `${directImport.importerPath}: ${directImport.moduleImport}`,
            ).toHaveLength(1);
            for (const seam of directImport.seams) {
                expect
                    .soft(
                        importMatches[0]?.[1] ?? '',
                        `${directImport.moduleImport}: ${seam}`,
                    )
                    .toMatch(new RegExp(`\\b${seam}\\b`));
            }
        }

        for (const viewPath of [inputsPath, executionPath] as const) {
            expect.soft(
                sourceFor(viewPath),
                `${viewPath}: type-only workbench model import`,
            ).toMatch(
                /import\s+type\s*{\s*ManualRallarWorkbenchModel\s*}\s*from\s*'\.\/use-manual-rallar-workbench\.ts';/,
            );
        }

        for (const declaration of [
            'manualTransportFrom',
            'stringValue',
            'booleanValue',
            'jsonTextValue',
            'numberValue',
            'manualValuesFromState',
            'actionLabel',
            'ManualRallarWorkbenchPanel',
            'ReceivedDataInboxPanel',
        ] as const) {
            expect
                .soft(appSource, `App.tsx local ${declaration}`)
                .not.toMatch(
                    new RegExp(
                        `^\\s*(?:export\\s+)?function\\s+${declaration}\\s*(?:<[^>]+>)?\\s*\\(`,
                        'm',
                    ),
                );
        }
        expect(
            [...appSource.matchAll(/\bstringValue\s*\(/g)],
            'App.tsx: all unaffected stringValue consumers use the shared import',
        ).toHaveLength(42);
        for (const movedMarker of [
            'title="Manual Rallar Inputs"',
            '<h3>RTC Delivery Matrix</h3>',
            '<h2>Received Data</h2>',
        ] as const) {
            expect.soft(appSource, `App.tsx moved JSX: ${movedMarker}`).not.toContain(
                movedMarker,
            );
        }

        const sectionCalls = [
            ...appSource.matchAll(/<ManualRallarSection\b([\s\S]*?)\/>/g),
        ];
        expect(sectionCalls, 'App.tsx: two live manual controller instances').toHaveLength(
            2,
        );
        const expectedSectionProps = [
            'state',
            'bootstrap',
            'authSession',
            'globalValues',
            'globalValuesEdited',
            'busy',
            'history',
            'selectedCommandId',
            'onSelectCommand',
            'onGlobalValueChange',
        ] as const;
        for (const sectionCall of sectionCalls) {
            const propNames = [
                ...(sectionCall[1] ?? '').matchAll(/\b(\w+)=\{/g),
            ].map((match) => match[1]);
            expect.soft(propNames, 'ManualRallarSection: exact ordered props').toEqual(
                expectedSectionProps,
            );
            expect.soft(sectionCall[0], 'ManualRallarSection call: no key').not.toMatch(
                /\bkey\s*=/,
            );
        }
        expect(
            sectionCalls[0]?.[0] ?? '',
            'RunnerAdvanced preserves selected history expression',
        ).toContain('history={selectRallarBlackBoxCommandHistory(state)}');
        expect(
            sectionCalls[1]?.[0] ?? '',
            'legacy App preserves selected history binding',
        ).toContain('history={history}');
        expect(
            [...appSource.matchAll(/^ {20}<ManualRallarSection\b/gm)],
            'App.tsx: both manual sections are unconditional direct children',
        ).toHaveLength(2);
        for (const legacyChild of [
            'ManualRallarWorkbenchPanel',
            'ReceivedDataInboxPanel',
            'CommandHistoryPanel',
        ] as const) {
            expect(
                [...appSource.matchAll(new RegExp(`<${legacyChild}\\b`, 'g'))],
                `App.tsx: no direct old manual cluster child ${legacyChild}`,
            ).toHaveLength(legacyChild === 'CommandHistoryPanel' ? 1 : 0);
        }

        const runnerWrapper = appSource.match(
            /<div\s+id="panel-manual-rallar"[\s\S]*?<\/div>/,
        )?.[0] ?? '';
        for (const wrapperMarker of [
            'className="workspace-grid tab-workspace manual-tab-grid"',
            "hidden={surface !== 'manual'}",
        ] as const) {
            expect.soft(
                runnerWrapper,
                `RunnerAdvanced manual wrapper: ${wrapperMarker}`,
            ).toContain(wrapperMarker);
        }
        expect(
            [...runnerWrapper.matchAll(/<ManualRallarSection\b/g)],
            'RunnerAdvanced manual instance',
        ).toHaveLength(1);

        const legacyWrapper = appSource.match(
            /<section\s+id="legacy-panel-manual-rallar"[\s\S]*?<\/section>/,
        )?.[0] ?? '';
        for (const wrapperMarker of [
            'className="workspace-grid tab-workspace manual-tab-grid"',
            'role="tabpanel"',
            'aria-labelledby="tab-manual-rallar"',
            "hidden={activeTab !== 'manual-rallar'}",
        ] as const) {
            expect.soft(
                legacyWrapper,
                `legacy manual wrapper: ${wrapperMarker}`,
            ).toContain(wrapperMarker);
        }
        expect(
            [...legacyWrapper.matchAll(/<ManualRallarSection\b/g)],
            'legacy manual instance',
        ).toHaveLength(1);

        const hookSource = sourceFor(hookPath);
        const normalizedHookSource = hookSource.replace(/\s+/g, ' ');
        expect(hookSource, 'hook inferred model alias').toMatch(
            /^\s*export\s+type\s+ManualRallarWorkbenchModel\s*=\s*\n?\s*ReturnType<\s*typeof\s+useManualRallarWorkbench\s*>;/m,
        );
        expect(hookSource, 'hook has no render-only busy input').not.toMatch(/\bbusy\b/);
        expect(hookSource, 'hook has no useCallback').not.toMatch(/\buseCallback\b/);
        expect(
            [...hookSource.matchAll(/\buseState(?:<[^>]+>)?\s*\(/g)],
            'manual hook: exact state count',
        ).toHaveLength(9);
        const stateMarkers = [
            'const [initialDraft] = useState(() => {',
            'const [values, setValues] = useState<ManualWorkbenchValues>(',
            'const [valuesEdited, setValuesEdited] = useState(initialDraft.restored);',
            'const [payloadPresetId, setPayloadPresetId] = useState(',
            'const [payloadText, setPayloadText] = useState(',
            'const [sequence, setSequence] = useState(1);',
            'const [history, setHistory] = useState<readonly ManualActionHistoryEntry[]>(',
            'const [localError, setLocalError] = useState<string | undefined>();',
            'const [recipeVisible, setRecipeVisible] = useState(false);',
        ] as const;
        const statePositions = stateMarkers.map((marker) =>
            normalizedHookSource.indexOf(marker),
        );
        expect.soft(
            statePositions.every((position) => position >= 0),
            'manual hook: state initializers',
        ).toBe(true);
        expect.soft(statePositions, 'manual hook: state order').toEqual(
            [...statePositions].sort((left, right) => left - right),
        );
        expect(normalizedHookSource, 'manual hook: lazy payload text').toContain(
            'const [payloadText, setPayloadText] = useState( () => initialDraft.draft.payloadText, );',
        );

        expect(
            [...hookSource.matchAll(/\buseMemo(?:<[^>]+>)?\s*\(/g)],
            'manual hook: exact memo count',
        ).toHaveLength(9);
        const memoSpecs = [
            {
                marker: 'const defaultValues = useMemo(',
                dependencies:
                    '[authSession,bootstrap,globalValues?.apiBaseUrl,globalValues?.applicationId,globalValues?.clientId,globalValues?.roomId,globalValues?.sessionId,globalValues?.workspaceId,state.currentConfig]',
            },
            {
                marker: 'const defaultDraft = useMemo<ManualWorkbenchDraft>(',
                dependencies: '[defaultValues]',
            },
            {
                marker: 'const payloadResult = useMemo(',
                dependencies: '[payloadText]',
            },
            {
                marker: 'const previewCommands = useMemo(',
                dependencies: '[payloadResult,sequence,values]',
            },
            {
                marker: 'const recipeText = useMemo(',
                dependencies: '[history]',
            },
            {
                marker: 'const negativeRecipeText = useMemo(',
                dependencies: '[payloadResult,values]',
            },
            {
                marker: 'const previewRecipeValidation = useMemo(',
                dependencies: '[payloadResult.ok,previewCommands]',
            },
            {
                marker: 'const manualRecipeValidation = useMemo(',
                dependencies: '[recipeText]',
            },
            {
                marker: 'const negativeRecipeValidation = useMemo(',
                dependencies: '[negativeRecipeText,payloadResult.ok]',
            },
        ] as const;
        const memoPositions = memoSpecs.map((spec) => hookSource.indexOf(spec.marker));
        expect.soft(
            memoPositions.every((position) => position >= 0),
            'manual hook: memo declarations',
        ).toBe(true);
        expect.soft(memoPositions, 'manual hook: memo order').toEqual(
            [...memoPositions].sort((left, right) => left - right),
        );
        for (const [index, memoSpec] of memoSpecs.entries()) {
            const segment = hookSource.slice(
                memoPositions[index],
                memoPositions[index + 1] ??
                    hookSource.indexOf('useEffect(', memoPositions[index]),
            );
            expect.soft(
                segment.replace(/\s+/g, '').replace(/,]/g, ']'),
                `manual hook memo dependencies: ${memoSpec.marker}`,
            ).toContain(memoSpec.dependencies);
        }
        expect(
            [...hookSource.matchAll(/selectRallarBlackBoxEvents\(state\)/g)],
            'manual hook: one plain events selector',
        ).toHaveLength(1);
        expect(normalizedHookSource, 'manual hook: events are not memoized').toContain(
            'const events = selectRallarBlackBoxEvents(state);',
        );

        const effectMatches = [...hookSource.matchAll(/\buseEffect\s*\(/g)];
        expect(effectMatches, 'manual hook: exact effect count').toHaveLength(4);
        const effectSpecs = [
            {
                marker: 'if(!valuesEdited){setValues(defaultValues);}',
                dependencies: '[defaultValues,valuesEdited]',
            },
            {
                marker: 'if(!authSession){return;}',
                dependencies:
                    '[authSession?.clientId,authSession?.sessionId,authSession?.username,globalValues?.clientId,globalValues?.sessionId]',
            },
            {
                marker: 'if(!globalValues||!globalValuesEdited){return;}',
                dependencies:
                    '[globalValues?.apiBaseUrl,globalValues?.applicationId,globalValues?.clientId,globalValues?.roomId,globalValues?.sessionId,globalValues?.workspaceId,globalValuesEdited]',
            },
            {
                marker: 'writeManualWorkbenchDraft(',
                dependencies:
                    '[authSession?.accessToken,payloadPresetId,payloadText,state.currentConfig?.redaction,values]',
            },
        ] as const;
        for (const [index, effectSpec] of effectSpecs.entries()) {
            const effectStart = effectMatches[index]?.index ?? -1;
            const effectEnd =
                effectMatches[index + 1]?.index ?? hookSource.indexOf('const updateValue');
            const compactEffect = hookSource
                .slice(effectStart, effectEnd)
                .replace(/\s+/g, '')
                .replace(/,]/g, ']');
            expect.soft(
                compactEffect,
                `manual hook effect body ${index + 1}`,
            ).toContain(effectSpec.marker);
            expect.soft(
                compactEffect,
                `manual hook effect dependencies ${index + 1}`,
            ).toContain(effectSpec.dependencies);
        }
        expect(
            hookSource.replace(/\s+/g, ''),
            'manual hook: persistence uses exact redacted secrets',
        ).toContain(
            'uiSecretValues(state,authSession,[values.rallarPassword]),',
        );
        expect(
            hookSource.replace(/\s+/g, ''),
            'manual hook: auth equality fast path',
        ).toContain(
            'returncurrent.actor===nextValues.actor&&current.sessionId===nextValues.sessionId&&current.rallarUsername===nextValues.rallarUsername&&current.rallarRestoreSession===nextValues.rallarRestoreSession?current:nextValues;',
        );
        expect(
            hookSource.replace(/\s+/g, ''),
            'manual hook: global equality fast path',
        ).toContain(
            'returncurrent.apiBaseUrl===nextValues.apiBaseUrl&&current.applicationId===nextValues.applicationId&&current.workspaceId===nextValues.workspaceId&&current.actor===nextValues.actor&&current.sessionId===nextValues.sessionId&&current.groupId===nextValues.groupId?current:nextValues;',
        );

        const actionSlice = (start: string, end: string): string => {
            const startPosition = hookSource.indexOf(start);
            const endPosition = hookSource.indexOf(end, startPosition + start.length);
            return hookSource.slice(
                startPosition,
                endPosition >= 0 ? endPosition : undefined,
            );
        };
        const updateValueSource = actionSlice('const updateValue', 'const selectPreset');
        expect.soft(
            updateValueSource.indexOf('setValuesEdited(true)'),
            'manual hook: edited flag before merge',
        ).toBeLessThan(updateValueSource.indexOf('setValues((current)'));
        const selectPresetSource = actionSlice(
            'const selectPreset',
            'const runManualCommandSet',
        ).replace(/\s+/g, '');
        expect(selectPresetSource, 'manual hook: preset id first').toContain(
            'setPayloadPresetId(presetId);constpreset=',
        );
        expect(selectPresetSource, 'manual hook: custom preset keeps text').toContain(
            'if(preset){setPayloadText(JSON.stringify(preset.payload,null,2));}',
        );

        const commandSetSource = actionSlice(
            'const runManualCommandSet',
            'const runManualAction',
        );
        const commandSetPositions = [
            'setSequence((current) => current + commands.length + 1)',
            'setHistory((current) => [...current, entry].slice(-12))',
            'onSelectCommand(entry.commandIds.at(-1) ?? entry.commandIds[0])',
            'try {',
            'await rallarBlackBoxRuntimeStore.executeManualCommands(',
        ].map((marker) => commandSetSource.indexOf(marker));
        expect.soft(
            commandSetPositions.every((position) => position >= 0),
            'manual hook: optimistic command sequencing markers',
        ).toBe(true);
        expect.soft(
            commandSetPositions,
            'manual hook: optimistic updates happen before await',
        ).toEqual([...commandSetPositions].sort((left, right) => left - right));

        const manualActionSource = actionSlice(
            'const runManualAction',
            'const runRtcMatrix',
        ).replace(/\s+/g, '');
        expect(manualActionSource, 'manual hook: send-only invalid payload block').toContain(
            "if(action==='send'&&!payloadResult.ok){setLocalError(payloadResult.error);return;}",
        );
        expect(manualActionSource, 'manual hook: exact group propagation actions').toContain(
            "['configure','join','connect','send'].includes(action)",
        );
        expect(manualActionSource, 'manual hook: group propagation target').toContain(
            "onGlobalValueChange('roomId',selectedGroupId);",
        );
        for (const marker of [
            'const label = `RTC ${transport} delivery matrix`;',
            "'RTC not-yet-in-sync probe'",
            'realtime.length + 2',
            "recipeId: 'manual-rtc-delivery-matrix'",
            'void navigator.clipboard.writeText(recipeText)',
            'void navigator.clipboard.writeText(negativeRecipeText)',
        ] as const) {
            expect.soft(hookSource, `manual hook action marker: ${marker}`).toContain(
                marker,
            );
        }

        const inputsSource = sourceFor(inputsPath);
        expect(inputsSource, 'inputs view: fragment return').toMatch(
            /return\s*\(\s*<>[\s\S]*<\/\>\s*\);/,
        );
        expect(
            [...inputsSource.matchAll(/<CollapsiblePanelSection\b/g)],
            'inputs view: exact two input blocks',
        ).toHaveLength(2);
        const inputBlockPositions = [
            'title="Manual Rallar Inputs"',
            'title="Manual Payload"',
        ].map((marker) => inputsSource.indexOf(marker));
        expect.soft(
            inputBlockPositions,
            'inputs view: input then payload block order',
        ).toEqual([...inputBlockPositions].sort((left, right) => left - right));
        const inlinePayloadPositions = [
            "setPayloadPresetId('custom')",
            'setPayloadText(event.target.value)',
        ].map((marker) => inputsSource.indexOf(marker));
        expect.soft(
            inlinePayloadPositions.every((position) => position >= 0),
            'inputs view: inline payload markers',
        ).toBe(true);
        expect.soft(
            inlinePayloadPositions,
            'inputs view: custom preset before payload text',
        ).toEqual([...inlinePayloadPositions].sort((left, right) => left - right));

        const executionSource = sourceFor(executionPath);
        const executionOrder = [
            'className="manual-preview"',
            'className="manual-action-grid"',
            'className="manual-matrix-card"',
            'className="manual-history"',
            'className="report-output manual-recipe-output"',
        ].map((marker) => executionSource.indexOf(marker));
        expect.soft(
            executionOrder.every((position) => position >= 0),
            'execution view: all command sections',
        ).toBe(true);
        expect.soft(executionOrder, 'execution view: preserved DOM order').toEqual(
            [...executionOrder].sort((left, right) => left - right),
        );
        for (const action of [
            'configure',
            'join',
            'connect',
            'send',
            'health',
            'close',
            'reset',
        ] as const) {
            expect.soft(executionSource, `execution view action: ${action}`).toMatch(
                new RegExp(`['"]${action}['"]`),
            );
        }

        const workbenchSource = sourceFor(workbenchPath);
        const workbenchOrder = [
            '<section className="panel manual-rallar-panel">',
            'className="panel-heading"',
            '<ManualRallarInputsPanel',
            '<ManualRallarExecutionPanel',
            '{model.localError &&',
        ].map((marker) => workbenchSource.indexOf(marker));
        expect.soft(
            workbenchOrder.every((position) => position >= 0),
            'workbench panel: outer composition markers',
        ).toBe(true);
        expect.soft(workbenchOrder, 'workbench panel: preserved DOM order').toEqual(
            [...workbenchOrder].sort((left, right) => left - right),
        );
        expect(
            [...workbenchSource.matchAll(/\buseManualRallarWorkbench\s*\(/g)],
            'workbench panel: one controller call',
        ).toHaveLength(1);

        const inboxSource = sourceFor(inboxPath);
        expect(
            [...inboxSource.matchAll(/\buseMemo(?:<[^>]+>)?\s*\(/g)],
            'inbox: exact memo count',
        ).toHaveLength(1);
        expect(inboxSource.replace(/\s+/g, ''), 'inbox: memo dependency').toContain(
            '[state],',
        );
        expect(inboxSource, 'inbox: latest 24 reversed').toMatch(
            /\.slice\(-24\)\s*\.reverse\(\)/,
        );
        expect(inboxSource, 'inbox: redacted payload').toContain(
            'redactedJson(message.payload, state)',
        );

        const sectionSource = sourceFor(sectionPath);
        expect(sectionSource, 'manual section: fragment return').toMatch(
            /return\s*\(\s*<>[\s\S]*<\/\>\s*\);/,
        );
        expect(sectionSource, 'manual section: no wrapper').not.toMatch(
            /<(?:section|div)\b/,
        );
        expect(sectionSource, 'manual section: no key').not.toMatch(/\bkey\s*=/);
        const sectionChildMarkers = [
            '<ManualRallarWorkbenchPanel',
            '<ReceivedDataInboxPanel',
            '<CommandHistoryPanel',
        ] as const;
        const sectionChildPositions = sectionChildMarkers.map((marker) =>
            sectionSource.indexOf(marker),
        );
        expect.soft(
            sectionChildPositions.every((position) => position >= 0),
            'manual section: exact three children',
        ).toBe(true);
        expect.soft(sectionChildPositions, 'manual section: child order').toEqual(
            [...sectionChildPositions].sort((left, right) => left - right),
        );
        for (const marker of sectionChildMarkers) {
            expect(
                [...sectionSource.matchAll(new RegExp(marker, 'g'))],
                `manual section: ${marker} once`,
            ).toHaveLength(1);
        }
        expect(sectionSource, 'manual section: forwards history directly').toContain(
            'history={history}',
        );

        for (const viewPath of [
            inputsPath,
            executionPath,
            workbenchPath,
            inboxPath,
            sectionPath,
        ] as const) {
            const viewSource = sourceFor(viewPath);
            expect.soft(viewSource, `${viewPath}: no local state`).not.toMatch(
                /\buseState\b/,
            );
            expect.soft(viewSource, `${viewPath}: no effects`).not.toMatch(
                /\buseEffect\b/,
            );
            expect.soft(viewSource, `${viewPath}: no useCallback`).not.toMatch(
                /\buseCallback\b/,
            );
            expect.soft(viewSource, `${viewPath}: no runtime execution import`).not.toMatch(
                /import(?!\s+type\b)\s*{[^}]*}\s*from\s*['"][^'"]*runtime-store\.ts['"]/s,
            );
            expect.soft(viewSource, `${viewPath}: no persistence import`).not.toMatch(
                /\bfrom\s*['"][^'"]*ui-persistence\.ts['"]/,
            );
            expect.soft(viewSource, `${viewPath}: no storage import`).not.toMatch(
                /\bfrom\s*['"][^'"]*browser-ui-storage\.ts['"]/,
            );
            if (viewPath !== inboxPath) {
                expect.soft(viewSource, `${viewPath}: no selector import`).not.toMatch(
                    /\bfrom\s*['"][^'"]*selectors\.ts['"]/,
                );
            }
        }
        for (const viewPath of [
            inputsPath,
            executionPath,
            workbenchPath,
            sectionPath,
        ] as const) {
            expect(
                [...sourceFor(viewPath).matchAll(/\buseMemo(?:<[^>]+>)?\s*\(/g)],
                `${viewPath}: no memo ownership`,
            ).toHaveLength(0);
        }
        expect(inboxSource, 'inbox: events selector only').toMatch(
            /import\s*{\s*selectRallarBlackBoxEvents\s*}\s*from\s*'@shared-test\/rallar-bb-test\/selectors\.ts';/,
        );

        for (const runtimeMarker of [
            'rallarBlackBoxRuntimeStore',
            'readManualWorkbenchDraft',
            'writeManualWorkbenchDraft',
            'browserUiStorage',
        ] as const) {
            const markerOwners = manualOwners
                .filter((owner) => sourceFor(owner.path).includes(runtimeMarker))
                .map((owner) => owner.path);
            expect.soft(
                markerOwners,
                `${runtimeMarker}: controller-only ownership`,
            ).toEqual([hookPath]);
        }

        const targetPaths = new Set(manualOwners.map((owner) => owner.path));
        const dependencies = new Map<string, readonly string[]>();
        for (const owner of manualOwners) {
            dependencies.set(
                owner.path,
                [...sourceFor(owner.path).matchAll(
                    /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g,
                )]
                    .map((match) => match[1] ?? match[2])
                    .filter((moduleImport) => moduleImport.startsWith('.'))
                    .map((moduleImport) =>
                        relative(
                            repositoryRoot,
                            resolve(
                                resolve(repositoryRoot, owner.path),
                                '..',
                                moduleImport,
                            ),
                        ),
                    )
                    .filter((dependency) => targetPaths.has(dependency)),
            );
        }
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) {
                cycles.push(path);
                return;
            }
            if (visited.has(path)) {
                return;
            }
            active.add(path);
            for (const dependency of dependencies.get(path) ?? []) {
                visit(dependency);
            }
            active.delete(path);
            visited.add(path);
        };
        for (const targetPath of targetPaths) {
            visit(targetPath);
        }
        expect(cycles, 'manual Rallar import cycles').toEqual([]);
    });

    it('keeps the Shared Test domain in exact focused owners', () => {
        const appSource = repositorySource(appSourcePath);
        const catalogPath =
            'apps/rallar-black-box/src/legacy/runner/shared-test/shared-test-catalog.ts';
        const catalogPanelPath =
            'apps/rallar-black-box/src/legacy/runner/shared-test/SharedTestCatalogPanel.tsx';
        const artifactPanelPath =
            'apps/rallar-black-box/src/legacy/runner/shared-test/SharedTestArtifactImportPanel.tsx';
        const panelPath =
            'apps/rallar-black-box/src/legacy/runner/shared-test/SharedTestPanel.tsx';
        const owners = [
            {
                path: catalogPath,
                exports: [
                    'AppLocalRecipeEntry',
                    'APP_LOCAL_RECIPE_CATALOG',
                    'catalogEntryMatches',
                    'catalogRequirements',
                ],
                lineCap: 150,
            },
            {
                path: catalogPanelPath,
                exports: ['SharedTestCatalogPanel'],
                lineCap: 310,
            },
            {
                path: artifactPanelPath,
                exports: ['SharedTestArtifactImportPanel'],
                lineCap: 310,
            },
            {
                path: panelPath,
                exports: ['SharedTestPanel'],
                lineCap: 90,
            },
        ] as const;
        const sourceByPath = new Map<string, string>();

        for (const owner of owners) {
            const ownerExists = existsSync(resolve(repositoryRoot, owner.path));
            const ownerSource = ownerExists ? repositorySource(owner.path) : '';
            sourceByPath.set(owner.path, ownerSource);

            expect.soft(ownerExists, `${owner.path}: missing owner`).toBe(true);
            expect
                .soft(ownerSource, `${owner.path}: export-star barrel`)
                .not.toMatch(/^\s*export\s*\*(?:\s+as\s+\w+)?\s+from\b/m);
            expect
                .soft(ownerSource, `${owner.path}: named re-export facade`)
                .not.toMatch(/^\s*export\s+(?:type\s+)?{[^}]+}\s*from\s*['"]/m);
            expect.soft(ownerSource, `${owner.path}: App.tsx import`).not.toMatch(
                /\b(?:from\s+|import\s*\(\s*)['"][^'"]*App\.tsx['"]/,
            );
            expect.soft(ownerSource, `${owner.path}: CSS import`).not.toMatch(
                /\b(?:from\s+|import\s*)['"][^'"]+\.css['"]/,
            );
            expect.soft(
                ownerSource === ''
                    ? 0
                    : ownerSource.trimEnd().split(/\r?\n/).length,
                `${owner.path}: line count`,
            ).toBeLessThanOrEqual(owner.lineCap);

            for (const exportedName of owner.exports) {
                expect
                    .soft(ownerSource, `${owner.path}: direct ${exportedName} export`)
                    .toMatch(
                        new RegExp(
                            `^\\s*export\\s+(?:type\\s+${exportedName}\\s*=|const\\s+${exportedName}\\b|function\\s+${exportedName}\\s*\\()`,
                            'm',
                        ),
                    );
            }
        }

        const sourceFor = (path: string): string =>
            path === appSourcePath
                ? appSource
                : sourceByPath.get(path) ??
                  (existsSync(resolve(repositoryRoot, path))
                      ? repositorySource(path)
                      : '');
        const directImports = [
            {
                importerPath: appSourcePath,
                moduleImport:
                    './legacy/runner/shared-test/shared-test-catalog.ts',
                seams: ['catalogRequirements'],
            },
            {
                importerPath: appSourcePath,
                moduleImport:
                    './legacy/runner/shared-test/SharedTestPanel.tsx',
                seams: ['SharedTestPanel'],
            },
            {
                importerPath: catalogPath,
                moduleImport: '../../../shared-test-handoff-fixtures.ts',
                seams: ['RallarBlackBoxSharedTestRecipeCatalogEntry'],
            },
            {
                importerPath: catalogPanelPath,
                moduleImport: './shared-test-catalog.ts',
                seams: [
                    'APP_LOCAL_RECIPE_CATALOG',
                    'catalogEntryMatches',
                    'catalogRequirements',
                ],
            },
            {
                importerPath: artifactPanelPath,
                moduleImport: '../../../shared-test-handoff-fixtures.ts',
                seams: [
                    'RALLAR_BLACK_BOX_SHARED_TEST_ARTIFACT_CONTRACT',
                    'parseRallarBlackBoxSharedTestArtifactBundle',
                    'RallarBlackBoxSharedTestArtifactBundleFiles',
                ],
            },
            {
                importerPath: artifactPanelPath,
                moduleImport: '../shared/artifact-issue-presentation.ts',
                seams: ['artifactIssueText'],
            },
            {
                importerPath: panelPath,
                moduleImport: './SharedTestCatalogPanel.tsx',
                seams: ['SharedTestCatalogPanel'],
            },
            {
                importerPath: panelPath,
                moduleImport: './SharedTestArtifactImportPanel.tsx',
                seams: ['SharedTestArtifactImportPanel'],
            },
        ] as const;

        for (const directImport of directImports) {
            const importerSource = sourceFor(directImport.importerPath);
            const escapedModuleImport = directImport.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const importMatches = [
                ...importerSource.matchAll(
                    new RegExp(
                        `import\\s*(?:type\\s*)?{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                        'g',
                    ),
                ),
            ];
            expect.soft(
                importMatches,
                `${directImport.importerPath}: ${directImport.moduleImport}`,
            ).toHaveLength(1);
            for (const seam of directImport.seams) {
                expect
                    .soft(
                        importMatches[0]?.[1] ?? '',
                        `${directImport.moduleImport}: ${seam}`,
                    )
                    .toMatch(new RegExp(`\\b${seam}\\b`));
            }
        }

        for (const declaration of [
            /^\s*type\s+AppLocalRecipeEntry\s*=/m,
            /^\s*const\s+APP_LOCAL_RECIPE_CATALOG\b/m,
            /\bfunction\s+catalogEntryMatches\s*\(/,
            /\bfunction\s+catalogRequirements\s*\(/,
            /^\s*const\s+SHARED_TEST_ARTIFACT_FILE_NAMES\b/m,
            /\bfunction\s+SharedTestCatalogPanel\s*\(/,
            /\bfunction\s+SharedTestArtifactImportPanel\s*\(/,
            /\bfunction\s+SharedTestPanel\s*\(/,
        ] as const) {
            expect.soft(appSource, `App.tsx local ${declaration.source}`).not.toMatch(
                declaration,
            );
        }
        expect(appSource, 'runner catalog keeps the direct shared fixture import').toMatch(
            /import\s*{[^}]*RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG[^}]*}\s*from\s*'\.\/shared-test-handoff-fixtures\.ts';/s,
        );
        const runnerCatalogSource = appSource.slice(
            appSource.indexOf('function runnerRecipeCatalog'),
            appSource.indexOf('function runnerRecipeDefaultScore'),
        );
        expect(runnerCatalogSource, 'runner catalog keeps helper mapping').toContain(
            'requirements: catalogRequirements(entry),',
        );

        const catalogSource = sourceFor(catalogPanelPath);
        expect(
            [...catalogSource.matchAll(/\buseState(?:<[^>]+>)?\s*\(/g)],
            'catalog panel: exact state count',
        ).toHaveLength(3);
        const catalogStatePositions = [
            "const [query, setQuery] = useState('');",
            "const [profile, setProfile] = useState('');",
            'const [selectedEntryId, setSelectedEntryId] = useState(',
        ].map((marker) => catalogSource.indexOf(marker));
        expect.soft(
            catalogStatePositions.every((position) => position >= 0),
            'catalog panel: state declarations',
        ).toBe(true);
        expect.soft(catalogStatePositions, 'catalog panel: state order').toEqual(
            [...catalogStatePositions].sort((left, right) => left - right),
        );
        expect(
            [...catalogSource.matchAll(/\buseMemo(?:<[^>]+>)?\s*\(/g)],
            'catalog panel: exact memo count',
        ).toHaveLength(2);
        const catalogMemoPositions = [
            'const profileOptions = useMemo(',
            'const filteredEntries = useMemo(',
        ].map((marker) => catalogSource.indexOf(marker));
        expect.soft(
            catalogMemoPositions.every((position) => position >= 0),
            'catalog panel: memo declarations',
        ).toBe(true);
        expect.soft(catalogMemoPositions, 'catalog panel: memo order').toEqual(
            [...catalogMemoPositions].sort((left, right) => left - right),
        );
        expect(catalogSource.replace(/\s+/g, ''), 'catalog filtered memo deps').toContain(
            '[catalog.entries,profile,query],',
        );
        expect(catalogSource, 'catalog panel: no effects').not.toMatch(/\buseEffect\b/);
        expect(catalogSource, 'catalog query trim at match call').toContain(
            'catalogEntryMatches(entry, query.trim(), profile)',
        );
        expect(catalogSource, 'catalog selection fallback').toMatch(
            /catalog\.entries\.find\(\(entry\) => entry\.id === selectedEntryId\)\s*\?\?\s*filteredEntries\[0\]\s*\?\?\s*catalog\.entries\[0\]/,
        );

        const artifactSource = sourceFor(artifactPanelPath);
        expect(
            [...artifactSource.matchAll(/\buseState(?:<|\s*\()/g)],
            'artifact panel: exact state count',
        ).toHaveLength(3);
        const artifactStatePositions = [
            'const [files, setFiles]',
            'const [parseResult, setParseResult]',
            'const [readError, setReadError]',
        ].map((marker) => artifactSource.indexOf(marker));
        expect.soft(
            artifactStatePositions.every((position) => position >= 0),
            'artifact panel: state declarations',
        ).toBe(true);
        expect.soft(artifactStatePositions, 'artifact panel: state order').toEqual(
            [...artifactStatePositions].sort((left, right) => left - right),
        );
        expect(artifactSource, 'artifact panel: no memos').not.toMatch(/\buseMemo\b/);
        expect(artifactSource, 'artifact panel: no effects').not.toMatch(/\buseEffect\b/);
        for (const action of ['parseFiles', 'handleFiles', 'copyReplayRecipe'] as const) {
            expect.soft(artifactSource, `artifact panel action: ${action}`).toMatch(
                new RegExp(`const\\s+${action}\\s*=`),
            );
        }
        expect(artifactSource, 'artifact panel replaces with an empty bundle').toContain(
            'const nextFiles: RallarBlackBoxSharedTestArtifactBundleFiles = {};',
        );
        expect(artifactSource, 'artifact panel reads files sequentially').toMatch(
            /for \(const file of selectedFiles\)[\s\S]*?= await file\.text\(\);/,
        );
        expect(artifactSource, 'artifact panel renders parsed values').toContain(
            'const parsed = parseResult?.value;',
        );
        expect(artifactSource, 'artifact event cap').toContain('.slice(0, 24)');
        expect(
            [...artifactSource.matchAll(/\.slice\(0, 12\)/g)],
            'artifact diagnostic and failure caps',
        ).toHaveLength(2);

        const panelSource = sourceFor(panelPath);
        expect(panelSource, 'SharedTestPanel is stateless').not.toMatch(
            /\buse(?:State|Memo|Effect|Callback|Reducer|Ref)\b/,
        );
        const childMarkers = [
            '<SharedTestCatalogPanel />',
            '<SharedTestArtifactImportPanel />',
            '<section className="panel shared-test-coverage-panel">',
        ] as const;
        const childPositions = childMarkers.map((marker) =>
            panelSource.indexOf(marker),
        );
        expect.soft(
            childPositions.every((position) => position >= 0),
            'SharedTestPanel: all children',
        ).toBe(true);
        expect.soft(childPositions, 'SharedTestPanel: child order').toEqual(
            [...childPositions].sort((left, right) => left - right),
        );
        for (const marker of childMarkers) {
            expect(
                [...panelSource.matchAll(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))],
                `SharedTestPanel: ${marker} once`,
            ).toHaveLength(1);
        }
        expect(
            [...panelSource.matchAll(/RALLAR_BLACK_BOX_SHARED_TEST_COVERAGE_HANDOFF\.map\(/g)],
            'SharedTestPanel: one coverage handoff render',
        ).toHaveLength(1);

        const panelCalls = [...appSource.matchAll(/<SharedTestPanel\b([^>]*)\/>/g)];
        expect(panelCalls, 'App.tsx: two independent Shared Test instances').toHaveLength(2);
        for (const panelCall of panelCalls) {
            expect.soft(panelCall[1] ?? '', 'SharedTestPanel call: no props or key').toBe(' ');
        }
        const runnerWrapper = appSource.match(
            /{surface === 'shared-test' && \(\s*<div\s+id="panel-shared-test"[\s\S]*?<\/div>\s*\)}/,
        )?.[0] ?? '';
        expect(runnerWrapper, 'RunnerAdvanced Shared Test wrapper').toContain(
            'className="workspace-grid tab-workspace shared-test-tab-grid"',
        );
        expect(
            [...runnerWrapper.matchAll(/<SharedTestPanel\b/g)],
            'RunnerAdvanced conditional Shared Test instance',
        ).toHaveLength(1);
        const legacyWrapper = appSource.match(
            /<section\s+id="legacy-panel-shared-test"[\s\S]*?<\/section>/,
        )?.[0] ?? '';
        for (const wrapperMarker of [
            'className="workspace-grid tab-workspace shared-test-tab-grid"',
            'role="tabpanel"',
            'aria-labelledby="tab-shared-test"',
            "hidden={activeTab !== 'shared-test'}",
        ] as const) {
            expect.soft(legacyWrapper, `legacy Shared Test wrapper: ${wrapperMarker}`).toContain(
                wrapperMarker,
            );
        }
        expect(
            [...legacyWrapper.matchAll(/<SharedTestPanel\b/g)],
            'persistent legacy Shared Test instance',
        ).toHaveLength(1);

        const targetPaths = new Set(owners.map((owner) => owner.path));
        const dependencies = new Map<string, readonly string[]>();
        for (const owner of owners) {
            dependencies.set(
                owner.path,
                [...sourceFor(owner.path).matchAll(
                    /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g,
                )]
                    .map((match) => match[1] ?? match[2])
                    .filter((moduleImport) => moduleImport.startsWith('.'))
                    .map((moduleImport) =>
                        relative(
                            repositoryRoot,
                            resolve(
                                resolve(repositoryRoot, owner.path),
                                '..',
                                moduleImport,
                            ),
                        ),
                    )
                    .filter((dependency) => targetPaths.has(dependency)),
            );
        }
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) {
                cycles.push(path);
                return;
            }
            if (visited.has(path)) {
                return;
            }
            active.add(path);
            for (const dependency of dependencies.get(path) ?? []) {
                visit(dependency);
            }
            active.delete(path);
            visited.add(path);
        };
        for (const targetPath of targetPaths) {
            visit(targetPath);
        }
        expect(cycles, 'Shared Test import cycles').toEqual([]);
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
