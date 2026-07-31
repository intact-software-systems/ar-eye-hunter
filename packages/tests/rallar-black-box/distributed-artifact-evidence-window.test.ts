import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
    MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES,
    deriveDistributedArtifactEvidenceIndex,
    deriveDistributedArtifactEvidenceCollections,
    searchDistributedArtifactEvidence,
    searchDistributedArtifactEvidenceWindow,
    type DeriveDistributedArtifactEvidenceIndexInput,
    type DistributedArtifactEvidenceCatalog,
    type DistributedArtifactEvidenceCursor,
} from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-evidence.ts';
import { deduplicateArtifactEvidenceEntries } from
    '../../../packages/shared-test/rallar-bb-test/distributed-artifact-evidence-utils.ts';
import { resolveDistributedArtifactEvidenceCatalogEntryIds } from
    '../../../packages/shared-test/rallar-bb-test/distributed-artifact-evidence-catalog.ts';
import { distributedArtifactEvidenceCatalogWorkForTest } from
    '../../../packages/shared-test/rallar-bb-test/distributed-artifact-evidence-catalog.ts';
import {
    distributedArtifactEvidenceWindowWorkForTest,
    issueDistributedArtifactEvidenceCursorForTest,
    resetDistributedArtifactEvidenceWindowWorkForTest,
} from
    '../../../packages/shared-test/rallar-bb-test/distributed-artifact-evidence-window.ts';
import { createDistributedArtifactWorkspace } from
    '../../../packages/shared-test/rallar-bb-test/distributed-artifact-workspace.ts';
import {
    createRecipeConsoleScaleFixture,
    type RecipeConsoleScaleFixture,
} from '../../../packages/shared-test/rallar-bb-test/scale-fixture.ts';
import { parseBlackBoxRunnerArtifactIndex } from
    '../../../packages/shared-test/black-box-runner/artifacts/artifact-reader.ts';

function inputForFixture(
    fixture: RecipeConsoleScaleFixture,
): DeriveDistributedArtifactEvidenceIndexInput {
    const workspace = createDistributedArtifactWorkspace({
        files: fixture.files,
        generatedAtEpochMs: fixture.generatedAtEpochMs,
        artifactSchemaVersion: fixture.artifactSchemaVersion,
    });
    if (!workspace.analysis || !workspace.snapshots) {
        throw new Error('Expected a valid distributed scale workspace.');
    }
    return {
        analysis: workspace.analysis,
        snapshots: workspace.snapshots,
        sourceFileNames: Object.keys(fixture.files),
        sourceFiles: fixture.files,
    };
}

async function catalogForFixture(
    fixture: RecipeConsoleScaleFixture,
): Promise<DistributedArtifactEvidenceCatalog> {
    return (await deriveDistributedArtifactEvidenceCollections(
        inputForFixture(fixture),
    )).catalog;
}

function decodeCursorBody(cursor: DistributedArtifactEvidenceCursor): Record<string, unknown> {
    const [body] = cursor.split('.');
    return JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8'));
}

describe('distributed artifact evidence catalog windows', () => {
    it('preserves the legacy index/search contract while traversing all 15k evidence without gaps', async () => {
        const fixture = createRecipeConsoleScaleFixture();
        const { index, catalog } = await deriveDistributedArtifactEvidenceCollections(
            inputForFixture(fixture),
        );

        expect(index.limit).toBe(500);
        expect(index.entries).toHaveLength(500);
        expect(searchDistributedArtifactEvidence(index, { limit: 1 })).toMatchObject({
            entries: [expect.any(Object)],
            limit: 1,
            upstreamOmittedEntryCount: index.omittedEntryCount,
            totalMatchesIsComplete: false,
        });
        expect(catalog).toMatchObject({
            limit: MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES,
            totalEntries: 15_003,
            retainedEntryCount: 15_003,
            indexOmittedEntryCount: 0,
            producerCompaction: {
                status: 'unavailable',
                reason: 'no-distributed-producer-compaction-contract',
            },
        });

        for (const needle of [
            fixture.needles.events.first,
            fixture.needles.events.middle,
            fixture.needles.events.last,
            fixture.needles.results.first,
            fixture.needles.results.middle,
            fixture.needles.results.last,
        ]) {
            const result = await searchDistributedArtifactEvidenceWindow(catalog, {
                query: { query: needle },
            });
            expect(result, needle).toMatchObject({
                ok: true,
                window: {
                    rangeStart: 1,
                    rangeEnd: 1,
                    counts: {
                        retainedMatches: 1,
                        renderedMatches: 1,
                        renderOmittedMatches: 0,
                    },
                },
            });
        }

        const collected: string[] = [];
        let cursor: DistributedArtifactEvidenceCursor | undefined;
        let firstWindow: Awaited<ReturnType<typeof searchDistributedArtifactEvidenceWindow>> | undefined;
        let lastWindow: Awaited<ReturnType<typeof searchDistributedArtifactEvidenceWindow>> | undefined;
        resetDistributedArtifactEvidenceWindowWorkForTest(catalog);
        do {
            const result = await searchDistributedArtifactEvidenceWindow(catalog, {
                cursor,
                windowSize: 64,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.rejection.message);
            expect(result.window.rangeEnd - result.window.rangeStart + 1)
                .toBe(result.window.entries.length);
            firstWindow ??= result;
            lastWindow = result;
            collected.push(...result.window.entries.map(entry => entry.id));
            cursor = result.window.nextCursor;
        } while (cursor);

        expect(firstWindow?.ok && firstWindow.window.previousCursor).toBeUndefined();
        expect(lastWindow?.ok && lastWindow.window.nextCursor).toBeUndefined();
        expect(collected).toEqual(catalog.entries.map(entry => entry.id));
        expect(new Set(collected).size).toBe(collected.length);
        expect(lastWindow?.ok && lastWindow.window.counts).toEqual({
            totalEntries: 15_003,
            indexedEntries: 15_003,
            indexOmittedEntries: 0,
            retainedMatches: 15_003,
            queryExcludedEntries: 0,
            renderedMatches: 27,
            renderOmittedMatches: 14_976,
        });

        const backwardPages: string[][] = [];
        let previousCursor = lastWindow?.ok
            ? lastWindow.window.previousCursor
            : undefined;
        backwardPages.push(lastWindow?.ok
            ? lastWindow.window.entries.map(entry => entry.id)
            : []);
        while (previousCursor) {
            const result = await searchDistributedArtifactEvidenceWindow(catalog, {
                cursor: previousCursor,
                windowSize: 64,
            });
            if (!result.ok) throw new Error(result.rejection.message);
            backwardPages.push(result.window.entries.map(entry => entry.id));
            previousCursor = result.window.previousCursor;
        }
        expect(backwardPages.reverse().flat()).toEqual(collected);
        expect(distributedArtifactEvidenceWindowWorkForTest(catalog)).toEqual({
            cursorVerificationAttempts: 468,
            queryBuildCount: 1,
            queryCacheHits: 468,
            matchEvaluations: 15_003,
            matchIndexWrites: 15_003,
            windowIndexReads: 29_979,
            peakMatchIndexCapacity: 15_003,
        });

        for (const [windowSize, expected] of [
            [undefined, 64],
            [0, 1],
            [-10, 1],
            [10.8, 10],
            [10_000, 100],
            [Number.NaN, 64],
            [Number.POSITIVE_INFINITY, 64],
        ] as const) {
            const result = await searchDistributedArtifactEvidenceWindow(catalog, { windowSize });
            expect(result).toMatchObject({
                ok: true,
                window: { windowSize: expected, entries: expect.any(Array) },
            });
            if (result.ok) expect(result.window.entries).toHaveLength(expected);
        }
        const empty = await searchDistributedArtifactEvidenceWindow(catalog, {
            query: { query: 'definitely-no-evidence-row' },
        });
        expect(empty).toMatchObject({
            ok: true,
            window: {
                entries: [], rangeStart: 0, rangeEnd: 0,
                counts: { retainedMatches: 0, renderedMatches: 0 },
            },
        });
        if (empty.ok) {
            expect(empty.window).not.toHaveProperty('previousCursor');
            expect(empty.window).not.toHaveProperty('nextCursor');
        }
    }, 60_000);

    it('caps at 20,000 while retaining the primary failure, latest diagnostic, and stable newest rows', async () => {
        const fixture = createRecipeConsoleScaleFixture({ artifactRowCount: 20_004 });
        const [catalog, repeated] = await Promise.all([
            catalogForFixture(fixture),
            catalogForFixture(fixture),
        ]);

        expect(catalog.limit).toBe(20_000);
        expect(catalog.entries).toHaveLength(20_000);
        expect(catalog.totalEntries).toBeGreaterThan(20_000);
        expect(catalog.indexOmittedEntryCount)
            .toBe(catalog.totalEntries - catalog.retainedEntryCount);
        expect(catalog).toMatchObject({
            totalEntries: 20_007,
            retainedEntryCount: 20_000,
            indexOmittedEntryCount: 7,
        });
        const catalogWork = distributedArtifactEvidenceCatalogWorkForTest(catalog);
        expect(catalogWork).toMatchObject({
            sourceEntriesVisited: 20_007,
            canonicalDigestsComputed: 20_007,
            exactRepeatsDropped: 0,
            distinctEntries: 20_007,
            peakCanonicalBatchSize: 128,
            peakRetainedEntryReferences: 20_003,
            sortedRetainedEntries: 20_000,
            retainedModelDigests: 20_000,
            haystacksBuilt: 20_000,
            rawSearchAssociationReads: 20_007,
        });
        expect(catalogWork.retainedRawSearchValues).toBeLessThanOrEqual(20_000);
        expect(catalogWork.maxRetainedRawSearchValueLength).toBeLessThanOrEqual(2_000);
        expect(catalog.entries.some(entry => entry.id === catalog.primaryFailureId)).toBe(true);
        expect(catalog.entries.some(entry => entry.id === catalog.latestDiagnosticId)).toBe(true);
        expect(catalog.entries.find(entry =>
            entry.kind === 'result' && entry.status === 'failed'
        )).toMatchObject({
            commandId: inputForFixture(fixture).analysis.failure?.commandId,
            failureDetails: {
                code: 'SCALE_UPSTREAM_UNAVAILABLE',
                message: expect.stringContaining('Expected HTTP 200'),
            },
        });
        expect(repeated.entries.map(entry => entry.id))
            .toEqual(catalog.entries.map(entry => entry.id));
        expect((await searchDistributedArtifactEvidenceWindow(catalog, {
            query: { query: fixture.needles.events.last },
        }))).toMatchObject({
            ok: true,
            window: {
                totalMatchesIsComplete: false,
                counts: {
                    totalEntries: catalog.totalEntries,
                    indexedEntries: 20_000,
                    indexOmittedEntries: catalog.indexOmittedEntryCount,
                    retainedMatches: 1,
                    queryExcludedEntries: 19_999,
                    renderedMatches: 1,
                    renderOmittedMatches: 0,
                },
            },
        });
        expect((await searchDistributedArtifactEvidenceWindow(catalog, {
            query: { query: fixture.needles.results.last },
        }))).toMatchObject({ ok: true, window: { counts: { retainedMatches: 1 } } });
        expect((await searchDistributedArtifactEvidenceWindow(catalog, {
            query: { query: fixture.needles.events.first },
        }))).toMatchObject({ ok: true, window: { counts: { retainedMatches: 0 } } });
        const lastNeedle = await searchDistributedArtifactEvidenceWindow(catalog, {
            query: { query: fixture.needles.events.last },
        });
        if (!lastNeedle.ok) throw new Error(lastNeedle.rejection.message);
        const counts = lastNeedle.window.counts;
        expect(counts.totalEntries)
            .toBe(counts.indexedEntries + counts.indexOmittedEntries);
        expect(counts.indexedEntries)
            .toBe(counts.retainedMatches + counts.queryExcludedEntries);
        expect(counts.retainedMatches)
            .toBe(counts.renderedMatches + counts.renderOmittedMatches);
    }, 60_000);

    it('rejects malformed, tampered, foreign, stale, query-bound, and out-of-range cursors', async () => {
        const fixture = createRecipeConsoleScaleFixture({ artifactRowCount: 120 });
        const input = inputForFixture(fixture);
        const firstCollections = await deriveDistributedArtifactEvidenceCollections(input);
        const first = await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
            query: { query: 'scale' },
            windowSize: 10,
        });
        if (!first.ok || !first.window.nextCursor) throw new Error('Expected a next cursor.');
        const cursor = first.window.nextCursor;

        expect(await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
            cursor: 'not-a-cursor', query: { query: 'scale' }, windowSize: 10,
        })).toMatchObject({ ok: false, rejection: { code: 'cursor-malformed' } });
        const [cursorBody, cursorSignature] = cursor.split('.');
        const signatureBytes = Buffer.from(cursorSignature ?? '', 'base64url');
        signatureBytes[0] = (signatureBytes[0] ?? 0) ^ 0xff;
        const tamperedSignature = `${cursorBody}.${signatureBytes.toString('base64url')}`;
        resetDistributedArtifactEvidenceWindowWorkForTest(firstCollections.catalog);
        expect(await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
            cursor: tamperedSignature,
            query: { query: 'scale' }, windowSize: 10,
        })).toMatchObject({ ok: false, rejection: { code: 'cursor-tampered' } });
        expect(distributedArtifactEvidenceWindowWorkForTest(firstCollections.catalog))
            .toEqual({
                cursorVerificationAttempts: 1,
                queryBuildCount: 0,
                queryCacheHits: 0,
                matchEvaluations: 0,
                matchIndexWrites: 0,
                windowIndexReads: 0,
                peakMatchIndexCapacity: 0,
            });
        expect(await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
            cursor, query: { query: 'different-query' }, windowSize: 10,
        })).toMatchObject({ ok: false, rejection: { code: 'cursor-query-mismatch' } });
        const outOfRange = await issueDistributedArtifactEvidenceCursorForTest(
            firstCollections.catalog,
            { query: { query: 'scale' }, windowSize: 10, offset: Number.MAX_SAFE_INTEGER },
        );
        expect(await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
            cursor: outOfRange,
            query: { query: 'scale' }, windowSize: 10,
        })).toMatchObject({ ok: false, rejection: { code: 'cursor-out-of-range' } });

        expect(Object.keys(decodeCursorBody(cursor)).sort()).toEqual([
            'a', 'i', 'm', 'p', 'q', 'r', 's', 'v',
        ]);
        expect(cursor).not.toContain('scale-agent');
        expect(cursor).not.toContain('scale-command');
        expect(cursor).not.toContain('scale');

        const staleCollections = await deriveDistributedArtifactEvidenceCollections(input);
        expect(await searchDistributedArtifactEvidenceWindow(staleCollections.catalog, {
            cursor, query: { query: 'scale' }, windowSize: 10,
        })).toMatchObject({ ok: false, rejection: { code: 'cursor-stale-model' } });

        const foreignInput = inputForFixture(fixture);
        const foreignCollections = await deriveDistributedArtifactEvidenceCollections({
            ...foreignInput,
            analysis: {
                ...foreignInput.analysis,
                distributedRunId: 'foreign-distributed-run',
            },
        });
        expect(await searchDistributedArtifactEvidenceWindow(foreignCollections.catalog, {
            cursor, query: { query: 'scale' }, windowSize: 10,
        })).toMatchObject({ ok: false, rejection: { code: 'cursor-foreign-artifact' } });

        const equivalent = await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
            query: { query: '  SCALE   synthetic  ' }, windowSize: 10,
        });
        if (!equivalent.ok || !equivalent.window.nextCursor) {
            throw new Error('Expected an equivalent-query cursor.');
        }
        expect(await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
            cursor: equivalent.window.nextCursor,
            query: { query: 'synthetic scale' }, windowSize: 10,
        })).toMatchObject({ ok: true });

        const aliasFirst = await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
            query: { query: 'SCALE', agentId: 'SCALE-AGENT-001', status: 'ok' },
            windowSize: 10,
        });
        if (!aliasFirst.ok || !aliasFirst.window.nextCursor) {
            throw new Error('Expected a status-alias cursor.');
        }
        expect(await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
            cursor: aliasFirst.window.nextCursor,
            query: { query: ' scale ', agentId: 'scale-agent-001', status: 'PASSED' },
            windowSize: 10,
        })).toMatchObject({ ok: true });
        const absentAgent = await searchDistributedArtifactEvidenceWindow(
            firstCollections.catalog,
            { query: { query: 'scale' } },
        );
        const emptyAgent = await searchDistributedArtifactEvidenceWindow(
            firstCollections.catalog,
            { query: { query: 'scale', agentId: '' } },
        );
        expect(absentAgent.ok && absentAgent.window.counts.retainedMatches)
            .toBeGreaterThan(emptyAgent.ok ? emptyAgent.window.counts.retainedMatches : -1);

        for (const query of [
            { query: 'other' },
            { query: 'scale', agentId: '' },
            { query: 'scale', recipeId: 'recipe' },
            { query: 'scale', commandId: 'command' },
            { query: 'scale', status: 'passed' },
            { query: 'scale', severity: 'error' },
            { query: 'scale', transport: 'http' },
            { query: 'scale', category: 'event' },
            { query: 'scale', fromEpochMs: 0 },
            { query: 'scale', toEpochMs: Number.NaN },
        ]) {
            expect(await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
                cursor,
                query,
                windowSize: 10,
            }), JSON.stringify(query)).toMatchObject({
                ok: false,
                rejection: { code: 'cursor-query-mismatch' },
            });
        }
    }, 60_000);

    it('preserves distinct stable-ID collisions while deduplicating exact repeats', async () => {
        const base = {
            id: 'event:collision',
            kind: 'event' as const,
            sourceFile: 'events.jsonl',
            summary: 'first',
            payloadSummary: 'payload-a',
        };
        const sourceEntries = [
            base,
            { ...base },
            { ...base, summary: 'second', payloadSummary: 'payload-b' },
        ];
        const legacyEntries = deduplicateArtifactEvidenceEntries(sourceEntries);
        const [entries, repeated] = await Promise.all([
            resolveDistributedArtifactEvidenceCatalogEntryIds(sourceEntries),
            resolveDistributedArtifactEvidenceCatalogEntryIds(sourceEntries),
        ]);

        expect(legacyEntries).toEqual([
            { ...base, summary: 'second', payloadSummary: 'payload-b' },
        ]);
        expect(entries).toHaveLength(2);
        expect(new Set(entries.map(entry => entry.id)).size).toBe(2);
        expect(entries[1]?.id).toMatch(/^event:collision:collision:[A-Za-z0-9_-]{43}$/);
        expect(repeated.map(entry => entry.id)).toEqual(entries.map(entry => entry.id));

        const fixture = createRecipeConsoleScaleFixture({ artifactRowCount: 6 });
        const eventRows = (fixture.files['events.jsonl'] ?? '').split('\n').map(line =>
            JSON.parse(line) as Record<string, unknown>);
        const sourceEvent = eventRows[0] ?? {};
        const sourceValue = sourceEvent.value as Record<string, unknown>;
        eventRows[0] = {
            ...sourceEvent,
            value: { ...sourceValue, message: 'catalog collision alphaunique' },
        };
        eventRows.splice(1, 0, {
            ...sourceEvent,
            value: { ...sourceValue, message: 'catalog collision betaunique' },
        });
        const collisionFixture: RecipeConsoleScaleFixture = {
            ...fixture,
            files: {
                ...fixture.files,
                'events.jsonl': eventRows.map(row => JSON.stringify(row)).join('\n'),
            },
        };
        const input = inputForFixture(collisionFixture);
        const collections = await deriveDistributedArtifactEvidenceCollections(input);
        const legacy = deriveDistributedArtifactEvidenceIndex(input);

        expect(collections.index).toEqual(legacy);
        expect(searchDistributedArtifactEvidence(collections.index, {
            query: 'catalog collision alphaunique',
        })).toEqual(searchDistributedArtifactEvidence(legacy, {
            query: 'catalog collision alphaunique',
        }));
        const first = await searchDistributedArtifactEvidenceWindow(collections.catalog, {
            query: { query: 'catalog collision alphaunique' },
        });
        const second = await searchDistributedArtifactEvidenceWindow(collections.catalog, {
            query: { query: 'catalog collision betaunique' },
        });
        expect(first).toMatchObject({ ok: true, window: { counts: { retainedMatches: 1 } } });
        expect(second).toMatchObject({ ok: true, window: { counts: { retainedMatches: 1 } } });
        if (first.ok && second.ok) {
            expect(first.window.entries[0]?.id).not.toBe(second.window.entries[0]?.id);
        }
        expect(entries.map(entry => entry.summary).sort()).toEqual(['first', 'second']);
    });

    it('associates high-collision searches with linear bounded catalog work', async () => {
        const fixture = createRecipeConsoleScaleFixture({ artifactRowCount: 6 });
        const eventRows = (fixture.files['events.jsonl'] ?? '').split('\n').map(line =>
            JSON.parse(line) as Record<string, unknown>);
        const sourceEvent = eventRows[0] ?? {};
        const sourceValue = sourceEvent.value as Record<string, unknown>;
        const collisions = Array.from({ length: 2_000 }, (_, index) => ({
            ...sourceEvent,
            value: {
                ...sourceValue,
                message: `catalog high-collision-${String(index).padStart(6, '0')}`,
            },
        }));
        eventRows.splice(0, 1, ...collisions);
        const collisionFixture: RecipeConsoleScaleFixture = {
            ...fixture,
            files: {
                ...fixture.files,
                'events.jsonl': eventRows.map(row => JSON.stringify(row)).join('\n'),
            },
        };
        const catalog = await catalogForFixture(collisionFixture);

        for (const index of [0, 1_000, 1_999]) {
            const result = await searchDistributedArtifactEvidenceWindow(catalog, {
                query: {
                    query: `catalog high-collision-${String(index).padStart(6, '0')}`,
                },
            });
            expect(result, String(index)).toMatchObject({
                ok: true,
                window: { counts: { retainedMatches: 1 } },
            });
        }
        const work = distributedArtifactEvidenceCatalogWorkForTest(catalog);
        expect(work.sourceEntriesVisited).toBe(2_008);
        expect(work.canonicalDigestsComputed).toBe(work.sourceEntriesVisited);
        expect(work.rawSearchAssociationReads).toBe(work.sourceEntriesVisited);
        expect(work.exactRepeatsDropped).toBe(0);
        expect(work.distinctEntries).toBe(work.sourceEntriesVisited);
        expect(work.peakCanonicalBatchSize).toBe(128);
        expect(work.peakRetainedEntryReferences).toBeLessThanOrEqual(20_002);
        expect(work.sortedRetainedEntries).toBe(work.distinctEntries);
        expect(work.retainedModelDigests).toBe(work.distinctEntries);
        expect(work.haystacksBuilt).toBe(work.distinctEntries);
        expect(work.retainedRawSearchValues).toBeLessThanOrEqual(work.distinctEntries);
        expect(work.maxRetainedRawSearchValueLength).toBeLessThanOrEqual(2_000);
    }, 60_000);

    it('keeps raw-distinct bounded-identical rows while dropping a true repeat', async () => {
        const fixture = createRecipeConsoleScaleFixture({ artifactRowCount: 6 });
        const eventRows = (fixture.files['events.jsonl'] ?? '').split('\n').map(line =>
            JSON.parse(line) as Record<string, unknown>);
        const sourceEvent = eventRows[0] ?? {};
        const sourceValue = sourceEvent.value as Record<string, unknown>;
        const rawVariant = (token: string): Record<string, unknown> => ({
            ...sourceEvent,
            value: {
                ...sourceValue,
                message: 'Catalog bounded identity probe.',
                aFiller: 'x'.repeat(700),
                rawOnlyToken: token,
            },
        });
        const alpha = rawVariant('raw-identity-alphaunique');
        eventRows.splice(0, 1, alpha, { ...alpha }, rawVariant('raw-identity-betaunique'));
        const rawIdentityFixture: RecipeConsoleScaleFixture = {
            ...fixture,
            files: {
                ...fixture.files,
                'events.jsonl': eventRows.map(row => JSON.stringify(row)).join('\n'),
            },
        };
        const input = inputForFixture(rawIdentityFixture);
        const collections = await deriveDistributedArtifactEvidenceCollections(input);

        expect(collections.index).toEqual(deriveDistributedArtifactEvidenceIndex(input));
        for (const token of [
            'raw-identity-alphaunique',
            'raw-identity-betaunique',
        ]) {
            expect(await searchDistributedArtifactEvidenceWindow(collections.catalog, {
                query: { query: token },
            }), token).toMatchObject({
                ok: true,
                window: { counts: { retainedMatches: 1 } },
            });
        }
        const matchingRows = collections.catalog.entries.filter(entry =>
            entry.summary === 'Catalog bounded identity probe.'
        );
        expect(matchingRows).toHaveLength(2);
        expect(new Set(matchingRows.map(entry => entry.id)).size).toBe(2);
        const work = distributedArtifactEvidenceCatalogWorkForTest(collections.catalog);
        expect(work.exactRepeatsDropped).toBe(1);
        expect(work.distinctEntries).toBe(work.sourceEntriesVisited - 1);
        expect(work.rawSearchAssociationReads).toBe(work.sourceEntriesVisited);
    });

    it('keeps generic artifact-index compaction in its standalone reader', async () => {
        const text = await readFile(new URL(
            '../../../packages/shared-test/black-box-runner/fixtures/schema/v1/artifact-bundle/artifact-index.json',
            import.meta.url,
        ), 'utf8');
        const parsed = parseBlackBoxRunnerArtifactIndex(text);

        expect(parsed.ok).toBe(true);
        expect(parsed.value).toMatchObject({
            compaction: { compacted: true },
            truncation: {
                totalEvents: 7,
                emittedEvents: 4,
                omittedEvents: 3,
                truncated: true,
            },
        });
    });
});
