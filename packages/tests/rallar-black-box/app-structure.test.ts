import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const appSourcePath = 'apps/rallar-black-box/src/App.tsx';
const recipeConsoleSourcePath = 'apps/rallar-black-box/src/recipe-console';
const runnerAdvancedSourcePath =
    'apps/rallar-black-box/src/legacy/runner/advanced/RunnerAdvancedPanel.tsx';
const flowBuilderPreviewsSourcePath =
    'apps/rallar-black-box/src/legacy/runner/builder/FlowBuilderPreviews.tsx';
const fleetOverviewSourcePath =
    'apps/rallar-black-box/src/legacy/runner/fleet/views/RunnerFleetOverview.tsx';
const fleetAnalysisSourcePath =
    'apps/rallar-black-box/src/legacy/runner/fleet/views/RunnerFleetReportAnalysis.tsx';
const fleetDetailsSourcePath =
    'apps/rallar-black-box/src/legacy/runner/fleet/views/RunnerFleetSelectedDetails.tsx';
const fleetTimingSourcePath =
    'apps/rallar-black-box/src/legacy/runner/fleet/views/FleetTimingGroupList.tsx';
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
        importerPath:
            'apps/rallar-black-box/src/legacy/diagnostics/events/EventStreamPanel.tsx',
        moduleImport: '../../shared/FilterSelect.tsx',
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
        importerPath: existsSync(
            resolve(repositoryRoot, flowBuilderPreviewsSourcePath),
        )
            ? flowBuilderPreviewsSourcePath
            : appSourcePath,
        moduleImport: existsSync(
            resolve(repositoryRoot, flowBuilderPreviewsSourcePath),
        )
            ? '../../shared/schema/SchemaAuthoringPanel.tsx'
            : './legacy/shared/schema/SchemaAuthoringPanel.tsx',
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
        importerPath:
            'apps/rallar-black-box/src/legacy/runner/runs/ImportedDistributedArtifactAnalysisPanel.tsx',
        moduleImport: './distributed-artifact-import.ts',
        seams: ['DISTRIBUTED_ARTIFACT_REQUIRED_FILES'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/runner/runs/distributed-artifact-import.ts',
        importerPath:
            'apps/rallar-black-box/src/legacy/runner/runs/use-runner-runs-controller.ts',
        moduleImport: './distributed-artifact-import.ts',
        seams: [
            'DistributedArtifactImportStatus',
            'distributedArtifactImportStatus',
        ],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/runner/runs/distributed-run-seed-url.ts',
        importerPath:
            'apps/rallar-black-box/src/legacy/runner/runs/use-runner-runs-controller.ts',
        moduleImport: './distributed-run-seed-url.ts',
        seams: [
            'readDistributedRunSeedFromUrl',
            'writeDistributedRunSeedToUrl',
        ],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/runner/runs/DistributedRunAnalysisReportPanel.tsx',
        importerPath:
            'apps/rallar-black-box/src/legacy/runner/runs/RunnerDistributedAnalysisSection.tsx',
        moduleImport: './DistributedRunAnalysisReportPanel.tsx',
        seams: ['DistributedRunAnalysisReportPanel'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/runner/runs/ImportedDistributedArtifactAnalysisPanel.tsx',
        importerPath:
            'apps/rallar-black-box/src/legacy/runner/runs/RunnerDistributedAnalysisSection.tsx',
        moduleImport: './ImportedDistributedArtifactAnalysisPanel.tsx',
        seams: ['ImportedDistributedArtifactAnalysisPanel'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/runner/shared/performance-format.ts',
        importerPath: existsSync(resolve(repositoryRoot, fleetOverviewSourcePath))
            ? fleetOverviewSourcePath
            : appSourcePath,
        moduleImport: existsSync(resolve(repositoryRoot, fleetOverviewSourcePath))
            ? '../../shared/performance-format.ts'
            : './legacy/runner/shared/performance-format.ts',
        seams: ['formatPercent', 'formatFleetDuration'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/runner/shared/performance-format.ts',
        importerPath: fleetAnalysisSourcePath,
        moduleImport: '../../shared/performance-format.ts',
        seams: ['formatPercent', 'formatFleetDuration'],
    },
    {
        path: 'apps/rallar-black-box/src/legacy/runner/shared/performance-format.ts',
        importerPath: fleetTimingSourcePath,
        moduleImport: '../../shared/performance-format.ts',
        seams: ['formatFleetDuration'],
    },
] as const;

function repositorySource(path: string): string {
    return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

const task9aAstTextKinds = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.Identifier,
    ts.SyntaxKind.PrivateIdentifier,
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NumericLiteral,
    ts.SyntaxKind.BigIntLiteral,
    ts.SyntaxKind.RegularExpressionLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.JsxText,
]);

function task9aSourceFile(path: string, source: string): ts.SourceFile {
    return ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
}

function task9aAstShape(node: ts.Node): string {
    const text = task9aAstTextKinds.has(node.kind)
        ? String((node as ts.Node & { text: string }).text)
        : '';
    const children = node
        .getChildren(node.getSourceFile())
        .map((child) => task9aAstShape(child));
    return `(${node.kind}:${JSON.stringify(text)}${children.join('')})`;
}

function task9aAstFingerprint(nodes: readonly ts.Node[]): string {
    return createHash('sha256')
        .update(nodes.map(task9aAstShape).join('\n'))
        .digest('hex');
}

function task9aNamedFunction(
    sourceFile: ts.SourceFile,
    name: string,
): ts.FunctionDeclaration {
    const declaration = sourceFile.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
    if (!declaration?.body) {
        throw new Error(`Missing Task 9A function ${name} in ${sourceFile.fileName}`);
    }
    return declaration;
}

function task9aReturnExpression(
    declaration: ts.FunctionDeclaration,
): ts.Expression {
    const statement = declaration.body!.statements.find(ts.isReturnStatement);
    if (!statement?.expression) {
        throw new Error(
            `Missing Task 9A return expression in ${declaration.name?.text ?? 'function'}`,
        );
    }
    let expression = statement.expression;
    while (ts.isParenthesizedExpression(expression)) {
        expression = expression.expression;
    }
    return expression;
}

function task9aJsxCalls(
    root: ts.Node,
    name: string,
): readonly ts.JsxSelfClosingElement[] {
    const calls: ts.JsxSelfClosingElement[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isJsxSelfClosingElement(node) &&
            ts.isIdentifier(node.tagName) &&
            node.tagName.text === name
        ) {
            calls.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(root);
    return calls;
}

function task9aJsxRuntimeFingerprint(expression: ts.Expression): string {
    const runtimeSource = ts.transpileModule(
        `const extracted = (${expression.getText()});`,
        {
            compilerOptions: {
                jsx: ts.JsxEmit.ReactJSX,
                module: ts.ModuleKind.ESNext,
                target: ts.ScriptTarget.ESNext,
            },
        },
    ).outputText;
    return task9aAstFingerprint(
        task9aSourceFile('task9a-runtime.ts', runtimeSource).statements,
    );
}

function task9aImportEdges(sourceFile: ts.SourceFile): readonly string[] {
    const seamsByModule = new Map<string, string[]>();
    for (const statement of sourceFile.statements) {
        if (
            !ts.isImportDeclaration(statement) ||
            !ts.isStringLiteral(statement.moduleSpecifier)
        ) {
            continue;
        }
        const moduleImport = statement.moduleSpecifier.text;
        const seams = seamsByModule.get(moduleImport) ?? [];
        const clause = statement.importClause;
        if (!clause) {
            seams.push('side-effect');
        } else {
            if (clause.name) {
                seams.push(
                    `${clause.isTypeOnly ? 'type' : 'value'}:default->${clause.name.text}`,
                );
            }
            if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
                seams.push(
                    `${clause.isTypeOnly ? 'type' : 'value'}:*->${clause.namedBindings.name.text}`,
                );
            }
            if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                for (const element of clause.namedBindings.elements) {
                    const importedName = element.propertyName?.text ?? element.name.text;
                    const localName = element.name.text;
                    const alias = importedName === localName ? '' : `->${localName}`;
                    seams.push(
                        `${clause.isTypeOnly || element.isTypeOnly ? 'type' : 'value'}:${importedName}${alias}`,
                    );
                }
            }
        }
        seamsByModule.set(moduleImport, seams);
    }
    return [...seamsByModule]
        .map(
            ([moduleImport, seams]) =>
                `${moduleImport}|${[...seams].sort().join(',')}`,
        )
        .sort();
}

function task9aExportSeams(sourceFile: ts.SourceFile): readonly string[] {
    const seams: string[] = [];
    for (const statement of sourceFile.statements) {
        if (ts.isExportDeclaration(statement)) {
            const moduleImport =
                statement.moduleSpecifier &&
                ts.isStringLiteral(statement.moduleSpecifier)
                ? statement.moduleSpecifier.text
                : 'local';
            if (!statement.exportClause) {
                seams.push(`re-export:${moduleImport}:*`);
            } else if (ts.isNamespaceExport(statement.exportClause)) {
                seams.push(
                    `re-export:${moduleImport}:*->${statement.exportClause.name.text}`,
                );
            } else {
                for (const element of statement.exportClause.elements) {
                    seams.push(
                        `re-export:${moduleImport}:${element.isTypeOnly ? 'type' : 'value'}:${element.propertyName?.text ?? element.name.text}${element.propertyName ? `->${element.name.text}` : ''}`,
                    );
                }
            }
            continue;
        }
        if (ts.isExportAssignment(statement)) {
            seams.push('value:default-assignment');
            continue;
        }
        const modifiers = ts.canHaveModifiers(statement)
            ? ts.getModifiers(statement)
            : undefined;
        const exported = modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        );
        if (!exported) continue;
        if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
            seams.push(`type:${statement.name.text}`);
        } else if (
            ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isEnumDeclaration(statement)
        ) {
            seams.push(`value:${statement.name?.text ?? 'default'}`);
        } else if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                seams.push(
                    `value:${ts.isIdentifier(declaration.name) ? declaration.name.text : declaration.name.getText(sourceFile)}`,
                );
            }
        } else {
            seams.push(`unsupported:${ts.SyntaxKind[statement.kind]}`);
        }
    }
    return seams.sort();
}

function runnerAdvancedSource(appSource: string): string {
    return existsSync(resolve(repositoryRoot, runnerAdvancedSourcePath))
        ? repositorySource(runnerAdvancedSourcePath)
        : appSource;
}

function appAndRunnerAdvancedSource(appSource: string): string {
    const advancedSource = runnerAdvancedSource(appSource);
    return advancedSource === appSource
        ? appSource
        : `${appSource}\n${advancedSource}`;
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
                importerPath:
                    'apps/rallar-black-box/src/legacy/runner/runs/RunnerRunsPanel.tsx',
                moduleImport: '../evidence/RunVerdictPanel.tsx',
                seams: ['RunVerdictPanel'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/evidence/CausalTrailPanel.tsx',
                importerPath:
                    'apps/rallar-black-box/src/legacy/runner/runs/RunnerRunsPanel.tsx',
                moduleImport: '../evidence/CausalTrailPanel.tsx',
                seams: ['CausalTrailPanel'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/agents/ControlAgentBoardPanel.tsx',
                importerPath: existsSync(resolve(repositoryRoot, fleetOverviewSourcePath))
                    ? fleetOverviewSourcePath
                    : appSourcePath,
                moduleImport: existsSync(resolve(repositoryRoot, fleetOverviewSourcePath))
                    ? '../../agents/ControlAgentBoardPanel.tsx'
                    : './legacy/runner/agents/ControlAgentBoardPanel.tsx',
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
                importerPath: existsSync(resolve(repositoryRoot, fleetAnalysisSourcePath))
                    ? fleetAnalysisSourcePath
                    : appSourcePath,
                moduleImport: existsSync(resolve(repositoryRoot, fleetAnalysisSourcePath))
                    ? '../../shared/run-id-presentation.ts'
                    : './legacy/runner/shared/run-id-presentation.ts',
                seams: ['shortRunId'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/shared/run-id-presentation.ts',
                importerPath: existsSync(resolve(repositoryRoot, fleetDetailsSourcePath))
                    ? fleetDetailsSourcePath
                    : appSourcePath,
                moduleImport: existsSync(resolve(repositoryRoot, fleetDetailsSourcePath))
                    ? '../../shared/run-id-presentation.ts'
                    : './legacy/runner/shared/run-id-presentation.ts',
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
                importerPath:
                    'apps/rallar-black-box/src/legacy/diagnostics/rtc/RtcDiagnosticsPanel.tsx',
                moduleImport: '../../runner/evidence/rtc/RtcDiagnosticsTimeseriesPanel.tsx',
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
                importerPath:
                    'apps/rallar-black-box/src/legacy/diagnostics/rtc/RtcDiagnosticsPanel.tsx',
                moduleImport: '../../runner/evidence/rtc/RtcPerformancePanel.tsx',
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

            const importerPath =
                'importerPath' in runAnalysisModule
                    ? runAnalysisModule.importerPath
                    : appSourcePath;
            const importerSource = existsSync(resolve(repositoryRoot, importerPath))
                ? repositorySource(importerPath)
                : '';
            const escapedModuleImport = runAnalysisModule.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const importedSeams = importerSource.match(
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
                importerPath:
                    'apps/rallar-black-box/src/legacy/runner/recipes/runner-recipe-catalog.ts',
                appImport:
                    '../distributed-recipes/distributed-recipe-catalog.ts',
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
                importerPath:
                    'apps/rallar-black-box/src/legacy/runner/recipes/use-runner-recipes-controller.ts',
                appImport:
                    '../distributed-recipes/distributed-manifest-validation.ts',
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
                importerPath:
                    'apps/rallar-black-box/src/legacy/runner/recipes/use-runner-recipes-controller.ts',
                appImport: '../../shared/safe-id-segment.ts',
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
                appSeams: ['recordArray', 'recordValue'],
                declarations: [
                    {
                        seam: 'recordArray',
                        pattern: /^\s*export\s+function\s+recordArray\s*\(/m,
                    },
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
                importerPath:
                    'apps/rallar-black-box/src/legacy/runner/recipes/views/RunnerRecipeDetail.tsx',
                appImport:
                    '../../distributed-recipes/DistributedRecipePreflightPanel.tsx',
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
        const advancedSource = runnerAdvancedSource(appSource);
        const aggregateSource = appAndRunnerAdvancedSource(appSource);
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
            ...aggregateSource.matchAll(
                /<DistributedRecipesPanel\b([\s\S]*?)\/>/g,
            ),
        ];
        expect(panelCalls, 'advanced and legacy panel calls').toHaveLength(2);
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
        expect(advancedSource, 'Advanced distributed mount guard').toContain(
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
                importerPath:
                    'apps/rallar-black-box/src/legacy/diagnostics/events/EventStreamPanel.tsx',
                moduleImport: '../../shared/unique-values.ts',
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
                importerPath:
                    'apps/rallar-black-box/src/legacy/runner/runs/RunnerDistributedAnalysisSection.tsx',
                moduleImport: '../distributed/DistributedRunMonitorPanel.tsx',
                seams: ['DistributedRunMonitorPanel'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed/DistributedRunComparePanel.tsx',
                importerPath:
                    'apps/rallar-black-box/src/legacy/runner/runs/RunnerDistributedAnalysisSection.tsx',
                moduleImport: '../distributed/DistributedRunComparePanel.tsx',
                seams: ['DistributedRunComparePanel'],
            },
            {
                path: 'apps/rallar-black-box/src/legacy/runner/distributed/DistributedRunSummary.tsx',
                importerPath:
                    'apps/rallar-black-box/src/legacy/runner/runs/RunnerDistributedAnalysisSection.tsx',
                moduleImport: '../distributed/DistributedRunSummary.tsx',
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
        const advancedSource = runnerAdvancedSource(appSource);
        const aggregateSource = appAndRunnerAdvancedSource(appSource);
        const manualRallarSectionPath =
            'apps/rallar-black-box/src/legacy/runner/manual/ManualRallarSection.tsx';
        const manualRallarSectionSource = existsSync(
            resolve(repositoryRoot, manualRallarSectionPath),
        )
            ? repositorySource(manualRallarSectionPath)
            : '';
        const localWorkbenchPath =
            'apps/rallar-black-box/src/legacy/runner/workbench/LocalWorkbenchSection.tsx';
        const runnerRunsPanelPath =
            'apps/rallar-black-box/src/legacy/runner/runs/RunnerRunsPanel.tsx';
        const runnerRunsPanelSource = repositorySource(runnerRunsPanelPath);
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
                importerPath: runnerRunsPanelPath,
                moduleImport: '../advanced/ReportPanel.tsx',
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
                    : directImport.importerPath === runnerRunsPanelPath
                      ? runnerRunsPanelSource
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
            ...aggregateSource.matchAll(
                /<LocalWorkbenchSection\b[\s\S]*?\/>/g,
            ),
        ].map((match) => match[0]);
        expect(sectionCalls, 'advanced and legacy workbench instances').toHaveLength(
            2,
        );
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
            [...aggregateSource.matchAll(/^ {20}<LocalWorkbenchSection\b/gm)],
            'both workbenches mount as unconditional direct children',
        ).toHaveLength(2);

        const runnerWrapper = advancedSource.match(
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
            [...runnerRunsPanelSource.matchAll(/<ReportPanel\b/g)],
            'RunnerRunsPanel: non-workbench report consumer',
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
        const advancedSource = runnerAdvancedSource(appSource);
        const aggregateSource = appAndRunnerAdvancedSource(appSource);
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
            [
                appSource,
                repositorySource(
                    'apps/rallar-black-box/src/legacy/diagnostics/events/event-presentation.ts',
                ),
                repositorySource(
                    'apps/rallar-black-box/src/legacy/diagnostics/events/event-filters.ts',
                ),
                repositorySource(
                    'apps/rallar-black-box/src/legacy/shell/rallar-browser-status.ts',
                ),
                repositorySource(
                    'apps/rallar-black-box/src/legacy/diagnostics/quick-test/use-quick-rallar-test-controller.ts',
                ),
                existsSync(resolve(
                    repositoryRoot,
                    'apps/rallar-black-box/src/legacy/diagnostics/rtc-realtime/use-rtc-realtime-controller.ts',
                ))
                    ? repositorySource(
                          'apps/rallar-black-box/src/legacy/diagnostics/rtc-realtime/use-rtc-realtime-controller.ts',
                      )
                    : '',
                ...[
                    'apps/rallar-black-box/src/legacy/diagnostics/websocket/websocket-routing.ts',
                    'apps/rallar-black-box/src/legacy/diagnostics/websocket/websocket-recipes.ts',
                ].map((path) =>
                    existsSync(resolve(repositoryRoot, path))
                        ? repositorySource(path)
                        : '',
                ),
            ].flatMap((source) => [...source.matchAll(/\bstringValue\s*\(/g)]),
            'all unaffected stringValue consumers use the shared import',
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
            ...aggregateSource.matchAll(
                /<ManualRallarSection\b([\s\S]*?)\/>/g,
            ),
        ];
        expect(
            sectionCalls,
            'advanced and legacy manual controller instances',
        ).toHaveLength(2);
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
            sectionCalls.some((sectionCall) =>
                sectionCall[0].includes(
                    'history={selectRallarBlackBoxCommandHistory(state)}',
                ),
            ),
            'RunnerAdvanced preserves selected history expression',
        ).toBe(true);
        expect(
            sectionCalls.some((sectionCall) =>
                sectionCall[0].includes('history={history}'),
            ),
            'legacy App preserves selected history binding',
        ).toBe(true);
        expect(
            [...aggregateSource.matchAll(/^ {20}<ManualRallarSection\b/gm)],
            'both manual sections are unconditional direct children',
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

        const runnerWrapper = advancedSource.match(
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
        const advancedSource = runnerAdvancedSource(appSource);
        const aggregateSource = appAndRunnerAdvancedSource(appSource);
        const runnerRecipeCatalogPath =
            'apps/rallar-black-box/src/legacy/runner/recipes/runner-recipe-catalog.ts';
        const runnerRecipeCatalogExists = existsSync(
            resolve(repositoryRoot, runnerRecipeCatalogPath),
        );
        const runnerRecipeCatalogSource = runnerRecipeCatalogExists
            ? repositorySource(runnerRecipeCatalogPath)
            : appSource;
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
                importerPath: runnerRecipeCatalogExists
                    ? runnerRecipeCatalogPath
                    : appSourcePath,
                moduleImport: runnerRecipeCatalogExists
                    ? '../shared-test/shared-test-catalog.ts'
                    : './legacy/runner/shared-test/shared-test-catalog.ts',
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
        expect(runnerRecipeCatalogSource, 'runner catalog keeps the direct shared fixture import').toMatch(
            /import\s*{[^}]*RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG[^}]*}\s*from\s*'[^']*shared-test-handoff-fixtures\.ts';/s,
        );
        const runnerCatalogSource = runnerRecipeCatalogSource.slice(
            runnerRecipeCatalogSource.indexOf('function runnerRecipeCatalog'),
            runnerRecipeCatalogSource.indexOf('function runnerRecipeDefaultScore'),
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

        const panelCalls = [
            ...aggregateSource.matchAll(/<SharedTestPanel\b([^>]*)\/>/g),
        ];
        expect(
            panelCalls,
            'advanced and legacy independent Shared Test instances',
        ).toHaveLength(2);
        for (const panelCall of panelCalls) {
            expect.soft(panelCall[1] ?? '', 'SharedTestPanel call: no props or key').toBe(' ');
        }
        const runnerWrapper = advancedSource.match(
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

    it('keeps the advanced runner controller in its exact focused owner', () => {
        const appSource = repositorySource(appSourcePath);
        const ownerExists = existsSync(
            resolve(repositoryRoot, runnerAdvancedSourcePath),
        );
        const ownerSource = ownerExists
            ? repositorySource(runnerAdvancedSourcePath)
            : '';

        expect.soft(ownerExists, 'RunnerAdvancedPanel owner').toBe(true);
        expect(ownerSource, 'direct RunnerAdvancedPanel export').toMatch(
            /^\s*export\s+function\s+RunnerAdvancedPanel\s*\(/m,
        );
        expect(ownerSource, 'no export-star barrel').not.toMatch(
            /^\s*export\s*\*(?:\s+as\s+\w+)?\s+from\b/m,
        );
        expect(ownerSource, 'no named re-export facade').not.toMatch(
            /^\s*export\s+(?:type\s+)?{[^}]+}\s*from\s*['"]/m,
        );
        expect(ownerSource, 'no App import').not.toMatch(
            /\b(?:from\s+|import\s*\(\s*)['"][^'"]*App\.tsx['"]/
        );
        expect(ownerSource, 'no CSS import').not.toMatch(
            /\b(?:from\s+|import\s*)['"][^'"]+\.css['"]/
        );
        expect(
            ownerSource === ''
                ? 0
                : ownerSource.trimEnd().split(/\r?\n/).length,
            'RunnerAdvancedPanel line count',
        ).toBeLessThanOrEqual(220);

        const declarationOwners = sourceFilesUnder(
            'apps/rallar-black-box/src',
        ).filter((sourcePath) =>
            /^\s*(?:export\s+)?function\s+RunnerAdvancedPanel\s*\(/m.test(
                repositorySource(sourcePath),
            ),
        );
        expect(declarationOwners, 'one RunnerAdvancedPanel declaration').toEqual([
            runnerAdvancedSourcePath,
        ]);
        expect(appSource, 'App has no local RunnerAdvancedPanel').not.toMatch(
            /^\s*function\s+RunnerAdvancedPanel\s*\(/m,
        );
        expect(appSource, 'App direct RunnerAdvancedPanel import').toMatch(
            /import\s*{\s*RunnerAdvancedPanel\s*}\s*from\s*'\.\/legacy\/runner\/advanced\/RunnerAdvancedPanel\.tsx';/,
        );

        const directImports = [
            {
                moduleImport: '../workbench/LocalWorkbenchSection.tsx',
                seams: ['LocalWorkbenchSection'],
            },
            {
                moduleImport:
                    '../distributed-recipes/DistributedRecipesPanel.tsx',
                seams: ['DistributedRecipesPanel'],
            },
            {
                moduleImport: '../run-manager/RunManagerPanel.tsx',
                seams: ['RunManagerPanel'],
            },
            {
                moduleImport: '../manual/ManualRallarSection.tsx',
                seams: ['ManualRallarSection'],
            },
            {
                moduleImport: '../shared-test/SharedTestPanel.tsx',
                seams: ['SharedTestPanel'],
            },
            {
                moduleImport: '../runner-contracts.ts',
                seams: ['CommandQueueRow'],
            },
            {
                moduleImport: '../../shell/global-context-model.ts',
                seams: ['CommandCenterGlobalValues'],
            },
            {
                moduleImport: '../../../app-tabs.ts',
                seams: ['RunnerAdvancedSurfaceId'],
            },
            {
                moduleImport: '../../../runtime-store.ts',
                seams: ['RallarBlackBoxBootstrapConfig'],
            },
            {
                moduleImport: '../../../control-client.ts',
                seams: ['RallarBlackBoxControlSnapshot'],
            },
        ] as const;

        for (const directImport of directImports) {
            const escapedModuleImport = directImport.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const importedSeams = ownerSource.match(
                new RegExp(
                    `import\\s*(?:type\\s*)?{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                ),
            )?.[1];
            expect.soft(importedSeams, directImport.moduleImport).toBeDefined();
            for (const seam of directImport.seams) {
                expect
                    .soft(importedSeams ?? '', `${directImport.moduleImport}: ${seam}`)
                    .toMatch(new RegExp(`\\b${seam}\\b`));
            }
        }
        expect(ownerSource, 'selector import').toMatch(
            /import\s*{\s*selectRallarBlackBoxCommandHistory\s*}\s*from\s*'@shared-test\/rallar-bb-test\/selectors\.ts';/,
        );
        expect(ownerSource, 'React state/effect import').toMatch(
            /import\s*{[^}]*\buseEffect\b[^}]*\buseState\b[^}]*}\s*from\s*'react';/s,
        );

        const normalizedOwner = ownerSource.replace(/\s+/g, ' ');
        const propMarkers = [
            'state: RallarBlackBoxTestState;',
            'bootstrap: RallarBlackBoxBootstrapConfig;',
            'control: RallarBlackBoxControlSnapshot;',
            'authSession?: AuthSession;',
            'globalValues: CommandCenterGlobalValues;',
            'globalValuesEdited: boolean;',
            'busy: boolean;',
            'runState: string;',
            'loadedFixtureId?: string;',
            'lastError?: string;',
            'selectedCommandId?: string;',
            'queueRows: readonly CommandQueueRow[];',
            'initialSurface?: RunnerAdvancedSurfaceId;',
            'onSelectCommand(commandId: string | undefined): void;',
            'onGlobalValueChange<K extends keyof CommandCenterGlobalValues>(',
            'onSurfaceChange(surface: RunnerAdvancedSurfaceId): void;',
        ] as const;
        const propPositions = propMarkers.map((marker) =>
            normalizedOwner.indexOf(marker),
        );
        expect.soft(
            propPositions.every((position) => position >= 0),
            'complete public prop type',
        ).toBe(true);
        expect.soft(propPositions, 'public prop order').toEqual(
            [...propPositions].sort((left, right) => left - right),
        );
        const propTypeStart = ownerSource.indexOf('}: {');
        const propTypeEnd = ownerSource.indexOf('\n}) {', propTypeStart);
        const declaredPropNames = [
            ...ownerSource
                .slice(propTypeStart, propTypeEnd)
                .matchAll(/^ {4}(\w+)(?:\?|<[^\n]+>)?(?=[:(])/gm),
        ].map((match) => match[1]);
        const expectedPropNames = [
            'state',
            'bootstrap',
            'control',
            'authSession',
            'globalValues',
            'globalValuesEdited',
            'busy',
            'runState',
            'loadedFixtureId',
            'lastError',
            'selectedCommandId',
            'queueRows',
            'initialSurface',
            'onSelectCommand',
            'onGlobalValueChange',
            'onSurfaceChange',
        ] as const;
        expect(declaredPropNames, 'exact public prop cardinality').toEqual(
            expectedPropNames,
        );
        expect(normalizedOwner, 'initial surface default').toContain(
            "initialSurface = 'workbench',",
        );

        const appCalls = [
            ...appSource.matchAll(/<RunnerAdvancedPanel\b([\s\S]*?)\/>/g),
        ];
        expect(appCalls, 'one App RunnerAdvancedPanel call').toHaveLength(1);
        const appCall = appCalls[0]?.[0] ?? '';
        const callMarkers = [
            'state={state}',
            'bootstrap={bootstrap}',
            'control={control}',
            'authSession={authSession}',
            'globalValues={globalValues}',
            'globalValuesEdited={globalValuesEdited}',
            'busy={busy}',
            'runState={runState}',
            'loadedFixtureId={loadedFixtureId}',
            'lastError={lastError}',
            'selectedCommandId={selectedCommandId}',
            'queueRows={queueRows}',
            'initialSurface={activeAdvancedSurface}',
            'onSelectCommand={setSelectedCommandId}',
            'onGlobalValueChange={updateGlobalValue}',
            'onSurfaceChange={(surface) =>',
            "mode: 'black-box-runner',",
            "tab: 'advanced',",
            'advancedSurface: surface,',
        ] as const;
        const callPositions = callMarkers.map((marker) => appCall.indexOf(marker));
        expect.soft(
            callPositions.every((position) => position >= 0),
            'complete App call expressions',
        ).toBe(true);
        expect.soft(callPositions, 'App call prop order').toEqual(
            [...callPositions].sort((left, right) => left - right),
        );
        const appCallPropNames = [
            ...appCall.matchAll(/^\s+(\w+)=\{/gm),
        ].map((match) => match[1]);
        expect(appCallPropNames, 'exact App call prop cardinality').toEqual(
            expectedPropNames,
        );
        const appSimpleProps = [
            ...appCall.matchAll(/^\s+(\w+)=\{([^}\n]+)}$/gm),
        ].map((match) => [match[1], match[2]]);
        expect(appSimpleProps, 'exact App call simple expressions').toEqual([
            ['state', 'state'],
            ['bootstrap', 'bootstrap'],
            ['control', 'control'],
            ['authSession', 'authSession'],
            ['globalValues', 'globalValues'],
            ['globalValuesEdited', 'globalValuesEdited'],
            ['busy', 'busy'],
            ['runState', 'runState'],
            ['loadedFixtureId', 'loadedFixtureId'],
            ['lastError', 'lastError'],
            ['selectedCommandId', 'selectedCommandId'],
            ['queueRows', 'queueRows'],
            ['initialSurface', 'activeAdvancedSurface'],
            ['onSelectCommand', 'setSelectedCommandId'],
            ['onGlobalValueChange', 'updateGlobalValue'],
        ]);
        expect(appCall, 'exact App surface callback expression').toMatch(
            /onSurfaceChange=\{\(surface\) =>\s*selectNavigation\(\{\s*mode: 'black-box-runner',\s*tab: 'advanced',\s*advancedSurface: surface,\s*\}\)\}\s*\/>/,
        );
        expect(appCall, 'App call has no key').not.toMatch(/\bkey\s*=/);

        expect(
            [...ownerSource.matchAll(/\buseState(?:<[^>]+>)?\s*\(/g)],
            'advanced controller exact state count',
        ).toHaveLength(1);
        expect(ownerSource, 'advanced controller state initializer').toContain(
            'useState<RunnerAdvancedSurfaceId>(initialSurface)',
        );
        expect(
            [...ownerSource.matchAll(/\buseEffect\s*\(/g)],
            'advanced controller exact effect count',
        ).toHaveLength(1);
        const compactOwner = ownerSource.replace(/\s+/g, '');
        expect(compactOwner, 'surface synchronization effect').toContain(
            'useEffect(()=>{setSurface(initialSurface);},[initialSurface]);',
        );
        expect(ownerSource, 'advanced controller no memos').not.toMatch(/\buseMemo\b/);
        expect(ownerSource, 'advanced controller no callbacks').not.toMatch(
            /\buseCallback\b/,
        );
        const selectSurfaceSource = ownerSource.slice(
            ownerSource.indexOf('const selectSurface'),
            ownerSource.indexOf('return (', ownerSource.indexOf('const selectSurface')),
        );
        const setSurfacePosition = selectSurfaceSource.indexOf(
            'setSurface(nextSurface)',
        );
        const onSurfaceChangePosition = selectSurfaceSource.indexOf(
            'onSurfaceChange(nextSurface)',
        );
        expect.soft(
            setSurfacePosition,
            'selectSurface state update exists',
        ).toBeGreaterThanOrEqual(0);
        expect.soft(
            onSurfaceChangePosition,
            'selectSurface callback exists',
        ).toBeGreaterThanOrEqual(0);
        expect.soft(
            setSurfacePosition,
            'selectSurface state update first',
        ).toBeLessThan(onSurfaceChangePosition);

        const switchMarkers = [
            "['workbench', 'Local Workbench']",
            "['distributed', 'Distributed Recipes']",
            "['run-manager', 'Run Manager']",
            "['manual', 'Manual Rallar']",
            "['shared-test', 'Shared Test']",
        ] as const;
        const switchPositions = switchMarkers.map((marker) =>
            ownerSource.indexOf(marker),
        );
        expect.soft(
            switchPositions.every((position) => position >= 0),
            'all advanced switches',
        ).toBe(true);
        expect.soft(switchPositions, 'advanced switch order').toEqual(
            [...switchPositions].sort((left, right) => left - right),
        );
        const switchEntries = [
            ...ownerSource.matchAll(/\['([^']+)', '([^']+)'\]/g),
        ].map((match) => [match[1], match[2]]);
        expect(switchEntries, 'exact five-switch cardinality').toEqual([
            ['workbench', 'Local Workbench'],
            ['distributed', 'Distributed Recipes'],
            ['run-manager', 'Run Manager'],
            ['manual', 'Manual Rallar'],
            ['shared-test', 'Shared Test'],
        ]);
        expect(ownerSource, 'selected switch class').toContain(
            "className={surface === id ? 'selected' : ''}",
        );
        expect(ownerSource, 'switch id cast').toContain(
            'selectSurface(id as RunnerAdvancedSurfaceId)',
        );

        const wrapperSpecs = [
            {
                id: 'panel-local-workbench',
                className: 'workspace-grid tab-workspace workbench-tab-grid',
                child: 'LocalWorkbenchSection',
                guard: "hidden={surface !== 'workbench'}",
                props: [
                    ['state', 'state'],
                    ['bootstrap', 'bootstrap'],
                    ['control', 'control'],
                    ['authSession', 'authSession'],
                    ['busy', 'busy'],
                    ['runState', 'runState'],
                    ['loadedFixtureId', 'loadedFixtureId'],
                    ['lastError', 'lastError'],
                    ['queueRows', 'queueRows'],
                    ['selectedCommandId', 'selectedCommandId'],
                    ['onSelectCommand', 'onSelectCommand'],
                ],
            },
            {
                id: 'panel-distributed-recipes',
                className:
                    'workspace-grid tab-workspace distributed-recipes-tab-grid',
                child: 'DistributedRecipesPanel',
                guard: "surface === 'distributed'",
                props: [
                    ['state', 'state'],
                    ['bootstrap', 'bootstrap'],
                    ['control', 'control'],
                    ['globalValues', 'globalValues'],
                ],
            },
            {
                id: 'panel-run-manager',
                className: 'workspace-grid tab-workspace run-manager-tab-grid',
                child: 'RunManagerPanel',
                guard: "surface === 'run-manager'",
                props: [
                    ['state', 'state'],
                    ['bootstrap', 'bootstrap'],
                    ['control', 'control'],
                ],
            },
            {
                id: 'panel-manual-rallar',
                className: 'workspace-grid tab-workspace manual-tab-grid',
                child: 'ManualRallarSection',
                guard: "hidden={surface !== 'manual'}",
                props: [
                    ['state', 'state'],
                    ['bootstrap', 'bootstrap'],
                    ['authSession', 'authSession'],
                    ['globalValues', 'globalValues'],
                    ['globalValuesEdited', 'globalValuesEdited'],
                    ['busy', 'busy'],
                    [
                        'history',
                        'selectRallarBlackBoxCommandHistory(state)',
                    ],
                    ['selectedCommandId', 'selectedCommandId'],
                    ['onSelectCommand', 'onSelectCommand'],
                    ['onGlobalValueChange', 'onGlobalValueChange'],
                ],
            },
            {
                id: 'panel-shared-test',
                className: 'workspace-grid tab-workspace shared-test-tab-grid',
                child: 'SharedTestPanel',
                guard: "surface === 'shared-test'",
                props: [],
            },
        ] as const;
        const wrapperPositions = wrapperSpecs.map((spec) =>
            ownerSource.indexOf(`id="${spec.id}"`),
        );
        expect.soft(
            wrapperPositions.every((position) => position >= 0),
            'all advanced wrappers',
        ).toBe(true);
        expect.soft(wrapperPositions, 'advanced wrapper order').toEqual(
            [...wrapperPositions].sort((left, right) => left - right),
        );
        for (const spec of wrapperSpecs) {
            const wrapper = ownerSource.match(
                new RegExp(
                    `<div\\s+id="${spec.id}"[\\s\\S]*?<\\/div>`,
                ),
            )?.[0] ?? '';
            expect.soft(wrapper, `${spec.id}: class`).toContain(
                `className="${spec.className}"`,
            );
            if (spec.guard.startsWith('surface ===')) {
                expect.soft(
                    ownerSource,
                    `${spec.id}: conditional mount guard`,
                ).toMatch(
                    new RegExp(
                        `\\{${spec.guard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} && \\(\\s*<div\\s+id="${spec.id}"`,
                    ),
                );
            } else {
                expect.soft(wrapper, `${spec.id}: persistent hidden guard`).toContain(
                    spec.guard,
                );
            }
            expect(
                [...wrapper.matchAll(new RegExp(`<${spec.child}\\b`, 'g'))],
                `${spec.id}: one direct child`,
            ).toHaveLength(1);
            const childCall = wrapper.match(
                new RegExp(`<${spec.child}\\b[\\s\\S]*?\\/>`),
            )?.[0] ?? '';
            const childProps = [
                ...childCall.matchAll(/\b(\w+)=\{([^}]+)}/g),
            ].map((match) => [match[1], match[2]]);
            expect.soft(
                childProps,
                `${spec.child}: exact ordered prop expressions`,
            ).toEqual(spec.props);
            expect.soft(childCall, `${spec.child}: no key`).not.toMatch(/\bkey\s*=/);
        }
        const conditionalMounts = [
            ...ownerSource.matchAll(
                /{surface === '([^']+)' && \(\s*<div\s+id="([^"]+)"/g,
            ),
        ].map((match) => [match[1], match[2]]);
        expect(conditionalMounts, 'exact three conditional mount branches').toEqual([
            ['distributed', 'panel-distributed-recipes'],
            ['run-manager', 'panel-run-manager'],
            ['shared-test', 'panel-shared-test'],
        ]);
        for (const persistentId of [
            'panel-local-workbench',
            'panel-manual-rallar',
        ] as const) {
            expect.soft(
                ownerSource,
                `${persistentId}: no conditional wrapper`,
            ).not.toMatch(
                new RegExp(
                    `\\{[^{}\\n]+(?:&&|\\?)\\s*\\(\\s*<div\\s+id="${persistentId}"`,
                ),
            );
        }
        expect(ownerSource, 'manual history selector stays direct').toContain(
            'history={selectRallarBlackBoxCommandHistory(state)}',
        );

        const dependencies = new Map<string, readonly string[]>();
        const discoverDependencies = (sourcePath: string): void => {
            if (dependencies.has(sourcePath)) return;
            const source = existsSync(resolve(repositoryRoot, sourcePath))
                ? repositorySource(sourcePath)
                : '';
            const directDependencies = [
                ...source.matchAll(
                    /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g,
                ),
            ]
                .map((match) => match[1] ?? match[2])
                .filter((moduleImport) => moduleImport.startsWith('.'))
                .map((moduleImport) =>
                    relative(
                        repositoryRoot,
                        resolve(
                            resolve(repositoryRoot, sourcePath),
                            '..',
                            moduleImport,
                        ),
                    ),
                )
                .filter(
                    (dependency) =>
                        ['.ts', '.tsx'].includes(extname(dependency)) &&
                        existsSync(resolve(repositoryRoot, dependency)),
                );
            dependencies.set(sourcePath, directDependencies);
            for (const dependency of directDependencies) {
                discoverDependencies(dependency);
            }
        };
        discoverDependencies(runnerAdvancedSourcePath);
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) {
                cycles.push(path);
                return;
            }
            if (visited.has(path)) return;
            active.add(path);
            for (const dependency of dependencies.get(path) ?? []) visit(dependency);
            active.delete(path);
            visited.add(path);
        };
        visit(runnerAdvancedSourcePath);
        expect(cycles, 'recursive RunnerAdvancedPanel import cycles').toEqual([]);
    });

    it('keeps runner recipe support and controlled views in exact owners', () => {
        const appSource = repositorySource(appSourcePath);
        const extractedPanelPath =
            'apps/rallar-black-box/src/legacy/runner/recipes/RunnerRecipesPanel.tsx';
        const hasExtractedPanel = existsSync(
            resolve(repositoryRoot, extractedPanelPath),
        );
        const controllerSource = hasExtractedPanel
            ? repositorySource(extractedPanelPath)
            : appSource.slice(
                  appSource.indexOf('function RunnerRecipesPanel'),
                  appSource.indexOf('function RunnerRunsPanel'),
              );
        const appAst = task9aSourceFile(appSourcePath, appSource);
        const tokenCollisionProbes = [
            'const probe = !value;',
            'const probe = +value;',
            'void run();',
            'delete run();',
            'value++;',
            'value--;',
            'const probe = value;',
            'let probe = value;',
            'for (let i = 0; i < 2; i++) run(i);',
            'for (let i = 0; i < 2; i--) run(i);',
        ].map((source, index) =>
            task9aAstFingerprint(
                task9aSourceFile(`task9a-token-probe-${index}.ts`, source).statements,
            ),
        );
        expect(
            new Set(tokenCollisionProbes).size,
            'Task 9A AST proof distinguishes behavior-bearing tokens',
        ).toBe(tokenCollisionProbes.length);
        const catalogPath =
            'apps/rallar-black-box/src/legacy/runner/recipes/runner-recipe-catalog.ts';
        const launchPath =
            'apps/rallar-black-box/src/legacy/runner/recipes/runner-launch-presentation.ts';
        const endpointsPath =
            'apps/rallar-black-box/src/legacy/runner/recipes/runner-endpoints.ts';
        const readinessPath =
            'apps/rallar-black-box/src/legacy/runner/recipes/RunnerReadinessPanel.tsx';
        const agentSetupPath =
            'apps/rallar-black-box/src/legacy/runner/recipes/RunnerAgentSetupPanel.tsx';
        const overviewPath =
            'apps/rallar-black-box/src/legacy/runner/recipes/views/RunnerRecipesOverview.tsx';
        const catalogListPath =
            'apps/rallar-black-box/src/legacy/runner/recipes/views/RunnerRecipeCatalogList.tsx';
        const detailPath =
            'apps/rallar-black-box/src/legacy/runner/recipes/views/RunnerRecipeDetail.tsx';
        const owners = [
            {
                path: catalogPath,
                lineCap: 150,
                declarations: [
                    ['RunnerRecipeSource', /^\s*export\s+type\s+RunnerRecipeSource\s*=/m],
                    ['RunnerRecipeCatalogEntry', /^\s*export\s+type\s+RunnerRecipeCatalogEntry\s*=/m],
                    ['runnerRecipeCatalog', /^\s*export\s+function\s+runnerRecipeCatalog\s*\(/m],
                    ['runnerRecipeDefaultScore', /^\s*function\s+runnerRecipeDefaultScore\s*\(/m],
                    ['runnerRecipeMatches', /^\s*export\s+function\s+runnerRecipeMatches\s*\(/m],
                ],
            },
            {
                path: launchPath,
                lineCap: 60,
                declarations: [
                    ['RunnerServiceProbe', /^\s*export\s+type\s+RunnerServiceProbe\s*=/m],
                    ['runnerLaunchStateFromRunState', /^\s*export\s+function\s+runnerLaunchStateFromRunState\s*\(/m],
                    ['runnerLaunchTone', /^\s*export\s+function\s+runnerLaunchTone\s*\(/m],
                    ['runnerReadinessCheckTone', /^\s*export\s+function\s+runnerReadinessCheckTone\s*\(/m],
                ],
            },
            {
                path: endpointsPath,
                lineCap: 90,
                declarations: [
                    ['runnerProbeUrl', /^\s*function\s+runnerProbeUrl\s*\(/m],
                    ['runnerApiProbeUrl', /^\s*export\s+function\s+runnerApiProbeUrl\s*\(/m],
                    ['runnerApiEndpointUrl', /^\s*export\s+function\s+runnerApiEndpointUrl\s*\(/m],
                    ['runnerControlWsUrlFromHttpBaseUrl', /^\s*export\s+function\s+runnerControlWsUrlFromHttpBaseUrl\s*\(/m],
                    ['runnerBrowserOrigin', /^\s*export\s+function\s+runnerBrowserOrigin\s*\(/m],
                ],
            },
            {
                path: readinessPath,
                lineCap: 90,
                declarations: [
                    ['RunnerReadinessPanel', /^\s*export\s+function\s+RunnerReadinessPanel\s*\(/m],
                ],
            },
            {
                path: agentSetupPath,
                lineCap: 250,
                declarations: [
                    ['RunnerAgentSetupPanel', /^\s*export\s+function\s+RunnerAgentSetupPanel\s*\(/m],
                ],
            },
            {
                path: overviewPath,
                lineCap: 320,
                declarations: [
                    ['RunnerRecipesOverview', /^\s*export\s+function\s+RunnerRecipesOverview\s*\(/m],
                ],
            },
            {
                path: catalogListPath,
                lineCap: 170,
                declarations: [
                    ['RunnerRecipeCatalogList', /^\s*export\s+function\s+RunnerRecipeCatalogList\s*\(/m],
                ],
            },
            {
                path: detailPath,
                lineCap: 380,
                declarations: [
                    ['RunnerRecipeDetail', /^\s*export\s+function\s+RunnerRecipeDetail\s*\(/m],
                ],
            },
        ] as const;
        const sourceByPath = new Map<string, string>();

        for (const owner of owners) {
            const ownerExists = existsSync(resolve(repositoryRoot, owner.path));
            const ownerSource = ownerExists ? repositorySource(owner.path) : '';
            sourceByPath.set(owner.path, ownerSource);
            expect.soft(ownerExists, `${owner.path}: owner exists`).toBe(true);
            expect.soft(ownerSource, `${owner.path}: no export-star barrel`).not.toMatch(
                /^\s*export\s*\*(?:\s+as\s+\w+)?\s+from\b/m,
            );
            expect.soft(ownerSource, `${owner.path}: no re-export facade`).not.toMatch(
                /^\s*export\s+(?:type\s+)?{[^}]+}\s*from\s*['"]/m,
            );
            expect.soft(ownerSource, `${owner.path}: no App import`).not.toMatch(
                /\b(?:from\s+|import\s*\(\s*)['"][^'"]*App\.tsx['"]/
            );
            expect.soft(ownerSource, `${owner.path}: no CSS import`).not.toMatch(
                /\b(?:from\s+|import\s*)['"][^'"]+\.css['"]/
            );
            expect.soft(
                ownerSource === ''
                    ? 0
                    : ownerSource.trimEnd().split(/\r?\n/).length,
                `${owner.path}: line cap`,
            ).toBeLessThanOrEqual(owner.lineCap);
            for (const [name, pattern] of owner.declarations) {
                expect.soft(ownerSource, `${owner.path}: ${name}`).toMatch(pattern);
            }
        }

        const sourceFor = (path: string): string => sourceByPath.get(path) ?? '';
        for (const contract of [
            {
                path: catalogPath,
                imports: [
                    '../../../distributed-recipes.ts|type:DistributedRecipeCatalogItem,value:distributedRecipeCommandPreview',
                    '../../../shared-test-handoff-fixtures.ts|value:RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG',
                    '../../shared/json-presentation.ts|value:json',
                    '../distributed-recipes/distributed-recipe-catalog.ts|value:DISTRIBUTED_RECIPE_CATALOG,value:configuredDistributedRecipeCatalogItem',
                    '../shared-test/shared-test-catalog.ts|value:catalogRequirements',
                    '@shared-test/rallar-bb-test/distributed-run.ts|type:RallarBlackBoxDistributedGroupRef',
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestRecipe',
                ],
                exports: [
                    'type:RunnerRecipeCatalogEntry',
                    'type:RunnerRecipeSource',
                    'value:runnerRecipeCatalog',
                    'value:runnerRecipeMatches',
                ],
            },
            {
                path: launchPath,
                imports: [
                    '../../../runner-readiness.ts|type:RecipeLaunchState,type:RunnerReadinessCheck,type:RunnerServiceProbeStatus',
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestRuntimeStatus',
                ],
                exports: [
                    'type:RunnerServiceProbe',
                    'value:runnerLaunchStateFromRunState',
                    'value:runnerLaunchTone',
                    'value:runnerReadinessCheckTone',
                ],
            },
            {
                path: endpointsPath,
                imports: [],
                exports: [
                    'value:runnerApiEndpointUrl',
                    'value:runnerApiProbeUrl',
                    'value:runnerBrowserOrigin',
                    'value:runnerControlWsUrlFromHttpBaseUrl',
                ],
            },
            {
                path: readinessPath,
                imports: [
                    '../../../runner-readiness.ts|type:RunnerReadinessCheck',
                    './runner-launch-presentation.ts|value:runnerReadinessCheckTone',
                ],
                exports: ['value:RunnerReadinessPanel'],
            },
            {
                path: agentSetupPath,
                imports: [
                    '../../../control-run-manager.ts|type:ControlRunSnapshot',
                    '../../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig',
                    '@shared/api/api-config.ts|type:AuthSession',
                ],
                exports: ['value:RunnerAgentSetupPanel'],
            },
            {
                path: overviewPath,
                imports: [
                    '../../../../control-agent-board.ts|type:ControlAgentBoardRow,type:ControlAgentBoardSummary',
                    '../../../../control-operator-token.ts|type:BlackBoxControlTokenSession',
                    '../../../../control-run-manager.ts|type:ControlRunSnapshot',
                    '../../../../distributed-recipes.ts|type:DistributedRecipeTargetRow',
                    '../../../../runner-readiness.ts|type:RecipeLaunchState,type:RunnerReadinessStatus',
                    '../../../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig',
                    '../../../shared/Metric.tsx|value:Metric',
                    '../../../shared/time-format.ts|value:formatTime',
                    '../../../shell/global-context-model.ts|type:CommandCenterGlobalValues',
                    '../../agents/ControlAgentBoardPanel.tsx|value:ControlAgentBoardPanel',
                    '../RunnerAgentSetupPanel.tsx|value:RunnerAgentSetupPanel',
                    '../RunnerReadinessPanel.tsx|value:RunnerReadinessPanel',
                    '../runner-launch-presentation.ts|type:RunnerServiceProbe,value:runnerLaunchTone',
                    '../runner-recipe-catalog.ts|type:RunnerRecipeCatalogEntry,type:RunnerRecipeSource',
                    '@shared-test/rallar-bb-test/distributed-run.ts|type:RallarBlackBoxDistributedGroupRef',
                    '@shared/api/api-config.ts|type:AuthSession',
                    'react|type:Dispatch,type:SetStateAction',
                ],
                exports: ['value:RunnerRecipesOverview'],
            },
            {
                path: catalogListPath,
                imports: [
                    '../../../../distributed-recipes.ts|value:distributedRecipeCommandPreview',
                    '../runner-recipe-catalog.ts|type:RunnerRecipeCatalogEntry',
                    'react|type:Dispatch,type:SetStateAction',
                ],
                exports: ['value:RunnerRecipeCatalogList'],
            },
            {
                path: detailPath,
                imports: [
                    '../../../../app-tabs.ts|type:AppTabId',
                    '../../../../control-run-manager.ts|type:ControlDistributedRunArtifactBundle,type:ControlDistributedRunSnapshot',
                    '../../../../distributed-recipes.ts|type:DistributedRecipePreflightSummary,value:distributedRecipeStateTone',
                    '../../../../runner-readiness.ts|type:RecipeLaunchState,value:runnerFriendlyErrorMessage',
                    '../../../shared/Metric.tsx|value:Metric',
                    '../../../shared/command-presentation.ts|value:resultSummary,value:statusTone',
                    '../../../shared/json-presentation.ts|value:json',
                    '../../../shared/time-format.ts|value:formatTime',
                    '../../../shell/global-context-model.ts|type:CommandCenterGlobalValues',
                    '../../distributed-recipes/DistributedRecipePreflightPanel.tsx|value:DistributedRecipePreflightPanel',
                    '../runner-launch-presentation.ts|value:runnerLaunchTone',
                    '../runner-recipe-catalog.ts|type:RunnerRecipeCatalogEntry',
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestResult,type:RallarBlackBoxTestState',
                ],
                exports: ['value:RunnerRecipeDetail'],
            },
        ] as const) {
            const ownerAst = task9aSourceFile(contract.path, sourceFor(contract.path));
            expect.soft(
                task9aImportEdges(ownerAst),
                `${contract.path}: exact import edges and kinds`,
            ).toEqual(contract.imports);
            expect.soft(
                task9aExportSeams(ownerAst),
                `${contract.path}: exact export seams`,
            ).toEqual(contract.exports);
        }
        expect.soft(
            task9aImportEdges(appAst).filter((edge) =>
                edge.startsWith('./legacy/runner/recipes/'),
            ),
            'App exact direct runner recipe owner edges',
        ).toEqual(
            hasExtractedPanel
                ? [
                      './legacy/runner/recipes/RunnerRecipesPanel.tsx|value:RunnerRecipesPanel',
                  ]
                : [
                      './legacy/runner/recipes/runner-endpoints.ts|value:runnerApiEndpointUrl,value:runnerApiProbeUrl,value:runnerBrowserOrigin,value:runnerControlWsUrlFromHttpBaseUrl',
                      './legacy/runner/recipes/runner-launch-presentation.ts|type:RunnerServiceProbe,value:runnerLaunchStateFromRunState',
                      './legacy/runner/recipes/runner-recipe-catalog.ts|type:RunnerRecipeCatalogEntry,type:RunnerRecipeSource,value:runnerRecipeCatalog,value:runnerRecipeMatches',
                      './legacy/runner/recipes/views/RunnerRecipeCatalogList.tsx|value:RunnerRecipeCatalogList',
                      './legacy/runner/recipes/views/RunnerRecipeDetail.tsx|value:RunnerRecipeDetail',
                      './legacy/runner/recipes/views/RunnerRecipesOverview.tsx|value:RunnerRecipesOverview',
                  ],
        );
        const appDirectImports = [
            {
                moduleImport:
                    './legacy/runner/recipes/runner-recipe-catalog.ts',
                seams: [
                    'RunnerRecipeSource',
                    'RunnerRecipeCatalogEntry',
                    'runnerRecipeCatalog',
                    'runnerRecipeMatches',
                ],
            },
            {
                moduleImport:
                    './legacy/runner/recipes/runner-launch-presentation.ts',
                seams: ['RunnerServiceProbe', 'runnerLaunchStateFromRunState'],
            },
            {
                moduleImport: './legacy/runner/recipes/runner-endpoints.ts',
                seams: [
                    'runnerApiProbeUrl',
                    'runnerApiEndpointUrl',
                    'runnerControlWsUrlFromHttpBaseUrl',
                    'runnerBrowserOrigin',
                ],
            },
            {
                moduleImport:
                    './legacy/runner/recipes/views/RunnerRecipesOverview.tsx',
                seams: ['RunnerRecipesOverview'],
            },
            {
                moduleImport:
                    './legacy/runner/recipes/views/RunnerRecipeCatalogList.tsx',
                seams: ['RunnerRecipeCatalogList'],
            },
            {
                moduleImport:
                    './legacy/runner/recipes/views/RunnerRecipeDetail.tsx',
                seams: ['RunnerRecipeDetail'],
            },
        ] as const;
        for (const directImport of hasExtractedPanel ? [] : appDirectImports) {
            const escapedModuleImport = directImport.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const importedSeams = appSource.match(
                new RegExp(
                    `import\\s*(?:type\\s*)?{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                ),
            )?.[1];
            expect.soft(importedSeams, directImport.moduleImport).toBeDefined();
            for (const seam of directImport.seams) {
                expect.soft(importedSeams ?? '', `${directImport.moduleImport}: ${seam}`).toMatch(
                    new RegExp(`\\b${seam}\\b`),
                );
            }
        }

        const overviewSource = sourceFor(overviewPath);
        for (const directImport of [
            {
                moduleImport: '../RunnerReadinessPanel.tsx',
                seam: 'RunnerReadinessPanel',
            },
            {
                moduleImport: '../RunnerAgentSetupPanel.tsx',
                seam: 'RunnerAgentSetupPanel',
            },
        ] as const) {
            const escapedModuleImport = directImport.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            expect.soft(overviewSource, directImport.moduleImport).toMatch(
                new RegExp(
                    `import\\s*{[^}]*\\b${directImport.seam}\\b[^}]*}\\s*from\\s*'${escapedModuleImport}';`,
                ),
            );
        }

        for (const declaration of owners.flatMap((owner) => owner.declarations)) {
            const [name] = declaration;
            expect.soft(appSource, `App local ${name}`).not.toMatch(
                new RegExp(
                    `^\\s*(?:(?:export\\s+)?(?:type\\s+${name}\\s*=|function\\s+${name}\\s*\\())`,
                    'm',
                ),
            );
        }
        expect(
            hasExtractedPanel ? controllerSource : appSource,
            'RunnerRecipesPanel direct declaration owner',
        ).toMatch(/^\s*(?:export\s+)?function\s+RunnerRecipesPanel\s*\(/m);
        if (hasExtractedPanel) {
            expect(appSource, 'RunnerRecipesPanel absent from App').not.toMatch(
                /^\s*function\s+RunnerRecipesPanel\s*\(/m,
            );
        }
        const controllerAst = task9aNamedFunction(
            task9aSourceFile(
                hasExtractedPanel ? extractedPanelPath : appSourcePath,
                controllerSource,
            ),
            'RunnerRecipesPanel',
        );
        const controllerReturnIndex = controllerAst.body!.statements.findIndex(
            ts.isReturnStatement,
        );
        expect(
            controllerReturnIndex,
            'RunnerRecipes has one final top-level return',
        ).toBe(controllerAst.body!.statements.length - 1);
        if (!hasExtractedPanel) {
            expect.soft(
                task9aAstFingerprint(
                    controllerAst.body!.statements.slice(0, controllerReturnIndex),
                ),
                'RunnerRecipes exact pre-return controller AST',
            ).toBe(
                '9b281a50b4bca6bb1421d9da543ca80cd319828125862f416b9b560b1b34e29d',
            );
        }

        for (const viewPath of [
            readinessPath,
            agentSetupPath,
            overviewPath,
            catalogListPath,
            detailPath,
        ] as const) {
            const viewSource = sourceFor(viewPath);
            expect.soft(viewSource, `${viewPath}: hook-free`).not.toMatch(
                /\buse(?:State|Memo|Effect|Ref|Callback|Reducer|Context|LayoutEffect)\b/,
            );
            expect.soft(viewSource, `${viewPath}: no fetch`).not.toMatch(/\bfetch\s*\(/);
            expect.soft(viewSource, `${viewPath}: no runtime execution`).not.toMatch(
                /rallarBlackBoxRuntimeStore|fetchControl|createDistributedRun|stageDistributedRun|startDistributedRun/,
            );
            expect.soft(viewSource, `${viewPath}: no persistence`).not.toMatch(
                /localStorage|sessionStorage|browserUiStorage|ui-persistence|writeStored|readStored/,
            );
            expect.soft(viewSource, `${viewPath}: no browser URL state`).not.toMatch(
                /globalThis\.location|window\.location|history\.(?:pushState|replaceState)/,
            );
        }
        for (const [viewPath, modelImport] of [
            [overviewPath, '../runner-recipe-catalog.ts'],
            [catalogListPath, '../runner-recipe-catalog.ts'],
            [detailPath, '../runner-recipe-catalog.ts'],
        ] as const) {
            const escapedModelImport = modelImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            expect.soft(sourceFor(viewPath), `${viewPath}: type-only catalog model`).toMatch(
                new RegExp(
                    `import\\s+type\\s*{[^}]*RunnerRecipeCatalogEntry[^}]*}\\s*from\\s*'${escapedModelImport}';`,
                ),
            );
        }

        if (!hasExtractedPanel) {
        expect(
            [...controllerSource.matchAll(/\buseState(?:<|\s*\()/g)],
            'RunnerRecipes exact state count',
        ).toHaveLength(27);
        const stateNames = [
            ...controllerSource.matchAll(/const \[(\w+),\s*\w+\]\s*=\s*useState/g),
        ].map((match) => match[1]);
        expect(stateNames, 'RunnerRecipes exact ordered states').toEqual([
            'controlBaseUrl',
            'controlToken',
            'brokeredControlToken',
            'brokeredControlTokenError',
            'controlRunId',
            'agentRunId',
            'agentPrefix',
            'agentCount',
            'agentLaunchSuffix',
            'agentRestoreSession',
            'agentLaunchMessage',
            'apiProbe',
            'controlProbe',
            'turnProbe',
            'controlRun',
            'controlSnapshot',
            'distributedRun',
            'artifactBundle',
            'query',
            'profile',
            'sourceFilter',
            'selectedRecipeId',
            'showEditor',
            'busyAction',
            'launchState',
            'launchMessage',
            'launchError',
        ]);
        expect(
            [...controllerSource.matchAll(/\buseMemo\s*\(/g)],
            'RunnerRecipes exact memo count',
        ).toHaveLength(10);
        const memoNames = [
            ...controllerSource.matchAll(/const (\w+) = useMemo\s*\(/g),
        ].map((match) => match[1]);
        expect(memoNames, 'RunnerRecipes exact ordered memos').toEqual([
            'groupRef',
            'catalog',
            'profileOptions',
            'filteredRecipes',
            'recipePreflight',
            'targetRows',
            'recipeAgentRows',
            'recipeAgentSummary',
            'agentIds',
            'agentLaunchUrls',
        ]);
        expect(
            [...controllerSource.matchAll(/\buseEffect\s*\(/g)],
            'RunnerRecipes exact effect count',
        ).toHaveLength(4);
        expect(
            [...controllerSource.matchAll(/\buseRef\s*\(/g)],
            'RunnerRecipes exact ref count',
        ).toHaveLength(1);
        expect(controllerSource, 'RunnerRecipes initial refresh ref').toContain(
            'const didInitialRefresh = useRef(false);',
        );
        const actionMarkers = [
            'const resolveDistributedControlToken = async',
            'const refreshReadiness = async',
            'const copyText = async',
            'const createBrokeredAgentLaunchUrls = async',
            'const copyAgentLinks = async',
            'const openAgentTabs = async',
            'const runLocalRecipe = async',
            'const runDistributedRecipe = async',
        ] as const;
        const actionPositions = actionMarkers.map((marker) =>
            controllerSource.indexOf(marker),
        );
        expect.soft(
            actionPositions.every((position) => position >= 0),
            'RunnerRecipes all actions',
        ).toBe(true);
        expect.soft(actionPositions, 'RunnerRecipes action order').toEqual(
            [...actionPositions].sort((left, right) => left - right),
        );
        const openAgentTabsSource = controllerSource.slice(
            controllerSource.indexOf('const openAgentTabs'),
            controllerSource.indexOf('const runLocalRecipe'),
        );
        const popupPosition = openAgentTabsSource.indexOf(
            "globalThis.open?.('about:blank'",
        );
        const mintPosition = openAgentTabsSource.indexOf(
            'await createBrokeredAgentLaunchUrls()',
        );
        expect(popupPosition, 'agent popup marker').toBeGreaterThanOrEqual(0);
        expect(mintPosition, 'agent mint marker').toBeGreaterThanOrEqual(0);
        expect(popupPosition, 'popup opens before mint await').toBeLessThan(
            mintPosition,
        );
        const distributedAction = controllerSource.slice(
            controllerSource.indexOf('const runDistributedRecipe'),
            controllerSource.indexOf('return (', controllerSource.indexOf('const runDistributedRecipe')),
        );
        const distributedSequence = [
            'await createDistributedRun({',
            'await stageDistributedRun({',
            'await startDistributedRun({',
        ].map((marker) => distributedAction.indexOf(marker));
        expect.soft(
            distributedSequence.every((position) => position >= 0),
            'distributed create-stage-start markers',
        ).toBe(true);
        expect.soft(distributedSequence, 'distributed create-stage-start order').toEqual(
            [...distributedSequence].sort((left, right) => left - right),
        );
        }

        const viewCalls = [
            {
                name: 'RunnerRecipesOverview',
                props: [
                    'selectedRecipe', 'launchState', 'busyAction',
                    'localDisabledReason', 'localRunning',
                    'distributedDisabledReason', 'runLocalRecipe',
                    'runDistributedRecipe', 'readiness', 'refreshReadiness',
                    'openAgentTabs', 'groupRef', 'recipeAgentRows',
                    'recipeAgentSummary', 'agentRunId', 'agentPrefix',
                    'agentCount', 'agentRestoreSession', 'bootstrap',
                    'authSession', 'agentControlWsUrl', 'globalValues',
                    'controlRun', 'agentLaunchUrls', 'agentLaunchMessage',
                    'setAgentRunId', 'setControlRunId', 'setControlRun',
                    'setAgentPrefix', 'setAgentCount',
                    'setAgentRestoreSession', 'copyAgentLinks', 'query',
                    'setQuery', 'profile', 'setProfile', 'profileOptions',
                    'sourceFilter', 'setSourceFilter', 'controlBaseUrl',
                    'setControlBaseUrl', 'controlToken', 'setControlToken',
                    'brokeredControlToken', 'brokeredControlTokenError',
                    'filteredRecipes', 'catalog', 'apiProbe', 'controlProbe',
                    'targetableRows', 'connectedAgentCount',
                ],
            },
            {
                name: 'RunnerRecipeCatalogList',
                props: [
                    'filteredRecipes', 'selectedRecipe',
                    'localDisabledReason', 'localRunning',
                    'distributedDisabledReason', 'setSelectedRecipeId',
                    'runLocalRecipe', 'runDistributedRecipe', 'setShowEditor',
                    'copyText',
                ],
            },
            {
                name: 'RunnerRecipeDetail',
                props: [
                    'selectedRecipe', 'launchState', 'localDisabledReason',
                    'localRunning', 'distributedDisabledReason',
                    'runLocalRecipe', 'runDistributedRecipe', 'controlRunId',
                    'globalValues', 'recipePreflight', 'launchMessage',
                    'launchError', 'lastError', 'runState', 'history',
                    'failures', 'latestResult', 'firstFailure',
                    'distributedRun', 'artifactBundle', 'state', 'showEditor',
                    'copyText', 'onOpenTab',
                ],
            },
        ] as const;
        const viewCallPositions: number[] = [];
        for (const viewCall of viewCalls) {
            const calls = [
                ...controllerSource.matchAll(
                    new RegExp(`<${viewCall.name}\\b([\\s\\S]*?)\\/>`, 'g'),
                ),
            ];
            expect.soft(calls, `${viewCall.name}: one call`).toHaveLength(1);
            const call = calls[0]?.[0] ?? '';
            const propNames = [...call.matchAll(/^\s+(\w+)=\{/gm)].map(
                (match) => match[1],
            );
            expect.soft(propNames, `${viewCall.name}: exact props`).toEqual(
                viewCall.props,
            );
            expect.soft(call, `${viewCall.name}: no key`).not.toMatch(/\bkey\s*=/);
            viewCallPositions.push(controllerSource.indexOf(`<${viewCall.name}`));
        }
        expect.soft(
            viewCallPositions.every((position) => position >= 0),
            'runner recipe view call markers',
        ).toBe(true);
        expect.soft(viewCallPositions, 'Overview-Catalog-Detail order').toEqual(
            [...viewCallPositions].sort((left, right) => left - right),
        );
        expect(controllerSource, 'App retains runner recipe outer panel').toContain(
            '<section className="panel runner-recipes-panel">',
        );
        expect(controllerSource, 'App retains runner recipe layout').toContain(
            '<div className="runner-recipes-layout">',
        );
        const controllerReturn = task9aReturnExpression(controllerAst);
        expect.soft(
            task9aJsxRuntimeFingerprint(controllerReturn),
            'RunnerRecipes exact wrapper/composition return AST',
        ).toBe(
            '3d78f25aaeb5bc4414be93dbb276bc2cf1f63863a25695913148ebfef3bbe632',
        );
        for (const [viewName, expectedFingerprint] of [
            [
                'RunnerRecipesOverview',
                'b118bbf976a5fe659345396b76a2245ccd868afae7936131203d8d1df5763897',
            ],
            [
                'RunnerRecipeCatalogList',
                '437eae66976db2ba8ce7bc06437c442cde57739c4877f7d39b16a6a1b8294b9b',
            ],
            [
                'RunnerRecipeDetail',
                '23aff1008690a8a6f0004b2ff81f929f51b6712a75ed7eef6729537ecbd7c432',
            ],
        ] as const) {
            const calls = task9aJsxCalls(controllerAst, viewName);
            expect.soft(calls, `${viewName}: compiler call cardinality`).toHaveLength(1);
            expect.soft(
                task9aAstFingerprint(calls),
                `${viewName}: exact compiler call AST`,
            ).toBe(expectedFingerprint);
        }
        for (const [viewPath, viewName, expectedFingerprint] of [
            [
                readinessPath,
                'RunnerReadinessPanel',
                'd21751b8240fb8b49803ff0fcda5f6cdf1b4715df8fbfbef4cf4137e82e3d9ca',
            ],
            [
                agentSetupPath,
                'RunnerAgentSetupPanel',
                'a566a63c3543f0c71e3280119905675a47f818ca826309eae39460a1c0043ee7',
            ],
            [
                overviewPath,
                'RunnerRecipesOverview',
                '72fc83fc223ebe3a4cc23d5e716e9c2ae0110191fb1a6b57dfa17a2fcb5e8158',
            ],
            [
                catalogListPath,
                'RunnerRecipeCatalogList',
                'ebd6a56c92014c4a4b4b070b99756e99688d5ad12d0a472d1977e65d1c7efbaa',
            ],
            [
                detailPath,
                'RunnerRecipeDetail',
                'a108dd25ba209333cdd48d09a5b210445877b739b30e0544fc6d7146ad75a65b',
            ],
        ] as const) {
            const viewAst = task9aSourceFile(viewPath, sourceFor(viewPath));
            expect.soft(
                task9aJsxRuntimeFingerprint(
                    task9aReturnExpression(task9aNamedFunction(viewAst, viewName)),
                ),
                `${viewName}: exact compiled return AST`,
            ).toBe(expectedFingerprint);
        }

        expect(overviewSource, 'overview fragment-only return').toMatch(
            /return\s*\(\s*<>[\s\S]*<\/\>\s*\);/,
        );
        const overviewOrder = [
            'className="panel-heading"',
            'runner-quick-launch-strip',
            '<RunnerReadinessPanel',
            'title="Targetable Agents"',
            '<RunnerAgentSetupPanel',
            'runner-recipes-toolbar',
            'runner-recipes-summary-grid',
        ].map((marker) => overviewSource.indexOf(marker));
        expect.soft(
            overviewOrder.every((position) => position >= 0),
            'overview JSX markers',
        ).toBe(true);
        expect.soft(overviewOrder, 'overview JSX order').toEqual(
            [...overviewOrder].sort((left, right) => left - right),
        );
        expect(overviewSource, 'targetable board hides connected list').toContain(
            'showConnectedAgents={false}',
        );
        const runIdCallback = overviewSource.slice(
            overviewSource.indexOf('onRunIdChange={(value) =>'),
            overviewSource.indexOf('onAgentPrefixChange=', overviewSource.indexOf('onRunIdChange={(value) =>')),
        );
        const runIdSequence = [
            'setAgentRunId(value)',
            'setControlRunId(value)',
            'setControlRun(undefined)',
        ].map((marker) => runIdCallback.indexOf(marker));
        expect.soft(
            runIdSequence.every((position) => position >= 0),
            'agent run ID setter markers',
        ).toBe(true);
        expect.soft(runIdSequence, 'agent run ID setter order').toEqual(
            [...runIdSequence].sort((left, right) => left - right),
        );

        const catalogListSource = sourceFor(catalogListPath);
        const catalogOrder = [
            'filteredRecipes.map',
            'setSelectedRecipeId(entry.id)',
            'void runLocalRecipe()',
            'void runDistributedRecipe()',
            'setShowEditor((value) => !value)',
            "'Copied recipe command.'",
            'No recipes match the filters',
        ].map((marker) => catalogListSource.indexOf(marker));
        expect.soft(
            catalogOrder.every((position) => position >= 0),
            'catalog leaf JSX/action markers',
        ).toBe(true);
        expect.soft(catalogOrder, 'catalog leaf JSX/action order').toEqual(
            [...catalogOrder].sort((left, right) => left - right),
        );

        const detailSource = sourceFor(detailPath);
        const detailOrder = [
            'runner-recipe-actions-primary',
            'runner-disabled-reasons',
            'runner-recipe-meta',
            'runner-requirements',
            'runner-preflight',
            'runner-launch-result',
            'runner-result-grid',
            'runner-failure-focus',
            'runner-distributed-summary',
            'runner-artifact-summary',
            'runner-inline-editor',
            'runner-secondary-actions',
        ].map((marker) => detailSource.indexOf(marker));
        expect.soft(
            detailOrder.every((position) => position >= 0),
            'detail leaf JSX markers',
        ).toBe(true);
        expect.soft(detailOrder, 'detail leaf JSX order').toEqual(
            [...detailOrder].sort((left, right) => left - right),
        );

        const dependencies = new Map<string, readonly string[]>();
        const discoverDependencies = (sourcePath: string): void => {
            if (dependencies.has(sourcePath)) return;
            const source = existsSync(resolve(repositoryRoot, sourcePath))
                ? repositorySource(sourcePath)
                : '';
            const directDependencies = [
                ...source.matchAll(
                    /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g,
                ),
            ]
                .map((match) => match[1] ?? match[2])
                .filter((moduleImport) => moduleImport.startsWith('.'))
                .map((moduleImport) =>
                    relative(
                        repositoryRoot,
                        resolve(
                            resolve(repositoryRoot, sourcePath),
                            '..',
                            moduleImport,
                        ),
                    ),
                )
                .filter(
                    (dependency) =>
                        ['.ts', '.tsx'].includes(extname(dependency)) &&
                        existsSync(resolve(repositoryRoot, dependency)),
                );
            dependencies.set(sourcePath, directDependencies);
            for (const dependency of directDependencies) {
                discoverDependencies(dependency);
            }
        };
        for (const owner of owners) discoverDependencies(owner.path);
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) {
                cycles.push(path);
                return;
            }
            if (visited.has(path)) return;
            active.add(path);
            for (const dependency of dependencies.get(path) ?? []) visit(dependency);
            active.delete(path);
            visited.add(path);
        };
        for (const owner of owners) visit(owner.path);
        expect(cycles, 'runner recipe owner import cycles').toEqual([]);

        const appCalls = [
            ...appSource.matchAll(/<RunnerRecipesPanel\b([\s\S]*?)\/>/g),
        ];
        expect(appCalls, 'one App RunnerRecipesPanel call').toHaveLength(1);
        expect(appSource, 'conditional Recipes mount remains App-owned').toContain(
            "{activeMode === 'black-box-runner' &&\n                        activeTab === 'recipes' && (",
        );
        const appCall = appCalls[0]?.[0] ?? '';
        expect(appCall, 'Recipes-to-Runs setter before navigation').toMatch(
            /onDistributedRunStarted=\{\(selection\) => \{\s*setRunnerDistributedSelection\(selection\);\s*selectTab\('runs'\);\s*}}/,
        );
        expect(appCall, 'RunnerRecipes call has no key').not.toMatch(/\bkey\s*=/);
    });

    it('cuts the runner recipes controller into exact focused owners', () => {
        const appSource = repositorySource(appSourcePath);
        const recipesRoot =
            'apps/rallar-black-box/src/legacy/runner/recipes';
        const catalogHookPath = `${recipesRoot}/use-runner-recipe-catalog.ts`;
        const agentHookPath = `${recipesRoot}/use-runner-agent-launch-state.ts`;
        const agentActionsPath = `${recipesRoot}/runner-agent-launch-actions.ts`;
        const controllerPath = `${recipesRoot}/use-runner-recipes-controller.ts`;
        const panelPath = `${recipesRoot}/RunnerRecipesPanel.tsx`;
        const owners = [
            {
                path: catalogHookPath,
                lineCap: 150,
                declarations: [
                    /^export function useRunnerRecipeCatalog\(/m,
                    /^export type RunnerRecipeCatalogModel\s*=/m,
                ],
            },
            {
                path: agentHookPath,
                lineCap: 180,
                declarations: [
                    /^export function useRunnerAgentLaunchState\(/m,
                    /^export type RunnerAgentLaunchStateModel\s*=/m,
                ],
            },
            {
                path: agentActionsPath,
                lineCap: 240,
                declarations: [
                    /^export function createRunnerAgentLaunchActions\(/m,
                ],
            },
            {
                path: controllerPath,
                lineCap: 700,
                declarations: [
                    /^export type UseRunnerRecipesControllerInput\s*=/m,
                    /^export function useRunnerRecipesController\(/m,
                    /^export type RunnerRecipesControllerModel\s*=/m,
                ],
            },
            {
                path: panelPath,
                lineCap: 260,
                declarations: [
                    /^export function RunnerRecipesPanel\(/m,
                ],
            },
        ] as const;
        const sources = new Map<string, string>();
        for (const owner of owners) {
            const exists = existsSync(resolve(repositoryRoot, owner.path));
            const source = exists ? repositorySource(owner.path) : '';
            sources.set(owner.path, source);
            expect.soft(exists, `${owner.path}: exists`).toBe(true);
            expect.soft(
                source === '' ? 0 : source.trimEnd().split(/\r?\n/).length,
                `${owner.path}: line cap`,
            ).toBeLessThanOrEqual(owner.lineCap);
            for (const declaration of owner.declarations) {
                expect.soft(source, `${owner.path}: ${declaration.source}`).toMatch(
                    declaration,
                );
            }
            expect.soft(source, `${owner.path}: no App import`).not.toMatch(
                /\b(?:from\s+|import\s*\(\s*)['"][^'"]*App\.tsx['"]/
            );
            expect.soft(source, `${owner.path}: no CSS import`).not.toMatch(
                /\b(?:from\s+|import\s*)['"][^'"]+\.css['"]/
            );
        }

        const catalogHook = sources.get(catalogHookPath) ?? '';
        const agentHook = sources.get(agentHookPath) ?? '';
        const agentActions = sources.get(agentActionsPath) ?? '';
        const controller = sources.get(controllerPath) ?? '';
        const panel = sources.get(panelPath) ?? '';

        expect.soft(appSource, 'RunnerRecipesPanel absent from App').not.toMatch(
            /^function RunnerRecipesPanel\(/m,
        );
        expect.soft(appSource, 'App direct RunnerRecipesPanel import').toMatch(
            /import\s*{\s*RunnerRecipesPanel\s*}\s*from\s*'\.\/legacy\/runner\/recipes\/RunnerRecipesPanel\.tsx';/,
        );
        const appCalls = [
            ...appSource.matchAll(/<RunnerRecipesPanel\b([\s\S]*?)\/>/g),
        ];
        expect.soft(appCalls, 'one App RunnerRecipesPanel call').toHaveLength(1);
        const appCall = appCalls[0]?.[0] ?? '';
        expect.soft(
            [...appCall.matchAll(/^\s+(\w+)=\{/gm)].map((match) => match[1]),
            'App exact ten-prop RunnerRecipesPanel call',
        ).toEqual([
            'state',
            'bootstrap',
            'control',
            'authSession',
            'globalValues',
            'busy',
            'runState',
            'lastError',
            'onDistributedRunStarted',
            'onOpenTab',
        ]);
        expect.soft(appCall, 'App RunnerRecipesPanel call has no key').not.toMatch(
            /\bkey\s*=/,
        );
        expect.soft(appCall, 'selection set before Runs navigation').toMatch(
            /setRunnerDistributedSelection\(selection\);\s*selectTab\('runs'\);/,
        );

        const stateNames = (source: string): readonly string[] => [
            ...source.matchAll(/const \[(\w+),\s*\w+\]\s*=\s*useState/g),
        ].map((match) => match[1]);
        const memoNames = (source: string): readonly string[] => [
            ...source.matchAll(/const (\w+) = useMemo\s*\(/g),
        ].map((match) => match[1]);
        expect.soft(stateNames(catalogHook), 'catalog exact states').toEqual([
            'query',
            'profile',
            'sourceFilter',
            'selectedRecipeId',
            'showEditor',
        ]);
        expect.soft(memoNames(catalogHook), 'catalog exact memos').toEqual([
            'groupRef',
            'catalog',
            'profileOptions',
            'filteredRecipes',
            'recipePreflight',
        ]);
        expect.soft(catalogHook, 'catalog fallback order').toMatch(
            /catalog\.find\([\s\S]*?\)\s*\?\?\s*filteredRecipes\[0\]\s*\?\?\s*catalog\[0\]/,
        );
        expect.soft(catalogHook, 'catalog has no effects/ref/callback').not.toMatch(
            /\buse(?:Effect|Ref|Callback)\b/,
        );

        expect.soft(stateNames(agentHook), 'agent exact states').toEqual([
            'agentRunId',
            'agentPrefix',
            'agentCount',
            'agentLaunchSuffix',
            'agentRestoreSession',
            'agentLaunchMessage',
        ]);
        expect.soft(memoNames(agentHook), 'agent exact memos').toEqual([
            'agentIds',
            'agentLaunchUrls',
        ]);
        expect.soft(agentHook, 'agent has no effects/ref/callback').not.toMatch(
            /\buse(?:Effect|Ref|Callback)\b/,
        );

        expect.soft(stateNames(controller), 'central exact states').toEqual([
            'controlBaseUrl',
            'controlToken',
            'brokeredControlToken',
            'brokeredControlTokenError',
            'controlRunId',
            'apiProbe',
            'controlProbe',
            'turnProbe',
            'controlRun',
            'controlSnapshot',
            'distributedRun',
            'artifactBundle',
            'busyAction',
            'launchState',
            'launchMessage',
            'launchError',
        ]);
        expect.soft(memoNames(controller), 'central exact memos').toEqual([
            'targetRows',
            'recipeAgentRows',
            'recipeAgentSummary',
        ]);
        const aggregate = [catalogHook, agentHook, controller].join('\n');
        expect.soft([...aggregate.matchAll(/\buseState(?:<|\s*\()/g)]).toHaveLength(27);
        expect.soft([...aggregate.matchAll(/\buseMemo\s*\(/g)]).toHaveLength(10);
        expect.soft([...aggregate.matchAll(/\buseEffect\s*\(/g)]).toHaveLength(4);
        expect.soft([...aggregate.matchAll(/\buseRef\s*\(/g)]).toHaveLength(1);
        expect.soft([...aggregate.matchAll(/\buseCallback\s*\(/g)]).toHaveLength(0);

        expect.soft(agentActions, 'actions have no React import').not.toMatch(
            /\bfrom\s*['"]react['"]|\buse[A-Z]\w*\b/,
        );
        expect.soft(agentActions, 'copy agent action').toContain(
            'const copyAgentLinks = async',
        );
        expect.soft(agentActions, 'open tabs action').toContain(
            'const openAgentTabs = async',
        );
        const openTabs = agentActions.slice(
            agentActions.indexOf('const openAgentTabs'),
        );
        expect.soft(openTabs.indexOf("globalThis.open?.('about:blank'"))
            .toBeGreaterThanOrEqual(0);
        expect.soft(openTabs.indexOf('await createBrokeredAgentLaunchUrls()'))
            .toBeGreaterThan(openTabs.indexOf("globalThis.open?.('about:blank'"));

        expect.soft(panel, 'panel has no built-in hooks').not.toMatch(
            /\buse(?:State|Memo|Effect|Ref|Callback|Reducer|Context|LayoutEffect)\b/,
        );
        expect.soft(panel, 'panel has no runtime/network/storage').not.toMatch(
            /\bfetch\s*\(|rallarBlackBoxRuntimeStore|localStorage|sessionStorage|browserUiStorage/,
        );
        expect.soft(
            [...panel.matchAll(/\buseRunnerRecipesController\s*\(/g)],
            'panel calls controller once',
        ).toHaveLength(1);
        const panelOrder = [
            '<RunnerRecipesOverview',
            'className="runner-recipes-layout"',
            '<RunnerRecipeCatalogList',
            '<RunnerRecipeDetail',
        ].map((marker) => panel.indexOf(marker));
        expect.soft(panelOrder.every((position) => position >= 0)).toBe(true);
        expect.soft(panelOrder).toEqual(
            [...panelOrder].sort((left, right) => left - right),
        );

        const exactImports = new Map<string, readonly string[]>([
            [
                catalogHookPath,
                [
                    '../../../distributed-recipes.ts|value:distributedRecipePreflight',
                    '../../../recipe-fixtures.ts|value:RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS',
                    '../../shared/unique-values.ts|value:uniqueValues',
                    '../../shell/global-context-model.ts|type:CommandCenterGlobalValues',
                    './runner-recipe-catalog.ts|type:RunnerRecipeSource,value:runnerRecipeCatalog,value:runnerRecipeMatches',
                    'react|value:useMemo,value:useState',
                ],
            ],
            [
                agentHookPath,
                [
                    '../../../control-client.ts|type:RallarBlackBoxControlSnapshot',
                    '../../../runner-agent-launch.ts|value:createRunnerAgentLaunchUrl,value:runnerAgentId,value:runnerNewAgentLaunchSuffix',
                    '../../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig',
                    '../../shared/safe-id-segment.ts|value:safeIdSegment',
                    '../../shell/global-context-model.ts|type:CommandCenterGlobalValues',
                    './runner-endpoints.ts|value:runnerBrowserOrigin,value:runnerControlWsUrlFromHttpBaseUrl',
                    '@shared/api/api-config.ts|type:AuthSession',
                    'react|value:useMemo,value:useState',
                ],
            ],
            [
                agentActionsPath,
                [
                    '../../../runner-agent-launch.ts|value:createRunnerAgentLaunchUrl,value:runnerNewAgentLaunchSuffix',
                    '../../../runner-readiness.ts|value:runnerFriendlyErrorMessage',
                    '../../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig',
                    './runner-endpoints.ts|value:runnerBrowserOrigin',
                    '@shared-web/browser/api-client-config.ts|value:configureApiClient',
                    '@shared-web/browser/api-integration.ts|value:issueAgentSessionTickets',
                    '@shared/api/api-config.ts|type:AuthSession',
                ],
            ],
            [
                controllerPath,
                [
                    '../../../control-agent-board.ts|value:deriveControlAgentBoardRows,value:summarizeControlAgentBoardRows',
                    '../../../control-client.ts|type:RallarBlackBoxControlSnapshot',
                    '../../../control-operator-token.ts|type:BlackBoxControlTokenSession,value:resolveBlackBoxControlToken',
                    '../../../control-run-manager.ts|type:ControlDistributedRunArtifactBundle,type:ControlDistributedRunSnapshot,type:ControlRunSnapshot,type:ControlServerSnapshot,value:controlHttpBaseUrlFromWsUrl,value:createDistributedRun,value:fetchControlRunSnapshot,value:fetchControlServerSnapshot,value:fetchDistributedRun,value:stageDistributedRun,value:startDistributedRun',
                    '../../../distributed-recipes.ts|value:buildDistributedRunManifest,value:defaultDistributedRecipeTargetIds,value:distributedRecipePreflight,value:distributedRecipeTargetRows',
                    '../../../runner-readiness.ts|type:RecipeLaunchState,type:RunnerTurnProbeStatus,value:runnerDisabledReason,value:runnerFriendlyErrorMessage,value:runnerReadinessStatus',
                    '../../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig,value:rallarBlackBoxRuntimeStore',
                    '../../shared/json-presentation.ts|value:json',
                    '../../shared/safe-id-segment.ts|value:safeIdSegment',
                    '../../shell/global-context-model.ts|type:CommandCenterGlobalValues',
                    '../distributed-recipes/distributed-manifest-validation.ts|value:validateDistributedRecipeManifest',
                    '../runner-contracts.ts|type:RunnerDistributedRunSelection',
                    '../shared/control-snapshot-bounds.ts|value:RUN_MANAGER_SNAPSHOT_BOUNDS',
                    './runner-agent-launch-actions.ts|value:createRunnerAgentLaunchActions',
                    './runner-endpoints.ts|value:runnerApiEndpointUrl,value:runnerApiProbeUrl',
                    './runner-launch-presentation.ts|type:RunnerServiceProbe,value:runnerLaunchStateFromRunState',
                    './use-runner-agent-launch-state.ts|value:useRunnerAgentLaunchState',
                    './use-runner-recipe-catalog.ts|value:useRunnerRecipeCatalog',
                    '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxCommandHistory,value:selectRallarBlackBoxFailures,value:selectRallarBlackBoxFirstFailure',
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
                    '@shared/api/api-config.ts|type:AuthSession',
                    'react|value:useEffect,value:useMemo,value:useRef,value:useState',
                ],
            ],
            [
                panelPath,
                [
                    '../../../app-tabs.ts|type:AppTabId',
                    './use-runner-recipes-controller.ts|type:UseRunnerRecipesControllerInput,value:useRunnerRecipesController',
                    './views/RunnerRecipeCatalogList.tsx|value:RunnerRecipeCatalogList',
                    './views/RunnerRecipeDetail.tsx|value:RunnerRecipeDetail',
                    './views/RunnerRecipesOverview.tsx|value:RunnerRecipesOverview',
                ],
            ],
        ]);
        for (const [path, expectedImports] of exactImports) {
            expect.soft(
                task9aImportEdges(
                    task9aSourceFile(path, sources.get(path) ?? ''),
                ),
                `${path}: exact imports/kinds/edges`,
            ).toEqual([...expectedImports].sort());
        }

        const exactExports = new Map<string, readonly string[]>([
            [
                catalogHookPath,
                [
                    'type:RunnerRecipeCatalogModel',
                    'value:useRunnerRecipeCatalog',
                ],
            ],
            [
                agentHookPath,
                [
                    'type:RunnerAgentLaunchStateModel',
                    'value:useRunnerAgentLaunchState',
                ],
            ],
            [agentActionsPath, ['value:createRunnerAgentLaunchActions']],
            [
                controllerPath,
                [
                    'type:RunnerRecipesControllerModel',
                    'type:UseRunnerRecipesControllerInput',
                    'value:useRunnerRecipesController',
                ],
            ],
            [panelPath, ['value:RunnerRecipesPanel']],
        ]);
        for (const [path, expectedExports] of exactExports) {
            expect.soft(
                task9aExportSeams(
                    task9aSourceFile(path, sources.get(path) ?? ''),
                ),
                `${path}: exact exports`,
            ).toEqual(expectedExports);
        }

        const appAst = task9aSourceFile(appSourcePath, appSource);
        expect.soft(
            task9aImportEdges(appAst).filter((edge) =>
                edge.startsWith('./legacy/runner/recipes/'),
            ),
            'App imports only the RunnerRecipesPanel owner',
        ).toEqual([
            './legacy/runner/recipes/RunnerRecipesPanel.tsx|value:RunnerRecipesPanel',
        ]);
        const appCallNodes = task9aJsxCalls(appAst, 'RunnerRecipesPanel');
        expect.soft(
            task9aAstFingerprint(appCallNodes),
            'App exact RunnerRecipesPanel call AST',
        ).toBe(
            'ca66bbe872757d895bbe5df47df3af8c907109db41b842c3025d292b8ac1a253',
        );
        let appGuardNode: ts.Node | undefined = appCallNodes[0];
        while (appGuardNode && !ts.isJsxExpression(appGuardNode)) {
            appGuardNode = appGuardNode.parent;
        }
        expect.soft(
            appGuardNode ? task9aAstFingerprint([appGuardNode]) : '',
            'App exact Recipes guard/callback AST',
        ).toBe(
            '2be228145b4d7199f7ae5436cea2e35063c6c1201486a4f3c69f69e47f4b761b',
        );

        const functionDeclaration = (
            path: string,
            name: string,
        ): ts.FunctionDeclaration | undefined => {
            const source = sources.get(path) ?? '';
            return task9aSourceFile(path, source).statements.find(
                (statement): statement is ts.FunctionDeclaration =>
                    ts.isFunctionDeclaration(statement) &&
                    statement.name?.text === name,
            );
        };
        for (const [path, name, expectedFingerprint] of [
            [catalogHookPath, 'useRunnerRecipeCatalog', '4bf50cb94592de66fdc974223a5659e76ed261a3932d647acd7225650b79a584'],
            [agentHookPath, 'useRunnerAgentLaunchState', 'a01124ddab504f883eedc382ba31afb593e406a7884a6331ef62072999ba02c1'],
            [agentActionsPath, 'createRunnerAgentLaunchActions', '3501b2153573cdfed7b3e8d2f47dc512217d12562e0fad6de7c526c71c8e181f'],
            [controllerPath, 'useRunnerRecipesController', 'fe9ad4ae358e5f206983c3cff2bfa9e20fa0124d92985b93bd7a18fee9a36a76'],
            [panelPath, 'RunnerRecipesPanel', 'ec8f1d339081250a5760d16b43587177836f9bf10cfbc22bbd94161096e6d650'],
        ] as const) {
            const declaration = functionDeclaration(path, name);
            expect.soft(
                declaration ? task9aAstFingerprint([declaration]) : '',
                `${name}: token-complete declaration AST`,
            ).toBe(expectedFingerprint);
        }

        const controllerDeclaration = functionDeclaration(
            controllerPath,
            'useRunnerRecipesController',
        );
        const effectCalls: ts.CallExpression[] = [];
        if (controllerDeclaration) {
            const visit = (node: ts.Node): void => {
                if (
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === 'useEffect'
                ) {
                    effectCalls.push(node);
                }
                ts.forEachChild(node, visit);
            };
            visit(controllerDeclaration);
        }
        expect.soft(effectCalls, 'four exact central effects').toHaveLength(4);
        expect.soft(
            effectCalls.map((call) => task9aAstFingerprint([call])),
            'central effect registration/body/dependency fingerprints',
        ).toEqual([
            '8f43bfaf1fd16a64b47556e02ceadb351e0b06ea1734f97956c8cfd93892f80f',
            '8af41adc7940438971685cd314d6aa15304ee5871c71bc18d213381b103ad364',
            '8afcc03c7abec76625fb5ffa951197e83e83c542c4f91dc171db7fae4e7bdd1f',
            '7f42af89a9324e46ef01e5221f32d622e8a02e95545e2f7336efb0ed8d227e1a',
        ]);

        const panelDeclaration = functionDeclaration(
            panelPath,
            'RunnerRecipesPanel',
        );
        const panelControllerCalls = panelDeclaration
            ? (() => {
                  const calls: ts.CallExpression[] = [];
                  const visit = (node: ts.Node): void => {
                      if (
                          ts.isCallExpression(node) &&
                          ts.isIdentifier(node.expression) &&
                          node.expression.text === 'useRunnerRecipesController'
                      ) {
                          calls.push(node);
                      }
                      ts.forEachChild(node, visit);
                  };
                  visit(panelDeclaration);
                  return calls;
              })()
            : [];
        expect.soft(
            task9aAstFingerprint(panelControllerCalls),
            'Panel exact controller call initializer AST',
        ).toBe(
            '369625156c825d13c3b886cae68e02fa41c6cf09022db8e7eaf6aca74e5428eb',
        );
        expect.soft(
            panelDeclaration
                ? task9aJsxRuntimeFingerprint(
                      task9aReturnExpression(panelDeclaration),
                  )
                : '',
            'Panel exact compiled return AST',
        ).toBe(
            '3d78f25aaeb5bc4414be93dbb276bc2cf1f63863a25695913148ebfef3bbe632',
        );
        for (const [viewName, expectedFingerprint] of [
            [
                'RunnerRecipesOverview',
                'b118bbf976a5fe659345396b76a2245ccd868afae7936131203d8d1df5763897',
            ],
            [
                'RunnerRecipeCatalogList',
                '437eae66976db2ba8ce7bc06437c442cde57739c4877f7d39b16a6a1b8294b9b',
            ],
            [
                'RunnerRecipeDetail',
                '23aff1008690a8a6f0004b2ff81f929f51b6712a75ed7eef6729537ecbd7c432',
            ],
        ] as const) {
            expect.soft(
                panelDeclaration
                    ? task9aAstFingerprint(
                          task9aJsxCalls(panelDeclaration, viewName),
                      )
                    : '',
                `${viewName}: unchanged Task 9A call AST`,
            ).toBe(expectedFingerprint);
        }

        const dependencies = new Map<string, readonly string[]>();
        const discoverDependencies = (sourcePath: string): void => {
            if (dependencies.has(sourcePath)) return;
            const source = existsSync(resolve(repositoryRoot, sourcePath))
                ? repositorySource(sourcePath)
                : '';
            const directDependencies = task9aImportEdges(
                task9aSourceFile(sourcePath, source),
            )
                .map((edge) => edge.slice(0, edge.indexOf('|')))
                .filter((moduleImport) => moduleImport.startsWith('.'))
                .map((moduleImport) =>
                    relative(
                        repositoryRoot,
                        resolve(
                            resolve(repositoryRoot, sourcePath),
                            '..',
                            moduleImport,
                        ),
                    ),
                )
                .filter(
                    (dependency) =>
                        ['.ts', '.tsx'].includes(extname(dependency)) &&
                        existsSync(resolve(repositoryRoot, dependency)),
                );
            dependencies.set(sourcePath, directDependencies);
            for (const dependency of directDependencies) {
                discoverDependencies(dependency);
            }
        };
        for (const owner of owners) discoverDependencies(owner.path);
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) {
                cycles.push(path);
                return;
            }
            if (visited.has(path)) return;
            active.add(path);
            for (const dependency of dependencies.get(path) ?? []) {
                visit(dependency);
            }
            active.delete(path);
            visited.add(path);
        };
        for (const owner of owners) visit(owner.path);
        expect(cycles, 'Task 9B recursive owner import cycles').toEqual([]);
    });

    it('extracts exact controlled Runs views while preserving the App controller', () => {
        const appSource = repositorySource(appSourcePath);
        const runsRoot = 'apps/rallar-black-box/src/legacy/runner/runs';
        const constantsPath = `${runsRoot}/runner-runs-constants.ts`;
        const distributedViewPath =
            `${runsRoot}/RunnerDistributedAnalysisSection.tsx`;
        const localViewPath = `${runsRoot}/RunnerLocalRunsSection.tsx`;
        const controllerOwnerPath = `${runsRoot}/use-runner-runs-controller.ts`;
        const panelOwnerPath = `${runsRoot}/RunnerRunsPanel.tsx`;
        const hasExtractedRunsController =
            existsSync(resolve(repositoryRoot, controllerOwnerPath)) &&
            existsSync(resolve(repositoryRoot, panelOwnerPath));
        const controllerOwnerSource = hasExtractedRunsController
            ? repositorySource(controllerOwnerPath)
            : appSource;
        const panelOwnerSource = hasExtractedRunsController
            ? repositorySource(panelOwnerPath)
            : appSource;
        const owners = [
            {
                path: constantsPath,
                lineCap: 20,
                declarations: [
                    /^export const DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS\s*=/m,
                    /^export const RUNNER_DISTRIBUTED_POLL_MS\s*=\s*1_000;/m,
                ],
            },
            {
                path: distributedViewPath,
                lineCap: 300,
                declarations: [
                    /^export function RunnerDistributedAnalysisSection\(/m,
                ],
            },
            {
                path: localViewPath,
                lineCap: 140,
                declarations: [
                    /^export function RunnerLocalRunsSection\(/m,
                ],
            },
        ] as const;
        const sources = new Map<string, string>();
        for (const owner of owners) {
            const exists = existsSync(resolve(repositoryRoot, owner.path));
            const source = exists ? repositorySource(owner.path) : '';
            sources.set(owner.path, source);
            expect.soft(exists, `${owner.path}: exists`).toBe(true);
            expect.soft(
                source === '' ? 0 : source.trimEnd().split(/\r?\n/).length,
                `${owner.path}: line cap`,
            ).toBeLessThanOrEqual(owner.lineCap);
            for (const declaration of owner.declarations) {
                expect.soft(source, `${owner.path}: ${declaration.source}`).toMatch(
                    declaration,
                );
            }
            expect.soft(source, `${owner.path}: no App import`).not.toMatch(
                /\b(?:from\s+|import\s*\(\s*)['"][^'"]*App\.tsx['"]/,
            );
            expect.soft(source, `${owner.path}: no CSS import`).not.toMatch(
                /\b(?:from\s+|import\s*)['"][^'"]+\.css['"]/,
            );
        }

        const constantsSource = sources.get(constantsPath) ?? '';
        const distributedView = sources.get(distributedViewPath) ?? '';
        const localView = sources.get(localViewPath) ?? '';
        expect.soft(appSource, 'Runs constants leave App').not.toMatch(
            /^const (?:DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS|RUNNER_DISTRIBUTED_POLL_MS)\s*=/m,
        );
        expect.soft(appSource, 'distributed Runs subtree leaves App').not.toContain(
            '<section className="runner-distributed-analysis">',
        );
        expect.soft(appSource, 'local Runs summary leaves App').not.toContain(
            '<div className="runner-runs-summary-grid">',
        );
        expect.soft(appSource, 'local Runs layout leaves App').not.toContain(
            '<div className="runner-runs-layout">',
        );
        expect.soft(
            panelOwnerSource,
            'RunnerRunsPanel direct declaration owner',
        ).toMatch(
            /^\s*(?:export\s+)?function RunnerRunsPanel\(/m,
        );
        if (hasExtractedRunsController) {
            expect.soft(appSource, 'RunnerRunsPanel leaves App').not.toMatch(
                /^function RunnerRunsPanel\(/m,
            );
        }

        const constantsAst = task9aSourceFile(constantsPath, constantsSource);
        const constantInitializers = new Map<string, ts.Expression>();
        for (const statement of constantsAst.statements) {
            if (!ts.isVariableStatement(statement)) continue;
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name) && declaration.initializer) {
                    constantInitializers.set(
                        declaration.name.text,
                        declaration.initializer,
                    );
                }
            }
        }
        for (const [name, expectedFingerprint] of [
            [
                'DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS',
                'e29f8421696115ccb1d6c1b04f23bd459a7bb3618f02add9cb40ef944c73900e',
            ],
            [
                'RUNNER_DISTRIBUTED_POLL_MS',
                'd1a53fb2a9a3a2254e9e3d56c6c6388bb848c936bb48444b7acb7c4b4bb6e9ab',
            ],
        ] as const) {
            const initializer = constantInitializers.get(name);
            expect.soft(
                initializer ? task9aAstFingerprint([initializer]) : '',
                `${name}: exact initializer AST`,
            ).toBe(expectedFingerprint);
        }

        const expectedImports = new Map<string, readonly string[]>([
            [constantsPath, []],
            [
                distributedViewPath,
                [
                    '../../../control-agent-board.ts|type:ControlAgentBoardRow,type:ControlAgentBoardSummary',
                    '../../../control-run-manager.ts|type:ControlDistributedRunArtifactBundle,type:ControlDistributedRunSnapshot',
                    '../../../distributed-recipes.ts|type:DistributedRunAnalysisReport,type:DistributedRunCompareSummary,type:DistributedRunMonitor,value:distributedRecipeStateTone',
                    '../../../distributed-run-seeds.ts|type:DistributedRunSeedId,type:SyntheticDistributedRunSeed,value:DISTRIBUTED_RUN_SEEDS',
                    '../../shared/time-format.ts|value:formatTime',
                    '../agents/ControlAgentBoardPanel.tsx|value:ControlAgentBoardPanel',
                    '../distributed/DistributedRunComparePanel.tsx|value:DistributedRunComparePanel',
                    '../distributed/DistributedRunMonitorPanel.tsx|value:DistributedRunMonitorPanel',
                    '../distributed/DistributedRunSummary.tsx|value:DistributedRunSummary',
                    './DistributedRunAnalysisReportPanel.tsx|value:DistributedRunAnalysisReportPanel',
                    './ImportedDistributedArtifactAnalysisPanel.tsx|value:ImportedDistributedArtifactAnalysisPanel',
                    './distributed-artifact-import.ts|type:DistributedArtifactImportStatus',
                    '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts|type:DistributedRunAnalysis',
                    'react|type:ChangeEvent',
                ],
            ],
            [
                localViewPath,
                [
                    '../../../control-client.ts|type:RallarBlackBoxControlSnapshot',
                    '../../shared/Metric.tsx|value:Metric',
                    '../../shared/command-presentation.ts|value:statusTone',
                    '../../shared/time-format.ts|value:formatTime',
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestResult,type:RallarBlackBoxTestRuntimeStatus,type:RallarBlackBoxTestStatsSnapshot',
                    'react|type:ReactNode',
                ],
            ],
        ]);
        for (const [path, imports] of expectedImports) {
            expect.soft(
                task9aImportEdges(
                    task9aSourceFile(path, sources.get(path) ?? ''),
                ),
                `${path}: exact imports/kinds/edges`,
            ).toEqual([...imports].sort());
        }
        const expectedExports = new Map<string, readonly string[]>([
            [
                constantsPath,
                [
                    'value:DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS',
                    'value:RUNNER_DISTRIBUTED_POLL_MS',
                ],
            ],
            [
                distributedViewPath,
                ['value:RunnerDistributedAnalysisSection'],
            ],
            [localViewPath, ['value:RunnerLocalRunsSection']],
        ]);
        for (const [path, exports] of expectedExports) {
            expect.soft(
                task9aExportSeams(
                    task9aSourceFile(path, sources.get(path) ?? ''),
                ),
                `${path}: exact exports`,
            ).toEqual(exports);
        }

        const bannedViewRuntime =
            /\b(?:useState|useMemo|useEffect|useRef|useCallback|fetch|setInterval|clearInterval|analyzeDistributedRunArtifactFiles|distributedArtifactSnapshotsFromFiles|distributedArtifactBundleFromFiles|readDistributedRunSeedFromUrl|writeDistributedRunSeedToUrl|rallarBlackBoxRuntimeStore|localStorage|sessionStorage)\b/;
        for (const [label, source] of [
            ['distributed view', distributedView],
            ['local view', localView],
        ] as const) {
            expect.soft(source, `${label}: controlled-only runtime`).not.toMatch(
                bannedViewRuntime,
            );
        }

        const appAst = task9aSourceFile(appSourcePath, appSource);
        const controllerAst = task9aSourceFile(
            hasExtractedRunsController ? controllerOwnerPath : appSourcePath,
            controllerOwnerSource,
        );
        const panelAst = task9aSourceFile(
            hasExtractedRunsController ? panelOwnerPath : appSourcePath,
            panelOwnerSource,
        );
        const controller = task9aNamedFunction(
            controllerAst,
            hasExtractedRunsController
                ? 'useRunnerRunsController'
                : 'RunnerRunsPanel',
        );
        const panel = task9aNamedFunction(panelAst, 'RunnerRunsPanel');
        const controllerSource = controller.getText(controllerAst);
        const stateNames = [
            ...controllerSource.matchAll(
                /const \[(\w+),\s*\w+\]\s*=\s*useState/g,
            ),
        ].map((match) => match[1]);
        expect.soft(stateNames, 'Runs exact 17-state order').toEqual([
            'controlBaseUrl',
            'controlToken',
            'controlRunId',
            'distributedRuns',
            'selectedDistributedRunId',
            'selectedDistributedRun',
            'distributedControlRun',
            'artifactBundle',
            'importedArtifactAnalysis',
            'importedArtifactStatus',
            'selectedSyntheticSeedId',
            'activeSyntheticSeed',
            'distributedBusy',
            'distributedError',
            'lastDistributedRefresh',
            'compareLeftId',
            'compareRightId',
        ]);
        expect.soft(
            [...controllerSource.matchAll(/const (\w+) = useMemo(?:<|\s*\()/g)]
                .map((match) => match[1]),
            'Runs exact 11-memo order',
        ).toEqual([
            'initialSyntheticSeed',
            'selectedMonitor',
            'runParticipantRows',
            'runParticipantSummary',
            'analysisReport',
            'runVerdict',
            'rtcDiagnostics',
            'rtcPerformance',
            'compareLeftRun',
            'compareRightRun',
            'compareSummary',
        ]);
        expect.soft(
            [...controllerSource.matchAll(/const (\w+) = useRef(?:<|\s*\()/g)]
                .map((match) => match[1]),
            'Runs exact two-ref order',
        ).toEqual([
            'didInitialDistributedRefresh',
            'activeSyntheticSeedRef',
        ]);
        expect.soft(
            [...controllerSource.matchAll(/\buseEffect\s*\(/g)],
            'Runs exact effect count',
        ).toHaveLength(4);
        expect.soft(
            [...controllerSource.matchAll(/\buseCallback\s*\(/g)],
            'Runs no callbacks',
        ).toHaveLength(0);
        const returnIndex = controller.body!.statements.findIndex(
            ts.isReturnStatement,
        );
        expect.soft(
            returnIndex,
            'Runs controller has one final top-level return',
        ).toBe(controller.body!.statements.length - 1);
        expect.soft(
            task9aAstFingerprint(
                controller.body!.statements.slice(0, returnIndex),
            ),
            'Runs exact token-complete pre-return controller AST',
        ).toBe(
            'f0fa38d6a05764e97e09ae1738d5c8e67d8426cf879881ad364db000d16197c7',
        );
        const effectCalls = controller.body!.statements.flatMap((statement) =>
            ts.isExpressionStatement(statement) &&
            ts.isCallExpression(statement.expression) &&
            ts.isIdentifier(statement.expression.expression) &&
            statement.expression.expression.text === 'useEffect'
                ? [statement.expression]
                : [],
        );
        expect.soft(
            effectCalls.map((call) => task9aAstFingerprint([call])),
            'Runs exact effect registration/body/dependency order',
        ).toEqual([
            'e499a588e7200c463fd6a29cacaefd64ea1edcc79530576996e7ff4565a98e59',
            'a04e6d0f649507f3116b16e4d910e77bdf4c7db4d41d7ed081f63ef19d5ad2b7',
            'f14b8abfc30204050a31d70d5f7b9426d550864b14b41778ee769637fe234b95',
            '70a26a1d15c03b8f1e725637858bdb7b672cb18e3a2190d627b5eb0080b95c08',
        ]);
        for (const action of [
            'refreshDistributedAnalysis',
            'applySyntheticDistributedRunSeed',
            'clearSyntheticDistributedRunSeed',
            'selectSyntheticDistributedRunSeed',
            'loadDistributedArtifact',
            'handleDistributedArtifactFiles',
            'selectDistributedRun',
            'copyDistributedArtifact',
        ]) {
            expect.soft(
                controllerSource,
                `Runs App-owned action ${action}`,
            ).toContain(`const ${action}`);
        }

        const functionDeclaration = (
            path: string,
            name: string,
        ): ts.FunctionDeclaration | undefined =>
            task9aSourceFile(path, sources.get(path) ?? '').statements.find(
                (statement): statement is ts.FunctionDeclaration =>
                    ts.isFunctionDeclaration(statement) &&
                    statement.name?.text === name,
            );
        const distributedDeclaration = functionDeclaration(
            distributedViewPath,
            'RunnerDistributedAnalysisSection',
        );
        const localDeclaration = functionDeclaration(
            localViewPath,
            'RunnerLocalRunsSection',
        );
        const distributedReturn = distributedDeclaration
            ? task9aReturnExpression(distributedDeclaration)
            : undefined;
        const localReturn = localDeclaration
            ? task9aReturnExpression(localDeclaration)
            : undefined;
        expect.soft(
            distributedReturn
                ? task9aAstFingerprint([distributedReturn])
                : '',
            'distributed view exact token-complete return AST',
        ).toBe(
            '5f6a697e6e0abce3b994f57a01f6f0dbe961d909df5950a0157b6a4041567e69',
        );
        expect.soft(
            distributedReturn
                ? task9aJsxRuntimeFingerprint(distributedReturn)
                : '',
            'distributed view exact compiled return parity',
        ).toBe(
            'cf6ff4ef4f0d222b92fe180ebce7796a34d482c32ba8ee8222d89132da076784',
        );
        expect.soft(
            localReturn ? task9aAstFingerprint([localReturn]) : '',
            'local view exact token-complete return AST',
        ).toBe(
            '660a933ba3ecf7e73724fa3d5a33dc8cc54cd4653e8841b45d4698bf991bb58d',
        );
        expect.soft(
            localReturn ? task9aJsxRuntimeFingerprint(localReturn) : '',
            'local view exact compiled return parity',
        ).toBe(
            '179997f1ea2f8cc0d5c4b05f52035946a5bb4deb9ffd6fe85390bd01f41ad08d',
        );

        const distributedCalls = task9aJsxCalls(
            panel,
            'RunnerDistributedAnalysisSection',
        );
        const localCalls = task9aJsxCalls(panel, 'RunnerLocalRunsSection');
        expect.soft(distributedCalls, 'one distributed controlled view call')
            .toHaveLength(1);
        expect.soft(localCalls, 'one local controlled view call').toHaveLength(1);
        expect.soft(
            task9aAstFingerprint(distributedCalls),
            'App exact distributed view call AST',
        ).toBe(
            '29e6833e6ea6010e85eaff4a685c14b30a18621cf67d8a8da9a1c84ae9f1e7c4',
        );
        expect.soft(
            task9aAstFingerprint(localCalls),
            'App exact local view call AST',
        ).toBe(
            'e2d30bf906d2a73a365ef084c4d74fdb43f9b8add715393122f282e64ab12b67',
        );
        expect.soft(
            distributedCalls[0]?.attributes.properties.map((attribute) =>
                ts.isJsxAttribute(attribute) ? attribute.name.getText() : 'spread',
            ) ?? [],
            'distributed view exact prop order/cardinality',
        ).toEqual([
            'selectedDistributedRun',
            'distributedBusy',
            'activeSyntheticSeed',
            'selectedSyntheticSeedId',
            'selectSyntheticDistributedRunSeed',
            'controlBaseUrl',
            'setControlBaseUrl',
            'controlToken',
            'setControlToken',
            'selectedDistributedRunId',
            'selectDistributedRun',
            'distributedRuns',
            'refreshDistributedAnalysis',
            'artifactBundle',
            'loadDistributedArtifact',
            'copyDistributedArtifact',
            'handleDistributedArtifactFiles',
            'clearSyntheticDistributedRunSeed',
            'lastDistributedRefresh',
            'controlRunId',
            'distributedError',
            'runParticipantRows',
            'runParticipantSummary',
            'analysisReport',
            'importedArtifactAnalysis',
            'importedArtifactStatus',
            'selectedMonitor',
            'compareLeftId',
            'compareRightId',
            'compareSummary',
            'setCompareLeftId',
            'setCompareRightId',
        ]);
        expect.soft(
            localCalls[0]?.attributes.properties.map((attribute) =>
                ts.isJsxAttribute(attribute) ? attribute.name.getText() : 'spread',
            ) ?? [],
            'local view exact prop order/cardinality',
        ).toEqual([
            'runtimeStatus',
            'commandCount',
            'failureCount',
            'eventCount',
            'latestStats',
            'controlState',
            'recentHistory',
            'failurePanel',
            'reportPanel',
        ]);

        const controllerReturn = task9aReturnExpression(panel);
        if (!ts.isJsxElement(controllerReturn)) {
            throw new Error('RunnerRunsPanel must return its outer section');
        }
        const directChildNames = controllerReturn.children.flatMap((child) => {
            if (ts.isJsxSelfClosingElement(child)) {
                return [child.tagName.getText()];
            }
            if (ts.isJsxElement(child)) {
                return [child.openingElement.tagName.getText()];
            }
            return [];
        });
        expect.soft(
            directChildNames,
            'Runs exact outer evidence/view order with no extra wrapper',
        ).toEqual([
            'div',
            'RunVerdictPanel',
            'CausalTrailPanel',
            'RtcPerformancePanel',
            'RunnerDistributedAnalysisSection',
            'RunnerLocalRunsSection',
        ]);
        expect.soft(
            controllerReturn.openingElement.getText(),
            'Runs outer panel stays App-owned',
        ).toContain('className="panel runner-runs-panel"');

        const ownershipEdges = hasExtractedRunsController
            ? [
                  ...task9aImportEdges(controllerAst),
                  ...task9aImportEdges(panelAst),
              ]
            : task9aImportEdges(appAst);
        const task9cImports = new Set(
            hasExtractedRunsController
                ? [
                      './runner-runs-constants.ts',
                      './RunnerDistributedAnalysisSection.tsx',
                      './RunnerLocalRunsSection.tsx',
                  ]
                : [
                      './legacy/runner/runs/runner-runs-constants.ts',
                      './legacy/runner/runs/RunnerDistributedAnalysisSection.tsx',
                      './legacy/runner/runs/RunnerLocalRunsSection.tsx',
                  ],
        );
        expect.soft(
            ownershipEdges
                .filter((edge) =>
                    task9cImports.has(edge.slice(0, edge.indexOf('|'))),
                )
                .sort(),
            'exact direct Task 9C ownership imports',
        ).toEqual(
            (hasExtractedRunsController
                ? [
                      './RunnerDistributedAnalysisSection.tsx|value:RunnerDistributedAnalysisSection',
                      './RunnerLocalRunsSection.tsx|value:RunnerLocalRunsSection',
                      './runner-runs-constants.ts|value:DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS,value:RUNNER_DISTRIBUTED_POLL_MS',
                  ]
                : [
                      './legacy/runner/runs/RunnerDistributedAnalysisSection.tsx|value:RunnerDistributedAnalysisSection',
                      './legacy/runner/runs/RunnerLocalRunsSection.tsx|value:RunnerLocalRunsSection',
                      './legacy/runner/runs/runner-runs-constants.ts|value:DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS,value:RUNNER_DISTRIBUTED_POLL_MS',
                  ]).sort(),
        );
        const appDeclaration = task9aNamedFunction(appAst, 'App');
        const mountCalls = task9aJsxCalls(appDeclaration, 'RunnerRunsPanel');
        expect.soft(
            task9aAstFingerprint(mountCalls),
            'App exact five-prop RunnerRunsPanel call AST',
        ).toBe(
            '789dc97080fff282b5daef0dec3cd47064d15b620b857e8bf3a7dbf148cce9e1',
        );
        let mountGuard: ts.Node | undefined = mountCalls[0];
        while (mountGuard && !ts.isJsxExpression(mountGuard)) {
            mountGuard = mountGuard.parent;
        }
        expect.soft(
            mountGuard ? task9aAstFingerprint([mountGuard]) : '',
            'App exact active-tab Runs guard AST',
        ).toBe(
            '908c16b6a053ad9e8a66a6da96977bd60afc47b88f9b2ebaa15f3d2a162388c6',
        );
        expect.soft(
            mountCalls[0]?.attributes.properties.map((attribute) =>
                ts.isJsxAttribute(attribute) ? attribute.name.getText() : 'spread',
            ) ?? [],
            'App exact five Runs props and no key',
        ).toEqual([
            'state',
            'bootstrap',
            'control',
            'authSession',
            'preferredDistributedRun',
        ]);

        const dependencies = new Map<string, readonly string[]>();
        const discoverDependencies = (sourcePath: string): void => {
            if (dependencies.has(sourcePath)) return;
            const source = existsSync(resolve(repositoryRoot, sourcePath))
                ? repositorySource(sourcePath)
                : '';
            const directDependencies = task9aImportEdges(
                task9aSourceFile(sourcePath, source),
            )
                .map((edge) => edge.slice(0, edge.indexOf('|')))
                .filter((moduleImport) => moduleImport.startsWith('.'))
                .map((moduleImport) =>
                    relative(
                        repositoryRoot,
                        resolve(
                            resolve(repositoryRoot, sourcePath),
                            '..',
                            moduleImport,
                        ),
                    ),
                )
                .filter(
                    (dependency) =>
                        ['.ts', '.tsx'].includes(extname(dependency)) &&
                        existsSync(resolve(repositoryRoot, dependency)),
                );
            dependencies.set(sourcePath, directDependencies);
            for (const dependency of directDependencies) {
                discoverDependencies(dependency);
            }
        };
        for (const owner of owners) discoverDependencies(owner.path);
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) {
                cycles.push(path);
                return;
            }
            if (visited.has(path)) return;
            active.add(path);
            for (const dependency of dependencies.get(path) ?? []) {
                visit(dependency);
            }
            active.delete(path);
            visited.add(path);
        };
        for (const owner of owners) visit(owner.path);
        expect(cycles, 'Task 9C recursive owner import cycles').toEqual([]);
    });

    it('cuts the Runs controller into exact hook and composition owners', () => {
        const appSource = repositorySource(appSourcePath);
        const runsRoot = 'apps/rallar-black-box/src/legacy/runner/runs';
        const controllerPath = `${runsRoot}/use-runner-runs-controller.ts`;
        const panelPath = `${runsRoot}/RunnerRunsPanel.tsx`;
        const owners = [
            {
                path: controllerPath,
                lineCap: 700,
                declarations: [
                    /^export type UseRunnerRunsControllerInput\s*=/m,
                    /^export function useRunnerRunsController\(/m,
                    /^export type RunnerRunsControllerModel\s*=/m,
                ],
            },
            {
                path: panelPath,
                lineCap: 260,
                declarations: [
                    /^export function FailurePanel\(/m,
                    /^export function RunnerRunsPanel\(/m,
                ],
            },
        ] as const;
        const sources = new Map<string, string>();
        for (const owner of owners) {
            const exists = existsSync(resolve(repositoryRoot, owner.path));
            const source = exists ? repositorySource(owner.path) : '';
            sources.set(owner.path, source);
            expect.soft(exists, `${owner.path}: exists`).toBe(true);
            expect.soft(
                source === '' ? 0 : source.trimEnd().split(/\r?\n/).length,
                `${owner.path}: line cap`,
            ).toBeLessThanOrEqual(owner.lineCap);
            for (const declaration of owner.declarations) {
                expect.soft(source, `${owner.path}: ${declaration.source}`).toMatch(
                    declaration,
                );
            }
            expect.soft(source, `${owner.path}: no App import`).not.toMatch(
                /\b(?:from\s+|import\s*\(\s*)['"][^'"]*App\.tsx['"]/,
            );
            expect.soft(source, `${owner.path}: no CSS import`).not.toMatch(
                /\b(?:from\s+|import\s*)['"][^'"]+\.css['"]/,
            );
        }
        const controllerSource = sources.get(controllerPath) ?? '';
        const panelSource = sources.get(panelPath) ?? '';

        expect.soft(appSource, 'RunnerRunsPanel leaves App').not.toMatch(
            /^function RunnerRunsPanel\(/m,
        );
        expect.soft(appSource, 'FailurePanel leaves App').not.toMatch(
            /^function FailurePanel\(/m,
        );
        expect.soft(appSource, 'App direct Runs owner import').toMatch(
            /import\s*{\s*FailurePanel,\s*RunnerRunsPanel\s*}\s*from\s*'\.\/legacy\/runner\/runs\/RunnerRunsPanel\.tsx';/,
        );

        const expectedImports = new Map<string, readonly string[]>([
            [
                controllerPath,
                [
                    '../../../control-agent-board.ts|value:deriveControlAgentBoardRows,value:summarizeControlAgentBoardRows',
                    '../../../control-client.ts|type:RallarBlackBoxControlSnapshot',
                    '../../../control-run-manager.ts|type:ControlDistributedRunArtifactBundle,type:ControlDistributedRunSnapshot,type:ControlRunSnapshot,value:controlHttpBaseUrlFromWsUrl,value:fetchControlRunSnapshot,value:fetchDistributedRun,value:fetchDistributedRunArtifactBundle,value:fetchDistributedRuns',
                    '../../../distributed-recipes.ts|value:compareDistributedRuns,value:deriveDistributedRunAnalysisReport,value:deriveDistributedRunMonitor,value:deriveRunVerdictView',
                    '../../../distributed-run-seeds.ts|type:DistributedRunSeedId,type:SyntheticDistributedRunSeed,value:createSyntheticDistributedRunSeed,value:distributedRunSeedIdFromValue',
                    '../../../rtc-diagnostics.ts|value:deriveRtcDiagnostics,value:deriveRtcPerformanceView',
                    '../../../runner-readiness.ts|value:runnerFriendlyErrorMessage',
                    '../../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig',
                    '../../shared/json-presentation.ts|value:json',
                    '../runner-contracts.ts|type:RunnerDistributedRunSelection',
                    './distributed-artifact-import.ts|type:DistributedArtifactImportStatus,value:distributedArtifactImportStatus',
                    './distributed-run-seed-url.ts|value:readDistributedRunSeedFromUrl,value:writeDistributedRunSeedToUrl',
                    './runner-runs-constants.ts|value:DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS,value:RUNNER_DISTRIBUTED_POLL_MS',
                    '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts|type:DistributedRunAnalysis,type:DistributedRunArtifactFiles,value:analyzeDistributedRunArtifactFiles,value:distributedArtifactBundleFromFiles,value:distributedArtifactSnapshotsFromFiles',
                    '@shared-test/rallar-bb-test/distributed-run.ts|value:isDistributedRunTerminalState',
                    '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxCommandHistory,value:selectRallarBlackBoxFailures,value:selectRallarBlackBoxLatestStats',
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
                    'react|type:ChangeEvent,value:useEffect,value:useMemo,value:useRef,value:useState',
                ],
            ],
            [
                panelPath,
                [
                    '../../shared/redaction-presentation.ts|value:redactedJson',
                    '../advanced/ReportPanel.tsx|value:ReportPanel',
                    '../evidence/CausalTrailPanel.tsx|value:CausalTrailPanel',
                    '../evidence/RunVerdictPanel.tsx|value:RunVerdictPanel',
                    '../evidence/rtc/RtcPerformancePanel.tsx|value:RtcPerformancePanel',
                    './RunnerDistributedAnalysisSection.tsx|value:RunnerDistributedAnalysisSection',
                    './RunnerLocalRunsSection.tsx|value:RunnerLocalRunsSection',
                    './use-runner-runs-controller.ts|type:UseRunnerRunsControllerInput,value:useRunnerRunsController',
                    '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxFirstFailure',
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
                    '@shared/api/api-config.ts|type:AuthSession',
                ],
            ],
        ]);
        for (const [path, imports] of expectedImports) {
            expect.soft(
                task9aImportEdges(
                    task9aSourceFile(path, sources.get(path) ?? ''),
                ),
                `${path}: exact imports/kinds/edges`,
            ).toEqual([...imports].sort());
        }
        const expectedExports = new Map<string, readonly string[]>([
            [
                controllerPath,
                [
                    'type:RunnerRunsControllerModel',
                    'type:UseRunnerRunsControllerInput',
                    'value:useRunnerRunsController',
                ],
            ],
            [
                panelPath,
                ['value:FailurePanel', 'value:RunnerRunsPanel'],
            ],
        ]);
        for (const [path, exports] of expectedExports) {
            expect.soft(
                task9aExportSeams(
                    task9aSourceFile(path, sources.get(path) ?? ''),
                ),
                `${path}: exact exports`,
            ).toEqual(exports);
        }

        const inputBlock = controllerSource.match(
            /export type UseRunnerRunsControllerInput\s*=\s*Readonly<{([\s\S]*?)}>/,
        )?.[1] ?? '';
        expect.soft(
            [...inputBlock.matchAll(/^\s+(\w+)(?:\?|)[:(]/gm)].map(
                (match) => match[1],
            ),
            'controller exact input fields without auth',
        ).toEqual([
            'state',
            'bootstrap',
            'control',
            'preferredDistributedRun',
        ]);
        expect.soft(controllerSource, 'controller does not import Panel/views')
            .not.toMatch(
                /RunnerRunsPanel|RunnerDistributedAnalysisSection|RunnerLocalRunsSection/,
            );

        const optionalFunction = (
            path: string,
            source: string,
            name: string,
        ): ts.FunctionDeclaration | undefined =>
            task9aSourceFile(path, source).statements.find(
                (statement): statement is ts.FunctionDeclaration =>
                    ts.isFunctionDeclaration(statement) &&
                    statement.name?.text === name,
            );
        const controllerDeclaration = optionalFunction(
            controllerPath,
            controllerSource,
            'useRunnerRunsController',
        );
        const panelDeclaration = optionalFunction(
            panelPath,
            panelSource,
            'RunnerRunsPanel',
        );
        const failureDeclaration = optionalFunction(
            panelPath,
            panelSource,
            'FailurePanel',
        );
        const controllerText = controllerDeclaration?.getText() ?? '';
        expect.soft(
            [...controllerText.matchAll(/const \[(\w+),\s*\w+\]\s*=\s*useState/g)]
                .map((match) => match[1]),
            'controller exact 17-state order',
        ).toEqual([
            'controlBaseUrl',
            'controlToken',
            'controlRunId',
            'distributedRuns',
            'selectedDistributedRunId',
            'selectedDistributedRun',
            'distributedControlRun',
            'artifactBundle',
            'importedArtifactAnalysis',
            'importedArtifactStatus',
            'selectedSyntheticSeedId',
            'activeSyntheticSeed',
            'distributedBusy',
            'distributedError',
            'lastDistributedRefresh',
            'compareLeftId',
            'compareRightId',
        ]);
        expect.soft(
            [...controllerText.matchAll(/const (\w+) = useMemo(?:<|\s*\()/g)]
                .map((match) => match[1]),
            'controller exact 11-memo order',
        ).toEqual([
            'initialSyntheticSeed',
            'selectedMonitor',
            'runParticipantRows',
            'runParticipantSummary',
            'analysisReport',
            'runVerdict',
            'rtcDiagnostics',
            'rtcPerformance',
            'compareLeftRun',
            'compareRightRun',
            'compareSummary',
        ]);
        expect.soft(
            [...controllerText.matchAll(/const (\w+) = useRef(?:<|\s*\()/g)]
                .map((match) => match[1]),
            'controller exact two-ref order',
        ).toEqual([
            'didInitialDistributedRefresh',
            'activeSyntheticSeedRef',
        ]);
        expect.soft(
            [...controllerText.matchAll(/\buseEffect\s*\(/g)],
            'controller exact effects',
        ).toHaveLength(4);
        expect.soft(
            [...controllerText.matchAll(/\buseCallback\s*\(/g)],
            'controller no callbacks',
        ).toHaveLength(0);
        const controllerReturnIndex = controllerDeclaration?.body?.statements
            .findIndex(ts.isReturnStatement) ?? -1;
        const preReturnStatements =
            controllerDeclaration && controllerReturnIndex >= 0
                ? controllerDeclaration.body!.statements.slice(
                      0,
                      controllerReturnIndex,
                  )
                : [];
        expect.soft(preReturnStatements, 'all 46 controller statements')
            .toHaveLength(46);
        expect.soft(
            task9aAstFingerprint(preReturnStatements),
            'controller exact token-complete pre-return AST',
        ).toBe(
            'f0fa38d6a05764e97e09ae1738d5c8e67d8426cf879881ad364db000d16197c7',
        );

        const statementsByName = new Map<string, ts.VariableStatement>();
        for (const statement of preReturnStatements) {
            if (
                ts.isVariableStatement(statement) &&
                ts.isIdentifier(statement.declarationList.declarations[0]?.name)
            ) {
                statementsByName.set(
                    statement.declarationList.declarations[0].name.text,
                    statement,
                );
            }
        }
        for (const [name, expectedFingerprint] of [
            ['refreshDistributedAnalysis', 'ffe05eac2e48e40936cae086cc72f77ce0fc58ac2f5a0b34d2264031db212f8d'],
            ['applySyntheticDistributedRunSeed', '14842da64af7f6f7bc3f7f2fff90ee126cc38bc94b51c8e7dc1f7d440f38482e'],
            ['clearSyntheticDistributedRunSeed', '0ae9bf0c733e3d98aa2c446b13745a6d92cd0031de25763769c89ce3c3bfd4bd'],
            ['selectSyntheticDistributedRunSeed', '899981f54d1254ff3b7cc94e558f19368acdcf1cc984d91ace61fe83308f7ae8'],
            ['loadDistributedArtifact', 'f1b9c10c75e9bdacb49f60d727660c6983543f999f521a01985ebbadd06e17c6'],
            ['handleDistributedArtifactFiles', '640c2cb41758bc47a4b283fd32e1fb3131cc7ad0d87705194dec10371027a039'],
            ['selectDistributedRun', '94aa3eea54bd53c1c92a9ad66edc24b245897eb5382c85723d057f1e40865ae7'],
            ['copyDistributedArtifact', '8552f118f5a8c545f06416bc8663ec46156e23e98d3b2777596f80eacdb3e10c'],
        ] as const) {
            const statement = statementsByName.get(name);
            expect.soft(
                statement ? task9aAstFingerprint([statement]) : '',
                `${name}: exact action AST`,
            ).toBe(expectedFingerprint);
        }
        const effectCalls = preReturnStatements.flatMap((statement) =>
            ts.isExpressionStatement(statement) &&
            ts.isCallExpression(statement.expression) &&
            ts.isIdentifier(statement.expression.expression) &&
            statement.expression.expression.text === 'useEffect'
                ? [statement.expression]
                : [],
        );
        expect.soft(
            effectCalls.map((call) => task9aAstFingerprint([call])),
            'controller exact effect bodies/dependencies/order',
        ).toEqual([
            'e499a588e7200c463fd6a29cacaefd64ea1edcc79530576996e7ff4565a98e59',
            'a04e6d0f649507f3116b16e4d910e77bdf4c7db4d41d7ed081f63ef19d5ad2b7',
            'f14b8abfc30204050a31d70d5f7b9426d550864b14b41778ee769637fe234b95',
            '70a26a1d15c03b8f1e725637858bdb7b672cb18e3a2190d627b5eb0080b95c08',
        ]);

        const returnedFields =
            controllerDeclaration && controllerReturnIndex >= 0
                ? (() => {
                      const statement =
                          controllerDeclaration.body!.statements[
                              controllerReturnIndex
                          ];
                      if (
                          !ts.isReturnStatement(statement) ||
                          !statement.expression ||
                          !ts.isObjectLiteralExpression(statement.expression)
                      ) return [];
                      return statement.expression.properties.map((property) => {
                          if (
                              ts.isShorthandPropertyAssignment(property) ||
                              ts.isPropertyAssignment(property)
                          ) return property.name.getText();
                          return 'unsupported';
                      });
                  })()
                : [];
        expect.soft(returnedFields, 'controller exact public model order').toEqual([
            'runLabel',
            'runVerdict',
            'rtcPerformance',
            'selectedDistributedRun',
            'distributedBusy',
            'activeSyntheticSeed',
            'selectedSyntheticSeedId',
            'selectSyntheticDistributedRunSeed',
            'controlBaseUrl',
            'setControlBaseUrl',
            'controlToken',
            'setControlToken',
            'selectedDistributedRunId',
            'selectDistributedRun',
            'distributedRuns',
            'refreshDistributedAnalysis',
            'artifactBundle',
            'loadDistributedArtifact',
            'copyDistributedArtifact',
            'handleDistributedArtifactFiles',
            'clearSyntheticDistributedRunSeed',
            'lastDistributedRefresh',
            'controlRunId',
            'distributedError',
            'runParticipantRows',
            'runParticipantSummary',
            'analysisReport',
            'importedArtifactAnalysis',
            'importedArtifactStatus',
            'selectedMonitor',
            'compareLeftId',
            'compareRightId',
            'compareSummary',
            'setCompareLeftId',
            'setCompareRightId',
            'history',
            'failures',
            'latestStats',
            'recentHistory',
        ]);
        expect.soft(returnedFields, 'private seed apply action').not.toContain(
            'applySyntheticDistributedRunSeed',
        );

        expect.soft(panelSource, 'panel has no built-in hooks/network/timers/storage')
            .not.toMatch(
                /\b(?:useState|useMemo|useEffect|useRef|useCallback|fetch|setInterval|clearInterval|localStorage|sessionStorage|readDistributedRunSeedFromUrl|writeDistributedRunSeedToUrl)\b/,
            );
        const controllerCalls: ts.CallExpression[] = [];
        if (panelDeclaration) {
            const visit = (node: ts.Node): void => {
                if (
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === 'useRunnerRunsController'
                ) controllerCalls.push(node);
                ts.forEachChild(node, visit);
            };
            visit(panelDeclaration);
        }
        expect.soft(controllerCalls, 'panel calls controller exactly once')
            .toHaveLength(1);
        expect.soft(
            task9aAstFingerprint(controllerCalls),
            'panel exact controller call initializer',
        ).toBe(
            '3089c494df86d2a7f4a3ddd8029228621bd0c74519cc4bec228d4055585b6cc9',
        );
        const panelReturn = panelDeclaration
            ? task9aReturnExpression(panelDeclaration)
            : undefined;
        expect.soft(
            panelReturn ? task9aAstFingerprint([panelReturn]) : '',
            'panel exact token-complete return AST',
        ).toBe(
            '0d9fd52c6383d5a09080d841f3d79190238c9e9471b8ad5236582c83a22cf639',
        );
        expect.soft(
            panelReturn ? task9aJsxRuntimeFingerprint(panelReturn) : '',
            'panel exact compiled return parity',
        ).toBe(
            'c68c61a07b2fa31c74940ff3c12c9a72af285ea4c22e06c4b0f2aba9633394cf',
        );
        expect.soft(
            panelDeclaration
                ? task9aAstFingerprint(
                      task9aJsxCalls(
                          panelDeclaration,
                          'RunnerDistributedAnalysisSection',
                      ),
                  )
                : '',
            'panel unchanged Task 9C distributed call',
        ).toBe(
            '29e6833e6ea6010e85eaff4a685c14b30a18621cf67d8a8da9a1c84ae9f1e7c4',
        );
        expect.soft(
            panelDeclaration
                ? task9aAstFingerprint(
                      task9aJsxCalls(panelDeclaration, 'RunnerLocalRunsSection'),
                  )
                : '',
            'panel unchanged Task 9C local call',
        ).toBe(
            'e2d30bf906d2a73a365ef084c4d74fdb43f9b8add715393122f282e64ab12b67',
        );

        expect.soft(
            failureDeclaration
                ? task9aAstFingerprint(failureDeclaration.parameters)
                : '',
            'FailurePanel exact parameters',
        ).toBe(
            '20337dc92d8a93c924970346642e417020ca1451d78214af04803d0b2c446601',
        );
        expect.soft(
            failureDeclaration?.body
                ? task9aAstFingerprint([failureDeclaration.body])
                : '',
            'FailurePanel exact body',
        ).toBe(
            '35d6a47bdc9b4a8372f41c50a7b2ea36d0cc3a69ca5241e4381a0220eb659434',
        );
        expect.soft(
            failureDeclaration
                ? task9aJsxRuntimeFingerprint(
                      task9aReturnExpression(failureDeclaration),
                  )
                : '',
            'FailurePanel exact compiled return',
        ).toBe(
            '976693d0105e9416083aa1a45fa98bc159784846bba37a14d911ca70c423d4cb',
        );

        const appAst = task9aSourceFile(appSourcePath, appSource);
        const appDeclaration = task9aNamedFunction(appAst, 'App');
        expect.soft(
            task9aAstFingerprint(task9aJsxCalls(appDeclaration, 'FailurePanel')),
            'App two unchanged external FailurePanel calls',
        ).toBe(
            'fdd250c13889cf52500fd0c6b3d38778b90b287965a4b1e49219da8d813a9318',
        );
        const mountCalls = task9aJsxCalls(appDeclaration, 'RunnerRunsPanel');
        expect.soft(
            task9aAstFingerprint(mountCalls),
            'App unchanged five-prop Runs call',
        ).toBe(
            '789dc97080fff282b5daef0dec3cd47064d15b620b857e8bf3a7dbf148cce9e1',
        );
        let mountGuard: ts.Node | undefined = mountCalls[0];
        while (mountGuard && !ts.isJsxExpression(mountGuard)) {
            mountGuard = mountGuard.parent;
        }
        expect.soft(
            mountGuard ? task9aAstFingerprint([mountGuard]) : '',
            'App unchanged conditional Runs guard',
        ).toBe(
            '908c16b6a053ad9e8a66a6da96977bd60afc47b88f9b2ebaa15f3d2a162388c6',
        );
        expect.soft(
            task9aImportEdges(appAst).filter((edge) =>
                edge.startsWith('./legacy/runner/runs/'),
            ),
            'App imports only the direct Runs panel owner',
        ).toEqual([
            './legacy/runner/runs/RunnerRunsPanel.tsx|value:FailurePanel,value:RunnerRunsPanel',
        ]);

        const dependencies = new Map<string, readonly string[]>();
        const discoverDependencies = (sourcePath: string): void => {
            if (dependencies.has(sourcePath)) return;
            const source = existsSync(resolve(repositoryRoot, sourcePath))
                ? repositorySource(sourcePath)
                : '';
            const directDependencies = task9aImportEdges(
                task9aSourceFile(sourcePath, source),
            )
                .map((edge) => edge.slice(0, edge.indexOf('|')))
                .filter((moduleImport) => moduleImport.startsWith('.'))
                .map((moduleImport) =>
                    relative(
                        repositoryRoot,
                        resolve(
                            resolve(repositoryRoot, sourcePath),
                            '..',
                            moduleImport,
                        ),
                    ),
                )
                .filter(
                    (dependency) =>
                        ['.ts', '.tsx'].includes(extname(dependency)) &&
                        existsSync(resolve(repositoryRoot, dependency)),
                );
            dependencies.set(sourcePath, directDependencies);
            for (const dependency of directDependencies) {
                discoverDependencies(dependency);
            }
        };
        for (const owner of owners) discoverDependencies(owner.path);
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) {
                cycles.push(path);
                return;
            }
            if (visited.has(path)) return;
            active.add(path);
            for (const dependency of dependencies.get(path) ?? []) {
                visit(dependency);
            }
            active.delete(path);
            visited.add(path);
        };
        for (const owner of owners) visit(owner.path);
        expect(cycles, 'Task 9D recursive owner import cycles').toEqual([]);
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

        const fleetControllerPath =
            'apps/rallar-black-box/src/legacy/runner/fleet/use-runner-fleet-controller.ts';
        const controllerSharedImports = [
            {
                importerPath: existsSync(resolve(repositoryRoot, fleetControllerPath))
                    ? fleetControllerPath
                    : appSourcePath,
                moduleImport: existsSync(resolve(repositoryRoot, fleetControllerPath))
                    ? '../shared/control-snapshot-bounds.ts'
                    : './legacy/runner/shared/control-snapshot-bounds.ts',
                seam: 'RUN_MANAGER_SNAPSHOT_BOUNDS',
            },
        ] as const;

        for (const controllerSharedImport of controllerSharedImports) {
            const escapedModuleImport = controllerSharedImport.moduleImport.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            const importerSource = repositorySource(
                controllerSharedImport.importerPath,
            );
            const importedSeams = importerSource.match(
                new RegExp(
                    `import\\s*{([^}]*)}\\s*from\\s*'${escapedModuleImport}';`,
                ),
            )?.[1];

            expect.soft(
                importedSeams,
                controllerSharedImport.moduleImport,
            ).toBeDefined();
            expect
                .soft(
                    importedSeams ?? '',
                    `${controllerSharedImport.moduleImport}: ${controllerSharedImport.seam}`,
                )
                .toMatch(new RegExp(`\\b${controllerSharedImport.seam}\\b`));
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

    it('extracts the Builder domain without changing its two-instance lifetime contract', () => {
        const appSource = repositorySource(appSourcePath);
        const builderRoot = 'apps/rallar-black-box/src/legacy/runner/builder';
        const supportPath = `${builderRoot}/flow-builder-support.ts`;
        const controllerPath = `${builderRoot}/use-flow-builder-controller.ts`;
        const editorPath = `${builderRoot}/FlowBuilderEditor.tsx`;
        const previewsPath = `${builderRoot}/FlowBuilderPreviews.tsx`;
        const panelPath = `${builderRoot}/FlowBuilderPanel.tsx`;
        const owners = [
            {
                path: supportPath,
                lineCap: 100,
                declarations: [
                    /^export function flowBuilderVariablesFromGlobalValues\(/m,
                    /^export function parseVariablesText\(/m,
                    /^export const FLOW_STEP_BUTTONS\b/m,
                    /^export function flowStepCommandIds\(/m,
                ],
            },
            {
                path: controllerPath,
                lineCap: 300,
                declarations: [
                    /^export type UseFlowBuilderControllerInput\s*=/m,
                    /^export function useFlowBuilderController\(/m,
                    /^export type FlowBuilderControllerModel\s*=/m,
                ],
            },
            {
                path: editorPath,
                lineCap: 170,
                declarations: [/^export function FlowBuilderEditor\(/m],
            },
            {
                path: previewsPath,
                lineCap: 190,
                declarations: [/^export function FlowBuilderPreviews\(/m],
            },
            {
                path: panelPath,
                lineCap: 150,
                declarations: [/^export function FlowBuilderPanel\(/m],
            },
        ] as const;
        const sources = new Map<string, string>();
        for (const owner of owners) {
            const exists = existsSync(resolve(repositoryRoot, owner.path));
            const source = exists ? repositorySource(owner.path) : '';
            sources.set(owner.path, source);
            expect.soft(exists, `${owner.path}: exists`).toBe(true);
            expect.soft(
                source === '' ? 0 : source.trimEnd().split(/\r?\n/).length,
                `${owner.path}: line cap`,
            ).toBeLessThanOrEqual(owner.lineCap);
            for (const declaration of owner.declarations) {
                expect.soft(source, `${owner.path}: ${declaration.source}`).toMatch(
                    declaration,
                );
            }
            expect.soft(source, `${owner.path}: no App import`).not.toMatch(
                /\b(?:from\s+|import\s*\(\s*)['"][^'"]*App\.tsx['"]/,
            );
            expect.soft(source, `${owner.path}: no CSS import`).not.toMatch(
                /\b(?:from\s+|import\s*)['"][^'"]+\.css['"]/,
            );
            expect.soft(source, `${owner.path}: no barrel facade`).not.toMatch(
                /^\s*export\s+(?:\*|(?:type\s+)?{[^}]+}\s+from)\b/m,
            );
        }
        const supportSource = sources.get(supportPath) ?? '';
        const controllerSource = sources.get(controllerPath) ?? '';
        const editorSource = sources.get(editorPath) ?? '';
        const previewsSource = sources.get(previewsPath) ?? '';
        const panelSource = sources.get(panelPath) ?? '';

        for (const declaration of [
            'flowBuilderVariablesFromGlobalValues',
            'parseVariablesText',
            'FLOW_STEP_BUTTONS',
            'flowStepCommandIds',
            'FlowBuilderPanel',
        ] as const) {
            expect.soft(appSource, `App local ${declaration}`).not.toMatch(
                new RegExp(
                    `^\\s*(?:export\\s+)?(?:const|let|var|function)\\s+${declaration}\\b`,
                    'm',
                ),
            );
        }
        expect.soft(appSource, 'App direct Builder owner import').toMatch(
            /import\s*{\s*FlowBuilderPanel\s*}\s*from\s*'\.\/legacy\/runner\/builder\/FlowBuilderPanel\.tsx';/,
        );
        expect.soft(appSource, 'App no root flow-builder import').not.toMatch(
            /from\s*'\.\/flow-builder\.ts'/,
        );
        expect.soft(appSource, 'App no root schema-authoring import').not.toMatch(
            /from\s*'\.\/schema-authoring\.ts'/,
        );
        expect.soft(appSource, 'App no direct SchemaAuthoringPanel import')
            .not.toMatch(/from\s*'\.\/legacy\/shared\/schema\/SchemaAuthoringPanel\.tsx'/);

        const expectedImports = new Map<string, readonly string[]>([
            [
                supportPath,
                [
                    '../../../flow-builder.ts|type:FlowBuilderStepKind',
                    '../../shared/record-value.ts|value:recordValue',
                    '../../shell/global-context-model.ts|type:CommandCenterGlobalValues',
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestCommand',
                ],
            ],
            [
                controllerPath,
                [
                    '../../../flow-builder.ts|type:FlowBuilderStepKind,value:FLOW_BUILDER_TEMPLATES,value:addFlowBuilderStep,value:buildFlowBuilderRecipe,value:buildFlowBuilderRunnerScenario,value:flowBuilderText,value:parseFlowBuilderDefinition,value:templateFlowBuilderText',
                    '../../../runtime-store.ts|value:rallarBlackBoxRuntimeStore',
                    '../../../schema-authoring.ts|value:validateSchemaAuthoringValue',
                    '../../shared/redaction-presentation.ts|value:redactedJson',
                    '../../shell/global-context-model.ts|type:CommandCenterGlobalValues',
                    './flow-builder-support.ts|value:flowBuilderVariablesFromGlobalValues,value:parseVariablesText',
                    '@shared/api/api-config.ts|type:AuthSession',
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
                    'react|value:useEffect,value:useMemo,value:useState',
                ],
            ],
            [
                editorPath,
                [
                    '../../../flow-builder.ts|type:FlowBuilderStepKind,value:FLOW_BUILDER_TEMPLATES',
                    './flow-builder-support.ts|value:FLOW_STEP_BUTTONS',
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestRecipe',
                ],
            ],
            [
                previewsPath,
                [
                    '../../../flow-builder.ts|type:FlowBuilderDefinition',
                    '../../../schema-authoring.ts|type:SchemaAuthoringValidation',
                    '../../shared/command-presentation.ts|value:statusTone',
                    '../../shared/redaction-presentation.ts|value:redactedJson',
                    '../../shared/schema/SchemaAuthoringPanel.tsx|value:SchemaAuthoringPanel',
                    './flow-builder-support.ts|value:flowStepCommandIds',
                    '@shared/api/api-config.ts|type:AuthSession',
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestRecipe,type:RallarBlackBoxTestResult,type:RallarBlackBoxTestState',
                ],
            ],
            [
                panelPath,
                [
                    '../../shared/redaction-presentation.ts|value:uiRedactionOptions',
                    './FlowBuilderEditor.tsx|value:FlowBuilderEditor',
                    './FlowBuilderPreviews.tsx|value:FlowBuilderPreviews',
                    './use-flow-builder-controller.ts|type:UseFlowBuilderControllerInput,value:useFlowBuilderController',
                    '@shared-test/rallar-bb-test/redaction.ts|value:redactRallarBlackBoxValue',
                ],
            ],
        ]);
        for (const [path, imports] of expectedImports) {
            expect.soft(
                task9aImportEdges(task9aSourceFile(path, sources.get(path) ?? '')),
                `${path}: exact imports/kinds`,
            ).toEqual([...imports].sort());
        }
        const expectedExports = new Map<string, readonly string[]>([
            [
                supportPath,
                [
                    'value:FLOW_STEP_BUTTONS',
                    'value:flowBuilderVariablesFromGlobalValues',
                    'value:flowStepCommandIds',
                    'value:parseVariablesText',
                ],
            ],
            [
                controllerPath,
                [
                    'type:FlowBuilderControllerModel',
                    'type:UseFlowBuilderControllerInput',
                    'value:useFlowBuilderController',
                ],
            ],
            [editorPath, ['value:FlowBuilderEditor']],
            [previewsPath, ['value:FlowBuilderPreviews']],
            [panelPath, ['value:FlowBuilderPanel']],
        ]);
        for (const [path, exports] of expectedExports) {
            expect.soft(
                task9aExportSeams(task9aSourceFile(path, sources.get(path) ?? '')),
                `${path}: exact exports`,
            ).toEqual(exports);
        }

        const optionalFunction = (
            path: string,
            source: string,
            name: string,
        ): ts.FunctionDeclaration | undefined =>
            task9aSourceFile(path, source).statements.find(
                (statement): statement is ts.FunctionDeclaration =>
                    ts.isFunctionDeclaration(statement) &&
                    statement.name?.text === name,
            );
        const optionalVariable = (
            path: string,
            source: string,
            name: string,
        ): ts.VariableDeclaration | undefined => {
            const file = task9aSourceFile(path, source);
            for (const statement of file.statements) {
                if (!ts.isVariableStatement(statement)) continue;
                for (const declaration of statement.declarationList.declarations) {
                    if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
                        return declaration;
                    }
                }
            }
            return undefined;
        };
        for (const [name, parameterHash, bodyHash] of [
            [
                'flowBuilderVariablesFromGlobalValues',
                'af1ab4647a09754b591c9e9f43356afd19eb461612166531b68185a05899ed67',
                '33d47d0bcaf8a33c672f744c5da8f71b03b7a9bc537d4a5d108b56f58df55b8f',
            ],
            [
                'parseVariablesText',
                '471fc6c9019884d3151b01c30e0f9f610e6ae5deb2eaa9ff22c61d96d9f33271',
                'd9fec842ce5c9790c543f41ee6b4ca80f5ee62ab04b484a7bc0a3d905ca2bd00',
            ],
            [
                'flowStepCommandIds',
                '1ca5049fc7a612481aeccd05c92f81ad9701b6519e1d4e17dd530f24fe24d465',
                '42ec57142f1f74ba6854664353d3afaf8e636c4fd03904bc0af2be56d86edbb9',
            ],
        ] as const) {
            const declaration = optionalFunction(supportPath, supportSource, name);
            expect.soft(
                declaration ? task9aAstFingerprint(declaration.parameters) : '',
                `${name}: exact parameters`,
            ).toBe(parameterHash);
            expect.soft(
                declaration?.body ? task9aAstFingerprint([declaration.body]) : '',
                `${name}: exact body`,
            ).toBe(bodyHash);
        }
        const buttonDeclaration = optionalVariable(
            supportPath,
            supportSource,
            'FLOW_STEP_BUTTONS',
        );
        expect.soft(
            buttonDeclaration?.initializer
                ? task9aAstFingerprint([buttonDeclaration.initializer])
                : '',
            'FLOW_STEP_BUTTONS exact initializer',
        ).toBe('b1c4bdff5c746c62c712cb40e235a4f895306b324d5cc15a0468914e4f74d85b');
        const containsJsx = (path: string, source: string): boolean => {
            let found = false;
            const visit = (node: ts.Node): void => {
                if (
                    ts.isJsxElement(node) ||
                    ts.isJsxSelfClosingElement(node) ||
                    ts.isJsxFragment(node)
                ) {
                    found = true;
                    return;
                }
                ts.forEachChild(node, visit);
            };
            visit(task9aSourceFile(path, source));
            return found;
        };
        expect.soft(supportSource, 'support has no React/runtime').not.toMatch(
            /\b(?:react|rallarBlackBoxRuntimeStore|useState|useMemo|useEffect)\b/,
        );
        expect.soft(containsJsx(supportPath, supportSource), 'support has no JSX')
            .toBe(false);

        const inputBlock = controllerSource.match(
            /export type UseFlowBuilderControllerInput\s*=\s*Readonly<{([\s\S]*?)}>;/,
        )?.[1] ?? '';
        expect.soft(
            [...inputBlock.matchAll(/^\s+(\w+)(?:\?|)[:(]/gm)].map(
                (match) => match[1],
            ),
            'controller exact input fields without busy',
        ).toEqual(['state', 'authSession', 'globalValues', 'onSelectCommand']);
        const controllerDeclaration = optionalFunction(
            controllerPath,
            controllerSource,
            'useFlowBuilderController',
        );
        const controllerText = controllerDeclaration?.getText() ?? '';
        expect.soft(
            [...controllerText.matchAll(/const \[(\w+),\s*\w+\]\s*=\s*useState/g)].map(
                (match) => match[1],
            ),
            'controller exact six-state order',
        ).toEqual([
            'templateId',
            'flowText',
            'variablesText',
            'variablesEdited',
            'sequence',
            'localError',
        ]);
        expect.soft(
            [...controllerText.matchAll(/const (\w+) = useMemo(?:<|\s*\()/g)].map(
                (match) => match[1],
            ),
            'controller exact six-memo order',
        ).toEqual([
            'flowResult',
            'variablesResult',
            'recipe',
            'runnerScenario',
            'recipeValidation',
            'runnerValidation',
        ]);
        expect.soft([...controllerText.matchAll(/\buseEffect\s*\(/g)]).toHaveLength(1);
        expect.soft([...controllerText.matchAll(/\buseRef\s*\(/g)]).toHaveLength(0);
        expect.soft([...controllerText.matchAll(/\buseCallback\s*\(/g)]).toHaveLength(0);
        expect.soft(
            containsJsx(controllerPath, controllerSource),
            'controller has no JSX',
        ).toBe(false);
        const controllerReturnIndex = controllerDeclaration?.body?.statements
            .findIndex(ts.isReturnStatement) ?? -1;
        const preReturnStatements =
            controllerDeclaration && controllerReturnIndex >= 0
                ? controllerDeclaration.body!.statements.slice(0, controllerReturnIndex)
                : [];
        expect.soft(preReturnStatements, 'all 22 controller statements').toHaveLength(22);
        expect.soft(
            task9aAstFingerprint(preReturnStatements),
            'controller exact token-complete statements',
        ).toBe('67ac181f2bfc66e511d37089248f42e57043daafbece0bb164664c287c41504d');
        const statementsByName = new Map<string, ts.VariableStatement>();
        for (const statement of preReturnStatements) {
            if (
                ts.isVariableStatement(statement) &&
                ts.isIdentifier(statement.declarationList.declarations[0]?.name)
            ) {
                statementsByName.set(
                    statement.declarationList.declarations[0].name.text,
                    statement,
                );
            }
        }
        for (const [name, expectedHash] of [
            ['selectTemplate', '8a13c2ba1ad5dd089b93c58738f84a61e226d22c457e43f2823438f97aac061c'],
            ['addStep', 'c2a85bb5ffadb1f5a986ce8cf8ad2d865e9554e92ff94ad917317c3f18ab6813'],
            ['normalizeFlowJson', 'e551baf436b5f4f662bcaa8bdc54b0d8b57d51322715364abf371481923667bc'],
            ['runFlow', 'cfde177dd23012ef44d7df52d0996430215cdfcfb0e5a4d67d3fe114effdd107'],
            ['copyText', '5764a0a5be327a354e0acc3b0247357ae9fb88cc2a8b93060ea816c47b525945'],
        ] as const) {
            const statement = statementsByName.get(name);
            expect.soft(
                statement ? task9aAstFingerprint([statement]) : '',
                `${name}: exact action`,
            ).toBe(expectedHash);
        }
        const effect = preReturnStatements.find(
            (statement) =>
                ts.isExpressionStatement(statement) &&
                ts.isCallExpression(statement.expression) &&
                ts.isIdentifier(statement.expression.expression) &&
                statement.expression.expression.text === 'useEffect',
        );
        expect.soft(
            effect ? task9aAstFingerprint([effect]) : '',
            'controller exact effect body/dependencies',
        ).toBe('e0716f20908f0c95b8a8a22b73560ab1362e27942feb5f0ce21a9d9ece095cf2');
        const returnedFields =
            controllerDeclaration && controllerReturnIndex >= 0
                ? (() => {
                      const statement =
                          controllerDeclaration.body!.statements[controllerReturnIndex];
                      if (
                          !ts.isReturnStatement(statement) ||
                          !statement.expression ||
                          !ts.isObjectLiteralExpression(statement.expression)
                      ) return [];
                      return statement.expression.properties.map((property) =>
                          property.name?.getText() ?? 'unsupported',
                      );
                  })()
                : [];
        expect.soft(returnedFields, 'controller exact model fields').toEqual([
            'templateId',
            'flowText',
            'setFlowText',
            'variablesText',
            'setVariablesText',
            'setVariablesEdited',
            'flow',
            'recipe',
            'runnerScenario',
            'parseError',
            'recipeText',
            'runnerText',
            'recipeValidation',
            'runnerValidation',
            'localError',
            'selectTemplate',
            'addStep',
            'normalizeFlowJson',
            'runFlow',
            'copyText',
        ]);
        for (const privateField of [
            'flowResult',
            'variablesResult',
            'variablesEdited',
            'sequence',
        ]) {
            expect.soft(returnedFields, `private controller field ${privateField}`)
                .not.toContain(privateField);
        }

        const editorDeclaration = optionalFunction(
            editorPath,
            editorSource,
            'FlowBuilderEditor',
        );
        const previewsDeclaration = optionalFunction(
            previewsPath,
            previewsSource,
            'FlowBuilderPreviews',
        );
        const panelDeclaration = optionalFunction(
            panelPath,
            panelSource,
            'FlowBuilderPanel',
        );
        for (const [name, source] of [
            ['Editor', editorSource],
            ['Previews', previewsSource],
        ] as const) {
            expect.soft(source, `${name}: no hooks/runtime/controller effects`)
                .not.toMatch(
                    /\b(?:useState|useMemo|useEffect|useRef|useCallback|rallarBlackBoxRuntimeStore|executeManualCommands|fetch|navigator\.|localStorage|sessionStorage)\b/,
                );
        }
        const editorReturn = editorDeclaration
            ? task9aReturnExpression(editorDeclaration)
            : undefined;
        const previewsReturn = previewsDeclaration
            ? task9aReturnExpression(previewsDeclaration)
            : undefined;
        expect.soft(
            editorReturn ? task9aAstFingerprint([editorReturn]) : '',
            'Editor exact fragment return',
        ).toBe('b9e50a4bde372981986dd2a92b6dbdbdd6329bd3efbb36ea869844ef7dd262e0');
        expect.soft(
            editorReturn ? task9aJsxRuntimeFingerprint(editorReturn) : '',
            'Editor exact compiled return',
        ).toBe('dc3caf670fa63d578aff40eae1df8898e910526da7f24cc0fe4c7e1d21adfad1');
        expect.soft(
            previewsReturn ? task9aAstFingerprint([previewsReturn]) : '',
            'Previews exact layout return',
        ).toBe('025a36bca31a1b733484479086b01f186c331ab7695150fe29c0ed6b49a41344');
        expect.soft(
            previewsReturn ? task9aJsxRuntimeFingerprint(previewsReturn) : '',
            'Previews exact compiled return',
        ).toBe('e3ee80533f69092e0838968f532634b759ed0e858da01ab982009d38115bd65e');
        expect.soft(previewsReturn?.getText() ?? '', 'Previews direct layout root')
            .toMatch(/^<div className="flow-builder-layout">/);

        expect.soft(panelSource, 'Panel no hooks/runtime/network/storage').not.toMatch(
            /\b(?:useState|useMemo|useEffect|useRef|useCallback|rallarBlackBoxRuntimeStore|executeManualCommands|fetch|navigator\.|localStorage|sessionStorage)\b/,
        );
        const controllerCalls: ts.CallExpression[] = [];
        if (panelDeclaration) {
            const visit = (node: ts.Node): void => {
                if (
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === 'useFlowBuilderController'
                ) controllerCalls.push(node);
                ts.forEachChild(node, visit);
            };
            visit(panelDeclaration);
        }
        expect.soft(controllerCalls, 'Panel calls controller once').toHaveLength(1);
        expect.soft(
            task9aAstFingerprint(controllerCalls),
            'Panel exact controller input call',
        ).toBe('8b4a7b5848dd467f88231591b516d81ca2668d2f1180a9f08d2a54f2e7423c08');
        const panelReturn = panelDeclaration
            ? task9aReturnExpression(panelDeclaration)
            : undefined;
        expect.soft(
            panelReturn ? task9aAstFingerprint([panelReturn]) : '',
            'Panel exact composition return',
        ).toBe('6c687262ef786b0bfaf5bc73bb5b0bf81c4e0cd068d8f4d58f6a6a463790444a');
        expect.soft(
            panelReturn ? task9aJsxRuntimeFingerprint(panelReturn) : '',
            'Panel exact compiled composition',
        ).toBe('d83dca0805114f2e8507be43386d66b1e848e261366b4928a9424b8a95565405');
        expect.soft(
            panelDeclaration
                ? task9aAstFingerprint(task9aJsxCalls(panelDeclaration, 'FlowBuilderEditor'))
                : '',
            'Panel exact Editor call',
        ).toBe('1e98570872451ed061adbbfe517337a76f9bf0ec0d4f99a282df617dbe25d260');
        expect.soft(
            panelDeclaration
                ? task9aAstFingerprint(task9aJsxCalls(panelDeclaration, 'FlowBuilderPreviews'))
                : '',
            'Panel exact Previews call',
        ).toBe('5b5cb63bc542dba31e0b77775f27e396d8547e733088c8124c495cf78527fa89');
        expect.soft(panelSource, 'Panel no spreads/prop registries').not.toMatch(
            /<\w+[^>]*{\.\.\.|\b(?:viewProps|controllerProps|editorProps|previewProps)\b/,
        );

        const appAst = task9aSourceFile(appSourcePath, appSource);
        const appDeclaration = task9aNamedFunction(appAst, 'App');
        const appCalls = task9aJsxCalls(appDeclaration, 'FlowBuilderPanel');
        expect.soft(appCalls, 'App keeps exactly two Builder calls').toHaveLength(2);
        expect.soft(
            task9aAstFingerprint(appCalls),
            'App exact two five-prop Builder calls',
        ).toBe('618fffae88a71387d4f9993e3a1c612dadeb213ff399d6b9e6df8669c2dd969f');
        for (const call of appCalls) {
            expect.soft(task9aAstFingerprint([call]), 'each exact five-prop call')
                .toBe('cc200559c8f66b8fa65295c42a15211c5dd78ddce6a44c50fb962086c6263ce9');
            expect.soft(call.getText(), 'Builder call has no key').not.toMatch(/\bkey\s*=/);
        }
        let primaryGuard: ts.Node | undefined = appCalls[0];
        while (primaryGuard && !ts.isJsxExpression(primaryGuard)) {
            primaryGuard = primaryGuard.parent;
        }
        expect.soft(
            primaryGuard ? task9aAstFingerprint([primaryGuard]) : '',
            'primary conditional lifetime guard',
        ).toBe('e51261fa9a7168150fd104f5edc996b8e367b237c252d61779ddc84fb03444fc');
        const appReturn = task9aReturnExpression(appDeclaration);
        const elementById = (id: string): ts.JsxElement | undefined => {
            let found: ts.JsxElement | undefined;
            const visit = (node: ts.Node): void => {
                if (found) return;
                if (ts.isJsxElement(node)) {
                    const attribute = node.openingElement.attributes.properties.find(
                        (property): property is ts.JsxAttribute =>
                            ts.isJsxAttribute(property) &&
                            property.name.getText() === 'id',
                    );
                    if (
                        attribute?.initializer &&
                        ts.isStringLiteral(attribute.initializer) &&
                        attribute.initializer.text === id
                    ) {
                        found = node;
                        return;
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(appReturn);
            return found;
        };
        for (const [id, expectedHash] of [
            ['panel-builder', '7a4912305a4d8114e5bb868496c67a085b7fba485856573e2ff3f685617f6006'],
            ['panel-flow-builder', '1b33e2d5cb755ee147be635a7600e5200a4dc742b9ba8e241affe958cbd5a7d1'],
            ['legacy-panel-flow-builder', 'c9da790ef7af24a82da82786ef91ed73d35068f371bcd9255d6034079d8da232'],
        ] as const) {
            const element = elementById(id);
            expect.soft(
                element ? task9aAstFingerprint([element]) : '',
                `${id}: exact wrapper`,
            ).toBe(expectedHash);
        }
        const legacyWrapper = elementById('legacy-panel-flow-builder');
        expect.soft(legacyWrapper?.getText() ?? '', 'legacy remains hidden persistent')
            .toContain("hidden={activeTab !== 'flow-builder'}");
        expect.soft(
            task9aImportEdges(appAst).filter((edge) =>
                edge.startsWith('./legacy/runner/builder/'),
            ),
            'App imports only direct Builder Panel owner',
        ).toEqual([
            './legacy/runner/builder/FlowBuilderPanel.tsx|value:FlowBuilderPanel',
        ]);

        const dependencies = new Map<string, readonly string[]>();
        const discoverDependencies = (sourcePath: string): void => {
            if (dependencies.has(sourcePath)) return;
            const source = existsSync(resolve(repositoryRoot, sourcePath))
                ? repositorySource(sourcePath)
                : '';
            const directDependencies = task9aImportEdges(
                task9aSourceFile(sourcePath, source),
            )
                .map((edge) => edge.slice(0, edge.indexOf('|')))
                .filter((moduleImport) => moduleImport.startsWith('.'))
                .map((moduleImport) =>
                    relative(
                        repositoryRoot,
                        resolve(
                            resolve(repositoryRoot, sourcePath),
                            '..',
                            moduleImport,
                        ),
                    ),
                )
                .filter(
                    (dependency) =>
                        ['.ts', '.tsx'].includes(extname(dependency)) &&
                        existsSync(resolve(repositoryRoot, dependency)),
                );
            dependencies.set(sourcePath, directDependencies);
            for (const dependency of directDependencies) {
                discoverDependencies(dependency);
            }
        };
        for (const owner of owners) discoverDependencies(owner.path);
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) {
                cycles.push(path);
                return;
            }
            if (visited.has(path)) return;
            active.add(path);
            for (const dependency of dependencies.get(path) ?? []) visit(dependency);
            active.delete(path);
            visited.add(path);
        };
        for (const owner of owners) visit(owner.path);
        expect(cycles, 'Builder recursive owner import cycles').toEqual([]);
    });

    it('extracts the exact Fleet controller and panel over the preserved support and views', () => {
        const appSource = repositorySource(appSourcePath);
        const fleetRoot = 'apps/rallar-black-box/src/legacy/runner/fleet';
        const controllerPath = `${fleetRoot}/use-runner-fleet-controller.ts`;
        const panelPath = `${fleetRoot}/RunnerFleetPanel.tsx`;
        const controllerSource = existsSync(resolve(repositoryRoot, controllerPath))
            ? repositorySource(controllerPath)
            : appSource;
        const panelSource = existsSync(resolve(repositoryRoot, panelPath))
            ? repositorySource(panelPath)
            : appSource;
        const owners = [
            { path: controllerPath, cap: 460, exports: ['type:RunnerFleetControllerModel', 'type:UseRunnerFleetControllerInput', 'value:useRunnerFleetController'] },
            { path: panelPath, cap: 210, exports: ['value:RunnerFleetPanel'] },
            { path: `${fleetRoot}/fleet-types.ts`, cap: 80, exports: ['type:FleetAgentHeatmapRow', 'type:FleetFilterState', 'type:FleetLabelOverride', 'type:FleetTimingGroup'] },
            { path: `${fleetRoot}/fleet-helpers.ts`, cap: 280, exports: ['value:applyFleetLabelOverrides', 'value:fleetReportFilterFromUi', 'value:parseFleetLabelOverrides', 'value:readFleetFiltersFromUrl', 'value:readFleetWorldMapLayersFromUrl', 'value:writeFleetFiltersToSearchParams', 'value:writeFleetFiltersToUrl', 'value:writeFleetWorldMapLayersToSearchParams', 'value:writeFleetWorldMapLayersToUrl'] },
            { path: `${fleetRoot}/fleet-derivations.ts`, cap: 210, exports: ['value:fleetAgentDetail', 'value:fleetHeatmapRows', 'value:fleetMissingLabelAgents', 'value:fleetRegionRows'] },
            { path: `${fleetRoot}/fleet-timing.ts`, cap: 140, exports: ['value:fleetTimingDistribution', 'value:fleetTimingGroupsByRecipe', 'value:fleetTimingGroupsByRegion'] },
            { path: `${fleetRoot}/fleet-rollups.ts`, cap: 190, exports: ['value:fleetDisplaySummary', 'value:fleetFailureRows'] },
            { path: `${fleetRoot}/fleet-presentation.ts`, cap: 100, exports: ['value:fleetAgentStateTone', 'value:fleetCellTitle', 'value:fleetFailureTone', 'value:fleetRegionKey', 'value:fleetRegionLabel', 'value:shortSignatureId'] },
            { path: `${fleetRoot}/views/RunnerFleetControls.tsx`, cap: 210, exports: ['value:RunnerFleetControls'] },
            { path: `${fleetRoot}/views/RunnerFleetOverview.tsx`, cap: 230, exports: ['value:RunnerFleetOverview'] },
            { path: `${fleetRoot}/views/RunnerFleetReportAnalysis.tsx`, cap: 300, exports: ['value:RunnerFleetReportAnalysis'] },
            { path: `${fleetRoot}/views/RunnerFleetSelectedDetails.tsx`, cap: 180, exports: ['value:RunnerFleetSelectedDetails'] },
            { path: `${fleetRoot}/views/FleetTimingGroupList.tsx`, cap: 100, exports: ['value:FleetTimingGroupList'] },
        ] as const;
        const sources = new Map<string, string>();
        for (const owner of owners) {
            const exists = existsSync(resolve(repositoryRoot, owner.path));
            const source = exists ? repositorySource(owner.path) : '';
            sources.set(owner.path, source);
            expect.soft(exists, `${owner.path}: exists`).toBe(true);
            expect.soft(
                source === '' ? 0 : source.trimEnd().split(/\r?\n/).length,
                `${owner.path}: line cap`,
            ).toBeLessThanOrEqual(owner.cap);
            expect.soft(source, `${owner.path}: no App import`).not.toMatch(
                /\b(?:from\s+|import\s*\(\s*)['"][^'"]*App\.tsx['"]/
            );
            expect.soft(source, `${owner.path}: no CSS import`).not.toMatch(
                /\b(?:from\s+|import\s*)['"][^'"]+\.css['"]/
            );
            expect.soft(source, `${owner.path}: no barrel facade`).not.toMatch(
                /^\s*export\s+(?:\*|(?:type\s+)?{[^}]+}\s+from)\b/m,
            );
            expect.soft(
                task9aExportSeams(task9aSourceFile(owner.path, source)),
                `${owner.path}: exact exports`,
            ).toEqual([...owner.exports].sort());
        }

        const exactImports = new Map<string, readonly string[]>([
            [controllerPath, [
                '../../../control-agent-board.ts|value:deriveControlAgentBoardRows,value:summarizeControlAgentBoardRows',
                '../../../control-client.ts|type:RallarBlackBoxControlSnapshot',
                '../../../control-run-manager.ts|type:ControlFleetReportBundle,type:ControlFleetReportsResponse,type:ControlServerSnapshot,value:controlHttpBaseUrlFromWsUrl,value:fetchControlServerSnapshot,value:fetchFleetReportBundle,value:fetchFleetReports,value:rebuildFleetReports',
                '../../../runner-readiness.ts|value:runnerFriendlyErrorMessage',
                '../../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig',
                '../../../world-map-model.ts|type:FleetWorldMapLayerId,type:FleetWorldMapLayerState,type:FleetWorldMapRegion,value:deriveFleetWorldMapModel,value:routeEvidenceFromControlRun',
                '../../shared/json-presentation.ts|value:json',
                '../../shell/global-context-model.ts|type:CommandCenterGlobalValues',
                '../shared/control-snapshot-bounds.ts|value:RUN_MANAGER_SNAPSHOT_BOUNDS',
                './fleet-derivations.ts|value:fleetAgentDetail,value:fleetHeatmapRows,value:fleetMissingLabelAgents,value:fleetRegionRows',
                './fleet-helpers.ts|value:applyFleetLabelOverrides,value:fleetReportFilterFromUi,value:parseFleetLabelOverrides,value:readFleetFiltersFromUrl,value:readFleetWorldMapLayersFromUrl,value:writeFleetFiltersToSearchParams,value:writeFleetFiltersToUrl,value:writeFleetWorldMapLayersToSearchParams,value:writeFleetWorldMapLayersToUrl',
                './fleet-rollups.ts|value:fleetDisplaySummary,value:fleetFailureRows',
                './fleet-timing.ts|value:fleetTimingGroupsByRecipe,value:fleetTimingGroupsByRegion',
                './fleet-types.ts|type:FleetFilterState',
                'react|value:useEffect,value:useMemo,value:useRef,value:useState',
            ]],
            [panelPath, [
                './use-runner-fleet-controller.ts|type:UseRunnerFleetControllerInput,value:useRunnerFleetController',
                './views/RunnerFleetControls.tsx|value:RunnerFleetControls',
                './views/RunnerFleetOverview.tsx|value:RunnerFleetOverview',
                './views/RunnerFleetReportAnalysis.tsx|value:RunnerFleetReportAnalysis',
                './views/RunnerFleetSelectedDetails.tsx|value:RunnerFleetSelectedDetails',
            ]],
            [`${fleetRoot}/fleet-types.ts`, [
                '../../../control-run-manager.ts|type:ControlFleetAgentRunOutcome,type:ControlFleetTimingDistribution',
            ]],
            [`${fleetRoot}/fleet-helpers.ts`, [
                '../../../control-run-manager.ts|type:ControlFleetReportFilter,type:ControlFleetRunReport',
                '../../../world-map-model.ts|type:FleetWorldMapLayerId,type:FleetWorldMapLayerState,value:DEFAULT_FLEET_WORLD_MAP_LAYER_STATE,value:FLEET_WORLD_MAP_LAYER_IDS',
                './fleet-types.ts|type:FleetFilterState,type:FleetLabelOverride',
            ]],
            [`${fleetRoot}/fleet-presentation.ts`, [
                '../../../control-run-manager.ts|type:ControlFleetAgentRunOutcome,type:ControlFleetFailureSignature',
            ]],
            [`${fleetRoot}/fleet-timing.ts`, [
                '../../../control-run-manager.ts|type:ControlFleetRunReport,type:ControlFleetTimingDistribution',
                './fleet-presentation.ts|value:fleetRegionKey',
                './fleet-types.ts|type:FleetTimingGroup',
            ]],
            [`${fleetRoot}/fleet-derivations.ts`, [
                '../../../control-run-manager.ts|type:ControlFleetAgentRunOutcome,type:ControlFleetRunReport',
                './fleet-presentation.ts|value:fleetRegionKey',
                './fleet-timing.ts|value:fleetTimingDistribution',
                './fleet-types.ts|type:FleetAgentHeatmapRow',
            ]],
            [`${fleetRoot}/fleet-rollups.ts`, [
                '../../../control-run-manager.ts|type:ControlFleetFailureSignature,type:ControlFleetReportsResponse,type:ControlFleetRunReport',
                './fleet-presentation.ts|value:fleetRegionKey',
                './fleet-timing.ts|value:fleetTimingDistribution',
            ]],
            [`${fleetRoot}/views/RunnerFleetControls.tsx`, [
                '../../../../control-run-manager.ts|type:ControlFleetRunReport',
                '../../../shared/time-format.ts|value:formatTime',
                '../fleet-types.ts|type:FleetFilterState',
            ]],
            [`${fleetRoot}/views/RunnerFleetOverview.tsx`, [
                '../../../../control-agent-board.ts|type:ControlAgentBoardRow,type:ControlAgentBoardSummary',
                '../../../../control-run-manager.ts|type:ControlFleetRunReport,type:ControlRunSnapshot,type:ControlServerSnapshot',
                '../../../../fleet-world-map.tsx|value:FleetWorldMap',
                '../../../../world-map-model.ts|type:FleetWorldMapLayerId,type:FleetWorldMapLayerState,type:FleetWorldMapRegion,type:FleetWorldMapViewModel',
                '../../../shared/Metric.tsx|value:Metric',
                '../../../shared/json-presentation.ts|value:json',
                '../../../shared/time-format.ts|value:formatTime',
                '../../agents/ControlAgentBoardPanel.tsx|value:ControlAgentBoardPanel',
                '../../shared/performance-format.ts|value:formatFleetDuration,value:formatPercent',
            ]],
            [`${fleetRoot}/views/RunnerFleetReportAnalysis.tsx`, [
                '../../../../control-run-manager.ts|type:ControlFleetFailureSignature,type:ControlFleetReportBundle,type:ControlFleetRunReport,type:ControlFleetTimingDistribution',
                '../../shared/performance-format.ts|value:formatFleetDuration,value:formatPercent',
                '../../shared/run-id-presentation.ts|value:shortRunId',
                '../fleet-presentation.ts|value:fleetAgentStateTone,value:fleetCellTitle,value:fleetFailureTone,value:shortSignatureId',
                '../fleet-types.ts|type:FleetAgentHeatmapRow,type:FleetTimingGroup',
                './FleetTimingGroupList.tsx|value:FleetTimingGroupList',
            ]],
            [`${fleetRoot}/views/RunnerFleetSelectedDetails.tsx`, [
                '../../../../control-run-manager.ts|type:ControlFleetFailureSignature',
                '../../../shared/time-format.ts|value:formatTime',
                '../../shared/run-id-presentation.ts|value:shortRunId',
                '../fleet-derivations.ts|type:fleetAgentDetail',
                '../fleet-presentation.ts|value:fleetAgentStateTone,value:fleetRegionLabel',
            ]],
            [`${fleetRoot}/views/FleetTimingGroupList.tsx`, [
                '../../../../control-run-manager.ts|type:ControlFleetTimingDistribution',
                '../../shared/performance-format.ts|value:formatFleetDuration',
                '../fleet-types.ts|type:FleetTimingGroup',
            ]],
        ]);
        for (const [path, expected] of exactImports) {
            expect.soft(
                task9aImportEdges(task9aSourceFile(path, sources.get(path) ?? '')),
                `${path}: exact imports/kinds/DAG edges`,
            ).toEqual([...expected].sort());
        }
        for (const path of [
            `${fleetRoot}/fleet-types.ts`, `${fleetRoot}/fleet-helpers.ts`,
            `${fleetRoot}/fleet-derivations.ts`, `${fleetRoot}/fleet-timing.ts`,
            `${fleetRoot}/fleet-rollups.ts`, `${fleetRoot}/fleet-presentation.ts`,
        ]) {
            const source = sources.get(path) ?? '';
            const sourceFile = task9aSourceFile(path, source);
            let hasJsx = false;
            const visit = (node: ts.Node): void => {
                if (
                    ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) ||
                    ts.isJsxFragment(node)
                ) hasJsx = true;
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
            expect.soft(source, `${path}: no React/hooks`).not.toMatch(
                /\b(?:react|useState|useMemo|useEffect|useRef|useCallback)\b/,
            );
            expect.soft(hasJsx, `${path}: no JSX`).toBe(false);
        }

        for (const declaration of [
            'FleetFilterState', 'FleetAgentHeatmapRow', 'FleetTimingGroup',
            'FleetLabelOverride', 'DEFAULT_FLEET_FILTERS',
            'FleetTimingGroupList', 'FleetTimingStrip',
            'readFleetFiltersFromUrl', 'writeFleetFiltersToUrl',
            'writeFleetFiltersToSearchParams', 'readFleetWorldMapLayersFromUrl',
            'writeFleetWorldMapLayersToUrl', 'writeFleetWorldMapLayersToSearchParams',
            'parseFleetWorldMapLayers', 'fleetWorldMapLayersEqual',
            'parseFleetWindow', 'fleetReportFilterFromUi',
            'parseFleetLabelOverrides', 'isFleetRecord',
            'applyFleetLabelOverrides', 'fleetDisplaySummary',
            'fleetHeatmapRows', 'fleetRegionRows', 'fleetFailureRows',
            'fleetTimingGroupsByRegion', 'fleetTimingGroupsByRecipe',
            'fleetTimingDistribution', 'percentile', 'fleetMissingLabelAgents',
            'fleetAgentDetail', 'fleetRegionKey', 'fleetRegionLabel',
            'fleetAgentStateTone', 'fleetFailureTone', 'fleetCellTitle',
            'shortSignatureId', 'minDefined', 'maxDefined',
        ] as const) {
            expect.soft(appSource, `App local ${declaration}`).not.toMatch(
                new RegExp(`^\\s*(?:export\\s+)?(?:type|const|let|var|function)\\s+${declaration}\\b`, 'm'),
            );
        }

        const appAst = task9aSourceFile(appSourcePath, appSource);
        const ownerAst = (name: string): ts.SourceFile => {
            const path = `${fleetRoot}/${name}`;
            return task9aSourceFile(path, sources.get(path) ?? '');
        };
        const parameterAndBodyNodes = (
            sourceFile: ts.SourceFile,
            names: readonly string[],
        ): readonly ts.Node[] => names.flatMap((name) => {
            const declaration = task9aNamedFunction(sourceFile, name);
            return [...declaration.parameters, declaration.body!];
        });
        const supportFingerprints = [
            [
                ownerAst('fleet-helpers.ts'),
                [
                    'readFleetFiltersFromUrl', 'writeFleetFiltersToUrl',
                    'writeFleetFiltersToSearchParams',
                    'readFleetWorldMapLayersFromUrl',
                    'writeFleetWorldMapLayersToUrl',
                    'writeFleetWorldMapLayersToSearchParams',
                    'parseFleetWorldMapLayers', 'fleetWorldMapLayersEqual',
                    'parseFleetWindow', 'fleetReportFilterFromUi',
                    'parseFleetLabelOverrides', 'isFleetRecord',
                    'applyFleetLabelOverrides',
                ],
                '7ff4ee70fc130f886238efefdd4a5e6032bb8d402a0e35cb8c5b4f236d4cce9b',
            ],
            [
                ownerAst('fleet-derivations.ts'),
                ['fleetHeatmapRows', 'fleetRegionRows', 'fleetMissingLabelAgents', 'fleetAgentDetail'],
                '6a876cd493b99195541623f4134a2b361b38b7632cf502cf4ceb2bf476d305f7',
            ],
            [
                ownerAst('fleet-timing.ts'),
                ['fleetTimingGroupsByRegion', 'fleetTimingGroupsByRecipe', 'fleetTimingDistribution', 'percentile'],
                '9f85f91e3feb4c42a8df8ab85df139c55b10b3d985bda79d3be5b55abc1febf8',
            ],
            [
                ownerAst('fleet-rollups.ts'),
                ['fleetDisplaySummary', 'fleetFailureRows', 'minDefined', 'maxDefined'],
                '6349987408e5f4798688589cda005feca9d5ee935a1eee27191f29fda6cd5cd4',
            ],
            [
                ownerAst('fleet-presentation.ts'),
                ['fleetRegionKey', 'fleetRegionLabel', 'fleetAgentStateTone', 'fleetFailureTone', 'fleetCellTitle', 'shortSignatureId'],
                'ab350e7cc2faa8408b94372cc27f0b1ebcbd4c6ca1a03045851d839988c72470',
            ],
        ] as const;
        for (const [sourceFile, names, expectedFingerprint] of supportFingerprints) {
            expect.soft(
                task9aAstFingerprint(parameterAndBodyNodes(sourceFile, names)),
                `${sourceFile.fileName}: exact parameters and bodies`,
            ).toBe(expectedFingerprint);
        }
        const typesAst = ownerAst('fleet-types.ts');
        const typeNodes = [
            'FleetFilterState', 'FleetAgentHeatmapRow',
            'FleetTimingGroup', 'FleetLabelOverride',
        ].flatMap((name) => {
            const declaration = typesAst.statements.find(
                (statement): statement is ts.TypeAliasDeclaration =>
                    ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
            );
            return declaration ? [declaration.name, declaration.type] : [];
        });
        expect.soft(task9aAstFingerprint(typeNodes), 'exact Fleet type declarations')
            .toBe('8d17b621058f85094d88653aa2e8da5f2a8a853e93bf303cb34abf86b9f8a399');
        const helpersAst = ownerAst('fleet-helpers.ts');
        const defaultFilters = helpersAst.statements
            .filter(ts.isVariableStatement)
            .flatMap((statement) => [...statement.declarationList.declarations])
            .find((declaration) =>
                ts.isIdentifier(declaration.name) &&
                declaration.name.text === 'DEFAULT_FLEET_FILTERS',
            )?.initializer;
        expect.soft(
            defaultFilters ? task9aAstFingerprint([defaultFilters]) : '',
            'exact Fleet defaults initializer',
        ).toBe('2e5f3d85bc30369ca762432ec090c1cb48c322e8fe009139bf929512180f56be');

        const hasControllerOwner = existsSync(resolve(repositoryRoot, controllerPath));
        const controllerAst = task9aSourceFile(controllerPath, controllerSource);
        const controller = task9aNamedFunction(
            controllerAst,
            hasControllerOwner ? 'useRunnerFleetController' : 'RunnerFleetPanel',
        );
        const panelAst = task9aSourceFile(panelPath, panelSource);
        const panel = task9aNamedFunction(panelAst, 'RunnerFleetPanel');
        expect.soft(appSource, 'RunnerFleetPanel leaves App').not.toMatch(
            /^function RunnerFleetPanel\(/m,
        );
        const controllerStatements = controller.body?.statements ?? [];
        const returnIndex = controllerStatements.findIndex(ts.isReturnStatement);
        const preReturn = returnIndex >= 0
            ? controllerStatements.slice(0, returnIndex)
            : [];
        expect.soft(preReturn, '46 exact pre-return controller statements').toHaveLength(46);
        expect.soft(
            task9aAstFingerprint(preReturn),
            'token-complete Fleet controller hook',
        ).toBe('68e62590dd3ece0d091f1ee7c5dc62e005e348a0f4fe30e31957173c3aa894c4');
        expect.soft(
            task9aAstFingerprint(preReturn.filter((statement) =>
                /\buse(?:State|Memo|Ref|Effect)\s*(?:<|\()/.test(statement.getText()),
            )),
            'exact Fleet hook-bearing statements',
        ).toBe('dc15e915d5585804686e36a0844e70986bfdbe12aed6e83ec8a8aa911ab17b7b');
        const hookCalls = { useState: 0, useMemo: 0, useRef: 0, useEffect: 0, useCallback: 0 };
        const visitControllerHooks = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text in hookCalls) {
                hookCalls[node.expression.text as keyof typeof hookCalls] += 1;
            }
            ts.forEachChild(node, visitControllerHooks);
        };
        visitControllerHooks(controller);
        expect.soft(hookCalls, 'Fleet controller hook topology').toEqual({
            useState: 15, useMemo: 17, useRef: 1, useEffect: 4, useCallback: 0,
        });
        const effects: ts.CallExpression[] = [];
        const visitControllerEffects = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect') effects.push(node);
            ts.forEachChild(node, visitControllerEffects);
        };
        visitControllerEffects(controller);
        expect.soft(effects.map((effect) => task9aAstFingerprint([effect])), 'exact Fleet effects').toEqual([
            '12a49a857f746ca8e6fcdc92ad09893d333631bf88dad1bdeffe380b74b91ba4',
            '9016a31a96ecc30de10cc5047a74e80b9ebb6eebec46e2a06ce1fe39f11acb50',
            'afcd6dbc355b0833cf12a8cd8bd0d872ae93c7d2bbfb140c4f4770394fb90ab5',
            '568263a7b6f1fafd7e1566e41530534bcae773d9aafc8c0196fa272906198890',
        ]);
        expect.soft(
            preReturn
                .filter((statement) =>
                    ts.isExpressionStatement(statement) &&
                    ts.isCallExpression(statement.expression) &&
                    ts.isIdentifier(statement.expression.expression) &&
                    statement.expression.expression.text === 'useEffect',
                )
                .map((statement) => task9aAstFingerprint([statement])),
            'exact Fleet effect statements',
        ).toEqual([
            'e105809fc0853fd897ef3af0f7651efffd9191965562c1a56584b9f657aa3f80',
            'a6a50c52b0f7061c6327bae9af01dfcf710c1e9d4fdf5a2aeb27783eb3b6cf00',
            '9cd28a1de469aee9cc5a98be7938479156c3a6740d406ddbdc529e28985389a7',
            'c05e7daa34881115888d79c0c1e8cb77de5119e800815bff35bbdc8e5e698912',
        ]);
        const controllerDeclarations = new Map<string, ts.VariableStatement>();
        for (const statement of preReturn) {
            if (!ts.isVariableStatement(statement)) continue;
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) {
                    controllerDeclarations.set(declaration.name.text, statement);
                }
            }
        }
        for (const [name, fingerprint] of [
            ['refreshFleet', '1e0554fb6f15ddf51599c5872c828912dacfddab158d44597ee5bded0a66608c'],
            ['updateFilter', '51638c3a885ede605336508a72f68d8b344b9a927451bd0763751d7154aec0e1'],
            ['updateMapLayer', '6522b1bd4ec0b8938d770990d19e40f2c4857dda91133d2f7af65805fd14d49d'],
            ['selectMapRegion', '86bfd70e981c7f6b484a3cd4ac9561ba084aba4270023385803f2f28c8ecdce4'],
            ['copyShareLink', '822c50a5152ab37c7ebabf51fec4fa28849d5f46045e352cb736a579156afe48'],
            ['exportSelectedReport', '0e94ae28777f92968fafe356eeae4d21edbd447cae834ad0bd8c0b48189daf2a'],
        ] as const) {
            const statement = controllerDeclarations.get(name);
            expect.soft(
                statement ? task9aAstFingerprint([statement]) : '',
                `${name}: exact controller action`,
            ).toBe(fingerprint);
        }

        const inputAlias = controllerAst.statements.find(
            (statement): statement is ts.TypeAliasDeclaration =>
                ts.isTypeAliasDeclaration(statement) &&
                statement.name.text === 'UseRunnerFleetControllerInput',
        );
        const expectedInputAst = task9aSourceFile(
            'expected-fleet-controller-input.ts',
            `type Expected = Readonly<{
                bootstrap: RallarBlackBoxBootstrapConfig;
                control: RallarBlackBoxControlSnapshot;
                globalValues: CommandCenterGlobalValues;
            }>;`,
        ).statements[0] as ts.TypeAliasDeclaration;
        expect.soft(
            inputAlias ? task9aAstFingerprint([inputAlias.type]) : '',
            'exact Fleet controller input type',
        ).toBe(task9aAstFingerprint([expectedInputAst.type]));
        const modelAlias = controllerAst.statements.find(
            (statement): statement is ts.TypeAliasDeclaration =>
                ts.isTypeAliasDeclaration(statement) &&
                statement.name.text === 'RunnerFleetControllerModel',
        );
        const expectedModelAst = task9aSourceFile(
            'expected-fleet-controller-model.ts',
            'type Expected = ReturnType<typeof useRunnerFleetController>;',
        ).statements[0] as ts.TypeAliasDeclaration;
        expect.soft(
            modelAlias ? task9aAstFingerprint([modelAlias.type]) : '',
            'exact inferred Fleet controller model alias',
        ).toBe(task9aAstFingerprint([expectedModelAst.type]));
        const controllerParameter = controller.parameters[0];
        const controllerParameterKeys = controllerParameter &&
                ts.isObjectBindingPattern(controllerParameter.name)
            ? controllerParameter.name.elements.map((element) =>
                  element.name.getText(controllerAst)
              )
            : [];
        expect.soft(controllerParameterKeys, 'exact Fleet controller input order')
            .toEqual(['bootstrap', 'control', 'globalValues']);
        expect.soft(
            controllerParameter?.type?.getText(controllerAst) ?? '',
            'Fleet hook uses its named input contract',
        ).toBe('UseRunnerFleetControllerInput');
        const modelKeys = [
            'controlBaseUrl', 'setControlBaseUrl', 'controlToken',
            'setControlToken', 'filters', 'mapLayers', 'liveSnapshot',
            'liveRunId', 'setLiveRunId', 'busy', 'error', 'lastRefresh',
            'selectedAgentId', 'setSelectedAgentId', 'setSelectedFailureId',
            'setSelectedReportId', 'overrideText', 'setOverrideText',
            'lastExport', 'overrides', 'reports', 'displaySummary',
            'heatmapRuns', 'heatmapRows', 'regionRows', 'failureRows',
            'selectedFailure', 'selectedAgent', 'regionTiming', 'recipeTiming',
            'missingLabelAgents', 'selectedReport', 'liveGroupRef',
            'liveRunOptions', 'liveRun', 'liveAgentRows', 'liveAgentSummary',
            'worldMapModel', 'refreshFleet', 'updateFilter', 'updateMapLayer',
            'selectMapRegion', 'copyShareLink', 'exportSelectedReport',
        ] as const;
        expect.soft(modelKeys, 'brief model key count').toHaveLength(44);
        const controllerReturn = task9aReturnExpression(controller);
        const returnedKeys = ts.isObjectLiteralExpression(controllerReturn)
            ? controllerReturn.properties.map((property) =>
                  ts.isShorthandPropertyAssignment(property)
                      ? property.name.text
                      : property.getText(controllerAst)
              )
            : [];
        expect.soft(returnedKeys, 'exact Fleet controller return key order')
            .toEqual(modelKeys);
        expect.soft(
            ts.isObjectLiteralExpression(controllerReturn) &&
                controllerReturn.properties.every(ts.isShorthandPropertyAssignment),
            'Fleet controller returns only direct shorthand model fields',
        ).toBe(true);
        expect.soft(
            controllerStatements.filter(ts.isReturnStatement),
            'one final Fleet controller return',
        ).toHaveLength(1);

        const panelHookCalls: ts.CallExpression[] = [];
        const visitPanelHook = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === 'useRunnerFleetController'
            ) panelHookCalls.push(node);
            ts.forEachChild(node, visitPanelHook);
        };
        visitPanelHook(panel);
        expect.soft(panelHookCalls, 'Panel calls Fleet controller exactly once')
            .toHaveLength(1);
        const expectedHookCallAst = task9aSourceFile(
            'expected-fleet-hook-call.ts',
            'useRunnerFleetController({ bootstrap, control, globalValues });',
        );
        const expectedHookCall = (
            expectedHookCallAst.statements[0] as ts.ExpressionStatement
        ).expression as ts.CallExpression;
        expect.soft(
            task9aAstFingerprint(panelHookCalls),
            'Panel exact Fleet controller input call',
        ).toBe(task9aAstFingerprint([expectedHookCall]));
        const panelStatements = panel.body?.statements ?? [];
        const panelReturnIndex = panelStatements.findIndex(ts.isReturnStatement);
        const panelPreReturn = panelReturnIndex >= 0
            ? panelStatements.slice(0, panelReturnIndex)
            : [];
        expect.soft(panelPreReturn, 'Panel has one controller destructure')
            .toHaveLength(1);
        const panelBinding = panelPreReturn
            .filter(ts.isVariableStatement)
            .flatMap((statement) => [...statement.declarationList.declarations])
            .find((declaration) => ts.isObjectBindingPattern(declaration.name));
        const panelBindingKeys = panelBinding && ts.isObjectBindingPattern(panelBinding.name)
            ? panelBinding.name.elements.map((element) => element.name.getText(panelAst))
            : [];
        expect.soft(panelBindingKeys, 'Panel exact model destructure order')
            .toEqual(modelKeys);
        expect.soft(
            panelSource,
            'Panel has no controller internals or side effects',
        ).not.toMatch(
            /\b(?:useState|useMemo|useEffect|useRef|useCallback|fetchFleetReports|fetchControlServerSnapshot|fetchFleetReportBundle|navigator\.|localStorage|sessionStorage|fleetDisplaySummary|fleetHeatmapRows|fleetRegionRows|fleetFailureRows)\b/,
        );
        const panelParameter = panel.parameters[0];
        const panelParameterKeys = panelParameter &&
                ts.isObjectBindingPattern(panelParameter.name)
            ? panelParameter.name.elements.map((element) =>
                  element.name.getText(panelAst)
              )
            : [];
        expect.soft(panelParameterKeys, 'Panel exact three-prop order')
            .toEqual(['bootstrap', 'control', 'globalValues']);
        expect.soft(
            panelParameter?.type?.getText(panelAst) ?? '',
            'Panel consumes the named controller input contract',
        ).toBe('UseRunnerFleetControllerInput');
        let controllerHasJsx = false;
        const visitControllerJsx = (node: ts.Node): void => {
            if (
                ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) ||
                ts.isJsxFragment(node)
            ) controllerHasJsx = true;
            ts.forEachChild(node, visitControllerJsx);
        };
        visitControllerJsx(controllerAst);
        expect.soft(controllerHasJsx, 'controller hook has no JSX').toBe(false);
        expect.soft(controllerSource, 'controller has no App or view dependency')
            .not.toMatch(/App\.tsx|RunnerFleetControls|RunnerFleetOverview|RunnerFleetReportAnalysis|RunnerFleetSelectedDetails/);

        const viewNames = [
            'RunnerFleetControls', 'RunnerFleetOverview',
            'RunnerFleetReportAnalysis', 'RunnerFleetSelectedDetails',
            'FleetTimingGroupList',
        ] as const;
        for (const viewName of viewNames) {
            const source = [...sources.entries()].find(([path]) => path.endsWith(`${viewName}.tsx`))?.[1] ?? '';
            expect.soft(source, `${viewName}: controlled and hook-free`).not.toMatch(
                /\b(?:useState|useMemo|useEffect|useRef|useCallback|fetch|navigator\.|localStorage|sessionStorage)\b/,
            );
        }
        for (const [fileName, viewName, expectedFingerprint] of [
            ['RunnerFleetControls.tsx', 'RunnerFleetControls', 'b51a812b3a271473e57ccc9592ed0f53e87a78e08830c263330611994773bbf9'],
            ['RunnerFleetOverview.tsx', 'RunnerFleetOverview', '33d316930d4a637e56c94dc9fc10214054d6054717f1b3558be86865206db28b'],
            ['RunnerFleetReportAnalysis.tsx', 'RunnerFleetReportAnalysis', '710090eab559a3b19404a5eaa4bf33a955947e11edcc86798a619ce28db51c6a'],
            ['RunnerFleetSelectedDetails.tsx', 'RunnerFleetSelectedDetails', '57a36bccbbc71a489862417615213ff8154c728cf3b0ecdf38bdda5436a1d46c'],
            ['FleetTimingGroupList.tsx', 'FleetTimingGroupList', 'a7cd54fbe357e341013790eda3928eb950741d02c2a9edde49b59b588f92e49b'],
            ['FleetTimingGroupList.tsx', 'FleetTimingStrip', 'bd606bd77e3000be8c6e96c48ec6977ad95c4144bf9ca34032cddf5448d68ab8'],
        ] as const) {
            const path = `${fleetRoot}/views/${fileName}`;
            const sourceFile = task9aSourceFile(path, sources.get(path) ?? '');
            const declaration = task9aNamedFunction(sourceFile, viewName);
            const returnExpression = task9aReturnExpression(declaration);
            expect.soft(
                task9aJsxRuntimeFingerprint(returnExpression),
                `${viewName}: exact compiled return`,
            ).toBe(expectedFingerprint);
            if (viewName === 'FleetTimingStrip') {
                expect.soft(
                    task9aAstFingerprint([
                        ...declaration.parameters,
                        declaration.body!,
                    ]),
                    'FleetTimingStrip exact parameters and full body',
                ).toBe('0184d6bcb6c2963441fbcebfb730d8857ba806c4427af85f8e57a77a63433f0a');
            }
            if (viewName !== 'FleetTimingStrip') {
                expect.soft(
                    ts.isJsxFragment(returnExpression),
                    `${viewName}: direct controlled root`,
                ).toBe(viewName !== 'FleetTimingGroupList');
            }
        }
        expect.soft(
            panel ? task9aJsxRuntimeFingerprint(task9aReturnExpression(panel)) : '',
            'RunnerFleetPanel exact compiled composition return',
        ).toBe('4a768da66b1c3c081eac174d6dec4a00e9d124e7763cc4802272620237c02ae8');
        expect.soft(panel ? task9aAstFingerprint(task9aJsxCalls(panel, 'RunnerFleetControls')) : '', 'exact Controls call')
            .toBe('932b84f212980887f48ea7c113a9873521c82809f22059e63bdee1f252f06a17');
        expect.soft(panel ? task9aAstFingerprint(task9aJsxCalls(panel, 'RunnerFleetOverview')) : '', 'exact Overview call')
            .toBe('2c536663d4748522ef3d494d2455e0b524b6d7bc32f9874de2de6d5a86a62c97');
        expect.soft(panel ? task9aAstFingerprint(task9aJsxCalls(panel, 'RunnerFleetReportAnalysis')) : '', 'exact Analysis call')
            .toBe('ab05adba075aa2d1b52ab6581119a4a8bbc4cda05ba1dcbfc230805fed17a1ab');
        expect.soft(panel ? task9aAstFingerprint(task9aJsxCalls(panel, 'RunnerFleetSelectedDetails')) : '', 'exact Details call')
            .toBe('05130b7c686aae0b6466398d42ab70493c9be599cd55b67ef18116a885b2f192');

        const app = task9aNamedFunction(appAst, 'App');
        const mounts = task9aJsxCalls(app, 'RunnerFleetPanel');
        expect.soft(task9aAstFingerprint(mounts), 'unchanged three-prop Fleet mount')
            .toBe('be98d0d14b67833f30c5b15313ad2effdee490d2ed79da67c000ccfeb1bd01bf');
        let guard: ts.Node | undefined = mounts[0];
        while (guard && !ts.isJsxExpression(guard)) guard = guard.parent;
        expect.soft(guard ? task9aAstFingerprint([guard]) : '', 'unchanged Fleet guard')
            .toBe('5d583f66a7974b0dccd1d157795ac15cb73ec8526fd928fc47212c6f62528680');
        let mountSection: ts.Node | undefined = mounts[0];
        while (mountSection && !ts.isJsxElement(mountSection)) {
            mountSection = mountSection.parent;
        }
        expect.soft(
            mountSection ? task9aAstFingerprint([mountSection]) : '',
            'unchanged Fleet mount section',
        ).toBe('2f31f7b75b335708b31ef66b3756380a6f96e3e8244b970004af065d62e76f92');
        expect.soft(task9aAstFingerprint([app]), 'unchanged App function')
            .toBe('9359ca185437ff49b62e1f643f86119ef5a8419a9fe887e4f183e3d82ef96f33');
        expect.soft(
            task9aImportEdges(appAst).filter((edge) =>
                edge.startsWith('./legacy/runner/fleet/'),
            ),
            'App imports only the direct Fleet Panel owner',
        ).toEqual([
            './legacy/runner/fleet/RunnerFleetPanel.tsx|value:RunnerFleetPanel',
        ]);
        expect.soft(appSource, 'App has no Fleet hook/controller internals')
            .not.toMatch(
                /\b(?:useRunnerFleetController|readFleetFiltersFromUrl|readFleetWorldMapLayersFromUrl|refreshFleet|updateMapLayer|selectMapRegion|copyShareLink|exportSelectedReport)\b/,
            );
        const appEdges = task9aImportEdges(appAst);
        for (const movedViewDependency of [
            './fleet-world-map.tsx|',
            './legacy/runner/agents/ControlAgentBoardPanel.tsx|',
            './legacy/runner/shared/performance-format.ts|',
            './legacy/runner/shared/run-id-presentation.ts|',
        ]) {
            expect.soft(
                appEdges.some((edge) => edge.startsWith(movedViewDependency)),
                `App no stale direct ${movedViewDependency}`,
            ).toBe(false);
        }

        const dependencies = new Map<string, readonly string[]>();
        const discover = (path: string): void => {
            if (dependencies.has(path)) return;
            const source = existsSync(resolve(repositoryRoot, path)) ? repositorySource(path) : '';
            const direct = task9aImportEdges(task9aSourceFile(path, source))
                .map((edge) => edge.slice(0, edge.indexOf('|')))
                .filter((moduleImport) => moduleImport.startsWith('.'))
                .map((moduleImport) => relative(repositoryRoot, resolve(resolve(repositoryRoot, path), '..', moduleImport)))
                .filter((dependency) => ['.ts', '.tsx'].includes(extname(dependency)) && existsSync(resolve(repositoryRoot, dependency)));
            dependencies.set(path, direct);
            for (const dependency of direct) discover(dependency);
        };
        for (const owner of owners) discover(owner.path);
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) { cycles.push(path); return; }
            if (visited.has(path)) return;
            active.add(path);
            for (const dependency of dependencies.get(path) ?? []) visit(dependency);
            active.delete(path);
            visited.add(path);
        };
        for (const owner of owners) visit(owner.path);
        expect(cycles, 'Fleet recursive owner import cycles').toEqual([]);
    });

    it('extracts diagnostic evidence owners without changing mounted lifetimes', () => {
        const appSource = repositorySource(appSourcePath);
        const appAst = task9aSourceFile(appSourcePath, appSource);
        const diagnosticsRoot = 'apps/rallar-black-box/src/legacy/diagnostics';
        const owners = [
            [`${diagnosticsRoot}/shared/action-feedback.ts`, 90, [
                'type:CommandCenterActionFeedback', 'value:completedActionFeedback',
                'value:idleActionFeedback', 'value:runningActionFeedback',
            ]],
            [`${diagnosticsRoot}/shared/CommandCenterActionFeedbackPanel.tsx`, 120,
                ['value:CommandCenterActionFeedbackPanel']],
            ['apps/rallar-black-box/src/legacy/shared/finite-number.ts', 30,
                ['value:optionalNumber']],
            ['apps/rallar-black-box/src/legacy/shared/use-now.ts', 35,
                ['value:useNow']],
            [`${diagnosticsRoot}/events/event-presentation.ts`, 160, [
                'value:eventFailureText', 'value:eventPayloadDetails',
                'value:eventPayloadText', 'value:isRallarBrowserEvent',
                'value:isRallarTraceEvent', 'value:rallarTraceSource',
                'value:traceMetaText', 'value:traceTimingText',
            ]],
            [`${diagnosticsRoot}/events/event-filters.ts`, 160, [
                'type:EventFilter', 'type:EventFilters',
                'value:DEFAULT_EVENT_FILTERS', 'value:EVENT_KIND_FILTERS',
                'value:eventFilterFromValue', 'value:eventGroupValue',
                'value:eventMatchesFilters', 'value:eventPeerValue',
                'value:eventSelectorValue',
            ]],
            [`${diagnosticsRoot}/events/ExecutionFocusPanel.tsx`, 130,
                ['value:ExecutionFocusPanel']],
            [`${diagnosticsRoot}/events/EventStreamPanel.tsx`, 230,
                ['value:EventStreamPanel']],
            [`${diagnosticsRoot}/events/RallarTracePanel.tsx`, 230,
                ['value:RallarTracePanel']],
            [`${diagnosticsRoot}/events/StatsPanel.tsx`, 100,
                ['value:StatsPanel']],
            ['apps/rallar-black-box/src/legacy/shell/rallar-browser-status.ts', 260, [
                'type:RallarBrowserStatusSummary', 'value:deriveRallarBrowserStatus',
            ]],
            ['apps/rallar-black-box/src/legacy/shell/RallarBrowserTraceBar.tsx', 190,
                ['value:RallarBrowserTraceBar']],
        ] as const;
        const sources = new Map<string, string>();

        for (const [path, cap, expectedExports] of owners) {
            const present = existsSync(resolve(repositoryRoot, path));
            expect.soft(present, `${path}: owner exists`).toBe(true);
            if (!present) continue;
            const source = repositorySource(path);
            sources.set(path, source);
            expect.soft(source.split('\n').length, `${path}: line cap`)
                .toBeLessThanOrEqual(cap);
            const sourceFile = task9aSourceFile(path, source);
            expect.soft(task9aExportSeams(sourceFile), `${path}: exact exports`)
                .toEqual(expectedExports);
            expect.soft(source, `${path}: no reverse/App/CSS/barrel edge`)
                .not.toMatch(/(?:App\.tsx['"]|\.css['"]|\/index\.(?:ts|tsx)['"]|\/mod\.(?:ts|tsx)['"])/);
        }

        const expectedOwnerImports = new Map<string, readonly string[]>([
            [`${diagnosticsRoot}/shared/action-feedback.ts`, []],
            [`${diagnosticsRoot}/shared/CommandCenterActionFeedbackPanel.tsx`, [
                '../../shared/redaction-presentation.ts|value:uiRedactionOptions',
                '../../shared/time-format.ts|value:formatDuration,value:formatTime',
                './action-feedback.ts|type:CommandCenterActionFeedback',
                '@shared-test/rallar-bb-test/redaction.ts|value:redactRallarBlackBoxValue',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
                '@shared/api/api-config.ts|type:AuthSession',
            ]],
            ['apps/rallar-black-box/src/legacy/shared/finite-number.ts', []],
            ['apps/rallar-black-box/src/legacy/shared/use-now.ts', [
                'react|value:useEffect,value:useState',
            ]],
            [`${diagnosticsRoot}/events/event-presentation.ts`, [
                '../../shared/record-value.ts|value:recordValue->optionalRecord',
                '../../shared/string-value.ts|value:stringValue',
                '../../shared/time-format.ts|value:formatDuration,value:formatRelativeDuration,value:formatTime',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestEvent',
            ]],
            [`${diagnosticsRoot}/events/event-filters.ts`, [
                '../../shared/record-value.ts|value:recordValue->optionalRecord',
                '../../shared/string-value.ts|value:stringValue',
                './event-presentation.ts|value:eventPayloadDetails',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestEvent,type:RallarBlackBoxTestEventKind',
            ]],
            [`${diagnosticsRoot}/events/ExecutionFocusPanel.tsx`, [
                '../../shared/command-presentation.ts|value:statusTone',
                '../../shared/json-presentation.ts|value:json',
                '../../shared/time-format.ts|value:formatDuration,value:formatTime',
                '@shared-test/rallar-bb-test/redaction.ts|value:redactRallarBlackBoxValue',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestCommand,type:RallarBlackBoxTestRedactionOptions,type:RallarBlackBoxTestResult',
            ]],
            [`${diagnosticsRoot}/events/EventStreamPanel.tsx`, [
                '../../../ui-persistence.ts|value:readEventFilters,value:writeEventFilters',
                '../../shared/FilterSelect.tsx|value:FilterSelect',
                '../../shared/time-format.ts|value:formatTime',
                '../../shared/unique-values.ts|value:uniqueValues',
                '../../shell/browser-ui-storage.ts|value:browserUiStorage',
                './event-filters.ts|type:EventFilters,value:DEFAULT_EVENT_FILTERS,value:EVENT_KIND_FILTERS,value:eventFilterFromValue,value:eventGroupValue,value:eventMatchesFilters,value:eventPeerValue,value:eventSelectorValue',
                '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxEvents',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestSeverity,type:RallarBlackBoxTestState,type:RallarBlackBoxTestTransport',
                'react|value:useEffect,value:useMemo,value:useState',
            ]],
            [`${diagnosticsRoot}/events/RallarTracePanel.tsx`, [
                '../../shared/Metric.tsx|value:Metric',
                '../../shared/redaction-presentation.ts|value:redactedJson',
                '../../shared/time-format.ts|value:formatTime',
                '../../shared/use-now.ts|value:useNow',
                './event-presentation.ts|value:eventFailureText,value:eventPayloadText,value:isRallarTraceEvent,value:rallarTraceSource,value:traceTimingText',
                '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxEvents',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestSeverity,type:RallarBlackBoxTestState',
                '@shared/api/api-config.ts|type:AuthSession',
                'react|value:useMemo,value:useState',
            ]],
            [`${diagnosticsRoot}/events/StatsPanel.tsx`, [
                '../../shared/Metric.tsx|value:Metric',
                '../../shared/time-format.ts|value:formatDuration,value:formatTime',
                '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxFailures,value:selectRallarBlackBoxLatestStats',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
            ]],
            ['apps/rallar-black-box/src/legacy/shell/rallar-browser-status.ts', [
                '../diagnostics/events/event-presentation.ts|value:eventPayloadDetails,value:isRallarBrowserEvent',
                '../shared/finite-number.ts|value:optionalNumber',
                '../shared/record-value.ts|value:recordValue->optionalRecord',
                '../shared/string-value.ts|value:stringValue',
                './global-context-model.ts|type:CommandCenterGlobalValues',
                '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxEvents',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
            ]],
            ['apps/rallar-black-box/src/legacy/shell/RallarBrowserTraceBar.tsx', [
                '../../app-tabs.ts|type:AppModeId',
                '../diagnostics/events/event-presentation.ts|value:eventPayloadText,value:isRallarBrowserEvent,value:traceMetaText,value:traceTimingText',
                '../shared/time-format.ts|value:formatTime',
                '../shared/use-now.ts|value:useNow',
                './rallar-browser-status.ts|type:RallarBrowserStatusSummary',
                '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxEvents',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
                'react|value:useEffect,value:useMemo,value:useRef,value:useState',
            ]],
        ]);
        for (const [path] of owners) {
            expect.soft(
                task9aImportEdges(
                    task9aSourceFile(path, sources.get(path) ?? ''),
                ),
                `${path}: exact import kinds and edges`,
            ).toEqual(expectedOwnerImports.get(path));
        }

        const appLocalDeclarations = new Set(
            appAst.statements.flatMap((statement): readonly string[] => {
                if (
                    (ts.isTypeAliasDeclaration(statement) ||
                        ts.isInterfaceDeclaration(statement) ||
                        ts.isFunctionDeclaration(statement)) &&
                    statement.name
                ) {
                    return [statement.name.text];
                }
                if (ts.isVariableStatement(statement)) {
                    return statement.declarationList.declarations.flatMap(
                        (declaration) =>
                            ts.isIdentifier(declaration.name)
                                ? [declaration.name.text]
                                : [],
                    );
                }
                return [];
            }),
        );
        for (const declaration of [
            'EventFilter', 'EventFilters', 'RallarBrowserStatusSummary',
            'CommandCenterActionFeedback', 'DEFAULT_EVENT_FILTERS',
            'EVENT_KIND_FILTERS', 'eventFilterFromValue', 'idleActionFeedback',
            'runningActionFeedback', 'completedActionFeedback',
            'activeDeadlineEpochMs', 'eventMatchesFilters', 'firstStringValue',
            'eventGroupValue', 'eventPeerValue', 'eventSelectorValue',
            'optionalRecord', 'recordArray', 'optionalNumber',
            'isRallarBrowserEvent',
            'isRallarTraceEvent', 'rallarTraceSource', 'eventPayloadDetails',
            'eventPayloadText', 'eventFailureText', 'traceTimingText',
            'traceMetaText', 'looksLikeWsStatus', 'looksLikeRtcStatus',
            'wsStatusFromDetails', 'rtcStatusFromDetails', 'arrayCount',
            'deriveWsStatusLabel', 'deriveRtcStatusLabel',
            'deriveRallarBrowserStatus', 'useNow', 'RallarBrowserTraceBar',
            'ExecutionFocusPanel', 'EventStreamPanel', 'RallarTracePanel',
            'StatsPanel', 'CommandCenterActionFeedbackPanel',
        ] as const) {
            expect.soft(
                appLocalDeclarations.has(declaration),
                `App local ${declaration}`,
            ).toBe(false);
        }
        expect.soft(appSource, 'later Groups/Server helper remains local')
            .toMatch(/^function\s+findStringDeep\b/m);
        expect.soft(task9aImportEdges(appAst)).toContain(
            './legacy/shared/record-value.ts|value:recordArray,value:recordValue->optionalRecord',
        );

        const ownerAst = (path: string): ts.SourceFile =>
            task9aSourceFile(path, sources.get(path) ?? appSource);
        const parameterAndBodyNodes = (
            sourceFile: ts.SourceFile,
            names: readonly string[],
        ): readonly ts.Node[] => names.flatMap((name) => {
            const declaration = task9aNamedFunction(sourceFile, name);
            return [...declaration.parameters, declaration.body!];
        });
        const typeNodes = (
            sourceFile: ts.SourceFile,
            name: string,
        ): readonly ts.Node[] => {
            const declaration = sourceFile.statements.find(
                (statement): statement is ts.TypeAliasDeclaration =>
                    ts.isTypeAliasDeclaration(statement) &&
                    statement.name.text === name,
            );
            return declaration ? [declaration.name, declaration.type] : [];
        };
        const variableNodes = (
            sourceFile: ts.SourceFile,
            name: string,
        ): readonly ts.Node[] => {
            const declaration = sourceFile.statements
                .filter(ts.isVariableStatement)
                .flatMap((statement) => [
                    ...statement.declarationList.declarations,
                ])
                .find((candidate) =>
                    ts.isIdentifier(candidate.name) &&
                    candidate.name.text === name,
                );
            return declaration?.initializer
                ? [declaration.name, declaration.initializer]
                : [];
        };
        const actionAst = ownerAst(
            `${diagnosticsRoot}/shared/action-feedback.ts`,
        );
        expect.soft(
            task9aAstFingerprint([
                ...typeNodes(actionAst, 'CommandCenterActionFeedback'),
                ...parameterAndBodyNodes(actionAst, [
                    'idleActionFeedback',
                    'runningActionFeedback',
                    'completedActionFeedback',
                ]),
            ]),
            'exact action-feedback model and builders',
        ).toBe('7915a57801a10de11d4737360b2e1c482f7ad3645488bf22f31ea465be4b233a');
        const eventPresentationAst = ownerAst(
            `${diagnosticsRoot}/events/event-presentation.ts`,
        );
        expect.soft(
            task9aAstFingerprint(parameterAndBodyNodes(
                eventPresentationAst,
                [
                    'isRallarBrowserEvent', 'isRallarTraceEvent',
                    'rallarTraceSource', 'eventPayloadDetails',
                    'eventPayloadText', 'eventFailureText',
                    'traceTimingText', 'traceMetaText',
                ],
            )),
            'exact event presentation helpers',
        ).toBe('c5b4ddc5b1d3951107df3bbb358d1030caabacbaa204054083669e0ed05c328b');
        const eventFiltersAst = ownerAst(
            `${diagnosticsRoot}/events/event-filters.ts`,
        );
        expect.soft(
            task9aAstFingerprint([
                ...typeNodes(eventFiltersAst, 'EventFilter'),
                ...typeNodes(eventFiltersAst, 'EventFilters'),
                ...variableNodes(eventFiltersAst, 'DEFAULT_EVENT_FILTERS'),
                ...variableNodes(eventFiltersAst, 'EVENT_KIND_FILTERS'),
                ...parameterAndBodyNodes(eventFiltersAst, [
                    'eventFilterFromValue', 'eventMatchesFilters',
                    'firstStringValue', 'eventGroupValue',
                    'eventPeerValue', 'eventSelectorValue',
                ]),
            ]),
            'exact event filter types, defaults, and helpers',
        ).toBe('72f6730a5d9172ad0d6045e10f6d435a0335f1086050ae4e377771d27c89eff8');
        const browserStatusAst = ownerAst(
            'apps/rallar-black-box/src/legacy/shell/rallar-browser-status.ts',
        );
        expect.soft(
            task9aAstFingerprint([
                ...typeNodes(browserStatusAst, 'RallarBrowserStatusSummary'),
                ...parameterAndBodyNodes(browserStatusAst, [
                    'looksLikeWsStatus', 'looksLikeRtcStatus',
                    'wsStatusFromDetails', 'rtcStatusFromDetails',
                    'arrayCount', 'deriveWsStatusLabel',
                    'deriveRtcStatusLabel', 'deriveRallarBrowserStatus',
                ]),
            ]),
            'exact browser status model and derivation',
        ).toBe('49e90c3cdc6eb37eea374252058b827ce3064c0641f866d1ee23f9e6f8b0211f');
        expect.soft(
            task9aAstFingerprint(parameterAndBodyNodes(
                ownerAst('apps/rallar-black-box/src/legacy/shared/use-now.ts'),
                ['useNow'],
            )),
            'exact useNow hook',
        ).toBe('41c6c642a785d41befe55808554b4fba6a1f1381228fe5a1b38cf2f09d7df724');
        expect.soft(
            task9aAstFingerprint(parameterAndBodyNodes(
                ownerAst(`${diagnosticsRoot}/events/ExecutionFocusPanel.tsx`),
                ['activeDeadlineEpochMs'],
            )),
            'exact private active deadline helper',
        ).toBe('53e84fb640a4b03c4e99d1268c79b8c61a732880440ff9d30b0545fbc4859bbd');
        expect.soft(
            task9aAstFingerprint(parameterAndBodyNodes(
                ownerAst('apps/rallar-black-box/src/legacy/shared/finite-number.ts'),
                ['optionalNumber'],
            )),
            'exact finite-number helper',
        ).toBe('92630c88329c78d9a80f4eef42584dce4cad56d73b77db524e7ddd7fdca083de');

        const task10AppOwnerModules = new Set([
            './legacy/diagnostics/events/event-filters.ts',
            './legacy/diagnostics/events/event-presentation.ts',
            './legacy/diagnostics/events/EventStreamPanel.tsx',
            './legacy/diagnostics/events/ExecutionFocusPanel.tsx',
            './legacy/diagnostics/events/RallarTracePanel.tsx',
            './legacy/diagnostics/events/StatsPanel.tsx',
            './legacy/diagnostics/shared/CommandCenterActionFeedbackPanel.tsx',
            './legacy/diagnostics/shared/action-feedback.ts',
            './legacy/shared/finite-number.ts',
            './legacy/shared/record-value.ts',
            './legacy/shared/use-now.ts',
            './legacy/shell/RallarBrowserTraceBar.tsx',
            './legacy/shell/rallar-browser-status.ts',
        ]);
        expect.soft(
            task9aImportEdges(appAst).filter((edge) =>
                task10AppOwnerModules.has(edge.slice(0, edge.indexOf('|'))),
            ),
            'App exact diagnostic owner imports and import kinds',
        ).toEqual([
            './legacy/diagnostics/events/EventStreamPanel.tsx|value:EventStreamPanel',
            './legacy/diagnostics/events/ExecutionFocusPanel.tsx|value:ExecutionFocusPanel',
            './legacy/diagnostics/events/RallarTracePanel.tsx|value:RallarTracePanel',
            './legacy/diagnostics/events/StatsPanel.tsx|value:StatsPanel',
            './legacy/diagnostics/shared/CommandCenterActionFeedbackPanel.tsx|value:CommandCenterActionFeedbackPanel',
            './legacy/diagnostics/shared/action-feedback.ts|type:CommandCenterActionFeedback,value:completedActionFeedback,value:idleActionFeedback,value:runningActionFeedback',
            './legacy/shared/finite-number.ts|value:optionalNumber',
            './legacy/shared/record-value.ts|value:recordArray,value:recordValue->optionalRecord',
            './legacy/shared/use-now.ts|value:useNow',
            './legacy/shell/RallarBrowserTraceBar.tsx|value:RallarBrowserTraceBar',
            './legacy/shell/rallar-browser-status.ts|type:RallarBrowserStatusSummary,value:deriveRallarBrowserStatus',
        ]);
        const components = [
            ['apps/rallar-black-box/src/legacy/shell/RallarBrowserTraceBar.tsx',
                'RallarBrowserTraceBar',
                'a6c36112bb3d0e9076280e2669c48b42961d8d783b253e1db468d95e86ea79df',
                'ff3742c918018f2b01980115551d8f883a619e3aa118334c8c6dcc4ef1d9bb68'],
            [`${diagnosticsRoot}/events/ExecutionFocusPanel.tsx`,
                'ExecutionFocusPanel',
                '27f816231e66a43c753e3d7f4e19c118d98cc099feba63174facf4607139a03f',
                '7b7570e4ca70c8eed8561444cd7390ea59c749cd0af3c04503b82a7454e2957b'],
            [`${diagnosticsRoot}/events/EventStreamPanel.tsx`,
                'EventStreamPanel',
                '68a89c8dd8ea1be9aebd4548b142d077a6a7a1c0a0991e43144d7aaf653a7bc2',
                'b05d5dbb9ae791565c294b8848bc859c40188d381e2703184c419bcff600233e'],
            [`${diagnosticsRoot}/events/RallarTracePanel.tsx`,
                'RallarTracePanel',
                '5777d2e767b8067a81885c0a959f997937e76dd78830320bafc72c484fa81b23',
                'e0349ca4c5c9e0671293efc99aa2022a51098e3d09271f4ca9eabca347687657'],
            [`${diagnosticsRoot}/events/StatsPanel.tsx`, 'StatsPanel',
                '82f080e4cc14d78f3bef5468a57cb3793c9b7ce8eab66b8333550a22674f73e7',
                'ba32c921ab7cefc2acfb75980ecf6f5f27aed3cfbc0ac4360636ff4d80746fce'],
            [`${diagnosticsRoot}/shared/CommandCenterActionFeedbackPanel.tsx`,
                'CommandCenterActionFeedbackPanel',
                '797175d3a110885df16f1f85fcccdccaff5914a6ff217bdacd7cbfc32e43eecc',
                '89affb9cc1cb6f3b8ff9e05c649cf292de3b504a9fe75b92963ad263083dad61'],
        ] as const;
        const expectedHookTopologies = new Map<string, Readonly<{
            useState: number;
            useMemo: number;
            useRef: number;
            useEffect: number;
            useCallback: number;
        }>>([
            ['RallarBrowserTraceBar', {
                useState: 1, useMemo: 2, useRef: 1,
                useEffect: 1, useCallback: 0,
            }],
            ['ExecutionFocusPanel', {
                useState: 0, useMemo: 0, useRef: 0,
                useEffect: 0, useCallback: 0,
            }],
            ['EventStreamPanel', {
                useState: 2, useMemo: 2, useRef: 0,
                useEffect: 1, useCallback: 0,
            }],
            ['RallarTracePanel', {
                useState: 3, useMemo: 4, useRef: 0,
                useEffect: 0, useCallback: 0,
            }],
            ['StatsPanel', {
                useState: 0, useMemo: 0, useRef: 0,
                useEffect: 0, useCallback: 0,
            }],
            ['CommandCenterActionFeedbackPanel', {
                useState: 0, useMemo: 0, useRef: 0,
                useEffect: 0, useCallback: 0,
            }],
        ]);
        const expectedEffectFingerprints = new Map<string, readonly string[]>([
            ['RallarBrowserTraceBar', [
                '9b3ddc1829d07085243a3094fbc6ce5724de6e490d973151f8b0b831c0b0b47d',
            ]],
            ['ExecutionFocusPanel', []],
            ['EventStreamPanel', [
                'f28f9a497b84379cbe3615166e298855f77d25fb0a6186b78ff7a262ed7270c0',
            ]],
            ['RallarTracePanel', []],
            ['StatsPanel', []],
            ['CommandCenterActionFeedbackPanel', []],
        ]);
        for (const [path, name, fullHash, returnHash] of components) {
            const declaration = task9aNamedFunction(ownerAst(path), name);
            expect.soft(
                task9aAstFingerprint([...declaration.parameters, declaration.body!]),
                `${name}: exact parameters/body`,
            ).toBe(fullHash);
            expect.soft(
                task9aJsxRuntimeFingerprint(task9aReturnExpression(declaration)),
                `${name}: exact compiled return`,
            ).toBe(returnHash);
            const hooks = {
                useState: 0,
                useMemo: 0,
                useRef: 0,
                useEffect: 0,
                useCallback: 0,
            };
            const effects: ts.CallExpression[] = [];
            const visitHooks = (node: ts.Node): void => {
                if (
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text in hooks
                ) {
                    hooks[node.expression.text as keyof typeof hooks] += 1;
                    if (node.expression.text === 'useEffect') {
                        effects.push(node);
                    }
                }
                ts.forEachChild(node, visitHooks);
            };
            visitHooks(declaration);
            expect.soft(hooks, `${name}: exact hook topology`)
                .toEqual(expectedHookTopologies.get(name));
            expect.soft(
                effects.map((effect) => task9aAstFingerprint([effect])),
                `${name}: exact effect bodies and dependencies`,
            ).toEqual(expectedEffectFingerprints.get(name));
        }

        const app = task9aNamedFunction(appAst, 'App');
        const appMountProofs = [
            ['RallarBrowserTraceBar', 1,
                '1436cb58918ea14e04510e017fbcca9af81b32a0a95417844f17a573b4d750d2',
                ['7b5407e8458b86adc0b684507c384b7d07ece13197cfd26002dbace01ae3c6d1']],
            ['ExecutionFocusPanel', 1,
                'b838bd6df53c8da849332246e5d9bc968ada161c7acb55e2e59fd8135ee4369f',
                ['765004f3fd3e22dd6137755fe0efaa067294b5e6e8e5244c3399ad6543d88d42']],
            ['EventStreamPanel', 1,
                'b2b10e7ca1da9c4795e341d7450c3d532894a2b7e7de88697f441886c1da8382',
                ['765004f3fd3e22dd6137755fe0efaa067294b5e6e8e5244c3399ad6543d88d42']],
            ['RallarTracePanel', 1,
                'fafb7d35fddc4721a34ada2fa36984d96676bb861aeff9b52aa8a03402b9cf4a',
                ['8ee2d071458b020c076dfcca453e6bf8d7df3642c317a7db30be9a5b6f029754']],
            ['StatsPanel', 2,
                '5bed2e1f0e640a5307f9d5466b7b20eed11b018a24cec995470b18dcd67c263f',
                [
                    'd5959ee02765a7ad12f8637986401f1583d692e8e15df90a8c18342e14c9eab5',
                    '765004f3fd3e22dd6137755fe0efaa067294b5e6e8e5244c3399ad6543d88d42',
                ]],
        ] as const;
        const mountAncestorFingerprints = (
            calls: readonly ts.JsxSelfClosingElement[],
        ): readonly string[] => calls.map((call) => {
            let ancestor: ts.Node | undefined = call.parent;
            while (ancestor && !ts.isJsxElement(ancestor)) {
                ancestor = ancestor.parent;
            }
            return ancestor ? task9aAstFingerprint([ancestor]) : '';
        });
        for (const [name, count, callFingerprint, ancestorFingerprints] of
            appMountProofs) {
            const calls = task9aJsxCalls(app, name);
            expect.soft(calls, `${name}: exact call count`).toHaveLength(count);
            expect.soft(
                task9aAstFingerprint(calls),
                `${name}: exact props and call AST`,
            ).toBe(callFingerprint);
            expect.soft(
                mountAncestorFingerprints(calls),
                `${name}: exact mount ancestors, hidden guards, and siblings`,
            ).toEqual(ancestorFingerprints);
        }
        const appActionFeedbackCalls = task9aJsxCalls(
            appAst,
            'CommandCenterActionFeedbackPanel',
        );
        const rtcRealtimeViewPath =
            'apps/rallar-black-box/src/legacy/diagnostics/rtc-realtime/RtcRealtimeView.tsx';
        const rtcRealtimeActionFeedbackCalls = existsSync(
            resolve(repositoryRoot, rtcRealtimeViewPath),
        )
            ? task9aJsxCalls(
                  task9aSourceFile(
                      rtcRealtimeViewPath,
                      repositorySource(rtcRealtimeViewPath),
                  ),
                  'CommandCenterActionFeedbackPanel',
              )
            : [];
        const actionFeedbackCalls = rtcRealtimeActionFeedbackCalls.length > 0
            ? [
                  appActionFeedbackCalls[0],
                  ...rtcRealtimeActionFeedbackCalls,
                  ...appActionFeedbackCalls.slice(1),
              ].filter(
                  (call): call is ts.JsxSelfClosingElement => Boolean(call),
              )
            : appActionFeedbackCalls;
        expect.soft(
            actionFeedbackCalls,
            'three direct-panel action feedback consumers',
        ).toHaveLength(3);
        expect.soft(
            task9aAstFingerprint(actionFeedbackCalls),
            'exact action-feedback props and consumer call ASTs',
        ).toBe('4c7a5fc3f8d23e91e2a04b77538b84b4080f7ba587f2fcf47d221457cec294d1');
        expect.soft(
            mountAncestorFingerprints(actionFeedbackCalls),
            'exact WebSocket, RTC/Realtimes, and Groups mount ancestors',
        ).toEqual([
            '0b5143759bc1bf4efa30c220efc519e3462ba72ddd093ffd6ba62ee7768bfaef',
            '9d6b554990b3f94fd3e5e5fa38d6cb1c5499830004b8ce38cbbba39f6d3776d9',
            '6849ea38c42aca8f34a1b6b463688dfd9fde9302c9b63c83f1d0d232f9cf8a79',
        ]);
        expect.soft(
            task9aAstFingerprint([app]),
            'exact unchanged App bootstrap/controller/routing body',
        ).toBe('9359ca185437ff49b62e1f643f86119ef5a8419a9fe887e4f183e3d82ef96f33');
        expect.soft(appSource, 'no lazy/Suspense lifetime cutover')
            .not.toMatch(/(?:lazy\s*\(|<Suspense\b)/);

        const ownerPaths = new Set(owners.map(([path]) => path));
        const graph = new Map<string, readonly string[]>();
        for (const path of ownerPaths) {
            if (!sources.has(path)) continue;
            const dependencies = task9aImportEdges(ownerAst(path))
                .map((edge) => edge.slice(0, edge.indexOf('|')))
                .filter((moduleImport) => moduleImport.startsWith('.'))
                .map((moduleImport) =>
                    relative(
                        repositoryRoot,
                        resolve(resolve(repositoryRoot, path), '..', moduleImport),
                    )
                )
                .filter((dependency) => ownerPaths.has(dependency));
            graph.set(path, dependencies);
        }
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) { cycles.push(path); return; }
            if (visited.has(path)) return;
            active.add(path);
            for (const dependency of graph.get(path) ?? []) visit(dependency);
            active.delete(path);
            visited.add(path);
        };
        for (const path of ownerPaths) visit(path);
        expect(cycles, 'diagnostic evidence owner import cycles').toEqual([]);
    });

    it('extracts exact RTC and Topology diagnostics without changing hidden-tab lifetimes', () => {
        const appSource = repositorySource(appSourcePath);
        const appAst = task9aSourceFile(appSourcePath, appSource);
        const rtcRoot = 'apps/rallar-black-box/src/legacy/diagnostics/rtc';
        const topologyRoot =
            'apps/rallar-black-box/src/legacy/diagnostics/topology';
        const presentationPath = `${rtcRoot}/rtc-diagnostics-presentation.ts`;
        const controllerPath = `${rtcRoot}/use-rtc-diagnostics-controller.ts`;
        const rtcPanelPath = `${rtcRoot}/RtcDiagnosticsPanel.tsx`;
        const topologyPanelPath = `${topologyRoot}/TopologyGraphPanel.tsx`;
        const owners = [
            [presentationPath, 40, [
                'value:formatList', 'value:stageTone',
            ]],
            [controllerPath, 240, [
                'type:RtcDiagnosticsControllerModel',
                'type:UseRtcDiagnosticsControllerInput',
                'value:useRtcDiagnosticsController',
            ]],
            [rtcPanelPath, 240, ['value:RtcDiagnosticsPanel']],
            [topologyPanelPath, 330, ['value:TopologyGraphPanel']],
        ] as const;
        const sources = new Map<string, string>();
        for (const [path, cap, expectedExports] of owners) {
            const present = existsSync(resolve(repositoryRoot, path));
            expect.soft(present, `${path}: owner exists`).toBe(true);
            if (!present) continue;
            const source = repositorySource(path);
            sources.set(path, source);
            expect.soft(source.split('\n').length, `${path}: line cap`)
                .toBeLessThanOrEqual(cap);
            const sourceFile = task9aSourceFile(path, source);
            expect.soft(task9aExportSeams(sourceFile), `${path}: exact exports`)
                .toEqual(expectedExports);
            expect.soft(source, `${path}: no reverse/App/CSS/barrel edge`)
                .not.toMatch(/(?:App\.tsx['"]|\.css['"]|\/index\.(?:ts|tsx)['"]|\/mod\.(?:ts|tsx)['"])/);
        }

        const expectedImports = new Map<string, readonly string[]>([
            [presentationPath, [
                '../../../rtc-diagnostics.ts|type:RtcConnectStageStatus',
            ]],
            [controllerPath, [
                '../../../client-defaults.ts|value:RALLAR_BLACK_BOX_CLIENT_DEFAULTS',
                '../../../direct-rallar-operations.ts|value:configureDirectRallarFacade,value:createDirectRallarRuntimeEvent,value:runDirectRallarStatusCheck',
                '../../../manual-workbench.ts|type:ManualWorkbenchAction,value:DEFAULT_MANUAL_WORKBENCH_VALUES',
                '../../../rtc-diagnostics.ts|value:deriveRtcDiagnostics,value:deriveRtcPerformanceView',
                '../../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig,value:rallarBlackBoxRuntimeStore',
                '../../rallar/load-browser-rallar-facade.ts|value:loadBrowserRallarFacade',
                '../../shared/redaction-presentation.ts|value:redactedJson',
                '../../shell/global-context-model.ts|type:CommandCenterGlobalValues',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestRuntimeEventInput,type:RallarBlackBoxTestState',
                '@shared/api/api-config.ts|type:AuthSession',
                'react|value:useMemo,value:useState',
            ]],
            [rtcPanelPath, [
                '../../runner/evidence/rtc/RtcDiagnosticsTimeseriesPanel.tsx|value:RtcDiagnosticsTimeseriesPanel',
                '../../runner/evidence/rtc/RtcPerformancePanel.tsx|value:RtcPerformancePanel',
                '../../shared/Metric.tsx|value:Metric',
                '../../shared/redaction-presentation.ts|value:uiRedactionOptions',
                '../../shared/time-format.ts|value:formatDuration',
                './rtc-diagnostics-presentation.ts|value:formatList,value:stageTone',
                './use-rtc-diagnostics-controller.ts|type:UseRtcDiagnosticsControllerInput,value:useRtcDiagnosticsController',
                '@shared-test/rallar-bb-test/redaction.ts|value:redactRallarBlackBoxValue',
            ]],
            [topologyPanelPath, [
                '../../../topology-graph.ts|type:RallarTopologyFilter,value:deriveRallarTopologyGraph,value:visibleTopologyCounts',
                '../../shared/Metric.tsx|value:Metric',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
                'react|value:useEffect,value:useMemo,value:useRef,value:useState',
                'sigma|value:default->Sigma',
            ]],
        ]);
        for (const [path] of owners) {
            expect.soft(
                task9aImportEdges(
                    task9aSourceFile(path, sources.get(path) ?? ''),
                ),
                `${path}: exact import kinds and edges`,
            ).toEqual(expectedImports.get(path));
        }

        const ownerSource = (path: string): string =>
            sources.get(path) ?? appSource;
        const ownerAst = (path: string): ts.SourceFile =>
            task9aSourceFile(
                sources.has(path) ? path : appSourcePath,
                ownerSource(path),
            );
        const functionNodes = (
            sourceFile: ts.SourceFile,
            names: readonly string[],
        ): readonly ts.Node[] => names.flatMap((name) => {
            const declaration = task9aNamedFunction(sourceFile, name);
            return [...declaration.parameters, declaration.body!];
        });

        const presentationAst = ownerAst(presentationPath);
        expect.soft(
            task9aAstFingerprint(functionNodes(
                presentationAst,
                ['stageTone', 'formatList'],
            )),
            'exact RTC presentation helpers',
        ).toBe('65948146090cde45b8308553a11c89a4a9ab452bdc95f95c9aeaf1919c7a2842');

        const controllerPresent = sources.has(controllerPath);
        const controllerAst = ownerAst(controllerPath);
        const controller = task9aNamedFunction(
            controllerAst,
            controllerPresent
                ? 'useRtcDiagnosticsController'
                : 'RtcDiagnosticsPanel',
        );
        if (!controllerPresent) {
            expect.soft(
                task9aAstFingerprint([
                    ...controller.parameters,
                    controller.body!,
                ]),
                'exact legacy RTC source before extraction',
            ).toBe('45c0ae99b021780a1594455fdd40c91a3e025975fa11b6219f2dd4f8ed02f3cd');
        }
        const controllerStatements = controller.body?.statements ?? [];
        const returnIndex = controllerStatements.findIndex(ts.isReturnStatement);
        const preReturn = returnIndex >= 0
            ? controllerStatements.slice(0, returnIndex)
            : [];
        expect.soft(preReturn, 'exact RTC controller statement count')
            .toHaveLength(12);
        expect.soft(
            task9aAstFingerprint(preReturn),
            'exact RTC controller sequence',
        ).toBe('c9037ffe1969e6ecc54d1b40aba27b4cb74e5bdd671e209459f67b1e28b27bf2');
        const hookCounts = {
            useState: 0,
            useMemo: 0,
            useEffect: 0,
            useRef: 0,
            useCallback: 0,
        };
        const visitControllerHooks = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text in hookCounts
            ) {
                hookCounts[node.expression.text as keyof typeof hookCounts] += 1;
            }
            ts.forEachChild(node, visitControllerHooks);
        };
        visitControllerHooks(controller);
        expect.soft(hookCounts, 'exact RTC controller hook topology').toEqual({
            useState: 3,
            useMemo: 3,
            useEffect: 0,
            useRef: 0,
            useCallback: 0,
        });
        const controllerDeclarations = new Map<string, ts.VariableStatement>();
        for (const statement of preReturn) {
            if (!ts.isVariableStatement(statement)) continue;
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) {
                    controllerDeclarations.set(declaration.name.text, statement);
                }
            }
        }
        for (const [name, expectedHash] of [
            ['directContext', '5caa8bf764230a2d96ca6d964b27a812b0ac336ff88cb7e135fdca880c14da71'],
            ['recordRtcDiagnostic', 'b037e3506a8b344c2dac3c61410697c3d614b592dd6d4e3ca8f0a45c84e0da0c'],
            ['runAction', '4f1bbee807661e6d8c4930d107dac66eaa86fea7eabeda38a07c3faff9716508'],
            ['copyBundle', '0efb7f1e163fb1861ee630cc5af2f9a895ebf822e92f894069f35c07c506af00'],
        ] as const) {
            const statement = controllerDeclarations.get(name);
            expect.soft(
                statement ? task9aAstFingerprint([statement]) : '',
                `${name}: exact RTC controller action`,
            ).toBe(expectedHash);
        }

        const inputAlias = controllerAst.statements.find(
            (statement): statement is ts.TypeAliasDeclaration =>
                ts.isTypeAliasDeclaration(statement) &&
                statement.name.text === 'UseRtcDiagnosticsControllerInput',
        );
        const expectedInputAst = task9aSourceFile(
            'expected-rtc-controller-input.ts',
            `type Expected = Readonly<{
                state: RallarBlackBoxTestState;
                bootstrap: RallarBlackBoxBootstrapConfig;
                authSession?: AuthSession;
                globalValues?: CommandCenterGlobalValues;
                busy: boolean;
                onSelectCommand(commandId: string): void;
            }>;`,
        ).statements[0] as ts.TypeAliasDeclaration;
        expect.soft(
            inputAlias ? task9aAstFingerprint([inputAlias.type]) : '',
            'exact RTC controller input contract',
        ).toBe(task9aAstFingerprint([expectedInputAst.type]));
        const modelAlias = controllerAst.statements.find(
            (statement): statement is ts.TypeAliasDeclaration =>
                ts.isTypeAliasDeclaration(statement) &&
                statement.name.text === 'RtcDiagnosticsControllerModel',
        );
        const expectedModelAst = task9aSourceFile(
            'expected-rtc-controller-model.ts',
            'type Expected = ReturnType<typeof useRtcDiagnosticsController>;',
        ).statements[0] as ts.TypeAliasDeclaration;
        expect.soft(
            modelAlias ? task9aAstFingerprint([modelAlias.type]) : '',
            'exact inferred RTC controller model alias',
        ).toBe(task9aAstFingerprint([expectedModelAst.type]));
        const controllerParameter = controller.parameters[0];
        const controllerParameterKeys = controllerParameter &&
                ts.isObjectBindingPattern(controllerParameter.name)
            ? controllerParameter.name.elements.map((element) =>
                  element.name.getText(controllerAst)
              )
            : [];
        expect.soft(controllerParameterKeys, 'exact six RTC controller inputs')
            .toEqual([
                'state', 'bootstrap', 'authSession', 'globalValues',
                'busy', 'onSelectCommand',
            ]);
        expect.soft(
            controllerParameter?.type?.getText(controllerAst) ?? '',
            'RTC hook uses the named input contract',
        ).toBe('UseRtcDiagnosticsControllerInput');
        const controllerReturn = returnIndex >= 0
            ? (controllerStatements[returnIndex] as ts.ReturnStatement).expression
            : undefined;
        const returnedKeys = controllerReturn &&
                ts.isObjectLiteralExpression(controllerReturn)
            ? controllerReturn.properties.map((property) =>
                  ts.isShorthandPropertyAssignment(property)
                      ? property.name.text
                      : property.getText(controllerAst)
              )
            : [];
        const modelKeys = [
            'diagnostics', 'rtcPerformance', 'bundleVisible',
            'setBundleVisible', 'canRunDirect', 'bundleText', 'localError',
            'runAction', 'copyBundle',
        ] as const;
        expect.soft(returnedKeys, 'exact RTC controller return order')
            .toEqual(modelKeys);
        expect.soft(
            controllerStatements.filter(ts.isReturnStatement),
            'one final RTC controller return',
        ).toHaveLength(1);
        let controllerHasJsx = false;
        const visitControllerJsx = (node: ts.Node): void => {
            if (
                ts.isJsxElement(node) ||
                ts.isJsxSelfClosingElement(node) ||
                ts.isJsxFragment(node)
            ) controllerHasJsx = true;
            ts.forEachChild(node, visitControllerJsx);
        };
        visitControllerJsx(controller);
        expect.soft(controllerHasJsx, 'RTC controller has no JSX').toBe(false);

        const rtcPanelAst = ownerAst(rtcPanelPath);
        const rtcPanel = task9aNamedFunction(rtcPanelAst, 'RtcDiagnosticsPanel');
        expect.soft(
            task9aJsxRuntimeFingerprint(task9aReturnExpression(rtcPanel)),
            'exact RTC Panel compiled JSX',
        ).toBe('acbf8e8af6a85cf023b6af06da6095c8f44e67327d5cf32677a2a444ea8ef7b5');
        const panelControllerCalls: ts.CallExpression[] = [];
        const visitPanelController = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === 'useRtcDiagnosticsController'
            ) panelControllerCalls.push(node);
            ts.forEachChild(node, visitPanelController);
        };
        visitPanelController(rtcPanel);
        expect.soft(panelControllerCalls, 'Panel calls RTC controller once')
            .toHaveLength(1);
        const expectedHookCallAst = task9aSourceFile(
            'expected-rtc-hook-call.ts',
            `useRtcDiagnosticsController({
                state, bootstrap, authSession, globalValues, busy,
                onSelectCommand,
            });`,
        );
        const expectedHookCall = (
            expectedHookCallAst.statements[0] as ts.ExpressionStatement
        ).expression as ts.CallExpression;
        expect.soft(
            task9aAstFingerprint(panelControllerCalls),
            'exact RTC controller call props',
        ).toBe(task9aAstFingerprint([expectedHookCall]));
        const panelStatements = rtcPanel.body?.statements ?? [];
        const panelReturnIndex = panelStatements.findIndex(ts.isReturnStatement);
        const panelPreReturn = panelReturnIndex >= 0
            ? panelStatements.slice(0, panelReturnIndex)
            : [];
        expect.soft(panelPreReturn, 'Panel has one controller destructure')
            .toHaveLength(1);
        const panelBinding = panelPreReturn
            .filter(ts.isVariableStatement)
            .flatMap((statement) => [...statement.declarationList.declarations])
            .find((declaration) => ts.isObjectBindingPattern(declaration.name));
        const panelBindingKeys = panelBinding &&
                ts.isObjectBindingPattern(panelBinding.name)
            ? panelBinding.name.elements.map((element) =>
                  element.name.getText(rtcPanelAst)
              )
            : [];
        expect.soft(panelBindingKeys, 'Panel exact model destructure order')
            .toEqual(modelKeys);
        expect.soft(
            rtcPanel.parameters[0]?.type?.getText(rtcPanelAst) ?? '',
            'RTC Panel consumes named input contract',
        ).toBe('UseRtcDiagnosticsControllerInput');
        expect.soft(
            ownerSource(rtcPanelPath),
            'RTC view has no controller state/action/derivation internals',
        ).not.toMatch(
            /\b(?:useState|useMemo|useEffect|useRef|useCallback|deriveRtcDiagnostics|deriveRtcPerformanceView|loadBrowserRallarFacade|configureDirectRallarFacade|createDirectRallarRuntimeEvent|rallarBlackBoxRuntimeStore|sequence|setSequence|directContext|recordRtcDiagnostic)\b/,
        );

        const topologyAst = ownerAst(topologyPanelPath);
        const topologyPanel = task9aNamedFunction(
            topologyAst,
            'TopologyGraphPanel',
        );
        expect.soft(
            task9aAstFingerprint([
                ...topologyPanel.parameters,
                topologyPanel.body!,
            ]),
            'exact full Topology panel',
        ).toBe('da487933c566806da4f62ff577afa2d014d1f64cb630e1d86aba003b7491a9e3');
        expect.soft(
            task9aJsxRuntimeFingerprint(task9aReturnExpression(topologyPanel)),
            'exact Topology compiled JSX',
        ).toBe('03e1d0789ad2d1f7bb878609542c35aa5d1351f0b2f8d02cf297227bbaf7ab8a');
        expect.soft(
            task9aAstFingerprint(functionNodes(
                topologyAst,
                ['topologyFilterLabel'],
            )),
            'exact private topology filter label',
        ).toBe('af343377ef1b2d87f29bfcbd0cc47fc3502bfbd74b1c9b60c941bd8d8d2642db');
        const topologyHooks = {
            useState: 0,
            useMemo: 0,
            useRef: 0,
            useEffect: 0,
            useCallback: 0,
        };
        const topologyEffects: ts.CallExpression[] = [];
        const visitTopologyHooks = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text in topologyHooks
            ) {
                topologyHooks[node.expression.text as keyof typeof topologyHooks] += 1;
                if (node.expression.text === 'useEffect') {
                    topologyEffects.push(node);
                }
            }
            ts.forEachChild(node, visitTopologyHooks);
        };
        visitTopologyHooks(topologyPanel);
        expect.soft(topologyHooks, 'exact Topology hook topology').toEqual({
            useState: 3,
            useMemo: 6,
            useRef: 1,
            useEffect: 1,
            useCallback: 0,
        });
        expect.soft(
            topologyEffects.map((effect) => task9aAstFingerprint([effect])),
            'exact Topology renderer effect and dependencies',
        ).toEqual([
            '2c1ae2c48a1890569c9636742ae5e90f986020d13dbe5e2b524b13cb34ae86cc',
        ]);
        expect.soft(
            topologyEffects[0]?.getText(topologyAst) ?? '',
            'Topology renderer cleanup kills Sigma',
        ).toContain('return () => renderer.kill();');

        const appLocalDeclarations = new Set(
            appAst.statements.flatMap((statement): readonly string[] => {
                if (
                    (ts.isTypeAliasDeclaration(statement) ||
                        ts.isInterfaceDeclaration(statement) ||
                        ts.isFunctionDeclaration(statement)) &&
                    statement.name
                ) return [statement.name.text];
                if (ts.isVariableStatement(statement)) {
                    return statement.declarationList.declarations.flatMap(
                        (declaration) => ts.isIdentifier(declaration.name)
                            ? [declaration.name.text]
                            : [],
                    );
                }
                return [];
            }),
        );
        for (const declaration of [
            'stageTone', 'formatList', 'topologyFilterLabel',
            'RtcDiagnosticsPanel', 'TopologyGraphPanel',
        ] as const) {
            expect.soft(
                appLocalDeclarations.has(declaration),
                `App local ${declaration}`,
            ).toBe(false);
        }
        expect.soft(appSource, 'App has no RTC/Topology controller internals')
            .not.toMatch(
                /\b(?:useRtcDiagnosticsController|deriveRtcPerformanceView|deriveRallarTopologyGraph|visibleTopologyCounts|containerRef|recordRtcDiagnostic|copyBundle)\b/,
            );
        const task10A2Modules = new Set([
            './legacy/diagnostics/rtc/rtc-diagnostics-presentation.ts',
            './legacy/diagnostics/rtc/use-rtc-diagnostics-controller.ts',
            './legacy/diagnostics/rtc/RtcDiagnosticsPanel.tsx',
            './legacy/diagnostics/topology/TopologyGraphPanel.tsx',
        ]);
        expect.soft(
            task9aImportEdges(appAst).filter((edge) =>
                task10A2Modules.has(edge.slice(0, edge.indexOf('|'))),
            ),
            'App imports only the two RTC/Topology root panels',
        ).toEqual([
            './legacy/diagnostics/rtc/RtcDiagnosticsPanel.tsx|value:RtcDiagnosticsPanel',
            './legacy/diagnostics/topology/TopologyGraphPanel.tsx|value:TopologyGraphPanel',
        ]);
        for (const staleModule of [
            'sigma', './topology-graph.ts',
            './legacy/runner/evidence/rtc/RtcDiagnosticsTimeseriesPanel.tsx',
            './legacy/runner/evidence/rtc/RtcPerformancePanel.tsx',
        ] as const) {
            expect.soft(
                task9aImportEdges(appAst).some((edge) =>
                    edge.startsWith(`${staleModule}|`)
                ),
                `App no stale ${staleModule} import`,
            ).toBe(false);
        }
        expect.soft(
            task9aImportEdges(appAst).filter((edge) =>
                edge.startsWith('./rtc-diagnostics.ts|')
            ),
            'App retains only the still-shared RTC derivation edge',
        ).toEqual([
            './rtc-diagnostics.ts|value:deriveRtcDiagnostics',
        ]);

        const app = task9aNamedFunction(appAst, 'App');
        const mountAncestorFingerprints = (
            calls: readonly ts.JsxSelfClosingElement[],
        ): readonly string[] => calls.map((call) => {
            let ancestor: ts.Node | undefined = call.parent;
            while (ancestor && !ts.isJsxElement(ancestor)) {
                ancestor = ancestor.parent;
            }
            return ancestor ? task9aAstFingerprint([ancestor]) : '';
        });
        for (const [name, expectedCallHash, expectedAncestorHash] of [
            [
                'RtcDiagnosticsPanel',
                '38c18708cac6760e27a6dddcf2e479b8ebedb1b0adbe4c7b76b97aa0e37e10f2',
                'd5959ee02765a7ad12f8637986401f1583d692e8e15df90a8c18342e14c9eab5',
            ],
            [
                'TopologyGraphPanel',
                'c992c603445a071f3e5e096e1f09e6ce00c3bba3ef81e8bf0b06ac1f2a07599d',
                '18267537358fa91ea149bbe8d3495a8f74b8882c49f18066a6eb3c0b5bff3b66',
            ],
        ] as const) {
            const calls = task9aJsxCalls(app, name);
            expect.soft(calls, `${name}: one exact always-mounted call`)
                .toHaveLength(1);
            expect.soft(
                task9aAstFingerprint(calls),
                `${name}: exact App call props`,
            ).toBe(expectedCallHash);
            expect.soft(
                mountAncestorFingerprints(calls),
                `${name}: exact hidden-capable mount ancestor and guard`,
            ).toEqual([expectedAncestorHash]);
        }
        expect.soft(
            task9aAstFingerprint([app]),
            'unchanged App function and lifetime policy',
        ).toBe('9359ca185437ff49b62e1f643f86119ef5a8419a9fe887e4f183e3d82ef96f33');
        expect.soft(appSource, 'no lazy/Suspense lifetime cutover')
            .not.toMatch(/(?:lazy\s*\(|<Suspense\b)/);

        const ownerPaths = new Set(owners.map(([path]) => path));
        const graph = new Map<string, readonly string[]>();
        for (const path of ownerPaths) {
            const dependencies = task9aImportEdges(
                task9aSourceFile(path, sources.get(path) ?? ''),
            )
                .map((edge) => edge.slice(0, edge.indexOf('|')))
                .filter((moduleImport) => moduleImport.startsWith('.'))
                .map((moduleImport) => relative(
                    repositoryRoot,
                    resolve(resolve(repositoryRoot, path), '..', moduleImport),
                ))
                .filter((dependency) => ownerPaths.has(dependency));
            graph.set(path, dependencies);
        }
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) { cycles.push(path); return; }
            if (visited.has(path)) return;
            active.add(path);
            for (const dependency of graph.get(path) ?? []) visit(dependency);
            active.delete(path);
            visited.add(path);
        };
        for (const path of ownerPaths) visit(path);
        expect(cycles, 'RTC/Topology owner import cycles').toEqual([]);
    });

    it('extracts the Quick Test controller behind one thin legacy root', () => {
        const appSource = repositorySource(appSourcePath);
        const appAst = task9aSourceFile(appSourcePath, appSource);
        const quickRoot = 'apps/rallar-black-box/src/legacy/diagnostics/quick-test';
        const contractsPath = `${quickRoot}/quick-rallar-contracts.ts`;
        const defaultsPath = `${quickRoot}/quick-rallar-defaults.ts`;
        const viewPath = `${quickRoot}/QuickRallarTestView.tsx`;
        const controllerPath = `${quickRoot}/use-quick-rallar-test-controller.ts`;
        const panelPath = `${quickRoot}/QuickRallarTestPanel.tsx`;
        const owners = [
            [contractsPath, 170, [
                'type:QuickRallarPayloadResult',
                'type:QuickRallarReceivedMessageRow',
                'type:QuickRallarSubscriptionState',
                'type:QuickRallarTestViewModel',
                'type:QuickRallarTransport',
                'type:QuickRallarValues',
                'type:QuickRallarWorkflowStep',
            ]],
            [defaultsPath, 45,
                ['value:QUICK_RALLAR_DEFAULT_VALUES']],
            [viewPath, 460,
                ['value:QuickRallarTestView']],
            [controllerPath, 700, [
                'type:QuickRallarTestControllerModel',
                'type:UseQuickRallarTestControllerInput',
                'value:useQuickRallarTestController',
            ]],
            [panelPath, 100, ['value:QuickRallarTestPanel']],
        ] as const;
        const sources = new Map<string, string>();
        for (const [path, cap, expectedExports] of owners) {
            const present = existsSync(resolve(repositoryRoot, path));
            expect.soft(present, `${path}: owner exists`).toBe(true);
            if (!present) continue;
            const source = repositorySource(path);
            sources.set(path, source);
            expect.soft(source.split('\n').length, `${path}: line cap`)
                .toBeLessThanOrEqual(cap);
            expect.soft(
                task9aExportSeams(task9aSourceFile(path, source)),
                `${path}: exact exports`,
            ).toEqual(expectedExports);
            expect.soft(source, `${path}: no reverse/App/CSS/barrel edge`)
                .not.toMatch(/(?:App\.tsx['"]|\.css['"]|\/index\.(?:ts|tsx)['"]|\/mod\.(?:ts|tsx)['"])/);
        }

        const expectedOwnerImports = new Map<string, readonly string[]>([
            [contractsPath, []],
            [defaultsPath, [
                '../../../client-defaults.ts|value:RALLAR_BLACK_BOX_CLIENT_DEFAULTS',
                '../../shared/json-presentation.ts|value:json',
                './quick-rallar-contracts.ts|type:QuickRallarValues',
            ]],
            [viewPath, [
                '../../shared/CollapsiblePanelSection.tsx|value:CollapsiblePanelSection',
                '../../shared/Metric.tsx|value:Metric',
                '../../shared/redaction-presentation.ts|value:redactedJson',
                '../../shared/time-format.ts|value:formatTime',
                '../../shell/global-context-model.ts|type:CommandCenterGlobalValues',
                '../../shell/rallar-browser-status.ts|type:RallarBrowserStatusSummary',
                './quick-rallar-contracts.ts|type:QuickRallarTestViewModel,type:QuickRallarTransport',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
                '@shared/api/api-config.ts|type:AuthSession',
            ]],
            [controllerPath, [
                '../../../direct-rallar-operations.ts|type:DirectRallarOperationResult,value:createDirectRallarRuntimeEvent,value:runDirectRallarGroupCreate,value:runDirectRallarGroupJoin,value:runDirectRallarStatusCheck,value:runDirectRallarWsSend,value:runDirectRallarWsSubscribe',
                '../../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig,value:rallarBlackBoxRuntimeStore',
                '../../rallar/load-browser-rallar-facade.ts|value:loadBrowserRallarFacade',
                '../../shared/finite-number.ts|value:optionalNumber',
                '../../shared/record-value.ts|value:recordValue->optionalRecord',
                '../../shared/redaction-presentation.ts|value:redactedJson',
                '../../shared/string-value.ts|value:stringValue',
                '../../shell/global-context-model.ts|type:CommandCenterGlobalValues',
                '../../shell/rallar-browser-status.ts|type:RallarBrowserStatusSummary',
                './quick-rallar-contracts.ts|type:QuickRallarReceivedMessageRow,type:QuickRallarSubscriptionState,type:QuickRallarValues',
                './quick-rallar-defaults.ts|value:QUICK_RALLAR_DEFAULT_VALUES',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
                '@shared/api/api-config.ts|type:AuthSession',
                'react|value:useEffect,value:useMemo,value:useRef,value:useState',
            ]],
            [panelPath, [
                './QuickRallarTestView.tsx|value:QuickRallarTestView',
                './use-quick-rallar-test-controller.ts|type:UseQuickRallarTestControllerInput,value:useQuickRallarTestController',
            ]],
        ]);
        for (const [path] of owners) {
            if (!sources.has(path)) continue;
            expect.soft(
                task9aImportEdges(
                    task9aSourceFile(path, sources.get(path)!),
                ),
                `${path}: exact import kinds and edges`,
            ).toEqual(expectedOwnerImports.get(path));
        }
        expect.soft(
            task9aImportEdges(appAst).filter((edge) =>
                edge.startsWith('./legacy/diagnostics/quick-test/'),
            ),
            'App exact Quick owner imports and import kinds',
        ).toEqual([
            './legacy/diagnostics/quick-test/QuickRallarTestPanel.tsx|value:QuickRallarTestPanel',
        ]);

        const namedTypeNodes = (
            sourceFile: ts.SourceFile,
            name: string,
        ): readonly ts.Node[] => {
            const declaration = sourceFile.statements.find(
                (statement): statement is ts.TypeAliasDeclaration =>
                    ts.isTypeAliasDeclaration(statement) &&
                    statement.name.text === name,
            );
            return declaration ? [declaration.name, declaration.type] : [];
        };
        const namedVariableNodes = (
            sourceFile: ts.SourceFile,
            name: string,
        ): readonly ts.Node[] => {
            const declaration = sourceFile.statements
                .filter(ts.isVariableStatement)
                .flatMap((statement) => [
                    ...statement.declarationList.declarations,
                ])
                .find((candidate) =>
                    ts.isIdentifier(candidate.name) &&
                    candidate.name.text === name,
                );
            return declaration?.initializer
                ? [declaration.name, declaration.initializer]
                : [];
        };
        if (sources.has(contractsPath)) {
            const contractsAst = task9aSourceFile(
                contractsPath,
                sources.get(contractsPath)!,
            );
            expect.soft(
                task9aAstFingerprint([
                    ...namedTypeNodes(contractsAst, 'QuickRallarTransport'),
                    ...namedTypeNodes(contractsAst, 'QuickRallarValues'),
                    ...namedTypeNodes(
                        contractsAst,
                        'QuickRallarSubscriptionState',
                    ),
                    ...namedTypeNodes(
                        contractsAst,
                        'QuickRallarReceivedMessageRow',
                    ),
                ]),
                'exact four moved Quick contracts',
            ).toBe('9313a8e66ac0346f296f9dd713ec0c87f07a0634637c12f9827b2ea838bd67f3');

            const expectedPresentationContracts = task9aSourceFile(
                'expected-quick-presentation-contracts.ts',
                `type QuickRallarPayloadResult =
                    | Readonly<{ ok: true }>
                    | Readonly<{ ok: false; error: string }>;
                type QuickRallarWorkflowStep = Readonly<{
                    id: string;
                    label: string;
                    detail: string;
                    state: 'done' | 'current' | 'blocked' | 'pending';
                }>;
                type QuickRallarTestViewModel = Readonly<{
                    values: QuickRallarValues;
                    busyAction?: string;
                    localError?: string;
                    lastResult?: Readonly<{
                        status: 'completed' | 'failed';
                    }>;
                    subscription?: Readonly<{
                        label: string;
                        groupId: string;
                        subscribedAtEpochMs: number;
                    }>;
                    receivedMessages: readonly Readonly<{
                        rowId: string;
                        atEpochMs: number;
                        senderId: string;
                        roomId: string;
                        typeId: string;
                        topicId: string;
                        contextId: string;
                        payload?: unknown;
                    }>[];
                    waitStatus: string;
                    providerMode: 'simulated' | 'browser-rallar';
                    realBackendReady: boolean;
                    canUseDirectRallar: boolean;
                    activeGroupId: string;
                    activeTypeId: string;
                    activeContextId: string;
                    selectorLabel: string;
                    payloadResult: QuickRallarPayloadResult;
                    updateValue<K extends keyof QuickRallarValues>(
                        key: K,
                        value: QuickRallarValues[K],
                    ): void;
                    updateGroupId(groupId: string): void;
                    createGroup(): Promise<void>;
                    joinGroup(): Promise<void>;
                    subscribeWs(): Promise<void>;
                    unsubscribeWs(): void;
                    sendWs(): Promise<void>;
                    waitForReceive(): Promise<void>;
                    copyDiagnostics(): void;
                    copyRunnerRecipe(): void;
                    setupComplete: boolean;
                    subscribed: boolean;
                    workflowSteps: readonly QuickRallarWorkflowStep[];
                }>;`,
            );
            for (const name of [
                'QuickRallarPayloadResult',
                'QuickRallarWorkflowStep',
                'QuickRallarTestViewModel',
            ] as const) {
                expect.soft(
                    task9aAstFingerprint(namedTypeNodes(contractsAst, name)),
                    `${name}: exact narrow presentation contract`,
                ).toBe(task9aAstFingerprint(
                    namedTypeNodes(expectedPresentationContracts, name),
                ));
            }
        }
        if (sources.has(defaultsPath)) {
            const defaultsAst = task9aSourceFile(
                defaultsPath,
                sources.get(defaultsPath)!,
            );
            expect.soft(
                task9aAstFingerprint(namedVariableNodes(
                    defaultsAst,
                    'QUICK_RALLAR_DEFAULT_VALUES',
                )),
                'exact moved Quick default initializer',
            ).toBe('cd00faf099d73bf87e9a65f4db86ab2b28abcb16ff538d9437b339c2cbfc316a');
        }
        if (sources.has(controllerPath)) {
            const controllerContractAst = task9aSourceFile(
                controllerPath,
                sources.get(controllerPath)!,
            );
            const expectedControllerContracts = task9aSourceFile(
                'expected-quick-controller-contracts.ts',
                `type UseQuickRallarTestControllerInput = Readonly<{
                    state: RallarBlackBoxTestState;
                    bootstrap: RallarBlackBoxBootstrapConfig;
                    authSession?: AuthSession;
                    globalValues: CommandCenterGlobalValues;
                    browserStatus: RallarBrowserStatusSummary;
                    onGlobalValueChange<K extends keyof CommandCenterGlobalValues>(
                        key: K,
                        value: CommandCenterGlobalValues[K],
                    ): void;
                }>;
                type QuickRallarTestControllerModel = ReturnType<
                    typeof useQuickRallarTestController
                >;`,
            );
            for (const name of [
                'UseQuickRallarTestControllerInput',
                'QuickRallarTestControllerModel',
            ] as const) {
                expect.soft(
                    task9aAstFingerprint(namedTypeNodes(
                        controllerContractAst,
                        name,
                    )),
                    `${name}: exact Quick controller contract`,
                ).toBe(task9aAstFingerprint(namedTypeNodes(
                    expectedControllerContracts,
                    name,
                )));
            }
        }

        const appLocalNames = new Set<string>();
        for (const statement of appAst.statements) {
            if (
                ts.isTypeAliasDeclaration(statement) ||
                ts.isInterfaceDeclaration(statement) ||
                ts.isFunctionDeclaration(statement)
            ) {
                if (statement.name) appLocalNames.add(statement.name.text);
            }
            if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    if (ts.isIdentifier(declaration.name)) {
                        appLocalNames.add(declaration.name.text);
                    }
                }
            }
        }
        for (const moved of [
            'QuickRallarTransport', 'QuickRallarValues',
            'QuickRallarSubscriptionState', 'QuickRallarReceivedMessageRow',
            'QuickRallarPayloadResult', 'QuickRallarWorkflowStep',
            'QuickRallarTestViewModel', 'QUICK_RALLAR_DEFAULT_VALUES',
            'QuickRallarTestView', 'UseQuickRallarTestControllerInput',
            'QuickRallarTestControllerModel',
            'useQuickRallarTestController', 'QuickRallarTestPanel',
        ]) {
            expect.soft(appLocalNames, `App no local ${moved}`).not.toContain(moved);
        }

        const controllerAst = sources.has(controllerPath)
            ? task9aSourceFile(controllerPath, sources.get(controllerPath)!)
            : appAst;
        const controller = task9aNamedFunction(
            controllerAst,
            sources.has(controllerPath)
                ? 'useQuickRallarTestController'
                : 'QuickRallarTestPanel',
        );
        const controllerStatements = controller.body!.statements;
        const controllerReturnIndex = controllerStatements.findIndex(ts.isReturnStatement);
        const preReturn = controllerReturnIndex >= 0
            ? controllerStatements.slice(0, controllerReturnIndex)
            : [];
        expect.soft(
            controllerReturnIndex,
            'Quick hook has one final top-level model return',
        ).toBe(controllerStatements.length - 1);
        expect.soft(preReturn, 'exact 42 extracted Quick controller statements')
            .toHaveLength(42);
        expect.soft(
            task9aAstFingerprint(preReturn),
            'token-complete extracted Quick controller',
        ).toBe('12ba49464b8518a89815d19cc1b8cb933c1f7bde43793d7b41a5c1b7c71c5e27');
        const hooks = {
            useState: 0, useMemo: 0, useRef: 0, useEffect: 0, useCallback: 0,
        };
        const effects: ts.CallExpression[] = [];
        const visitHooks = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
                node.expression.text in hooks
            ) {
                hooks[node.expression.text as keyof typeof hooks] += 1;
                if (node.expression.text === 'useEffect') effects.push(node);
            }
            ts.forEachChild(node, visitHooks);
        };
        visitHooks(controller);
        expect.soft(hooks, 'Quick controller exact hook topology').toEqual({
            useState: 7, useMemo: 1, useRef: 3, useEffect: 4, useCallback: 0,
        });
        expect.soft(effects, 'Quick controller exact effect count').toHaveLength(4);
        expect.soft(
            effects.map((effect) => task9aAstFingerprint([effect])),
            'exact Quick effects and dependencies',
        ).toEqual([
            '0c47a1dae1cc6553c5cf777a99f91fe90cc2a94b2ef2c403bdf00f39e8062add',
            '4401d06d15db5c19575d6a7daeb2ed5892dc35f7d413cac693406aed341b6748',
            '98c94a7f4fea59d40fe7315a4b0115acdce86ac7d108b4619307f4b72783413d',
            '1cfb59163858f189f1dd4265428f2faa9c2787b44b127bdfb6126f3dcd87a4f1',
        ]);
        const controllerDeclarations = new Map<string, ts.VariableStatement>();
        for (const statement of preReturn) {
            if (!ts.isVariableStatement(statement)) continue;
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) {
                    controllerDeclarations.set(declaration.name.text, statement);
                }
            }
        }
        for (const [name, expectedHash] of [
            ['operationContext', '9640c7143ee55d0183b9c615b33e5552da95a1709dd7f3a79829f4066870b352'],
            ['updateValue', '7ddeb4b4217bc28eec53a0acae7536169b16fc0a3428785f8193701a67804e37'],
            ['updateGroupId', 'a676052490f7310096209c2305c3b2e893cb5d37c0734f7f46ef8a8ac4514a0e'],
            ['recordDirectResult', '97f7edd9dff55d82f8ed4045c90ed48563af9a15c6ede5b056ecb6ef4d648a9f'],
            ['runOperation', 'ecc165f493fe6a8d2f6c418c26ab15533bf763f38ea8a0ad7ca7a735b8471903'],
            ['createGroup', '6a9e3d9b3876bf6cb6c3989107fc4b27ede85c83fd60d832304824fa6f991dca'],
            ['joinGroup', 'f391aba7f58ce0ce2ec2f71fa551a1d7a70cd33cee12c4ed694e86081657a741'],
            ['messageRowFromRallarMessage', '5a1017666ce6ec9ab889d9550e6f52fdc01ca94989cc9583b65e410edbbd829c'],
            ['subscribeWs', 'e112e0a3efb7c426cf6ef199ad1a72e77c06a0f0698b33bd67723c69f0e36826'],
            ['unsubscribeWs', 'e817df27bbfe22b6dc29a54ede2b45586c2d68b6dbbd1d694af6d9c0b189c431'],
            ['sendWs', 'ac005af4237ed73efac297a3c35268c55c551138b48cba3cee5387c788706ee5'],
            ['waitForReceive', '45f43202c00e7070378a587c06e14c44092a872595839f09ab6cf48df6766f6f'],
            ['copyDiagnostics', 'e79a98252e9c0ba175587b54c86a0827c6d6a3ff9fd5fc5b0fb3fbdeb721d3d2'],
            ['copyRunnerRecipe', '34aa677bca4a06755fc489d667bfbbb98889c6e15ac79b853e6992a4287f8f86'],
        ] as const) {
            const statement = controllerDeclarations.get(name);
            expect.soft(
                statement ? task9aAstFingerprint([statement]) : '',
                `${name}: exact Quick controller action`,
            ).toBe(expectedHash);
        }

        const controllerParameter = controller.parameters[0];
        const controllerInputKeys = controllerParameter &&
                ts.isObjectBindingPattern(controllerParameter.name)
            ? controllerParameter.name.elements.map((element) =>
                  element.name.getText(controllerAst)
              )
            : [];
        expect.soft(
            controllerInputKeys,
            'exact Quick controller input order',
        ).toEqual([
            'state', 'bootstrap', 'authSession', 'globalValues',
            'browserStatus', 'onGlobalValueChange',
        ]);
        if (sources.has(controllerPath)) {
            expect.soft(
                controllerParameter?.type?.getText(controllerAst) ?? '',
                'Quick hook consumes its named input contract',
            ).toBe('UseQuickRallarTestControllerInput');
        }
        const controllerReturn = controllerStatements.find(ts.isReturnStatement);
        const controllerModel = controllerReturn?.expression;
        expect.soft(
            controllerModel && ts.isObjectLiteralExpression(controllerModel),
            'Quick hook returns one explicit model object',
        ).toBe(true);
        if (controllerModel && ts.isObjectLiteralExpression(controllerModel)) {
            expect.soft(
                controllerModel.properties.map((property) => property.name?.getText()),
                'exact Quick hook model key order',
            ).toEqual([
                'values', 'busyAction', 'localError', 'lastResult',
                'subscription', 'receivedMessages', 'waitStatus',
                'providerMode', 'realBackendReady', 'canUseDirectRallar',
                'activeGroupId', 'activeTypeId', 'activeContextId',
                'selectorLabel', 'payloadResult', 'updateValue',
                'updateGroupId', 'createGroup', 'joinGroup', 'subscribeWs',
                'unsubscribeWs', 'sendWs', 'waitForReceive',
                'copyDiagnostics', 'copyRunnerRecipe', 'setupComplete',
                'subscribed', 'workflowSteps',
            ]);
            expect.soft(
                task9aAstFingerprint([controllerModel]),
                'exact Quick hook model object',
            ).toBe('ab6344a8375f2016fd56ebabea9a72b551dcfa2a8283f29c9669c596953c09b8');
        }
        let controllerHasJsx = false;
        const visitControllerJsx = (node: ts.Node): void => {
            if (
                ts.isJsxElement(node) ||
                ts.isJsxSelfClosingElement(node) ||
                ts.isJsxFragment(node)
            ) controllerHasJsx = true;
            ts.forEachChild(node, visitControllerJsx);
        };
        visitControllerJsx(controller);
        expect.soft(controllerHasJsx, 'Quick controller hook has no JSX')
            .toBe(false);

        const panelAst = sources.has(panelPath)
            ? task9aSourceFile(panelPath, sources.get(panelPath)!)
            : appAst;
        const panel = task9aNamedFunction(panelAst, 'QuickRallarTestPanel');
        const panelParameter = panel.parameters[0];
        const panelPropKeys = panelParameter &&
                ts.isObjectBindingPattern(panelParameter.name)
            ? panelParameter.name.elements.map((element) =>
                  element.name.getText(panelAst)
              )
            : [];
        expect.soft(panelPropKeys, 'exact Quick root prop order').toEqual([
            'state', 'bootstrap', 'authSession', 'globalValues',
            'browserStatus', 'onGlobalValueChange', 'onOpenAuth',
            'onOpenRunnerMode',
        ]);
        if (sources.has(panelPath)) {
            expect.soft(
                panelParameter?.type?.getText(panelAst) ?? '',
                'Quick root consumes its exact named prop contract',
            ).toBe('QuickRallarTestPanelProps');
            const expectedPanelContract = task9aSourceFile(
                'expected-quick-panel-contract.ts',
                `type QuickRallarTestPanelProps =
                    UseQuickRallarTestControllerInput & Readonly<{
                        onOpenAuth(): void;
                        onOpenRunnerMode(): void;
                    }>;`,
            );
            expect.soft(
                task9aAstFingerprint(namedTypeNodes(
                    panelAst,
                    'QuickRallarTestPanelProps',
                )),
                'exact Quick root prop contract',
            ).toBe(task9aAstFingerprint(namedTypeNodes(
                expectedPanelContract,
                'QuickRallarTestPanelProps',
            )));
        }
        const panelHookCalls: ts.CallExpression[] = [];
        const visitPanelHook = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === 'useQuickRallarTestController'
            ) panelHookCalls.push(node);
            ts.forEachChild(node, visitPanelHook);
        };
        visitPanelHook(panel);
        expect.soft(panelHookCalls, 'one Quick controller hook call').toHaveLength(1);
        const panelHookInput = panelHookCalls[0]?.arguments[0];
        expect.soft(
            panelHookInput && ts.isObjectLiteralExpression(panelHookInput),
            'Quick root passes one explicit hook input object',
        ).toBe(true);
        if (panelHookInput && ts.isObjectLiteralExpression(panelHookInput)) {
            expect.soft(
                panelHookCalls[0]?.arguments,
                'Quick root passes exactly one controller input argument',
            ).toHaveLength(1);
            expect.soft(
                panelHookInput.properties.map((property) => property.name?.getText()),
                'exact Quick hook call input order',
            ).toEqual([
                'state', 'bootstrap', 'authSession', 'globalValues',
                'browserStatus', 'onGlobalValueChange',
            ]);
            expect.soft(
                panelHookInput.properties.map((property) =>
                    ts.isShorthandPropertyAssignment(property)
                        ? property.name.text
                        : 'not-shorthand'
                ),
                'Quick root forwards each controller input as its matching shorthand identifier',
            ).toEqual([
                'state', 'bootstrap', 'authSession', 'globalValues',
                'browserStatus', 'onGlobalValueChange',
            ]);
        }
        const panelPreReturn = panel.body!.statements.filter(
            (statement) => !ts.isReturnStatement(statement),
        );
        const panelReturnIndex = panel.body!.statements.findIndex(
            ts.isReturnStatement,
        );
        expect.soft(
            panelReturnIndex,
            'Quick root has one final top-level View return',
        ).toBe(panel.body!.statements.length - 1);
        expect.soft(
            panelPreReturn,
            'Quick root has one controller-model destructure before return',
        ).toHaveLength(1);
        const panelModelDeclaration = panelPreReturn
            .filter(ts.isVariableStatement)
            .flatMap((statement) => [...statement.declarationList.declarations])[0];
        expect.soft(
            panelModelDeclaration?.initializer &&
                ts.isCallExpression(panelModelDeclaration.initializer) &&
                ts.isIdentifier(panelModelDeclaration.initializer.expression)
                ? panelModelDeclaration.initializer.expression.text
                : '',
            'Quick root destructures only the controller hook result',
        ).toBe('useQuickRallarTestController');
        const panelModelKeys = panelModelDeclaration &&
                ts.isObjectBindingPattern(panelModelDeclaration.name)
            ? panelModelDeclaration.name.elements.map((element) =>
                  element.name.getText(panelAst)
              )
            : [];
        expect.soft(panelModelKeys, 'exact Quick root model destructure order')
            .toEqual([
                'values', 'busyAction', 'localError', 'lastResult',
                'subscription', 'receivedMessages', 'waitStatus',
                'providerMode', 'realBackendReady', 'canUseDirectRallar',
                'activeGroupId', 'activeTypeId', 'activeContextId',
                'selectorLabel', 'payloadResult', 'updateValue',
                'updateGroupId', 'createGroup', 'joinGroup', 'subscribeWs',
                'unsubscribeWs', 'sendWs', 'waitForReceive',
                'copyDiagnostics', 'copyRunnerRecipe', 'setupComplete',
                'subscribed', 'workflowSteps',
            ]);

        const viewCalls = task9aJsxCalls(panel, 'QuickRallarTestView');
        expect.soft(viewCalls, 'one direct Quick controlled View call').toHaveLength(1);
        const viewCall = viewCalls[0];
        if (viewCall) {
            const propNames = viewCall.attributes.properties.map((property) =>
                ts.isJsxAttribute(property) ? property.name.getText() : 'spread'
            );
            expect.soft(propNames, 'exact Quick View prop order').toEqual([
                'state', 'authSession', 'globalValues', 'browserStatus', 'model',
                'onOpenAuth', 'onOpenRunnerMode',
            ]);
            const modelAttribute = viewCall.attributes.properties.find(
                (property): property is ts.JsxAttribute =>
                    ts.isJsxAttribute(property) && property.name.getText() === 'model',
            );
            const modelExpression = modelAttribute?.initializer &&
                ts.isJsxExpression(modelAttribute.initializer)
                ? modelAttribute.initializer.expression
                : undefined;
            expect.soft(
                modelExpression && ts.isObjectLiteralExpression(modelExpression),
                'Quick View receives one explicit model object',
            ).toBe(true);
            if (modelExpression && ts.isObjectLiteralExpression(modelExpression)) {
                expect.soft(
                    modelExpression.properties.map((property) => property.name?.getText()),
                    'exact Quick View model key order',
                ).toEqual([
                    'values', 'busyAction', 'localError', 'lastResult',
                    'subscription', 'receivedMessages', 'waitStatus',
                    'providerMode', 'realBackendReady', 'canUseDirectRallar',
                    'activeGroupId', 'activeTypeId', 'activeContextId',
                    'selectorLabel', 'payloadResult', 'updateValue',
                    'updateGroupId', 'createGroup', 'joinGroup', 'subscribeWs',
                    'unsubscribeWs', 'sendWs', 'waitForReceive',
                    'copyDiagnostics', 'copyRunnerRecipe', 'setupComplete',
                    'subscribed', 'workflowSteps',
                ]);
                expect.soft(
                    task9aAstFingerprint([modelExpression]),
                    'exact Quick View model object',
                ).toBe('ab6344a8375f2016fd56ebabea9a72b551dcfa2a8283f29c9669c596953c09b8');
            }
            expect.soft(
                task9aAstFingerprint(viewCalls),
                'exact Quick View call and prop initializers',
            ).toBe('a830afd10308bab7afe03731d507acb5ad439a17f92d67c53f64318790a285a0');
        }
        expect.soft(
            task9aJsxRuntimeFingerprint(task9aReturnExpression(panel)),
            'Quick root preserves the exact compiled controlled View return',
        ).toBe('4c3e93ff4b8d614b059fa4e8e426983beb873511d1c0a6546ffe247df1b9c751');

        if (sources.has(viewPath)) {
            const viewAst = task9aSourceFile(viewPath, sources.get(viewPath)!);
            const view = task9aNamedFunction(viewAst, 'QuickRallarTestView');
            const viewParameter = view.parameters[0];
            const viewParameterKeys = viewParameter &&
                    ts.isObjectBindingPattern(viewParameter.name)
                ? viewParameter.name.elements.map((element) =>
                      element.name.getText(viewAst)
                  )
                : [];
            expect.soft(viewParameterKeys, 'exact Quick View prop order')
                .toEqual([
                    'state', 'authSession', 'globalValues', 'browserStatus',
                    'model', 'onOpenAuth', 'onOpenRunnerMode',
                ]);
            const viewStatements = view.body!.statements;
            const viewReturnIndex = viewStatements.findIndex(ts.isReturnStatement);
            const viewPreReturn = viewReturnIndex >= 0
                ? viewStatements.slice(0, viewReturnIndex)
                : [];
            expect.soft(
                viewPreReturn,
                'Quick View has exactly one model destructure before its return',
            ).toHaveLength(1);
            const modelDeclaration = viewPreReturn
                .filter(ts.isVariableStatement)
                .flatMap((statement) => [
                    ...statement.declarationList.declarations,
                ])[0];
            expect.soft(
                modelDeclaration?.initializer?.getText(viewAst) ?? '',
                'Quick View destructures only its model',
            ).toBe('model');
            const viewModelBindingKeys = modelDeclaration &&
                    ts.isObjectBindingPattern(modelDeclaration.name)
                ? modelDeclaration.name.elements.map((element) =>
                      element.name.getText(viewAst)
                  )
                : [];
            expect.soft(
                viewModelBindingKeys,
                'exact Quick View model destructure order',
            ).toEqual([
                'values', 'busyAction', 'localError', 'lastResult',
                'subscription', 'receivedMessages', 'waitStatus',
                'providerMode', 'realBackendReady', 'canUseDirectRallar',
                'activeGroupId', 'activeTypeId', 'activeContextId',
                'selectorLabel', 'payloadResult', 'updateValue',
                'updateGroupId', 'createGroup', 'joinGroup', 'subscribeWs',
                'unsubscribeWs', 'sendWs', 'waitForReceive',
                'copyDiagnostics', 'copyRunnerRecipe', 'setupComplete',
                'subscribed', 'workflowSteps',
            ]);
            expect.soft(
                viewStatements.filter(ts.isReturnStatement),
                'Quick View has one final return',
            ).toHaveLength(1);
            const viewHookCalls: string[] = [];
            const forbiddenViewGlobals: string[] = [];
            const forbiddenGlobalNames = new Set([
                'fetch', 'localStorage', 'sessionStorage', 'navigator',
                'XMLHttpRequest', 'WebSocket', 'loadBrowserRallarFacade',
                'rallarBlackBoxRuntimeStore',
            ]);
            const visitView = (node: ts.Node): void => {
                if (ts.isCallExpression(node)) {
                    const calleeName = ts.isIdentifier(node.expression)
                        ? node.expression.text
                        : ts.isPropertyAccessExpression(node.expression)
                          ? node.expression.name.text
                          : '';
                    if (/^use[A-Z0-9]/.test(calleeName)) {
                        viewHookCalls.push(calleeName);
                    }
                }
                if (
                    ts.isIdentifier(node) &&
                    forbiddenGlobalNames.has(node.text)
                ) forbiddenViewGlobals.push(node.text);
                ts.forEachChild(node, visitView);
            };
            visitView(view);
            expect.soft(viewHookCalls, 'Quick View is hook-free').toEqual([]);
            expect.soft(
                forbiddenViewGlobals,
                'Quick View has no facade/store/storage/network globals',
            ).toEqual([]);
            expect.soft(
                task9aJsxRuntimeFingerprint(task9aReturnExpression(view)),
                'Quick View owns the exact legacy compiled JSX',
            ).toBe('dcce8b70c9ce3f73bb861200a411333dc85f30fbd64924162084aef837a6f23d');
        } else {
            expect.soft(
                task9aJsxRuntimeFingerprint(task9aReturnExpression(controller)),
                'base legacy Quick compiled JSX before ownership cutover',
            ).toBe('dcce8b70c9ce3f73bb861200a411333dc85f30fbd64924162084aef837a6f23d');
        }

        const app = task9aNamedFunction(appAst, 'App');
        const mounts = task9aJsxCalls(app, 'QuickRallarTestPanel');
        expect.soft(mounts, 'one always-mounted Quick controller').toHaveLength(1);
        expect.soft(task9aAstFingerprint(mounts), 'exact Quick App mount props')
            .toBe('66b7da5bb3bc0125e6ea74a28df8c29bbb8485b9907b3cca21b3a2d1cf936e68');
        let mountAncestor: ts.Node | undefined = mounts[0];
        while (mountAncestor && !ts.isJsxElement(mountAncestor)) {
            mountAncestor = mountAncestor.parent;
        }
        expect.soft(
            mountAncestor ? task9aAstFingerprint([mountAncestor]) : '',
            'exact hidden-capable always-mounted Quick ancestor',
        ).toBe('15085c9859abf9d7e36f8887661fb4cecfd1628a51070e91ed830fa1510dadd9');
        expect.soft(task9aAstFingerprint([app]), 'unchanged App function')
            .toBe('9359ca185437ff49b62e1f643f86119ef5a8419a9fe887e4f183e3d82ef96f33');
        expect.soft(appSource, 'no Quick lazy/Suspense cutover')
            .not.toMatch(/(?:lazy\s*\(|<Suspense\b)/);
        expect.soft(
            createHash('sha256')
                .update(repositorySource('apps/rallar-black-box/src/styles.css'))
                .digest('hex'),
            'Quick extraction leaves the complete legacy stylesheet unchanged',
        ).toBe('9778cfa43e7a858b30a9304b36b2939bfbf89df2722ac05a65b97579a37640b4');

        const ownerPaths = new Set(owners.map(([path]) => path));
        const graph = new Map<string, readonly string[]>();
        for (const path of ownerPaths) {
            if (!sources.has(path)) continue;
            const dependencies = task9aImportEdges(
                task9aSourceFile(path, sources.get(path)!),
            )
                .map((edge) => edge.slice(0, edge.indexOf('|')))
                .filter((moduleImport) => moduleImport.startsWith('.'))
                .map((moduleImport) => relative(
                    repositoryRoot,
                    resolve(resolve(repositoryRoot, path), '..', moduleImport),
                ))
                .filter((dependency) => ownerPaths.has(dependency));
            graph.set(path, dependencies);
        }
        const active = new Set<string>();
        const visited = new Set<string>();
        const cycles: string[] = [];
        const visit = (path: string): void => {
            if (active.has(path)) { cycles.push(path); return; }
            if (visited.has(path)) return;
            active.add(path);
            for (const dependency of graph.get(path) ?? []) visit(dependency);
            active.delete(path);
            visited.add(path);
        };
        for (const path of ownerPaths) visit(path);
        expect(cycles, 'Quick presentation owner import cycles').toEqual([]);
    });

    it('extracts the RTC/Realtimes controller behind one thin legacy root', () => {
        const appSource = repositorySource(appSourcePath);
        const appAst = task9aSourceFile(appSourcePath, appSource);
        const root = 'apps/rallar-black-box/src/legacy/diagnostics/rtc-realtime';
        const contractsPath = `${root}/rtc-realtime-contracts.ts`;
        const viewPath = `${root}/RtcRealtimeView.tsx`;
        const controllerPath = `${root}/use-rtc-realtime-controller.ts`;
        const panelPath = `${root}/RtcRealtimePanel.tsx`;
        const recordValuePath =
            'apps/rallar-black-box/src/legacy/shared/record-value.ts';
        const recordValueAst = task9aSourceFile(
            recordValuePath,
            repositorySource(recordValuePath),
        );
        const recordArrayDeclaration = recordValueAst.statements.find(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) &&
                statement.name?.text === 'recordArray',
        );
        expect.soft(
            Boolean(recordArrayDeclaration),
            'shared record-value owner exports recordArray',
        ).toBe(true);
        if (recordArrayDeclaration) {
            expect.soft(
                task9aAstFingerprint([recordArrayDeclaration]),
                'exact moved recordArray declaration',
            ).toBe('d1bf28c48a9d6609314991ec3e96e44ad79df547e3ab3538eab7534b099a3e4a');
        }
        const owners = [
            [contractsPath, 190, [
                'type:RtcRealtimeReceivedRow',
                'type:RtcRealtimeSubscriptionRow',
                'type:RtcRealtimeTransport',
                'type:RtcRealtimeViewModel',
            ]],
            [viewPath, 500, ['value:RtcRealtimeView']],
            [controllerPath, 720, [
                'type:RtcRealtimeControllerModel',
                'type:UseRtcRealtimeControllerInput',
                'value:useRtcRealtimeController',
            ]],
            [panelPath, 80, ['value:RtcRealtimePanel']],
        ] as const;
        const sources = new Map<string, string>();
        for (const [path, cap, exports] of owners) {
            const present = existsSync(resolve(repositoryRoot, path));
            expect.soft(present, `${path}: owner exists`).toBe(true);
            if (!present) continue;
            const source = repositorySource(path);
            sources.set(path, source);
            expect.soft(source.split('\n').length, `${path}: line cap`)
                .toBeLessThanOrEqual(cap);
            const sourceFile = task9aSourceFile(path, source);
            expect.soft(task9aExportSeams(sourceFile), `${path}: exact exports`)
                .toEqual(exports);
            expect.soft(source, `${path}: no reverse/App/CSS/barrel edge`)
                .not.toMatch(/(?:App\.tsx['"]|\.css['"]|\/index\.(?:ts|tsx)['"]|\/mod\.(?:ts|tsx)['"])/);
        }
        const expectedImports = new Map<string, readonly string[]>([
            [contractsPath, [
                '../shared/action-feedback.ts|type:CommandCenterActionFeedback',
            ]],
            [viewPath, [
                '../../shared/CollapsiblePanelSection.tsx|value:CollapsiblePanelSection',
                '../../shared/Metric.tsx|value:Metric',
                '../../shared/redaction-presentation.ts|value:redactedJson',
                '../../shared/time-format.ts|value:formatTime',
                '../shared/CommandCenterActionFeedbackPanel.tsx|value:CommandCenterActionFeedbackPanel',
                './rtc-realtime-contracts.ts|type:RtcRealtimeTransport,type:RtcRealtimeViewModel',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
                '@shared/api/api-config.ts|type:AuthSession',
            ]],
            [controllerPath, [
                '../../../client-defaults.ts|value:RALLAR_BLACK_BOX_CLIENT_DEFAULTS',
                '../../../direct-rallar-operations.ts|value:configureDirectRallarFacade,value:createDirectRallarRuntimeEvent',
                '../../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig,value:rallarBlackBoxRuntimeStore',
                '../../rallar/load-browser-rallar-facade.ts|value:loadBrowserRallarFacade',
                '../../shared/json-presentation.ts|value:json,value:parseJsonText,value:splitCsvValues',
                '../../shared/record-value.ts|value:recordArray,value:recordValue->optionalRecord',
                '../../shared/redaction-presentation.ts|value:redactedJson',
                '../../shared/string-value.ts|value:stringValue',
                '../../shell/global-context-model.ts|type:CommandCenterGlobalValues',
                '../shared/action-feedback.ts|type:CommandCenterActionFeedback,value:completedActionFeedback,value:idleActionFeedback,value:runningActionFeedback',
                './rtc-realtime-contracts.ts|type:RtcRealtimeReceivedRow,type:RtcRealtimeSubscriptionRow,type:RtcRealtimeTransport',
                '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestSeverity,type:RallarBlackBoxTestState',
                '@shared/api/api-config.ts|type:AuthSession',
                'react|value:useEffect,value:useRef,value:useState',
            ]],
            [panelPath, [
                './RtcRealtimeView.tsx|value:RtcRealtimeView',
                './use-rtc-realtime-controller.ts|type:UseRtcRealtimeControllerInput,value:useRtcRealtimeController',
            ]],
        ]);
        for (const [path] of owners) {
            if (!sources.has(path)) continue;
            expect.soft(
                task9aImportEdges(task9aSourceFile(path, sources.get(path)!)),
                `${path}: exact imports/kinds/DAG edges`,
            ).toEqual(expectedImports.get(path));
        }
        expect.soft(
            task9aImportEdges(appAst).filter((edge) =>
                edge.startsWith('./legacy/diagnostics/rtc-realtime/')
            ),
            'App exact RTC/Realtimes owner imports',
        ).toEqual([
            './legacy/diagnostics/rtc-realtime/RtcRealtimePanel.tsx|value:RtcRealtimePanel',
        ]);

        const namedTypeNodes = (
            sourceFile: ts.SourceFile,
            name: string,
        ): readonly ts.Node[] => {
            const declaration = sourceFile.statements.find(
                (statement): statement is ts.TypeAliasDeclaration =>
                    ts.isTypeAliasDeclaration(statement) &&
                    statement.name.text === name,
            );
            return declaration ? [declaration.name, declaration.type] : [];
        };
        if (sources.has(contractsPath)) {
            const contractsAst = task9aSourceFile(
                contractsPath,
                sources.get(contractsPath)!,
            );
            const expectedContracts = task9aSourceFile(
                'expected-rtc-realtime-contracts.ts',
                `type RtcRealtimeTransport = 'realtime' | 'messages.rtc';
                type RtcRealtimeReceivedRow = Readonly<{
                    rowId: string; atEpochMs: number;
                    transport: RtcRealtimeTransport; peerId: string;
                    laneId: string; roomId: string; typeId: string;
                    topicId: string; contextId: string; payload?: unknown;
                    raw?: unknown;
                }>;
                type RtcRealtimeSubscriptionRow = Readonly<{
                    subscriptionId: string; transport: RtcRealtimeTransport;
                    label: string; laneId: string; groupId: string;
                    subscribedAtEpochMs: number; unsubscribe(): void;
                }>;
                type RtcRealtimeViewModel = Readonly<{
                    transport: RtcRealtimeTransport;
                    setTransport(value: RtcRealtimeTransport): void;
                    laneId: string; setLaneId(value: string): void;
                    peerIdsText: string; setPeerIdsText(value: string): void;
                    typeId: string; setTypeId(value: string): void;
                    topicId: string; setTopicId(value: string): void;
                    contextId: string; setContextId(value: string): void;
                    payloadText: string; setPayloadText(value: string): void;
                    minSnapshotVersion: string;
                    setMinSnapshotVersion(value: string): void;
                    reliability: 'best-effort' | 'at-least-once';
                    setReliability(value: 'best-effort' | 'at-least-once'): void;
                    ack: 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader';
                    setAck(value: 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader'): void;
                    ownership: 'shared' | 'exclusive';
                    setOwnership(value: 'shared' | 'exclusive'): void;
                    timeoutMs: number; setTimeoutMs(value: number): void;
                    busyAction?: string; localError?: string;
                    actionFeedback: CommandCenterActionFeedback;
                    result: unknown;
                    received: readonly Readonly<{
                        rowId: string; atEpochMs: number;
                        transport: RtcRealtimeTransport; peerId: string;
                        laneId: string; roomId: string; typeId: string;
                        topicId: string; contextId: string; payload?: unknown;
                    }>[];
                    health: unknown;
                    subscriptions: readonly Readonly<{
                        transport: RtcRealtimeTransport; label: string;
                        laneId: string; groupId: string;
                        subscribedAtEpochMs: number;
                    }>[];
                    providerMode: 'simulated' | 'browser-rallar';
                    realBackendReady: boolean; activeGroupId: string;
                    peerIds: readonly string[]; canRun: boolean;
                    subscribeRealtime(): Promise<void>;
                    subscribeRtcMessages(): Promise<void>;
                    clearSubscriptions(): void;
                    sendRealtime(): Promise<void>;
                    sendRtcMessage(): Promise<void>;
                    waitForRoomLane(): Promise<void>;
                    refreshHealth(): Promise<void>;
                    copyRecipe(): void;
                }>;`,
            );
            for (const name of [
                'RtcRealtimeTransport', 'RtcRealtimeReceivedRow',
                'RtcRealtimeSubscriptionRow', 'RtcRealtimeViewModel',
            ] as const) {
                expect.soft(
                    task9aAstFingerprint(namedTypeNodes(contractsAst, name)),
                    `${name}: exact moved/narrow contract`,
                ).toBe(task9aAstFingerprint(namedTypeNodes(
                    expectedContracts,
                    name,
                )));
            }
        }
        if (sources.has(controllerPath)) {
            const controllerContractAst = task9aSourceFile(
                controllerPath,
                sources.get(controllerPath)!,
            );
            const expectedControllerContracts = task9aSourceFile(
                'expected-rtc-realtime-controller-contracts.ts',
                `type UseRtcRealtimeControllerInput = Readonly<{
                    state: RallarBlackBoxTestState;
                    bootstrap: RallarBlackBoxBootstrapConfig;
                    authSession?: AuthSession;
                    globalValues: CommandCenterGlobalValues;
                }>;
                type RtcRealtimeControllerModel = ReturnType<
                    typeof useRtcRealtimeController
                >;`,
            );
            for (const name of [
                'UseRtcRealtimeControllerInput',
                'RtcRealtimeControllerModel',
            ] as const) {
                expect.soft(
                    task9aAstFingerprint(namedTypeNodes(
                        controllerContractAst,
                        name,
                    )),
                    `${name}: exact RTC controller contract`,
                ).toBe(task9aAstFingerprint(namedTypeNodes(
                    expectedControllerContracts,
                    name,
                )));
            }
        }

        const appLocalNames = new Set<string>();
        for (const statement of appAst.statements) {
            if (
                ts.isTypeAliasDeclaration(statement) ||
                ts.isInterfaceDeclaration(statement) ||
                ts.isFunctionDeclaration(statement)
            ) {
                if (statement.name) appLocalNames.add(statement.name.text);
            }
            if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    if (ts.isIdentifier(declaration.name)) {
                        appLocalNames.add(declaration.name.text);
                    }
                }
            }
        }
        for (const moved of [
            'RtcRealtimeTransport', 'RtcRealtimeReceivedRow',
            'RtcRealtimeSubscriptionRow', 'RtcRealtimeViewModel',
            'RtcRealtimeView', 'UseRtcRealtimeControllerInput',
            'RtcRealtimeControllerModel', 'useRtcRealtimeController',
            'RtcRealtimePanel',
        ]) {
            expect.soft(appLocalNames, `App no local ${moved}`).not.toContain(moved);
        }

        const controllerAst = sources.has(controllerPath)
            ? task9aSourceFile(controllerPath, sources.get(controllerPath)!)
            : appAst;
        const controller = task9aNamedFunction(
            controllerAst,
            sources.has(controllerPath)
                ? 'useRtcRealtimeController'
                : 'RtcRealtimePanel',
        );
        const controllerParameter = controller.parameters[0];
        expect.soft(
            controller.parameters,
            'RTC controller has exactly one formal input parameter',
        ).toHaveLength(1);
        const controllerInputKeys = controllerParameter &&
                ts.isObjectBindingPattern(controllerParameter.name)
            ? controllerParameter.name.elements.map((element) =>
                  element.name.getText(controllerAst)
              )
            : [];
        expect.soft(
            controllerInputKeys,
            'exact four-prop RTC controller input order',
        ).toEqual(['state', 'bootstrap', 'authSession', 'globalValues']);
        const unsafeControllerInputs = controllerParameter &&
                ts.isObjectBindingPattern(controllerParameter.name)
            ? controllerParameter.name.elements.filter((element) =>
                  Boolean(
                      element.propertyName ||
                      element.initializer ||
                      element.dotDotDotToken,
                  )
              )
            : [];
        expect.soft(
            unsafeControllerInputs,
            'RTC controller input has no aliases, defaults, or rest escape',
        ).toEqual([]);
        if (sources.has(controllerPath)) {
            expect.soft(
                controllerParameter?.type?.getText(controllerAst) ?? '',
                'RTC hook consumes its named four-prop input contract',
            ).toBe('UseRtcRealtimeControllerInput');
        }
        const statements = controller.body!.statements;
        const returnIndex = statements.findIndex(ts.isReturnStatement);
        expect.soft(returnIndex, 'RTC controller hook has one final return')
            .toBe(statements.length - 1);
        const preReturn = statements.slice(0, returnIndex);
        expect.soft(preReturn, 'exact 46 extracted RTC controller statements')
            .toHaveLength(46);
        expect.soft(
            task9aAstFingerprint(preReturn),
            'token-complete RTC/Realtimes controller',
        ).toBe('526bc8f5ca3e56ef20f8b53e06a2a03a56f1155fc4b8721846f2c67b9cc6e9da');
        const hooks = {
            useState: 0, useMemo: 0, useRef: 0, useEffect: 0, useCallback: 0,
        };
        const effects: ts.CallExpression[] = [];
        const visitHooks = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
                node.expression.text in hooks
            ) {
                hooks[node.expression.text as keyof typeof hooks] += 1;
                if (node.expression.text === 'useEffect') effects.push(node);
            }
            ts.forEachChild(node, visitHooks);
        };
        visitHooks(controller);
        expect.soft(hooks, 'exact RTC controller hook topology').toEqual({
            useState: 19, useMemo: 0, useRef: 1, useEffect: 2, useCallback: 0,
        });
        expect.soft(
            effects.map((effect) => task9aAstFingerprint([effect])),
            'exact RTC controller effects and dependencies',
        ).toEqual([
            'c253b188565a336571a941a9518484f48705c2b1ea5e11b86cc321d1d67b5794',
            'e4b46deaa8c0a687dc40d2d5a71eaf6e614315f27d6f054fdde8adac33b46014',
        ]);
        const controllerDeclarations = new Map<string, ts.VariableStatement>();
        for (const statement of preReturn) {
            if (!ts.isVariableStatement(statement)) continue;
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) {
                    controllerDeclarations.set(declaration.name.text, statement);
                }
            }
        }
        for (const [name, expectedHash] of [
            ['context', 'd77af449e01d28590602b571b168bdac8b84ff0104b3996cad32731744198c68'],
            ['recordDirectEvent', 'e69900faf20cddff32029f7e038507526b2f976421d89d5b0e2f6b382c2b1dc7'],
            ['nowMs', 'ce0208a4e36cefa89754b097d573050994fc061da0b3d4c1b86925517650e7a0'],
            ['recordPhase', 'f52817ea4ea12573d44e6c651d01ee027f88a065cd22463644074bb16466db69'],
            ['runTimedPhase', '42d929e63a86ff511cf986f395e655b56bee48b069b5b3650e6ad2d058ab3401'],
            ['isFacadeJoinedToActiveGroup', '1f7467c32c194d594b5e9ceef6e07913463cbf26df43f80a638e993fa318038d'],
            ['ensureActiveGroupJoined', '81fbbbfc5ff21bd45fbca93021e6e354baa82fd10095dbc5fcf23016d4a6afbd'],
            ['withFacade', 'f712388db61594f25f6cf5467bfdfd0ba9846897dffc00f300c6176dacba6c0b'],
            ['runAction', 'b4dac615d21f402c35fee1d557eea7f1885f69d23a8cf2281f26b2722337a6a8'],
            ['addSubscription', '2df5eedb38b8056f927f10659dd7b72e1eba80954baa85448c550bfe29ba5b00'],
            ['addReceived', '01ff6839d9e43df5dbab308fd8fd005418161c8f68285875b8c99d1be33c97e6'],
            ['subscribeRealtime', 'e7dac9eed6227004904c39c8e4f24df38d072e8a3bbde4a6d9346d703adb361c'],
            ['subscribeRtcMessages', '5d267812fcde18c5c88c797a7cfcd993ebd28405e108874452c19eaae3c76b7c'],
            ['clearSubscriptions', 'ec5f9e217753929ef6b85410f3e54d191326db853aeadab48cb5513ea85664a0'],
            ['sendRealtime', '29763618157949ea892149a8dd35ceda3234c6883439fb20712e4e8d6fbb0c19'],
            ['sendRtcMessage', '9c20ae4c7f8dda6f945c74a8d9908f4b3c4dac5e3c5b0aa32a10e2059605125f'],
            ['waitForRoomLane', '34df714a67936a94daaeb89510dae89dfdec8df218daa6d4111d508ea89808dc'],
            ['refreshHealth', 'e0e4b7d7085fd737334e01f339380abb9056c9ba330e513fe14393f18a8b77fb'],
            ['copyRecipe', 'e73380d4b94754ab53dfb3d653aff98c67dfbbb868387b366c1d5b98c2d848cf'],
        ] as const) {
            const statement = controllerDeclarations.get(name);
            expect.soft(
                statement ? task9aAstFingerprint([statement]) : '',
                `${name}: exact RTC controller action`,
            ).toBe(expectedHash);
        }

        const modelKeys = [
            'transport', 'setTransport', 'laneId', 'setLaneId',
            'peerIdsText', 'setPeerIdsText', 'typeId', 'setTypeId',
            'topicId', 'setTopicId', 'contextId', 'setContextId',
            'payloadText', 'setPayloadText', 'minSnapshotVersion',
            'setMinSnapshotVersion', 'reliability', 'setReliability',
            'ack', 'setAck', 'ownership', 'setOwnership', 'timeoutMs',
            'setTimeoutMs', 'busyAction', 'localError', 'actionFeedback',
            'result', 'received', 'health', 'subscriptions', 'providerMode',
            'realBackendReady', 'activeGroupId', 'peerIds', 'canRun',
            'subscribeRealtime', 'subscribeRtcMessages', 'clearSubscriptions',
            'sendRealtime', 'sendRtcMessage', 'waitForRoomLane',
            'refreshHealth', 'copyRecipe',
        ];
        if (sources.has(controllerPath)) {
            expect.soft(
                [...appSource.matchAll(/\brecordArray\s*\(/g)],
                'all nine remaining App recordArray call sites survive the move',
            ).toHaveLength(9);
            expect.soft(
                [
                    ...sources
                        .get(controllerPath)!
                        .matchAll(/\brecordArray\s*\(/g),
                ],
                'RTC hook owns its one moved recordArray call site',
            ).toHaveLength(1);
            for (const [name, expectedHash] of [
                [
                    'rowsFromGroupSnapshots',
                    'a6f8cc7bf5e303da377fd893eb36dda35220b6d3df5370900e73c1b72ff0f862',
                ],
                [
                    'rowsFromClientSnapshots',
                    '244d50c521f6593f58d3d9aeb21145663db34b908d55c574be3a0c1a8bd7ddb0',
                ],
                [
                    'rowsFromStateEvents',
                    '470c7ee6823911dc723b4d322ca1bc5d5fc641cf9fb2c2acd32dda65b97c0a99',
                ],
                [
                    'RoomsClientsPanel',
                    'c7fe946335be41d27b620a07f591490fd635d5586f8e0675ae944ff5c5af6da5',
                ],
            ] as const) {
                expect.soft(
                    task9aAstFingerprint([
                        task9aNamedFunction(appAst, name),
                    ]),
                    `${name}: unchanged shared recordArray consumer`,
                ).toBe(expectedHash);
            }
            const controllerReturn = statements[returnIndex];
            const controllerModel = controllerReturn &&
                    ts.isReturnStatement(controllerReturn)
                ? controllerReturn.expression
                : undefined;
            expect.soft(
                controllerModel && ts.isObjectLiteralExpression(controllerModel),
                'RTC hook returns one explicit model object',
            ).toBe(true);
            if (controllerModel && ts.isObjectLiteralExpression(controllerModel)) {
                expect.soft(
                    controllerModel.properties.map((property) =>
                        property.name?.getText()
                    ),
                    'exact RTC hook model key order',
                ).toEqual(modelKeys);
                expect.soft(
                    controllerModel.properties.map((property) =>
                        ts.isShorthandPropertyAssignment(property)
                            ? property.name.text
                            : 'not-shorthand'
                    ),
                    'RTC hook returns every model field as matching shorthand',
                ).toEqual(modelKeys);
                expect.soft(
                    task9aAstFingerprint([controllerModel]),
                    'exact RTC hook model object AST',
                ).toBe('3bc116b3a2393ade2ddafc49816da8ee1ec04b2c76f55129496f04c2e8ec8838');
            }
            let controllerHasJsx = false;
            const visitControllerJsx = (node: ts.Node): void => {
                if (
                    ts.isJsxElement(node) ||
                    ts.isJsxSelfClosingElement(node) ||
                    ts.isJsxFragment(node)
                ) controllerHasJsx = true;
                ts.forEachChild(node, visitControllerJsx);
            };
            visitControllerJsx(controller);
            expect.soft(controllerHasJsx, 'RTC controller hook has no JSX')
                .toBe(false);
        }

        if (sources.has(panelPath)) {
            const panelAst = task9aSourceFile(panelPath, sources.get(panelPath)!);
            const panel = task9aNamedFunction(panelAst, 'RtcRealtimePanel');
            const panelParameter = panel.parameters[0];
            expect.soft(
                panel.parameters,
                'RTC root has exactly one formal input parameter',
            ).toHaveLength(1);
            const panelPropKeys = panelParameter &&
                    ts.isObjectBindingPattern(panelParameter.name)
                ? panelParameter.name.elements.map((element) =>
                      element.name.getText(panelAst)
                  )
                : [];
            expect.soft(panelPropKeys, 'exact four-prop RTC root order')
                .toEqual(['state', 'bootstrap', 'authSession', 'globalValues']);
            const unsafePanelInputs = panelParameter &&
                    ts.isObjectBindingPattern(panelParameter.name)
                ? panelParameter.name.elements.filter((element) =>
                      Boolean(
                          element.propertyName ||
                          element.initializer ||
                          element.dotDotDotToken,
                      )
                  )
                : [];
            expect.soft(
                unsafePanelInputs,
                'RTC root input has no aliases, defaults, or rest escape',
            ).toEqual([]);
            expect.soft(
                panelParameter?.type?.getText(panelAst) ?? '',
                'RTC root consumes the exact controller input contract',
            ).toBe('UseRtcRealtimeControllerInput');

            const panelStatements = [...panel.body!.statements];
            expect.soft(
                panelStatements,
                'RTC root has only one hook-model destructure and one View return',
            ).toHaveLength(2);
            expect.soft(
                panelStatements.findIndex(ts.isReturnStatement),
                'RTC root has one final top-level View return',
            ).toBe(1);
            const modelStatement = panelStatements[0];
            expect.soft(
                Boolean(modelStatement && ts.isVariableStatement(modelStatement)),
                'RTC root first statement owns only the hook model',
            ).toBe(true);
            const modelDeclarations = modelStatement &&
                    ts.isVariableStatement(modelStatement)
                ? [...modelStatement.declarationList.declarations]
                : [];
            expect.soft(
                modelDeclarations,
                'RTC root hook statement has one safe declaration',
            ).toHaveLength(1);
            const modelDeclaration = modelDeclarations[0];
            const rootModelKeys = modelDeclaration &&
                    ts.isObjectBindingPattern(modelDeclaration.name)
                ? modelDeclaration.name.elements.map((element) =>
                      element.name.getText(panelAst)
                  )
                : [];
            expect.soft(rootModelKeys, 'exact RTC root model destructure order')
                .toEqual(modelKeys);
            const unsafeModelBindings = modelDeclaration &&
                    ts.isObjectBindingPattern(modelDeclaration.name)
                ? modelDeclaration.name.elements.filter((element) =>
                      Boolean(
                          element.propertyName ||
                          element.initializer ||
                          element.dotDotDotToken,
                      )
                  )
                : [];
            expect.soft(
                unsafeModelBindings,
                'RTC root model destructure has no aliases, defaults, or rest escape',
            ).toEqual([]);

            const hookCalls: ts.CallExpression[] = [];
            const visitHookCalls = (node: ts.Node): void => {
                if (
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === 'useRtcRealtimeController'
                ) hookCalls.push(node);
                ts.forEachChild(node, visitHookCalls);
            };
            visitHookCalls(panel);
            expect.soft(hookCalls, 'one RTC controller hook call').toHaveLength(1);
            expect.soft(
                modelDeclaration?.initializer,
                'RTC root destructures the one controller hook call directly',
            ).toBe(hookCalls[0]);
            expect.soft(
                hookCalls[0]?.arguments,
                'RTC root passes one hook input argument',
            ).toHaveLength(1);
            const hookInput = hookCalls[0]?.arguments[0];
            expect.soft(
                hookInput && ts.isObjectLiteralExpression(hookInput),
                'RTC root passes one explicit hook input object',
            ).toBe(true);
            if (hookInput && ts.isObjectLiteralExpression(hookInput)) {
                const hookInputKeys = [
                    'state', 'bootstrap', 'authSession', 'globalValues',
                ];
                expect.soft(
                    hookInput.properties.map((property) =>
                        property.name?.getText()
                    ),
                    'exact RTC root hook input order',
                ).toEqual(hookInputKeys);
                expect.soft(
                    hookInput.properties.map((property) =>
                        ts.isShorthandPropertyAssignment(property)
                            ? property.name.text
                            : 'not-shorthand'
                    ),
                    'RTC root forwards every hook input as matching shorthand',
                ).toEqual(hookInputKeys);
            }

            const viewCalls = task9aJsxCalls(panel, 'RtcRealtimeView');
            expect.soft(viewCalls, 'one direct RTC controlled View call')
                .toHaveLength(1);
            const viewCall = viewCalls[0];
            if (viewCall) {
                expect.soft(
                    task9aReturnExpression(panel),
                    'RTC root returns the controlled View directly',
                ).toBe(viewCall);
                expect.soft(
                    viewCall.attributes.properties.map((property) =>
                        ts.isJsxAttribute(property)
                            ? property.name.getText()
                            : 'spread'
                    ),
                    'exact RTC View prop order',
                ).toEqual(['state', 'authSession', 'model']);
                for (const name of ['state', 'authSession'] as const) {
                    const attribute = viewCall.attributes.properties.find(
                        (property): property is ts.JsxAttribute =>
                            ts.isJsxAttribute(property) &&
                            property.name.getText() === name,
                    );
                    const expression = attribute?.initializer &&
                        ts.isJsxExpression(attribute.initializer)
                        ? attribute.initializer.expression
                        : undefined;
                    expect.soft(
                        expression && ts.isIdentifier(expression)
                            ? expression.text
                            : '',
                        `RTC View exact ${name} forwarding`,
                    ).toBe(name);
                }
                const modelAttribute = viewCall.attributes.properties.find(
                    (property): property is ts.JsxAttribute =>
                        ts.isJsxAttribute(property) &&
                        property.name.getText() === 'model',
                );
                const model = modelAttribute?.initializer &&
                    ts.isJsxExpression(modelAttribute.initializer)
                    ? modelAttribute.initializer.expression
                    : undefined;
                expect.soft(
                    model && ts.isObjectLiteralExpression(model),
                    'RTC View receives one explicit model object',
                ).toBe(true);
                if (model && ts.isObjectLiteralExpression(model)) {
                    expect.soft(
                        model.properties.map((property) =>
                            property.name?.getText()
                        ),
                        'exact RTC View model key order',
                    ).toEqual(modelKeys);
                    expect.soft(
                        model.properties.map((property) =>
                            ts.isShorthandPropertyAssignment(property)
                                ? property.name.text
                                : 'not-shorthand'
                        ),
                        'exact RTC View model shorthand forwarding',
                    ).toEqual(modelKeys);
                    expect.soft(
                        task9aAstFingerprint([model]),
                        'exact RTC View model object AST',
                    ).toBe('3bc116b3a2393ade2ddafc49816da8ee1ec04b2c76f55129496f04c2e8ec8838');
                }
                expect.soft(
                    task9aAstFingerprint(viewCalls),
                    'exact RTC View call and prop initializers',
                ).toBe('42a86bc757c2929d1f3de773c27933e64be9bb1c33cd28535548ad9025189d8d');
                expect.soft(
                    task9aJsxRuntimeFingerprint(task9aReturnExpression(panel)),
                    'exact compiled RTC controlled View call',
                ).toBe('ff2df9b2969ddb82a9e150000ac71d86c7811f436ea7d8141ff20b28f2c58b14');
            }
        }

        if (sources.has(viewPath)) {
            const viewAst = task9aSourceFile(viewPath, sources.get(viewPath)!);
            const view = task9aNamedFunction(viewAst, 'RtcRealtimeView');
            const parameter = view.parameters[0];
            const parameterKeys = parameter &&
                    ts.isObjectBindingPattern(parameter.name)
                ? parameter.name.elements.map((element) =>
                      element.name.getText(viewAst)
                  )
                : [];
            expect.soft(parameterKeys, 'exact RTC View prop order')
                .toEqual(['state', 'authSession', 'model']);
            const expectedViewSignature = task9aNamedFunction(
                task9aSourceFile(
                    'expected-rtc-realtime-view.tsx',
                    `function RtcRealtimeView({
                        state, authSession, model,
                    }: {
                        state: RallarBlackBoxTestState;
                        authSession?: AuthSession;
                        model: RtcRealtimeViewModel;
                    }) { return <div />; }`,
                ),
                'RtcRealtimeView',
            );
            expect.soft(
                parameter
                    ? task9aAstFingerprint([parameter.name, parameter.type!])
                    : '',
                'exact RTC View prop contract',
            ).toBe(task9aAstFingerprint([
                expectedViewSignature.parameters[0]!.name,
                expectedViewSignature.parameters[0]!.type!,
            ]));
            const viewStatements = view.body!.statements;
            const viewReturnIndex = viewStatements.findIndex(ts.isReturnStatement);
            expect.soft(viewReturnIndex, 'RTC View has one final return')
                .toBe(viewStatements.length - 1);
            const viewPreReturn = viewStatements.slice(0, viewReturnIndex);
            expect.soft(viewPreReturn).toHaveLength(1);
            const modelStatement = viewPreReturn[0];
            expect.soft(
                Boolean(modelStatement && ts.isVariableStatement(modelStatement)),
                'RTC View has only one model variable statement before return',
            ).toBe(true);
            const modelDeclarations = modelStatement &&
                    ts.isVariableStatement(modelStatement)
                ? [...modelStatement.declarationList.declarations]
                : [];
            expect.soft(
                modelDeclarations,
                'RTC View model statement has one safe declaration',
            ).toHaveLength(1);
            const declaration = modelDeclarations[0];
            expect.soft(
                declaration?.initializer?.getText(viewAst) ?? '',
                'RTC View destructures only model',
            ).toBe('model');
            const bindingKeys = declaration &&
                    ts.isObjectBindingPattern(declaration.name)
                ? declaration.name.elements.map((element) =>
                      element.name.getText(viewAst)
                  )
                : [];
            expect.soft(bindingKeys, 'exact RTC View model destructure')
                .toEqual(modelKeys);
            const unsafeBindingElements = declaration &&
                    ts.isObjectBindingPattern(declaration.name)
                ? declaration.name.elements.filter((element) =>
                      Boolean(
                          element.propertyName ||
                          element.initializer ||
                          element.dotDotDotToken,
                      )
                  )
                : [];
            expect.soft(
                unsafeBindingElements,
                'RTC View model destructure has no aliases, defaults, or rest escape',
            ).toEqual([]);
            const forbidden: string[] = [];
            const forbiddenNames = new Set([
                'fetch', 'localStorage', 'sessionStorage', 'navigator',
                'XMLHttpRequest', 'WebSocket', 'loadBrowserRallarFacade',
                'rallarBlackBoxRuntimeStore',
            ]);
            const visitView = (node: ts.Node): void => {
                if (ts.isCallExpression(node)) {
                    const name = ts.isIdentifier(node.expression)
                        ? node.expression.text
                        : ts.isPropertyAccessExpression(node.expression)
                          ? node.expression.name.text
                          : '';
                    if (/^use[A-Z0-9]/.test(name)) forbidden.push(name);
                }
                if (ts.isIdentifier(node) && forbiddenNames.has(node.text)) {
                    forbidden.push(node.text);
                }
                ts.forEachChild(node, visitView);
            };
            visitView(view);
            expect.soft(forbidden, 'RTC View is hook/side-effect free').toEqual([]);
            expect.soft(
                task9aAstFingerprint([task9aReturnExpression(view)]),
                'RTC View owns exact legacy JSX AST',
            ).toBe('9d6b554990b3f94fd3e5e5fa38d6cb1c5499830004b8ce38cbbba39f6d3776d9');
            expect.soft(
                task9aJsxRuntimeFingerprint(task9aReturnExpression(view)),
                'RTC View owns exact legacy compiled JSX',
            ).toBe('26399ff77cab09dca087b8aabc49428bb85415ba3f9b66018a50beb049a4dcef');
        } else {
            expect.soft(
                task9aJsxRuntimeFingerprint(task9aReturnExpression(controller)),
                'base RTC compiled JSX before cutover',
            ).toBe('26399ff77cab09dca087b8aabc49428bb85415ba3f9b66018a50beb049a4dcef');
        }

        const app = task9aNamedFunction(appAst, 'App');
        const mounts = task9aJsxCalls(app, 'RtcRealtimePanel');
        expect.soft(mounts, 'one always-mounted RTC controller').toHaveLength(1);
        expect.soft(task9aAstFingerprint(mounts), 'exact RTC App mount')
            .toBe('36002d8e9976c59c0981e7691e280abe150a24af3a34e0082c78ebd8051b85fd');
        let ancestor: ts.Node | undefined = mounts[0];
        while (ancestor && !ts.isJsxElement(ancestor)) ancestor = ancestor.parent;
        expect.soft(
            ancestor ? task9aAstFingerprint([ancestor]) : '',
            'exact hidden-capable RTC ancestor',
        ).toBe('3100cd447ab9c6e91e700daf6beaadc3c18f1f5859026e85759b6a13b4d0fdac');
        expect.soft(task9aAstFingerprint([app]), 'unchanged App function')
            .toBe('9359ca185437ff49b62e1f643f86119ef5a8419a9fe887e4f183e3d82ef96f33');
        expect.soft(appSource, 'no RTC lazy/Suspense cutover')
            .not.toMatch(/(?:lazy\s*\(|<Suspense\b)/);
        expect.soft(
            createHash('sha256')
                .update(repositorySource('apps/rallar-black-box/src/styles.css'))
                .digest('hex'),
            'RTC extraction leaves complete stylesheet unchanged',
        ).toBe('9778cfa43e7a858b30a9304b36b2939bfbf89df2722ac05a65b97579a37640b4');
    });

    it('keeps WebSocket command-center support in exact deterministic owners', () => {
        const appSource = repositorySource(appSourcePath);
        const appAst = task9aSourceFile(appSourcePath, appSource);
        const root =
            'apps/rallar-black-box/src/legacy/diagnostics/websocket';
        const sharedTicketPath =
            'apps/rallar-black-box/src/legacy/diagnostics/shared/auth-command-center-ticket.ts';
        const contractsPath = `${root}/websocket-contracts.ts`;
        const presetsPath = `${root}/websocket-presets.ts`;
        const routingPath = `${root}/websocket-routing.ts`;
        const recipesPath = `${root}/websocket-recipes.ts`;
        const diagnosticsPath = `${root}/websocket-diagnostics.ts`;
        const owners = [
            {
                path: sharedTicketPath,
                cap: 25,
                exports: ['type:AuthCommandCenterTicket'],
                appImport:
                    './legacy/diagnostics/shared/auth-command-center-ticket.ts',
                appSeams: ['type:AuthCommandCenterTicket'],
                imports: [],
            },
            {
                path: contractsPath,
                cap: 130,
                exports: [
                    'type:WebSocketCommandCenterValues',
                    'type:WebSocketDiagnostic',
                    'type:WebSocketEventRow',
                    'type:WebSocketPayloadPreset',
                    'type:WebSocketReceivedMessageRow',
                    'type:WebSocketRoutePreview',
                    'type:WebSocketSubscriptionState',
                ],
                appImport:
                    './legacy/diagnostics/websocket/websocket-contracts.ts',
                appSeams: [
                    'type:WebSocketCommandCenterValues',
                    'type:WebSocketDiagnostic',
                    'type:WebSocketEventRow',
                    'type:WebSocketPayloadPreset',
                    'type:WebSocketReceivedMessageRow',
                    'type:WebSocketRoutePreview',
                    'type:WebSocketSubscriptionState',
                ],
                imports: [
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestEventKind',
                ],
            },
            {
                path: presetsPath,
                cap: 150,
                exports: [
                    'value:DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID',
                    'value:WEBSOCKET_PAYLOAD_PRESETS',
                    'value:webSocketPayloadPresetById',
                    'value:webSocketPayloadPresetText',
                ],
                appImport:
                    './legacy/diagnostics/websocket/websocket-presets.ts',
                appSeams: [
                    'value:DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID',
                    'value:WEBSOCKET_PAYLOAD_PRESETS',
                    'value:webSocketPayloadPresetById',
                    'value:webSocketPayloadPresetText',
                ],
                imports: [
                    '../../shared/json-presentation.ts|value:json',
                    './websocket-contracts.ts|type:WebSocketPayloadPreset',
                ],
            },
            {
                path: routingPath,
                cap: 280,
                exports: [
                    'value:defaultWebSocketApiUrl',
                    'value:defaultWebSocketScope',
                    'value:defaultWebSocketTopicId',
                    'value:defaultWebSocketTypeId',
                    'value:defaultWebSocketValuesFromContext',
                    'value:resolveWebSocketUrlTemplate',
                    'value:webSocketRoutePreview',
                    'value:webSocketSendData',
                ],
                appImport:
                    './legacy/diagnostics/websocket/websocket-routing.ts',
                appSeams: [
                    'value:defaultWebSocketApiUrl',
                    'value:defaultWebSocketScope',
                    'value:defaultWebSocketTopicId',
                    'value:defaultWebSocketTypeId',
                    'value:defaultWebSocketValuesFromContext',
                    'value:resolveWebSocketUrlTemplate',
                    'value:webSocketRoutePreview',
                ],
                imports: [
                    '@shared/api/api-config.ts|type:AuthSession',
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestConfig',
                    '../../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig',
                    '../../shared/record-value.ts|value:recordValue->optionalRecord',
                    '../../shared/string-value.ts|value:stringValue',
                    '../../shell/global-context-model.ts|type:CommandCenterGlobalValues',
                    '../../shell/rallar-browser-status.ts|type:RallarBrowserStatusSummary',
                    '../shared/auth-command-center-ticket.ts|type:AuthCommandCenterTicket',
                    './websocket-contracts.ts|type:WebSocketCommandCenterValues,type:WebSocketDiagnostic,type:WebSocketRoutePreview',
                    './websocket-presets.ts|value:DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID,value:webSocketPayloadPresetById',
                ],
            },
            {
                path: recipesPath,
                cap: 280,
                exports: [
                    'value:webSocketCommandCenterRecipe',
                ],
                appImport:
                    './legacy/diagnostics/websocket/websocket-recipes.ts',
                appSeams: [
                    'value:webSocketCommandCenterRecipe',
                ],
                imports: [
                    '@shared/api/api-config.ts|type:AuthSession',
                    '@shared-test/rallar-bb-test/redaction.ts|value:redactRallarBlackBoxValue',
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestCommand',
                    '../../../runtime-store.ts|type:RallarBlackBoxBootstrapConfig',
                    '../../shared/json-presentation.ts|value:json',
                    '../../shared/redaction-presentation.ts|value:uiSecretValues',
                    './websocket-contracts.ts|type:WebSocketCommandCenterValues',
                    './websocket-routing.ts|value:webSocketSendData',
                ],
            },
            {
                path: diagnosticsPath,
                cap: 180,
                exports: ['value:deriveWebSocketDiagnostics'],
                appImport:
                    './legacy/diagnostics/websocket/websocket-diagnostics.ts',
                appSeams: ['value:deriveWebSocketDiagnostics'],
                imports: [
                    '@shared-test/rallar-bb-test/selectors.ts|value:selectRallarBlackBoxCommandHistory,value:selectRallarBlackBoxEvents',
                    '@shared-test/rallar-bb-test/types.ts|type:RallarBlackBoxTestState',
                    '../../shared/record-value.ts|value:recordValue->optionalRecord',
                    './websocket-contracts.ts|type:WebSocketDiagnostic',
                ],
            },
        ] as const;
        const ownerStatementInventories = new Map<string, readonly string[]>([
            [sharedTicketPath, [
                'type:AuthCommandCenterTicket',
            ]],
            [contractsPath, [
                'type:WebSocketPayloadPreset',
                'type:WebSocketRoutePreview',
                'type:WebSocketCommandCenterValues',
                'type:WebSocketEventRow',
                'type:WebSocketReceivedMessageRow',
                'type:WebSocketDiagnostic',
                'type:WebSocketSubscriptionState',
            ]],
            [presetsPath, [
                'variable:WEBSOCKET_PAYLOAD_PRESETS',
                'variable:DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID',
                'function:webSocketPayloadPresetText',
                'function:webSocketPayloadPresetById',
            ]],
            [routingPath, [
                'function:defaultWebSocketApiUrl',
                'function:resolveWebSocketUrlTemplate',
                'function:defaultWebSocketTypeId',
                'function:defaultWebSocketTopicId',
                'function:defaultWebSocketScope',
                'function:defaultWebSocketValuesFromContext',
                'function:webSocketSendData',
                'function:webSocketRoutePreview',
            ]],
            [recipesPath, [
                'function:webSocketConfigureCommand',
                'function:webSocketOpenCommand',
                'function:webSocketSendCommand',
                'function:webSocketCloseCommand',
                'function:webSocketCommandCenterRecipe',
            ]],
            [diagnosticsPath, [
                'function:deriveWebSocketDiagnostics',
            ]],
        ]);
        const sources = new Map<string, string>();
        const appImportEdges = task9aImportEdges(appAst);

        for (const owner of owners) {
            const present = existsSync(resolve(repositoryRoot, owner.path));
            expect.soft(present, `${owner.path}: owner exists`).toBe(true);
            if (present) {
                const source = repositorySource(owner.path);
                const sourceFile = task9aSourceFile(owner.path, source);
                sources.set(owner.path, source);
                expect.soft(
                    source.trimEnd().split(/\r?\n/).length,
                    `${owner.path}: line cap`,
                ).toBeLessThanOrEqual(owner.cap);
                expect.soft(
                    task9aExportSeams(sourceFile),
                    `${owner.path}: exact exports`,
                ).toEqual([...owner.exports].sort());
                expect.soft(
                    source,
                    `${owner.path}: no reverse/App/CSS/barrel edge`,
                ).not.toMatch(
                    /(?:App\.tsx['"]|\.css['"]|\/index\.(?:ts|tsx)['"]|\/mod\.(?:ts|tsx)['"])/,
                );
                expect.soft(
                    task9aImportEdges(sourceFile),
                    `${owner.path}: complete exact imports`,
                ).toEqual([...owner.imports].sort());
                const statementInventory = sourceFile.statements.flatMap(
                    (statement): readonly string[] => {
                        if (ts.isImportDeclaration(statement)) return [];
                        if (ts.isTypeAliasDeclaration(statement)) {
                            return [`type:${statement.name.text}`];
                        }
                        if (ts.isFunctionDeclaration(statement)) {
                            return [
                                `function:${statement.name?.text ?? '<anonymous>'}`,
                            ];
                        }
                        if (ts.isVariableStatement(statement)) {
                            return statement.declarationList.declarations.map(
                                (declaration) =>
                                    ts.isIdentifier(declaration.name)
                                        ? `variable:${declaration.name.text}`
                                        : `variable:${declaration.name.getText(sourceFile)}`,
                            );
                        }
                        return [`unexpected:${ts.SyntaxKind[statement.kind]}`];
                    },
                );
                expect.soft(
                    statementInventory,
                    `${owner.path}: exact deterministic top-level inventory`,
                ).toEqual(ownerStatementInventories.get(owner.path));
            }

            const expectedAppImport = `${owner.appImport}|${[
                ...owner.appSeams,
            ].sort().join(',')}`;
            expect.soft(
                appImportEdges.filter((edge) => edge.startsWith(
                    `${owner.appImport}|`,
                )),
                `${owner.appImport}: one exact direct App import`,
            ).toEqual([expectedAppImport]);
        }

        const movedDeclarations = [
            'AuthCommandCenterTicket',
            'WebSocketPayloadPreset',
            'WebSocketRoutePreview',
            'WebSocketCommandCenterValues',
            'WebSocketEventRow',
            'WebSocketReceivedMessageRow',
            'WebSocketDiagnostic',
            'WebSocketSubscriptionState',
            'WEBSOCKET_PAYLOAD_PRESETS',
            'DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID',
            'defaultWebSocketApiUrl',
            'resolveWebSocketUrlTemplate',
            'webSocketPayloadPresetText',
            'defaultWebSocketTypeId',
            'defaultWebSocketTopicId',
            'defaultWebSocketScope',
            'webSocketPayloadPresetById',
            'defaultWebSocketValuesFromContext',
            'webSocketSendData',
            'webSocketRoutePreview',
            'webSocketConfigureCommand',
            'webSocketOpenCommand',
            'webSocketSendCommand',
            'webSocketCloseCommand',
            'webSocketCommandCenterRecipe',
            'deriveWebSocketDiagnostics',
        ] as const;
        for (const declaration of movedDeclarations) {
            expect.soft(
                appSource,
                `App.tsx: moved ${declaration} declaration`,
            ).not.toMatch(
                new RegExp(
                    `^\\s*(?:type|interface|const|let|var|function)\\s+${declaration}\\b`,
                    'm',
                ),
            );
        }

        const topLevelDeclaration = (
            sourceFile: ts.SourceFile,
            name: string,
        ): ts.Statement | undefined => sourceFile.statements.find((statement) => {
            if (
                (ts.isTypeAliasDeclaration(statement) ||
                    ts.isInterfaceDeclaration(statement) ||
                    ts.isFunctionDeclaration(statement) ||
                    ts.isClassDeclaration(statement) ||
                    ts.isEnumDeclaration(statement)) &&
                statement.name?.text === name
            ) return true;
            return ts.isVariableStatement(statement) &&
                statement.declarationList.declarations.some(
                    (declaration) =>
                        ts.isIdentifier(declaration.name) &&
                        declaration.name.text === name,
                );
        });
        const declarationFromOwnerOrApp = (
            ownerPath: string,
            name: string,
        ): ts.Statement => {
            const ownerSource = sources.get(ownerPath);
            const sourceFile = ownerSource
                ? task9aSourceFile(ownerPath, ownerSource)
                : appAst;
            const declaration = topLevelDeclaration(sourceFile, name);
            if (!declaration) {
                throw new Error(`Missing WebSocket seam ${name}`);
            }
            return declaration;
        };
        const semanticNodes = (statement: ts.Statement): readonly ts.Node[] => {
            if (ts.isFunctionDeclaration(statement)) {
                if (!statement.body) throw new Error('Missing function body');
                return [...statement.parameters, statement.body];
            }
            if (ts.isVariableStatement(statement)) {
                return [statement.declarationList];
            }
            if (ts.isTypeAliasDeclaration(statement)) {
                return [
                    statement.name,
                    ...(statement.typeParameters ?? []),
                    statement.type,
                ];
            }
            if (ts.isInterfaceDeclaration(statement)) {
                return [
                    statement.name,
                    ...(statement.typeParameters ?? []),
                    ...statement.heritageClauses ?? [],
                    ...statement.members,
                ];
            }
            throw new Error(
                `Unsupported WebSocket seam ${ts.SyntaxKind[statement.kind]}`,
            );
        };
        const contractNodes = [
            ...semanticNodes(declarationFromOwnerOrApp(
                sharedTicketPath,
                'AuthCommandCenterTicket',
            )),
            ...[
                'WebSocketPayloadPreset',
                'WebSocketRoutePreview',
                'WebSocketCommandCenterValues',
                'WebSocketEventRow',
                'WebSocketReceivedMessageRow',
                'WebSocketDiagnostic',
                'WebSocketSubscriptionState',
            ].flatMap((name) => semanticNodes(
                declarationFromOwnerOrApp(contractsPath, name),
            )),
        ];
        expect.soft(
            task9aAstFingerprint(contractNodes),
            'exact moved WebSocket contracts and shared ticket',
        ).toBe('2f1f713b22722fc5277a53add023c8ac9bfb1b77d0de0a44a5554b3b64a8d3da');
        const groups = [
            [
                presetsPath,
                [
                    'WEBSOCKET_PAYLOAD_PRESETS',
                    'DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID',
                    'webSocketPayloadPresetText',
                    'webSocketPayloadPresetById',
                ],
                'bf275ddf45d34a817f80c1e874f4537371f02fd1e4ca54e5715b6a2e58ff5675',
            ],
            [
                routingPath,
                [
                    'defaultWebSocketApiUrl',
                    'resolveWebSocketUrlTemplate',
                    'defaultWebSocketTypeId',
                    'defaultWebSocketTopicId',
                    'defaultWebSocketScope',
                    'defaultWebSocketValuesFromContext',
                    'webSocketSendData',
                    'webSocketRoutePreview',
                ],
                'f3747e3f41e499e5e0c325b1fadac182e147ebce07fa1dcca2ce93bdaaa6c705',
            ],
            [
                recipesPath,
                [
                    'webSocketConfigureCommand',
                    'webSocketOpenCommand',
                    'webSocketSendCommand',
                    'webSocketCloseCommand',
                    'webSocketCommandCenterRecipe',
                ],
                'f689d278973df0589530fa5885c61571fba154dcbe9f80dfb6f3aee801c97652',
            ],
            [
                diagnosticsPath,
                ['deriveWebSocketDiagnostics'],
                '7e32f0877b28ba62ff050ea8feca9c5ed8cae0062425cb8642d11daf85dbf147',
            ],
        ] as const;
        for (const [ownerPath, declarations, expectedHash] of groups) {
            expect.soft(
                task9aAstFingerprint(
                    declarations.flatMap((name) => semanticNodes(
                        declarationFromOwnerOrApp(ownerPath, name),
                    )),
                ),
                `${ownerPath}: exact moved declaration group`,
            ).toBe(expectedHash);
        }

        const panel = task9aNamedFunction(
            appAst,
            'WebSocketCommandCenterPanel',
        );
        expect.soft(
            task9aAstFingerprint([...panel.parameters, panel.body!]),
            'complete WebSocket panel remains exact in App',
        ).toBe('f352a7e02092e4bbe3154e9e3f6c3b05ee67969b8ee94c95960f76bc824d6b7f');
        expect.soft(
            task9aJsxRuntimeFingerprint(task9aReturnExpression(panel)),
            'complete WebSocket panel JSX remains exact',
        ).toBe('3a61aca27c3848e23c37f55083d850101d8c8effa709f3864e4950690ab80881');

        const app = task9aNamedFunction(appAst, 'App');
        const mounts = task9aJsxCalls(app, 'WebSocketCommandCenterPanel');
        expect.soft(mounts, 'one always-mounted WebSocket panel')
            .toHaveLength(1);
        expect.soft(
            task9aAstFingerprint(mounts),
            'exact WebSocket App mount',
        ).toBe('023a6a866bf37b3d17c915c257a712cfd5ae97703920339eae6159a5bc7b6b17');
        let ancestor: ts.Node | undefined = mounts[0];
        while (ancestor && !ts.isJsxElement(ancestor)) ancestor = ancestor.parent;
        expect.soft(
            ancestor ? task9aAstFingerprint([ancestor]) : '',
            'exact hidden-capable WebSocket ancestor',
        ).toBe('9f5270848d5ad12d3102e23af1c1029f69dfc37c4178d60cb8c33e388f8f1894');
        expect.soft(
            task9aAstFingerprint([app]),
            'unchanged App function',
        ).toBe('9359ca185437ff49b62e1f643f86119ef5a8419a9fe887e4f183e3d82ef96f33');
        expect.soft(appSource, 'no WebSocket lazy/Suspense cutover')
            .not.toMatch(/(?:lazy\s*\(|<Suspense\b)/);
        expect.soft(
            createHash('sha256')
                .update(repositorySource('apps/rallar-black-box/src/styles.css'))
                .digest('hex'),
            'WebSocket support extraction leaves complete stylesheet unchanged',
        ).toBe('9778cfa43e7a858b30a9304b36b2939bfbf89df2722ac05a65b97579a37640b4');
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
