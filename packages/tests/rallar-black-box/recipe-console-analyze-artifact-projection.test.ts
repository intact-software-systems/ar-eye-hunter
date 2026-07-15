import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAnalyzeArtifactModel } from
    '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-artifact-model.ts';
import type { AnalyzeArtifactModel } from
    '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-artifact-model.ts';
import {
    ANALYZE_PROJECTION_MAX_ARRAY_LENGTH,
    ANALYZE_PROJECTION_MAX_SERIALIZED_BYTES,
    ANALYZE_PROJECTION_MAX_TEXT_BYTES,
    projectAnalyzeArtifactModel,
    projectAnalyzeEvidenceEntry,
    projectAnalyzeEvidenceWindow,
    projectAnalyzeTuneArtifactFacade,
} from
    '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-artifact-projection.ts';
import { createRecipeConsoleScaleFixture } from
    '../../../packages/shared-test/rallar-bb-test/scale-fixture.ts';
import { deriveTuneWorkspaceSourceModel } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-workspace-source-model.ts';
import type {
    DistributedArtifactEvidenceEntry,
    DistributedArtifactEvidenceWindow,
} from '../../../packages/shared-test/rallar-bb-test/mod.ts';

describe('Recipe Console Analyze artifact projection', () => {
    it('keeps projection ownership split into capped cohesive modules', () => {
        const modules = [
            'analyze-projection-bounds.ts',
            'analyze-analysis-projection.ts',
            'analyze-verdict-projection.ts',
            'analyze-performance-projection.ts',
            'analyze-artifact-display-projection.ts',
            'analyze-evidence-projection.ts',
            'analyze-tune-projection.ts',
            'analyze-tune-projection-rows.ts',
            'analyze-tune-fallback.ts',
        ];
        for (const fileName of modules) {
            const source = projectionSource(fileName);
            expect(source.split(/\r?\n/).length, fileName).toBeLessThanOrEqual(300);
        }
        const facade = projectionSource('analyze-artifact-projection.ts');
        expect(facade.split(/\r?\n/).length).toBeLessThanOrEqual(40);
        expect(facade).not.toMatch(/\bfunction\b/);
    });

    it('retains the bounded verdict and causal trail without report or raw evidence', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const model = createAnalyzeArtifactModel({
            files: fixture.files,
            source: 'local-files',
            label: 'Projection fixture',
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            artifactSchemaVersion: fixture.artifactSchemaVersion,
        });

        const projection = projectAnalyzeArtifactModel(model);

        expect(projection.analysis.spa?.verdict).toEqual(model.analysis.spa?.verdict);
        expect(projection.analysis.failure?.affectedAgents)
            .toEqual(model.analysis.failure?.affectedAgents);
        expect(projection.analysis.targetResolution?.targetAgentIds)
            .toEqual(model.analysis.targetResolution?.targetAgentIds);
        expect(projection.analysis.spa).not.toHaveProperty('report');
        expect(recursiveKeys(projection).some(key =>
            key.toLocaleLowerCase().startsWith('raw')
        )).toBe(false);
        expect(projection.workspace).not.toHaveProperty('files');
    });

    it('retains bounded non-URL-safe artifact identities for exact safety warnings', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const base = createAnalyzeArtifactModel({
            files: fixture.files,
            source: 'local-files',
            label: 'Unsafe identity fixture',
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            artifactSchemaVersion: fixture.artifactSchemaVersion,
        });
        const distributedRunId = `../dist-\u202e/${'x'.repeat(300)}`;
        const controlRunId = 'control-\u2066unsafe';
        const projection = projectAnalyzeArtifactModel({
            ...base,
            distributedRunId,
            controlRunId,
            identity: { distributedRunId, controlRunId },
        });

        expect(projection.distributedRunId).toBe(distributedRunId);
        expect(projection.identity).toEqual({ distributedRunId, controlRunId });
    });

    it('keeps URL-safe multibyte identities exact across Tune authority surfaces', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const base = createAnalyzeArtifactModel({
            files: fixture.files,
            source: 'local-files',
            label: 'Multibyte identity fixture',
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            artifactSchemaVersion: fixture.artifactSchemaVersion,
        });
        const distributedRunId = '界'.repeat(256);
        const controlRunId = 'é'.repeat(256);
        const model: AnalyzeArtifactModel = {
            ...base,
            distributedRunId,
            controlRunId,
            identity: { distributedRunId, controlRunId },
            analysis: { ...base.analysis, distributedRunId, controlRunId },
            snapshots: {
                ...base.snapshots,
                distributedRun: {
                    ...base.snapshots.distributedRun,
                    distributedRunId,
                    controlRunId,
                    manifest: {
                        ...base.snapshots.distributedRun.manifest,
                        distributedRunId,
                        controlRunId,
                    },
                },
            },
        };

        const facade = projectAnalyzeTuneArtifactFacade(model, {
            focusRunId: distributedRunId,
        });

        expect(distributedRunId).toHaveLength(256);
        expect(new TextEncoder().encode(distributedRunId).byteLength).toBe(768);
        expect(facade).toMatchObject({
            identity: { distributedRunId, controlRunId },
            manifestSummary: { distributedRunId, controlRunId },
            distributedRun: { distributedRunId, controlRunId },
            analysis: { distributedRunId, controlRunId },
            selection: { focusRunId: distributedRunId, artifactRole: 'focus' },
            candidateManifest: { distributedRunId, controlRunId },
        });

        const source = deriveTuneWorkspaceSourceModel({
            urlState: {
                v: 1,
                experience: 'recipe-console',
                view: 'tune',
                distributedRunId,
                controlRunId,
            },
            query: {
                status: 'offline',
                reachability: 'unreachable',
                authorization: 'ready',
                isRefreshing: false,
            },
            retained: { status: 'ready', model: facade },
        });
        expect(source.provenance.source).toBe('artifact');
        expect(source.retained.relation).toBe('matching');
    });

    it('bounds every artifact projection string, array, and serialized byte payload', () => {
        const model = hostileAnalyzeModel();

        const projection = projectAnalyzeArtifactModel(model);

        expect(maxArrayLength(projection)).toBeLessThanOrEqual(
            ANALYZE_PROJECTION_MAX_ARRAY_LENGTH,
        );
        expect(maxUtf8StringBytes(projection)).toBeLessThanOrEqual(
            ANALYZE_PROJECTION_MAX_TEXT_BYTES,
        );
        expect(serializedBytes(projection)).toBeLessThanOrEqual(
            ANALYZE_PROJECTION_MAX_SERIALIZED_BYTES,
        );
        expect(projection.identity.distributedRunId).toMatch(/^opaque-id:/);
        expect(projection.firstActionableEvidenceId).toMatch(/^opaque-id:/);
        expect(projection.primaryResultFailure?.evidenceId).toMatch(/^opaque-id:/);
        expect(new TextEncoder().encode(
            projection.primaryResultFailure?.sourceFile,
        ).byteLength).toBeLessThanOrEqual(ANALYZE_PROJECTION_MAX_TEXT_BYTES);
        expect(projection.primaryResultFailure?.failureDetails).toMatchObject({
            code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
            name: 'RALLAR_BLACK_BOX_TIMEOUT',
            message: 'Rallar black-box command timeout reached.',
        });
        expect(projection.primaryResultFailure?.failureDetails)
            .not.toHaveProperty('stack');
    });

    it('keeps the retained stack in the normal primary-result projection', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const base = createAnalyzeArtifactModel({
            files: fixture.files,
            source: 'local-files',
            label: 'Normal primary result fixture',
            generatedAtEpochMs: fixture.generatedAtEpochMs,
        });
        const projection = projectAnalyzeArtifactModel({
            ...base,
            primaryResultFailure: {
                evidenceId: `${HUGE_TEXT}-primary-result`,
                sourceFile: 'results.jsonl',
                failureDetails: {
                    code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
                    name: 'RALLAR_BLACK_BOX_TIMEOUT',
                    message: 'Rallar black-box command timeout reached.',
                    stack: 'RALLAR_BLACK_BOX_TIMEOUT: timeout\n at command.ts:4:2',
                },
            },
        });

        expect(projection.primaryResultFailure).toEqual({
            evidenceId: expect.stringMatching(/^opaque-id:/),
            sourceFile: 'results.jsonl',
            failureDetails: {
                code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
                name: 'RALLAR_BLACK_BOX_TIMEOUT',
                message: 'Rallar black-box command timeout reached.',
                stack: 'RALLAR_BLACK_BOX_TIMEOUT: timeout\n at command.ts:4:2',
            },
        });
    });

    it('projects evidence metadata recursively and retains deterministic opaque selection handles', () => {
        const hostileId = `${HUGE_TEXT}-evidence-a`;
        const otherHostileId = `${HUGE_TEXT}-evidence-b`;
        const entry = hostileEvidenceEntry(hostileId);
        const normal = hostileEvidenceEntry('evidence-42');

        const projected = projectAnalyzeEvidenceEntry(entry);
        const repeated = projectAnalyzeEvidenceEntry(entry);
        const other = projectAnalyzeEvidenceEntry(hostileEvidenceEntry(otherHostileId));
        const window = projectAnalyzeEvidenceWindow(hostileEvidenceWindow(entry));

        expect(projected.id).toMatch(/^opaque-id:/);
        expect(repeated.id).toBe(projected.id);
        expect(other.id).not.toBe(projected.id);
        expect(projectAnalyzeEvidenceEntry(normal).id).toBe('evidence-42');
        for (const value of [projected, window]) {
            expect(maxArrayLength(value)).toBeLessThanOrEqual(
                ANALYZE_PROJECTION_MAX_ARRAY_LENGTH,
            );
            expect(maxUtf8StringBytes(value)).toBeLessThanOrEqual(
                ANALYZE_PROJECTION_MAX_TEXT_BYTES,
            );
            expect(serializedBytes(value)).toBeLessThanOrEqual(
                ANALYZE_PROJECTION_MAX_SERIALIZED_BYTES,
            );
        }
        expect(window.entries).toHaveLength(64);
        expect(projected.agentIds?.length).toBeLessThanOrEqual(
            ANALYZE_PROJECTION_MAX_ARRAY_LENGTH,
        );
        expect(window.entries[0]).not.toHaveProperty('agentIds');
        expect(window.previousCursor).toBe('signed-cursor-previous');
        expect(window.nextCursor).toBe('signed-cursor-next');
        expect(projected.failureDetails).toMatchObject({
            code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
            name: 'RALLAR_BLACK_BOX_TIMEOUT',
            message: 'Rallar black-box command timeout reached.',
            stack: expect.any(String),
        });
        expect(new TextEncoder().encode(projected.failureDetails?.stack).byteLength)
            .toBeLessThanOrEqual(ANALYZE_PROJECTION_MAX_TEXT_BYTES);
        expect(window.entries[0]?.failureDetails).toEqual({
            code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
            name: 'RALLAR_BLACK_BOX_TIMEOUT',
            message: 'Rallar black-box command timeout reached.',
        });
    });

    it('bounds Tune display data and never truncates a candidate manifest into authority', () => {
        const model = hostileAnalyzeModel();

        const facade = projectAnalyzeTuneArtifactFacade(model, {
            focusRunId: model.distributedRunId,
            compareLeft: HUGE_TEXT,
            compareRight: `${HUGE_TEXT}-right`,
            timingMetric: HUGE_TEXT,
        });

        expect(maxArrayLength(facade)).toBeLessThanOrEqual(
            ANALYZE_PROJECTION_MAX_ARRAY_LENGTH,
        );
        expect(oversizedStringPaths(facade)).toEqual([]);
        expect(serializedBytes(facade)).toBeLessThanOrEqual(
            ANALYZE_PROJECTION_MAX_SERIALIZED_BYTES,
        );
        expect(facade).not.toHaveProperty('candidateManifest');
        expect(facade.candidateManifestOmittedReason).toBe('manifest-too-large');
        expect(facade.selection.artifactRole).toBe('focus');
        expect(facade.identity.distributedRunId).toMatch(/^opaque-id:/);
        expect(facade.manifestSummary.group.applicationId).toContain('…');
        expect(facade.receivedMessageDeltas).toMatchObject({
            total: 2,
            omitted: 2,
        });
    });

    it('joins measured receiver expectations without inventing missing Tune deltas', () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const base = createAnalyzeArtifactModel({
            files: fixture.files,
            source: 'local-files',
            label: 'Receiver fixture',
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            artifactSchemaVersion: fixture.artifactSchemaVersion,
        });
        const performance = base.analysis.performance;
        if (!performance) throw new Error('Scale fixture must include performance.');
        const model = {
            ...base,
            analysis: {
                ...base.analysis,
                performance: {
                    ...performance,
                    receiverDelivery: {
                        sampleCount: 2,
                        lowestAgents: [
                            {
                                agentId: 'measured-agent',
                                receivedMessages: 8,
                                expectedInboundMessages: 10,
                            },
                            {
                                agentId: 'unknown-agent',
                                receivedMessages: 4,
                            },
                            {
                                agentId: 'overflow-agent',
                                receivedMessages: Number.MAX_VALUE,
                                expectedInboundMessages: -Number.MAX_VALUE,
                            },
                        ],
                    },
                },
            },
            snapshots: {
                ...base.snapshots,
                controlRun: {
                    ...base.snapshots.controlRun,
                    stats: [
                        statsEnvelope('measured-agent', 8),
                        statsEnvelope('overflow-agent', Number.MAX_VALUE),
                        statsEnvelope('unknown-agent', 4),
                    ],
                },
            },
        } satisfies AnalyzeArtifactModel;

        const facade = projectAnalyzeTuneArtifactFacade(model);

        expect(facade.receivedMessageDeltas.entries).toEqual([
            {
                agentId: 'measured-agent',
                receivedMessages: 8,
                expectedMessages: 10,
                delta: -2,
            },
            {
                agentId: 'overflow-agent',
                receivedMessages: Number.MAX_VALUE,
                expectedMessages: -Number.MAX_VALUE,
            },
            {
                agentId: 'unknown-agent',
                receivedMessages: 4,
            },
        ]);
        expect(facade.receivedMessageDeltas.entries.find(
            row => row.agentId === 'overflow-agent'
        )).not.toHaveProperty('delta');
    });
});

const HUGE_TEXT = 'hostile-æøå-🧪'.repeat(100_000);
const OVERSIZED_TEXT = 'oversized-æøå-🧪'.repeat(1_000);
const ESCAPED_OVERSIZED_TEXT = '\\"'.repeat(10_000);

function hostileAnalyzeModel(): AnalyzeArtifactModel {
    const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
    const base = createAnalyzeArtifactModel({
        files: fixture.files,
        source: 'local-files',
        label: 'Projection fixture',
        generatedAtEpochMs: fixture.generatedAtEpochMs,
        artifactSchemaVersion: fixture.artifactSchemaVersion,
    });
    const repeated = Array.from(
        { length: ANALYZE_PROJECTION_MAX_ARRAY_LENGTH + 40 },
        (_, index) => index === 0
            ? OVERSIZED_TEXT
            : `hostile-row-${index}-${'x'.repeat(4_096)}`,
    );
    const manifest = {
        ...base.snapshots.distributedRun.manifest,
        distributedRunId: HUGE_TEXT,
        controlRunId: `${HUGE_TEXT}-control`,
        displayName: OVERSIZED_TEXT,
        group: {
            applicationId: OVERSIZED_TEXT,
            workspaceId: `${OVERSIZED_TEXT}-workspace`,
            groupId: `${OVERSIZED_TEXT}-group`,
        },
        recipes: repeated.map((recipeId, index) => ({
            recipeId,
            recipe: { recipeId, commands: [], variables: { [recipeId]: HUGE_TEXT } },
            role: `${OVERSIZED_TEXT}-${index}`,
        })),
        targetPolicy: {
            ...base.snapshots.distributedRun.manifest.targetPolicy,
            agentIds: repeated,
            roles: Object.fromEntries(repeated.map(value => [value, value])),
        },
    };
    const verdict = base.analysis.spa?.verdict;
    if (!verdict) throw new Error('Scale fixture must contain an SPA verdict.');
    return {
        ...base,
        distributedRunId: HUGE_TEXT,
        controlRunId: `${HUGE_TEXT}-control`,
        identity: {
            distributedRunId: HUGE_TEXT,
            controlRunId: `${HUGE_TEXT}-control`,
        },
        workspace: {
            ...base.workspace,
            inventory: repeated.map(fileName => ({
                fileName,
                status: 'loaded' as const,
                requirement: 'recognized' as const,
                message: OVERSIZED_TEXT,
            })),
            issues: repeated.map(fileName => ({
                code: 'ignored-file' as const,
                severity: 'warning' as const,
                fileName,
                message: OVERSIZED_TEXT,
            })),
        },
        analysis: {
            ...base.analysis,
            distributedRunId: HUGE_TEXT,
            controlRunId: `${HUGE_TEXT}-control`,
            status: OVERSIZED_TEXT,
            group: {
                applicationId: OVERSIZED_TEXT,
                workspaceId: `${OVERSIZED_TEXT}-workspace`,
                groupId: `${OVERSIZED_TEXT}-group`,
            },
            parseWarnings: repeated.map(fileName => ({
                fileName,
                message: OVERSIZED_TEXT,
            })),
            targetResolution: {
                selected: repeated.length,
                missingExpectedParticipants: 0,
                blockers: 0,
                staleAgents: 0,
                offlineAgents: 0,
                wrongGroupAgents: 0,
                agentsWithoutIdentity: 0,
                roleCounts: Object.fromEntries(repeated.map(value => [value, 1])),
                regions: Object.fromEntries(repeated.map(value => [value, 1])),
                providers: Object.fromEntries(repeated.map(value => [value, 1])),
                targetAgentIds: repeated,
                blockingAgentIds: repeated,
            },
            spa: {
                ...base.analysis.spa,
                verdict: {
                    ...verdict,
                    title: OVERSIZED_TEXT,
                    summary: OVERSIZED_TEXT,
                    artifactMessage: OVERSIZED_TEXT,
                    runId: HUGE_TEXT,
                    primaryEvidence: repeated.map(value => ({
                        label: value,
                        value: OVERSIZED_TEXT,
                        tone: 'warn' as const,
                        detail: OVERSIZED_TEXT,
                    })),
                    successSignals: repeated,
                    warningSignals: repeated,
                    causalTrail: repeated.map(value => ({
                        kind: 'diagnostic' as const,
                        label: value,
                        detail: OVERSIZED_TEXT,
                        tone: 'warn' as const,
                        targetId: value,
                        agentId: value,
                        evidence: repeated,
                    })),
                },
            },
            summaryMarkdown: OVERSIZED_TEXT,
            fixProposalMarkdown: OVERSIZED_TEXT,
            performanceMarkdown: OVERSIZED_TEXT,
        },
        snapshots: {
            ...base.snapshots,
            distributedRun: {
                ...base.snapshots.distributedRun,
                distributedRunId: HUGE_TEXT,
                controlRunId: `${HUGE_TEXT}-control`,
                targetAgentIds: repeated,
                manifest,
                rollup: {
                    ...base.snapshots.distributedRun.rollup,
                    state: OVERSIZED_TEXT,
                    failures: repeated.map(value => ({
                        agentId: value,
                        message: OVERSIZED_TEXT,
                    })),
                },
            },
            controlRun: {
                ...base.snapshots.controlRun,
                stats: repeated.map((_, index) => ({
                    agentId: `repeated-agent-${index % 2}`,
                    atEpochMs: fixture.generatedAtEpochMs,
                    payload: { counters: { messages: 1 }, summary: OVERSIZED_TEXT },
                })),
            },
        },
        issueMarkdown: OVERSIZED_TEXT,
        provenance: {
            ...base.provenance,
            label: OVERSIZED_TEXT,
            ignoredFiles: repeated.map(value => ({
                basename: value,
                sourcePath: value,
                reason: OVERSIZED_TEXT,
            })),
        },
        firstActionableEvidenceId: `${HUGE_TEXT}-first-evidence`,
        primaryResultFailure: {
            evidenceId: `${HUGE_TEXT}-result-evidence`,
            sourceFile: OVERSIZED_TEXT,
            failureDetails: {
                code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
                name: 'RALLAR_BLACK_BOX_TIMEOUT',
                message: 'Rallar black-box command timeout reached.',
                stack: OVERSIZED_TEXT,
            },
        },
    } as unknown as AnalyzeArtifactModel;
}

function hostileEvidenceEntry(id: string): DistributedArtifactEvidenceEntry {
    return {
        id,
        kind: 'result',
        sourceFile: ESCAPED_OVERSIZED_TEXT,
        agentId: OVERSIZED_TEXT,
        agentIds: Array.from(
            { length: ANALYZE_PROJECTION_MAX_ARRAY_LENGTH + 40 },
            (_, index) => index === 0
                ? OVERSIZED_TEXT
                : `hostile-agent-${index}-${'x'.repeat(4_096)}`,
        ),
        recipeId: OVERSIZED_TEXT,
        commandId: OVERSIZED_TEXT,
        topic: ESCAPED_OVERSIZED_TEXT,
        diagnosticType: ESCAPED_OVERSIZED_TEXT,
        severity: ESCAPED_OVERSIZED_TEXT,
        transport: ESCAPED_OVERSIZED_TEXT,
        status: 'failed',
        category: ESCAPED_OVERSIZED_TEXT,
        summary: ESCAPED_OVERSIZED_TEXT,
        payloadSummary: ESCAPED_OVERSIZED_TEXT,
        failureDetails: {
            code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
            name: 'RALLAR_BLACK_BOX_TIMEOUT',
            message: 'Rallar black-box command timeout reached.',
            stack: ESCAPED_OVERSIZED_TEXT,
        },
    };
}

function hostileEvidenceWindow(
    entry: DistributedArtifactEvidenceEntry,
): DistributedArtifactEvidenceWindow {
    return {
        entries: [
            entry,
            ...Array.from({ length: 89 }, (_, index) =>
                hostileEvidenceEntry(`normal-evidence-${index}`)
            ),
        ],
        rangeStart: 0,
        rangeEnd: 89,
        previousCursor: 'signed-cursor-previous' as
            DistributedArtifactEvidenceWindow['previousCursor'],
        nextCursor: 'signed-cursor-next' as
            DistributedArtifactEvidenceWindow['nextCursor'],
        counts: {
            totalEntries: 90,
            indexedEntries: 90,
            indexOmittedEntries: 0,
            retainedMatches: 90,
            queryExcludedEntries: 0,
            renderedMatches: 90,
            renderOmittedMatches: 0,
        },
        totalMatchesIsComplete: true,
        windowSize: 90,
    };
}

function statsEnvelope(agentId: string, receivedMessages: number) {
    return {
        kind: 'stats' as const,
        protocolVersion: 1 as const,
        runId: 'receiver-control-run',
        agentId,
        atEpochMs: 1,
        payload: { counters: { messages: receivedMessages } },
    };
}

function recursiveKeys(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap(recursiveKeys);
    return Object.entries(value).flatMap(([key, child]) => [
        key,
        ...recursiveKeys(child),
    ]);
}

function maxArrayLength(value: unknown): number {
    if (!value || typeof value !== 'object') return 0;
    if (Array.isArray(value)) {
        return Math.max(value.length, ...value.map(maxArrayLength));
    }
    return Math.max(0, ...Object.values(value).map(maxArrayLength));
}

function maxUtf8StringBytes(value: unknown): number {
    if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
    if (!value || typeof value !== 'object') return 0;
    if (Array.isArray(value)) {
        return Math.max(0, ...value.map(maxUtf8StringBytes));
    }
    return Math.max(
        0,
        ...Object.entries(value).flatMap(([key, child]) => [
            new TextEncoder().encode(key).byteLength,
            maxUtf8StringBytes(child),
        ]),
    );
}

function serializedBytes(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function projectionSource(fileName: string): string {
    return readFileSync(new URL(
        `../../../apps/rallar-black-box/src/recipe-console/analyze/${fileName}`,
        import.meta.url,
    ), 'utf8');
}

function oversizedStringPaths(value: unknown, path = '$'): string[] {
    if (typeof value === 'string') {
        return new TextEncoder().encode(value).byteLength >
                ANALYZE_PROJECTION_MAX_TEXT_BYTES
            ? [`${path} (${new TextEncoder().encode(value).byteLength} bytes)`]
            : [];
    }
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) {
        return value.flatMap((child, index) =>
            oversizedStringPaths(child, `${path}[${index}]`)
        );
    }
    return Object.entries(value).flatMap(([key, child]) => [
        ...(new TextEncoder().encode(key).byteLength >
                ANALYZE_PROJECTION_MAX_TEXT_BYTES
            ? [`${path}.{key:${key.slice(0, 20)}}`]
            : []),
        ...oversizedStringPaths(child, `${path}.${key}`),
    ]);
}
