import { describe, expect, it } from 'vitest';
import {
    AnalyzeArtifactModelError,
    createAnalyzeArtifactModel,
    deriveAnalyzeArtifactModel,
    deriveAnalyzeArtifactSearchResult,
    prepareAnalyzeArtifactModel
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-artifact-model.ts';
import { deriveAnalyzePrimaryResultFailure } from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-primary-result-failure.ts';
import type { RecipeConsoleUrlState } from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';
import { deriveDistributedArtifactEvidenceIndex, type DistributedRunArtifactFiles } from '../../../packages/shared-test/rallar-bb-test/mod.ts';
import { createRecipeConsoleScaleFixture } from '../../../packages/shared-test/rallar-bb-test/scale-fixture.ts';

const GENERATED_AT_EPOCH_MS = Date.parse('2026-07-12T14:00:00.000Z');
const TIMEOUT_STACK = [
    'RALLAR_BLACK_BOX_TIMEOUT: Rallar black-box command timeout reached.',
    ' at _t (https://blackbox.rallar.intactss.com/headless/assets/index-DG6wNwRv.js:1:50131)',
    ' at https://blackbox.rallar.intactss.com/headless/assets/index-DG6wNwRv.js:1:62093'
].join('\n');

function coreFiles(
    overrides: DistributedRunArtifactFiles = {}
): DistributedRunArtifactFiles {
    const manifest = {
        schemaVersion: 1,
        distributedRunId: 'distributed-analyze',
        controlRunId: 'control-analyze',
        group: { groupId: 'ci-analyze' },
        recipes: [{ recipeId: 'rtc-stability', profile: 'browser' }],
        targetPolicy: {},
        roleAssignments: [],
        startMode: 'manual'
    };
    return {
        'distributed-run.json': JSON.stringify({
            distributedRunId: 'distributed-analyze',
            controlRunId: 'control-analyze',
            state: 'failed',
            createdAtEpochMs: 100,
            updatedAtEpochMs: 500,
            completedAtEpochMs: 500,
            targetAgentIds: ['agent-eu'],
            commandLinks: [{
                phase: 'start',
                agentId: 'agent-eu',
                recipeId: 'rtc-stability',
                commandId: 'send-rtc',
                queuedAtEpochMs: 120
            }],
            manifest,
            rollup: {
                state: 'failed',
                ok: false,
                failures: [{
                    kind: 'command',
                    key: 'command:send-rtc',
                    state: 'failed',
                    agentId: 'agent-eu',
                    recipeId: 'rtc-stability',
                    commandId: 'send-rtc',
                    error: {
                        code: 'RTC_NO_ROUTE',
                        message: 'TURN allocation was unavailable.'
                    },
                    atEpochMs: 350
                }],
                summary: { blockingFailures: 1 }
            }
        }),
        'manifest.json': JSON.stringify(manifest),
        'control-run.json': JSON.stringify({
            runId: 'control-analyze',
            createdAtEpochMs: 100,
            updatedAtEpochMs: 500,
            agents: [],
            commands: [],
            results: [{
                kind: 'result',
                protocolVersion: 1,
                runId: 'control-analyze',
                agentId: 'agent-eu',
                commandId: 'send-rtc',
                ok: false,
                result: {
                    commandId: 'send-rtc',
                    kind: 'rtc.send',
                    status: 'failed',
                    ok: false,
                    startedAtEpochMs: 200,
                    endedAtEpochMs: 340,
                    durationMs: 140
                },
                error: {
                    code: 'RTC_NO_ROUTE',
                    message: 'TURN allocation was unavailable.'
                }
            }],
            events: [{
                kind: 'diagnostic',
                protocolVersion: 1,
                runId: 'control-analyze',
                agentId: 'agent-eu',
                commandId: 'send-rtc',
                atEpochMs: 320,
                eventId: 'rtc-no-route',
                payload: {
                    topic: 'rtc.route',
                    diagnosticTypeId: 'rallar.browser.rtc.no_route',
                    severity: 'error',
                    transport: 'messages.rtc',
                    message: 'TURN allocation was unavailable.'
                }
            }],
            stats: [],
            reports: [],
            heartbeats: []
        }),
        ...overrides
    };
}

function serverV2Files(): DistributedRunArtifactFiles {
    const files = coreFiles();
    const summary = {
        total: 1,
        success: 0,
        failure: 1,
        commandCount: 1,
        eventCount: 1,
        agentCount: 1,
        reportCount: 0
    };
    return {
        ...files,
        'report.json': JSON.stringify({
            schemaVersion: 2,
            artifactSchemaVersion: 2,
            execution: 'distributed-run',
            distributedRunId: 'distributed-analyze',
            controlRunId: 'control-analyze',
            state: 'failed',
            ok: false,
            summary,
            resultsList: [],
            outputs: {}
        }),
        'failures.json': JSON.stringify({
            summary,
            failures: [{ source: 'distributed-rollup', code: 'RTC_NO_ROUTE' }],
            outputs: {}
        }),
        'metadata.json': JSON.stringify({
            schemaVersion: 2,
            artifactSchemaVersion: 2,
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            config: 'rallar-black-box-control-server',
            execution: 'distributed-run',
            summary
        })
    };
}

function urlState(
    overrides: Partial<RecipeConsoleUrlState> = {}
): RecipeConsoleUrlState {
    return {
        v: 1,
        experience: 'recipe-console',
        view: 'analyze',
        ...overrides
    };
}

describe('Recipe Console Analyze artifact model', () => {
    it('keeps the compatibility model exact while exposing one parsed-pipeline telemetry snapshot', () => {
        const input = {
            files: coreFiles(),
            source: 'local-files' as const,
            label: 'Telemetry-compatible artifact',
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        };
        const derived = deriveAnalyzeArtifactModel(input);

        expect(derived.model).toEqual(createAnalyzeArtifactModel(input));
        expect(derived.pipelineTelemetry).toMatchObject({
            pipelinePassCount: 1,
            sourceCollectionPassCount: 1,
            sourceFileVisitCount: Object.keys(input.files).length,
            jsonDocumentParseCount: 3
        });
        expect(derived.pipelineTelemetry.jsonlFilePassCount).toBeGreaterThanOrEqual(0);
        expect(derived.pipelineTelemetry.jsonlRowParseCount).toBeGreaterThanOrEqual(0);
    });

    it('parses one source pipeline and reuses its monitor and control provenance', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const jsonDocuments = new Set(
            Object.entries(fixture.files)
                .filter(([fileName, text]) => fileName.endsWith('.json') && typeof text === 'string')
                .map(([, text]) => text as string)
        );
        const jsonlRows = new Set(
            Object.entries(fixture.files)
                .filter(([fileName, text]) => fileName.endsWith('.jsonl') && typeof text === 'string')
                .flatMap(([, text]) => (text as string).split(/\r?\n/u))
                .filter((row) => row.trim().length > 0)
        );
        let sourceEnumerationCount = 0;
        const files = new Proxy(fixture.files, {
            ownKeys(target) {
                sourceEnumerationCount += 1;
                return Reflect.ownKeys(target);
            }
        });
        const originalParse = JSON.parse;
        let jsonDocumentParseCount = 0;
        let jsonlRowParseCount = 0;
        let otherJsonParseCount = 0;
        JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
            if (jsonDocuments.has(text)) {
                jsonDocumentParseCount += 1;
            }
            else if (jsonlRows.has(text)) {
                jsonlRowParseCount += 1;
            }
            else {
                otherJsonParseCount += 1;
            }
            return originalParse(text, reviver);
        }) as typeof JSON.parse;
        try {
            const model = createAnalyzeArtifactModel({
                files,
                source: 'local-files',
                label: 'Single-pipeline scale fixture',
                generatedAtEpochMs: fixture.generatedAtEpochMs,
                artifactSchemaVersion: fixture.artifactSchemaVersion
            });

            expect(model.evidenceIndex.monitor.distributedRunId)
                .toBe(model.distributedRunId);
            expect(sourceEnumerationCount).toBe(1);
            expect(jsonDocumentParseCount).toBe(6);
            expect(jsonlRowParseCount).toBe(fixture.counts.sourceRows);
            expect(otherJsonParseCount).toBe(0);
        }
        finally {
            JSON.parse = originalParse;
        }
    });

    it('projects an authoritative server-v2 workspace and a portable re-import envelope', () => {
        const model = createAnalyzeArtifactModel({
            files: serverV2Files(),
            source: 'control',
            label: 'Control run control-analyze',
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            ignoredFiles: [{
                basename: 'worker.log',
                sourcePath: 'bundle/worker.log',
                reason: 'unsupported-extension'
            }]
        });

        expect(model).toMatchObject({
            distributedRunId: 'distributed-analyze',
            identity: {
                distributedRunId: 'distributed-analyze',
                controlRunId: 'control-analyze'
            },
            workspace: {
                support: 'supported',
                artifactSchemaVersion: 2
            },
            analysis: {
                artifactSchemaVersion: 2,
                distributedRunId: 'distributed-analyze'
            },
            portableEnvelope: {
                artifactSchemaVersion: 2,
                distributedRunId: 'distributed-analyze',
                generatedAtEpochMs: GENERATED_AT_EPOCH_MS
            },
            provenance: {
                source: 'control',
                label: 'Control run control-analyze',
                workspaceSource: 'loose-files',
                selectedFileCount: 7,
                artifactFileCount: 6,
                ignoredFileCount: 1
            }
        });
        expect(model.portableEnvelope.files).toEqual(serverV2Files());
        expect(model.provenance.ignoredFiles).toEqual([{
            basename: 'worker.log',
            sourcePath: 'bundle/worker.log',
            reason: 'unsupported-extension'
        }]);

        const reimported = createAnalyzeArtifactModel({
            files: {
                'distributed-analyze-artifact.json': JSON.stringify(
                    model.portableEnvelope
                )
            },
            source: 'local-files',
            label: 'Downloaded envelope'
        });
        expect(reimported.workspace.source).toBe('bundle-envelope');
        expect(reimported.analysis).toEqual(model.analysis);
        expect(reimported.snapshots).toEqual(model.snapshots);
        expect(reimported.provenance).toMatchObject({
            selectedFileCount: 1,
            artifactFileCount: 6
        });
    });

    it('retains an incomplete core workspace and still creates a portable envelope', () => {
        const files = coreFiles({
            'manifest.json': undefined,
            'control-run.json': undefined
        });
        const model = createAnalyzeArtifactModel({
            files,
            source: 'local-files',
            label: 'Partial CI bundle',
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });

        expect(model.workspace.support).toBe('incomplete');
        expect(model.workspace.bundle).toBeUndefined();
        expect(model.analysis.distributedRunId).toBe('distributed-analyze');
        expect(model.snapshots.distributedRun.distributedRunId)
            .toBe('distributed-analyze');
        expect(model.portableEnvelope).toMatchObject({
            artifactSchemaVersion: 1,
            distributedRunId: 'distributed-analyze',
            files: {
                'distributed-run.json': expect.any(String)
            }
        });
        expect(Object.keys(model.portableEnvelope.files))
            .toEqual(['distributed-run.json']);
    });

    it('retains usable analysis when an optional evidence file is malformed', () => {
        const model = createAnalyzeArtifactModel({
            files: coreFiles({ 'events.jsonl': '{not-json\n' }),
            source: 'local-files',
            label: 'Malformed optional evidence',
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });

        expect(model.workspace.inventory).toContainEqual(expect.objectContaining({
            fileName: 'events.jsonl',
            status: 'malformed'
        }));
        expect(model.analysis.parseWarnings).toContainEqual(expect.objectContaining({
            fileName: 'events.jsonl',
            lineNumber: 1
        }));
        expect(model.evidenceIndex.totalEntries).toBeGreaterThan(0);
    });

    it('preserves JSONL provenance when control-run contains no embedded results', () => {
        const files = coreFiles();
        const controlRun = JSON.parse(files['control-run.json'] ?? '{}');
        const [result] = controlRun.results;
        controlRun.results = [];
        const model = createAnalyzeArtifactModel({
            files: {
                ...files,
                'control-run.json': JSON.stringify(controlRun),
                'results.jsonl': `${JSON.stringify(result)}\n`
            },
            source: 'local-files',
            label: 'Linked JSONL evidence',
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });

        expect(
            model.evidenceIndex.entries.find(
                (entry) => entry.kind === 'result'
            )?.sourceFile
        ).toBe('results.jsonl');
    });

    it('rejects generic and unknown artifact families with typed operator errors', () => {
        const generic = () =>
            createAnalyzeArtifactModel({
                files: {
                    'report.json': JSON.stringify({ resultsList: [] }),
                    'metadata.json': JSON.stringify({
                        execution: 'run',
                        config: 'black-box-runner'
                    })
                },
                source: 'local-files',
                label: 'Generic runner export',
                generatedAtEpochMs: GENERATED_AT_EPOCH_MS
            });
        const unknown = () =>
            createAnalyzeArtifactModel({
                files: { 'notes.json': JSON.stringify({ note: 'not a run' }) },
                source: 'local-files',
                label: 'Unknown export',
                generatedAtEpochMs: GENERATED_AT_EPOCH_MS
            });

        expect(generic).toThrowError(AnalyzeArtifactModelError);
        expect(generic).toThrowError(
            'Generic runner export is a generic black-box-runner artifact; use the legacy Shared Test importer.'
        );
        try {
            generic();
        }
        catch (error) {
            expect(error).toMatchObject({
                code: 'generic-artifact-unsupported',
                workspace: { family: 'black-box-runner', support: 'unsupported' }
            });
        }
        try {
            unknown();
        }
        catch (error) {
            expect(error).toMatchObject({
                code: 'unknown-artifact-family',
                workspace: { family: 'unknown', support: 'unsupported' }
            });
        }
    });

    it('retains an unknown schema workspace and preserves the claimed version', () => {
        const model = createAnalyzeArtifactModel({
            files: coreFiles(),
            source: 'local-files',
            label: 'Future artifact',
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            artifactSchemaVersion: 99
        });

        expect(model.workspace.support).toBe('unsupported');
        expect(model.workspace.issues).toContainEqual(expect.objectContaining({
            code: 'unknown-schema-version',
            severity: 'error'
        }));
        expect(model.analysis.artifactSchemaVersion).toBe(99);
        expect(model.portableEnvelope.artifactSchemaVersion).toBe(99);
        expect(model.evidenceIndex.analysis).toBe(model.analysis);
    });

    it('composes issue-ready markdown and selects the first actionable failure', () => {
        const files = coreFiles({ 'events.jsonl': '{not-json\n' });
        const controlRun = JSON.parse(files['control-run.json'] ?? '{}');
        controlRun.results[0].error = {
            code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
            details: {
                name: 'RALLAR_BLACK_BOX_TIMEOUT',
                stack: TIMEOUT_STACK
            },
            message: 'Rallar black-box command timeout reached.'
        };
        const model = createAnalyzeArtifactModel({
            files: { ...files, 'control-run.json': JSON.stringify(controlRun) },
            source: 'local-files',
            label: 'Failed CI run',
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });

        expect(model.issueMarkdown).toContain(
            '# Distributed run distributed-analyze'
        );
        expect(model.issueMarkdown).toContain('## Fix proposal');
        expect(model.issueMarkdown).toContain('## Artifact warnings');
        expect(model.issueMarkdown).toContain('## Source evidence');
        expect(model.firstActionableEvidenceId).toMatch(/^failure:/);
        expect(model.evidenceIndex.entries.find((entry) => entry.id === model.firstActionableEvidenceId)?.kind).toBe('failure');
        expect(model.primaryResultFailure).toEqual({
            evidenceId: expect.stringMatching(/^result:/),
            sourceFile: 'control-run.json',
            failureDetails: {
                code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
                name: 'RALLAR_BLACK_BOX_TIMEOUT',
                message: 'Rallar black-box command timeout reached.',
                stack: TIMEOUT_STACK
            }
        });
        expect(model.evidenceIndex.entries.find((entry) => entry.id === model.primaryResultFailure?.evidenceId)).toMatchObject({
            commandId: model.analysis.failure?.commandId
        });
    });

    it('falls back deterministically when no structured result matches the analysis command', () => {
        const files = coreFiles();
        const controlRun = JSON.parse(files['control-run.json'] ?? '{}');
        controlRun.results[0].error = {
            code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
            details: { name: 'RALLAR_BLACK_BOX_TIMEOUT' },
            message: 'Rallar black-box command timeout reached.'
        };
        const prepared = prepareAnalyzeArtifactModel({
            files: { ...files, 'control-run.json': JSON.stringify(controlRun) },
            source: 'local-files',
            label: 'Unmatched failure command',
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });
        if (!prepared.analysis.failure) {
            throw new Error('Expected failure.');
        }
        const evidenceIndex = deriveDistributedArtifactEvidenceIndex(
            prepared.evidenceInput
        );
        const primaryResultFailure = deriveAnalyzePrimaryResultFailure({
            ...prepared.analysis,
            failure: {
                ...prepared.analysis.failure,
                commandId: 'missing-command'
            }
        }, evidenceIndex.entries);

        expect(primaryResultFailure).toMatchObject({
            evidenceId: expect.stringMatching(/^result:/),
            failureDetails: { name: 'RALLAR_BLACK_BOX_TIMEOUT' }
        });
    });

    it('retains the correlated structured result beyond the bounded evidence index window', () => {
        const fixture = createRecipeConsoleScaleFixture({
            eventCount: 3,
            resultCount: 600
        });
        const model = createAnalyzeArtifactModel({
            files: fixture.files,
            source: 'local-files',
            label: 'Large failed result fixture',
            generatedAtEpochMs: fixture.generatedAtEpochMs
        });

        expect(model.evidenceIndex).toMatchObject({
            limit: 500,
            totalEntries: 606,
            omittedEntryCount: 106
        });
        expect(model.primaryResultFailure).toMatchObject({
            evidenceId: expect.stringMatching(/^result:/),
            failureDetails: {
                code: 'SCALE_UPSTREAM_UNAVAILABLE',
                message: expect.stringContaining('Expected HTTP 200')
            }
        });
        expect(model.evidenceIndex.entries.find((entry) => entry.id === model.primaryResultFailure?.evidenceId)).toMatchObject({
            kind: 'result',
            status: 'failed',
            commandId: model.analysis.failure?.commandId
        });
    });

    it('derives evidence search exclusively from URL-backed Analyze fields', () => {
        const model = createAnalyzeArtifactModel({
            files: coreFiles(),
            source: 'local-files',
            label: 'Searchable CI run',
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });
        const failedCommand = deriveAnalyzeArtifactSearchResult(
            model,
            urlState({
                historyQuery: 'allocation',
                agentId: 'agent-eu',
                recipeId: 'rtc-stability',
                commandId: 'send-rtc',
                status: 'failed'
            })
        );
        const diagnostic = deriveAnalyzeArtifactSearchResult(
            model,
            urlState({
                historyQuery: 'allocation',
                agentId: 'agent-eu',
                commandId: 'send-rtc',
                diagnosticSeverity: 'error',
                transport: 'messages.rtc',
                from: 320,
                to: 320
            })
        );

        expect(failedCommand.entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'result',
                agentId: 'agent-eu',
                recipeId: 'rtc-stability',
                commandId: 'send-rtc',
                status: 'failed'
            })
        ]));
        expect(diagnostic.entries).toEqual([
            expect.objectContaining({
                kind: 'diagnostic',
                atEpochMs: 320,
                severity: 'error',
                transport: 'messages.rtc'
            })
        ]);
    });
});
