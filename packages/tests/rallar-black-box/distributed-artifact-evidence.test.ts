import { describe, expect, it } from 'vitest';
import {
    analyzeDistributedRunArtifactFiles,
    distributedArtifactSnapshotsFromFiles,
    type DistributedRunArtifactFiles,
} from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import {
    composeDistributedArtifactIssueMarkdown,
    deriveDistributedArtifactEvidence,
    deriveDistributedArtifactEvidenceIndex,
    searchDistributedArtifactEvidence,
} from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-evidence.ts';
import {
    deriveDistributedArtifactWorkspace,
    distributedArtifactPipelineJsonRecord,
} from '../../../packages/shared-test/rallar-bb-test/mod.ts';

const GENERATED_AT_EPOCH_MS = Date.parse('2026-07-12T12:00:00.000Z');

function evidenceFiles(): DistributedRunArtifactFiles {
    return {
        'distributed-run.json': JSON.stringify({
            distributedRunId: 'dist-evidence-search',
            controlRunId: 'run-evidence-search',
            state: 'failed',
            createdAtEpochMs: 100,
            completedAtEpochMs: 500,
            targetAgentIds: ['agent-a', 'agent-b'],
            commandLinks: [
                {
                    phase: 'start',
                    agentId: 'agent-a',
                    commandId: 'send-rtc',
                    recipeId: 'rtc-stability',
                    queuedAtEpochMs: 110,
                },
                {
                    phase: 'start',
                    agentId: 'agent-b',
                    commandId: 'receive-rtc',
                    recipeId: 'rtc-stability',
                    queuedAtEpochMs: 115,
                },
            ],
            rollup: {
                ok: false,
                failures: [
                    {
                        kind: 'command',
                        key: 'command:send-rtc',
                        state: 'failed',
                        agentId: 'agent-a',
                        recipeId: 'rtc-stability',
                        commandId: 'send-rtc',
                        error: {
                            code: 'RTC_NO_ROUTE',
                            message: 'No route <script>alert(1)</script>',
                        },
                        atEpochMs: 350,
                    },
                ],
                summary: { blockingFailures: 1 },
            },
            manifest: {
                schemaVersion: 1,
                distributedRunId: 'dist-evidence-search',
                controlRunId: 'run-evidence-search',
                recipes: [{ recipeId: 'rtc-stability', profile: 'browser' }],
                group: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'qa',
                },
                targetPolicy: { mode: 'explicit' },
                roleAssignments: [],
                startMode: 'manual',
            },
        }),
        'control-run.json': JSON.stringify({
            runId: 'run-evidence-search',
            createdAtEpochMs: 100,
            updatedAtEpochMs: 500,
            agents: [],
            commands: [],
            results: [
                {
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'run-evidence-search',
                    agentId: 'agent-a',
                    commandId: 'send-rtc',
                    ok: false,
                    result: {
                        commandId: 'send-rtc',
                        kind: 'rtc.send',
                        status: 'failed',
                        ok: false,
                        startedAtEpochMs: 200,
                        endedAtEpochMs: 340,
                        durationMs: 140,
                        error: { code: 'RTC_NO_ROUTE', message: 'TURN route missing' },
                    },
                    error: { code: 'RTC_NO_ROUTE', message: 'TURN route missing' },
                },
                {
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'run-evidence-search',
                    agentId: 'agent-b',
                    commandId: 'receive-rtc',
                    ok: true,
                    result: {
                        commandId: 'receive-rtc',
                        kind: 'wait',
                        status: 'ok',
                        ok: true,
                        startedAtEpochMs: 210,
                        endedAtEpochMs: 360,
                        durationMs: 150,
                        value: { received: 0 },
                    },
                },
            ],
            events: [
                {
                    kind: 'event',
                    protocolVersion: 1,
                    runId: 'run-evidence-search',
                    agentId: 'agent-b',
                    commandId: 'receive-rtc',
                    atEpochMs: 300,
                    eventId: 'message-received',
                    payload: {
                        topic: 'room.telemetry',
                        message: 'Receiver sample',
                        data: { received: 0, expected: 1 },
                    },
                },
                {
                    kind: 'diagnostic',
                    protocolVersion: 1,
                    runId: 'run-evidence-search',
                    agentId: 'agent-a',
                    commandId: 'send-rtc',
                    atEpochMs: 320,
                    eventId: 'rtc-no-route',
                    payload: {
                        topic: 'rtc.route',
                        diagnosticTypeId: 'rallar.browser.rtc.no_route',
                        severity: 'error',
                        transport: 'messages.rtc',
                        message: 'No TURN route',
                        data: { candidate: 'relay', reason: 'missing allocation' },
                    },
                },
            ],
            stats: [],
            reports: [],
            heartbeats: [],
        }),
        'manifest.json': JSON.stringify({
            recipes: [{ recipeId: 'rtc-stability' }],
        }),
        'events.jsonl': '{invalid-json\n',
    };
}

function evidenceFilesWithoutCommandLinks(): DistributedRunArtifactFiles {
    const files = evidenceFiles();
    const distributedRun = JSON.parse(files['distributed-run.json'] ?? '{}');
    const controlRun = JSON.parse(files['control-run.json'] ?? '{}');
    distributedRun.commandLinks = [];
    controlRun.events.push({
        kind: 'event',
        protocolVersion: 1,
        runId: 'run-evidence-search',
        agentId: 'agent-orphan',
        commandId: 'orphan-command',
        atEpochMs: 410,
        eventId: 'orphan-event',
        payload: {
            topic: 'orphan.topic',
            message: 'Usable unlinked payload evidence',
        },
    });
    controlRun.results.push({
        kind: 'result',
        protocolVersion: 1,
        runId: 'run-evidence-search',
        agentId: 'agent-orphan',
        commandId: 'orphan-command',
        ok: false,
        error: {
            code: 'ORPHAN_FAILURE',
            message: 'Usable unlinked result evidence',
        },
    });
    return {
        ...files,
        'distributed-run.json': JSON.stringify(distributedRun),
        'control-run.json': JSON.stringify(controlRun),
    };
}

describe('distributed artifact evidence index', () => {
    it('derives the same bounded deterministic index from files or precomputed artifacts', () => {
        const files = evidenceFiles();
        const fromFiles = deriveDistributedArtifactEvidence({
            files,
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            indexLimit: 4,
            summaryLimit: 28,
            payloadSummaryLimit: 32,
        });
        const fromPrecomputed = deriveDistributedArtifactEvidenceIndex({
            analysis: analyzeDistributedRunArtifactFiles({
                files,
                generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            }),
            snapshots: distributedArtifactSnapshotsFromFiles(files, GENERATED_AT_EPOCH_MS),
            sourceFileNames: Object.keys(files),
            indexLimit: 4,
            summaryLimit: 28,
            payloadSummaryLimit: 32,
        });

        expect(fromFiles).toEqual(fromPrecomputed);
        expect(fromFiles.totalEntries).toBeGreaterThan(fromFiles.entries.length);
        expect(fromFiles.entries).toHaveLength(4);
        expect(fromFiles.omittedEntryCount).toBe(fromFiles.totalEntries - 4);
        expect(fromFiles.entries.every((entry) => entry.summary.length <= 28)).toBe(true);
        expect(fromFiles.entries.every((entry) => entry.payloadSummary.length <= 32)).toBe(true);
        expect(fromFiles.entries.map((entry) => entry.atEpochMs)).toEqual([320, 340, 340, 500]);
    });

    it('reuses a precomputed monitor and parsed control provenance without JSON reparsing', () => {
        const files = evidenceFiles();
        const derived = deriveDistributedArtifactWorkspace({
            files,
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
        });
        const analysis = derived.workspace.analysis;
        const snapshots = derived.workspace.snapshots;
        if (!analysis || !snapshots || !derived.monitor) {
            throw new Error('Expected derived evidence inputs.');
        }
        const parsedControlRun = distributedArtifactPipelineJsonRecord(
            derived.parsed,
            'control-run.json',
        );
        const controlRunText = files['control-run.json'];
        const originalParse = JSON.parse;
        let controlRunParseCount = 0;
        JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
            if (text === controlRunText) controlRunParseCount += 1;
            return originalParse(text, reviver);
        }) as typeof JSON.parse;
        try {
            const index = deriveDistributedArtifactEvidenceIndex({
                analysis,
                snapshots,
                monitor: derived.monitor,
                parsedControlRun,
                sourceFileNames: Object.keys(derived.parsed.projectedFiles),
                sourceFiles: derived.parsed.projectedFiles,
                indexLimit: 100,
            });

            expect(index.monitor).toBe(derived.monitor);
            expect(controlRunParseCount).toBe(0);
            expect(index.entries.find(entry => entry.kind === 'result'))
                .toMatchObject({ sourceFile: 'control-run.json' });
            expect(index.entries.find(entry => entry.kind === 'diagnostic'))
                .toMatchObject({ sourceFile: 'control-run.json' });
        } finally {
            JSON.parse = originalParse;
        }
    });

    it('indexes failures, results, events, and diagnostics without duplicating diagnostic events', () => {
        const index = deriveDistributedArtifactEvidence({
            files: evidenceFiles(),
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            indexLimit: 100,
        });

        expect(new Set(index.entries.map((entry) => entry.kind))).toEqual(
            new Set(['failure', 'result', 'event', 'diagnostic']),
        );
        expect(index.entries.filter((entry) => entry.id.includes('rtc-no-route'))).toHaveLength(1);
        expect(index.entries.some((entry) => entry.id.startsWith('failure:analysis:'))).toBe(true);
        expect(index.entries.some((entry) => entry.id.startsWith('failure:monitor:'))).toBe(true);
        expect(index.entries.find((entry) => entry.kind === 'diagnostic')).toMatchObject({
            sourceFile: 'control-run.json',
            atEpochMs: 320,
            agentId: 'agent-a',
            recipeId: 'rtc-stability',
            commandId: 'send-rtc',
            topic: 'rtc.route',
            diagnosticType: 'rallar.browser.rtc.no_route',
            severity: 'error',
            transport: 'messages.rtc',
            status: 'diagnostic',
            category: 'diagnostic',
        });
        expect(index.entries.find((entry) => entry.kind === 'result' && entry.commandId === 'send-rtc')).toMatchObject({
            sourceFile: 'control-run.json',
            atEpochMs: 340,
            agentId: 'agent-a',
            recipeId: 'rtc-stability',
            status: 'failed',
            category: 'command',
        });
    });

    it('retains usable result and event rows when a partial run has no command links', () => {
        const index = deriveDistributedArtifactEvidence({
            files: evidenceFilesWithoutCommandLinks(),
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            indexLimit: 100,
        });

        expect(index.entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'result',
                agentId: 'agent-orphan',
                commandId: 'orphan-command',
                summary: 'Usable unlinked result evidence',
            }),
            expect.objectContaining({
                kind: 'event',
                agentId: 'agent-orphan',
                commandId: 'orphan-command',
                topic: 'orphan.topic',
            }),
        ]));
    });

    it('uses collision-safe stable IDs for distinct raw evidence', () => {
        const files = evidenceFiles();
        const controlRun = JSON.parse(files['control-run.json'] ?? '{}');
        controlRun.events.push(
            {
                kind: 'event', protocolVersion: 1,
                runId: 'run-evidence-search', agentId: 'agent-b',
                commandId: 'receive-rtc', atEpochMs: 330,
                eventId: 'collision a', payload: { topic: 'collision', message: 'first' },
            },
            {
                kind: 'event', protocolVersion: 1,
                runId: 'run-evidence-search', agentId: 'agent-b',
                commandId: 'receive-rtc', atEpochMs: 330,
                eventId: 'collision-a', payload: { topic: 'collision', message: 'second' },
            },
        );
        const index = deriveDistributedArtifactEvidence({
            files: { ...files, 'control-run.json': JSON.stringify(controlRun) },
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            indexLimit: 100,
        });
        const collisions = index.entries.filter(entry => entry.topic === 'collision');

        expect(collisions).toHaveLength(2);
        expect(new Set(collisions.map(entry => entry.id)).size).toBe(2);
    });

    it('retains the actionable failure and newest diagnostic when the index is capped', () => {
        const files = evidenceFiles();
        const controlRun = JSON.parse(files['control-run.json'] ?? '{}');
        controlRun.events.push(...Array.from({ length: 12 }, (_, index) => ({
            kind: index === 11 ? 'diagnostic' : 'event',
            protocolVersion: 1,
            runId: 'run-evidence-search',
            agentId: 'agent-b',
            commandId: 'receive-rtc',
            atEpochMs: 600 + index,
            eventId: `bounded-${index}`,
            payload: index === 11
                ? {
                    topic: 'latest.diagnostic',
                    diagnosticTypeId: 'latest-actionable-diagnostic',
                    severity: 'error',
                    message: 'Newest diagnostic evidence',
                }
                : { topic: 'bounded.noise', message: `noise ${index}` },
        })));
        const index = deriveDistributedArtifactEvidence({
            files: { ...files, 'control-run.json': JSON.stringify(controlRun) },
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            indexLimit: 2,
        });

        expect(index.entries).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: expect.stringMatching(/^failure:analysis:/) }),
            expect.objectContaining({ diagnosticType: 'latest-actionable-diagnostic' }),
        ]));
        expect(index.omittedEntryCount).toBe(index.totalEntries - 2);
    });

    it('points JSONL fallback rows at the file that actually supplied them', () => {
        const files = evidenceFiles();
        const controlRun = JSON.parse(files['control-run.json'] ?? '{}');
        const result = controlRun.results[0];
        const event = controlRun.events[0];
        controlRun.results = [];
        controlRun.events = [];
        const index = deriveDistributedArtifactEvidence({
            files: {
                ...files,
                'control-run.json': JSON.stringify(controlRun),
                'results.jsonl': `${JSON.stringify(result)}\n`,
                'events.jsonl': `${JSON.stringify(event)}\n`,
            },
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            indexLimit: 100,
        });

        expect(index.entries.find(entry => entry.kind === 'result'))
            .toMatchObject({ sourceFile: 'results.jsonl' });
        expect(index.entries.find(entry => entry.kind === 'event'))
            .toMatchObject({ sourceFile: 'events.jsonl' });
    });
});

describe('distributed artifact evidence search', () => {
    it('matches every searchable evidence field case-insensitively', () => {
        const index = deriveDistributedArtifactEvidence({
            files: evidenceFiles(),
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            indexLimit: 100,
        });

        for (const query of [
            'AGENT-A',
            'send-rtc',
            'rtc-stability',
            'rtc.route',
            'rallar.browser.rtc.no_route',
            'missing allocation',
            'diagnostic',
        ]) {
            expect(searchDistributedArtifactEvidence(index, { query }).totalMatches, query).toBeGreaterThan(0);
        }
    });

    it('combines structured filters with AND, treats time bounds as inclusive, and reports exact omissions', () => {
        const index = deriveDistributedArtifactEvidence({
            files: evidenceFiles(),
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            indexLimit: 100,
        });
        const result = searchDistributedArtifactEvidence(index, {
            agentId: 'agent-a',
            recipeId: 'rtc-stability',
            commandId: 'send-rtc',
            status: 'diagnostic',
            severity: 'error',
            transport: 'messages.rtc',
            category: 'diagnostic',
            fromEpochMs: 320,
            toEpochMs: 320,
            limit: 1,
        });

        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.diagnosticType).toBe('rallar.browser.rtc.no_route');
        expect(result.totalMatches).toBe(1);
        expect(result.omittedMatchCount).toBe(0);

        const capped = searchDistributedArtifactEvidence(index, {
            query: 'rtc-stability',
            limit: 2,
        });
        expect(capped.entries).toHaveLength(2);
        expect(capped.omittedMatchCount).toBe(capped.totalMatches - 2);
        expect(capped).toMatchObject({
            upstreamOmittedEntryCount: 0,
            totalMatchesIsComplete: true,
        });

        const maximums = deriveDistributedArtifactEvidence({
            files: evidenceFiles(),
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            indexLimit: Number.MAX_SAFE_INTEGER,
        });
        expect(maximums.limit).toBe(2_000);
        expect(
            searchDistributedArtifactEvidence(maximums, {
                limit: Number.MAX_SAFE_INTEGER,
            }).limit,
        ).toBe(500);

        const boundedIndex = deriveDistributedArtifactEvidence({
            files: evidenceFiles(),
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            indexLimit: 1,
        });
        expect(searchDistributedArtifactEvidence(boundedIndex, {
            query: 'definitely-not-in-retained-evidence',
        })).toMatchObject({
            totalMatches: 0,
            upstreamOmittedEntryCount: boundedIndex.omittedEntryCount,
            totalMatchesIsComplete: false,
        });
    });

    it('searches every affected agent and treats passed as an alias of ok', () => {
        const files = evidenceFiles();
        const analysis = analyzeDistributedRunArtifactFiles({
            files,
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
        });
        if (!analysis.failure) throw new Error('Expected deterministic failure.');
        const index = deriveDistributedArtifactEvidenceIndex({
            analysis: {
                ...analysis,
                failure: {
                    ...analysis.failure,
                    affectedAgents: ['agent-a', 'agent-b'],
                },
            },
            snapshots: distributedArtifactSnapshotsFromFiles(
                files,
                GENERATED_AT_EPOCH_MS,
            ),
            sourceFileNames: Object.keys(files),
            indexLimit: 100,
        });

        expect(searchDistributedArtifactEvidence(index, {
            agentId: 'agent-b',
            query: 'No route',
            status: 'failed',
        }).entries).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: expect.stringMatching(/^failure:analysis:/) }),
        ]));
        expect(searchDistributedArtifactEvidence(index, {
            commandId: 'receive-rtc',
            status: 'passed',
        }).entries).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'result', status: 'ok' }),
        ]));
    });
});

describe('distributed artifact issue markdown', () => {
    it('composes bounded issue-ready markdown with warnings, source evidence, and a labeled likely trail', () => {
        const index = deriveDistributedArtifactEvidence({
            files: evidenceFiles(),
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            indexLimit: 100,
        });
        const result = searchDistributedArtifactEvidence(index, {
            query: 'no route',
            limit: 10,
        });
        const markdown = composeDistributedArtifactIssueMarkdown({
            analysis: index.analysis,
            index,
            searchResult: result,
            maxCausalTrailItems: 2,
        });

        expect(markdown).toContain('# Distributed run dist-evidence-search');
        expect(markdown).toContain('## Artifact warnings');
        expect(markdown).toContain('events.jsonl');
        expect(markdown).toContain('## Likely causal trail');
        expect(markdown).toContain('Likely, not proven');
        expect(markdown).toContain('## Source evidence');
        expect(markdown).toContain('control-run.json');
        expect(markdown).toContain('## Fix proposal');
        expect(markdown).not.toContain('## Summary\n\n# Distributed Run Analysis');
        expect(markdown).not.toMatch(/<\/?[a-z][^>]*>/i);
    });
});
