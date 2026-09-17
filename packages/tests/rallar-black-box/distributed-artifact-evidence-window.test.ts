import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { parseBlackBoxRunnerArtifactIndex } from '../../../packages/shared-test/black-box-runner/artifacts/artifact-reader.ts';
import {
    DEFAULT_DISTRIBUTED_ARTIFACT_EVIDENCE_LIMITS,
    MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES,
    type ComputeDistributedArtifactEvidenceIndexInput,
    type DistributedArtifactEvidenceCatalog,
    type DistributedArtifactEvidenceCursor
} from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-evidence-contracts.ts';
import { computeDistributedArtifactEvidenceIndex } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-evidence-index.ts';
import { searchDistributedArtifactEvidence } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-evidence-search.ts';
import {
    computeDistributedArtifactEvidenceCollections,
    searchDistributedArtifactEvidenceWindow
} from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-evidence-window.ts';
import { computeDistributedArtifactEvidenceSource } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-evidence/compute-distributed-artifact-evidence-source.ts';
import { computeDistributedArtifactWorkspace } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-workspace.ts';
import {
    createDefaultRecipeConsoleScaleFixture,
    createRecipeConsoleScaleFixture,
    type RecipeConsoleScaleFixture
} from '../../../packages/shared-test/rallar-bb-test/scale-fixture.ts';

function inputForFixture(
    fixture: RecipeConsoleScaleFixture
): ComputeDistributedArtifactEvidenceIndexInput {
    const { workspace, monitor, parsed } = computeDistributedArtifactWorkspace({
        files: fixture.files,
        generatedAtEpochMs: fixture.generatedAtEpochMs,
        artifactSchemaVersion: fixture.artifactSchemaVersion
    });
    if (!workspace.analysis || !workspace.snapshots || !monitor) {
        throw new Error('Expected a valid distributed scale workspace.');
    }
    return {
        analysis: workspace.analysis,
        snapshots: workspace.snapshots,
        monitor,
        parsed,
        sourceFileNames: Object.keys(fixture.files),
        limits: DEFAULT_DISTRIBUTED_ARTIFACT_EVIDENCE_LIMITS
    };
}

async function catalogForFixture(
    fixture: RecipeConsoleScaleFixture
): Promise<DistributedArtifactEvidenceCatalog> {
    return (await computeDistributedArtifactEvidenceCollections(
        inputForFixture(fixture)
    )).catalog;
}

type JsonRecord = Record<string, unknown>;

interface DigestWatch {
    calls: number;
    peakInFlight: number;
}

interface WindowWork {
    cursorVerifications: number;
    entryReads: number;
}

interface WindowWorkWatch {
    readonly work: WindowWork;
    readonly stop: () => void;
}

/** Counts cursor signature checks and reads of the catalog's entries until the watch stops. */
function startWindowWorkWatch(catalog: DistributedArtifactEvidenceCatalog): WindowWorkWatch {
    const work: WindowWork = { cursorVerifications: 0, entryReads: 0 };
    const entries = catalog.entries;
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'verify').mockImplementation((algorithm, key, signature, data) => {
        work.cursorVerifications += 1;
        return verify(algorithm, key, signature, data);
    });
    Object.defineProperty(catalog, 'entries', {
        configurable: true,
        value: new Proxy(entries, {
            get(target, property, receiver) {
                if (typeof property === 'string' && /^\d+$/.test(property)) {
                    work.entryReads += 1;
                }
                return Reflect.get(target, property, receiver);
            }
        })
    });
    return {
        work,
        stop: () => {
            spy.mockRestore();
            Object.defineProperty(catalog, 'entries', { configurable: true, value: entries });
        }
    };
}

/** Counts SHA-256 digests and the most that run at once while the catalog is computed. */
async function computeCatalogWatchingDigests(
    input: ComputeDistributedArtifactEvidenceIndexInput
): Promise<Readonly<{ catalog: DistributedArtifactEvidenceCatalog; digests: DigestWatch; }>> {
    const digests: DigestWatch = { calls: 0, peakInFlight: 0 };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let inFlight = 0;
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
        digests.calls += 1;
        inFlight += 1;
        digests.peakInFlight = Math.max(digests.peakInFlight, inFlight);
        try {
            return await digest(algorithm, data);
        }
        finally {
            inFlight -= 1;
        }
    });
    try {
        const { catalog } = await computeDistributedArtifactEvidenceCollections(input);
        return { catalog, digests };
    }
    finally {
        spy.mockRestore();
    }
}

function decodeCursorBody(cursor: DistributedArtifactEvidenceCursor): JsonRecord {
    const [body] = cursor.split('.');
    return JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8'));
}

describe('distributed artifact evidence catalog windows', () => {
    it('preserves the legacy index/search contract while traversing all 15k evidence without gaps', async () => {
        const fixture = createDefaultRecipeConsoleScaleFixture();
        const { index, catalog } = await computeDistributedArtifactEvidenceCollections(
            inputForFixture(fixture)
        );

        expect(index.limit).toBe(500);
        expect(index.entries).toHaveLength(500);
        expect(searchDistributedArtifactEvidence(index, { limit: 1 })).toMatchObject({
            entries: [expect.any(Object)],
            limit: 1,
            upstreamOmittedEntryCount: index.omittedEntryCount,
            totalMatchesIsComplete: false
        });
        expect(catalog).toMatchObject({
            limit: MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES,
            totalEntries: 15_003,
            retainedEntryCount: 15_003,
            indexOmittedEntryCount: 0,
            producerCompaction: {
                status: 'unavailable',
                reason: 'no-distributed-producer-compaction-contract'
            }
        });

        for (
            const needle of [
                fixture.needles.events.first,
                fixture.needles.events.middle,
                fixture.needles.events.last,
                fixture.needles.results.first,
                fixture.needles.results.middle,
                fixture.needles.results.last
            ]
        ) {
            const result = await searchDistributedArtifactEvidenceWindow(catalog, {
                query: { query: needle }
            });
            expect(result, needle).toMatchObject({
                ok: true,
                window: {
                    rangeStart: 1,
                    rangeEnd: 1,
                    counts: {
                        retainedMatches: 1,
                        renderedMatches: 1,
                        renderOmittedMatches: 0
                    }
                }
            });
        }

        const collected: string[] = [];
        let cursor: DistributedArtifactEvidenceCursor | undefined;
        let firstWindow: Awaited<ReturnType<typeof searchDistributedArtifactEvidenceWindow>> | undefined;
        let lastWindow: Awaited<ReturnType<typeof searchDistributedArtifactEvidenceWindow>> | undefined;
        const pagingWatch = startWindowWorkWatch(catalog);
        let cursorSearches = 0;
        do {
            cursorSearches += cursor ? 1 : 0;
            const result = await searchDistributedArtifactEvidenceWindow(catalog, {
                cursor,
                windowSize: 64
            });
            expect(result.ok).toBe(true);
            if (!result.ok) {
                throw new Error(result.rejection.message);
            }
            expect(result.window.rangeEnd - result.window.rangeStart + 1)
                .toBe(result.window.entries.length);
            firstWindow ??= result;
            lastWindow = result;
            collected.push(...result.window.entries.map((entry) => entry.id));
            cursor = result.window.nextCursor;
        }
        while (cursor);

        expect(firstWindow?.ok && firstWindow.window.previousCursor).toBeUndefined();
        expect(lastWindow?.ok && lastWindow.window.nextCursor).toBeUndefined();
        expect(collected).toEqual(catalog.entries.map((entry) => entry.id));
        expect(new Set(collected).size).toBe(collected.length);
        expect(lastWindow?.ok && lastWindow.window.counts).toEqual({
            totalEntries: 15_003,
            indexedEntries: 15_003,
            indexOmittedEntries: 0,
            retainedMatches: 15_003,
            queryExcludedEntries: 0,
            renderedMatches: 27,
            renderOmittedMatches: 14_976
        });

        const backwardPages: string[][] = [];
        let previousCursor = lastWindow?.ok
            ? lastWindow.window.previousCursor
            : undefined;
        backwardPages.push(
            lastWindow?.ok
                ? lastWindow.window.entries.map((entry) => entry.id)
                : []
        );
        while (previousCursor) {
            cursorSearches += 1;
            const result = await searchDistributedArtifactEvidenceWindow(catalog, {
                cursor: previousCursor,
                windowSize: 64
            });
            if (!result.ok) {
                throw new Error(result.rejection.message);
            }
            backwardPages.push(result.window.entries.map((entry) => entry.id));
            previousCursor = result.window.previousCursor;
        }
        pagingWatch.stop();
        expect(backwardPages.reverse().flat()).toEqual(collected);
        // Each cursor is verified once, and paging matches the catalog once rather than once per window.
        expect(cursorSearches).toBe(468);
        expect(pagingWatch.work.cursorVerifications).toBe(cursorSearches);
        expect(pagingWatch.work.entryReads).toBeLessThan(4 * catalog.entries.length);

        for (
            const [windowSize, expected] of [
                [undefined, 64],
                [0, 1],
                [-10, 1],
                [10.8, 10],
                [10_000, 100],
                [Number.NaN, 64],
                [Number.POSITIVE_INFINITY, 64]
            ] as const
        ) {
            const result = await searchDistributedArtifactEvidenceWindow(catalog, { windowSize });
            expect(result).toMatchObject({
                ok: true,
                window: { windowSize: expected, entries: expect.any(Array) }
            });
            if (result.ok) {
                expect(result.window.entries).toHaveLength(expected);
            }
        }
        const empty = await searchDistributedArtifactEvidenceWindow(catalog, {
            query: { query: 'definitely-no-evidence-row' }
        });
        expect(empty).toMatchObject({
            ok: true,
            window: {
                entries: [],
                rangeStart: 0,
                rangeEnd: 0,
                counts: { retainedMatches: 0, renderedMatches: 0 }
            }
        });
        if (empty.ok) {
            expect(empty.window).not.toHaveProperty('previousCursor');
            expect(empty.window).not.toHaveProperty('nextCursor');
        }
    }, 60_000);

    it('caps at 20,000 while retaining the primary failure, latest diagnostic, and stable newest rows', async () => {
        const fixture = createRecipeConsoleScaleFixture({ artifactRowCount: 20_004 });
        const input = inputForFixture(fixture);
        const sourceRowCount = computeDistributedArtifactEvidenceSource(input).rawEntries.length;
        const { catalog, digests } = await computeCatalogWatchingDigests(input);
        const repeated = await catalogForFixture(fixture);

        expect(catalog.limit).toBe(20_000);
        expect(catalog.entries).toHaveLength(20_000);
        expect(catalog.totalEntries).toBeGreaterThan(20_000);
        expect(catalog.indexOmittedEntryCount)
            .toBe(catalog.totalEntries - catalog.retainedEntryCount);
        expect(catalog).toMatchObject({
            totalEntries: 20_007,
            retainedEntryCount: 20_000,
            indexOmittedEntryCount: 7
        });
        // Every source row is digested once, at most one batch at a time, and no exact repeat is dropped.
        expect(sourceRowCount).toBe(catalog.totalEntries);
        expect(digests.calls).toBeGreaterThanOrEqual(sourceRowCount);
        expect(digests.calls).toBeLessThanOrEqual(sourceRowCount + 2);
        expect(digests.peakInFlight).toBe(128);
        expect(catalog.entries.some((entry) => entry.id === catalog.primaryFailureId)).toBe(true);
        expect(catalog.entries.some((entry) => entry.id === catalog.latestDiagnosticId)).toBe(true);
        const scaleAnalysis = input.analysis;
        expect(catalog.entries.find((entry) => entry.kind === 'result' && entry.status === 'failed')).toMatchObject({
            commandId: scaleAnalysis.ok ? undefined : scaleAnalysis.failure.commandId,
            failureDetails: {
                code: 'SCALE_UPSTREAM_UNAVAILABLE',
                message: expect.stringContaining('Expected HTTP 200')
            }
        });
        expect(repeated.entries.map((entry) => entry.id))
            .toEqual(catalog.entries.map((entry) => entry.id));
        expect(
            await searchDistributedArtifactEvidenceWindow(catalog, {
                query: { query: fixture.needles.events.last }
            })
        ).toMatchObject({
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
                    renderOmittedMatches: 0
                }
            }
        });
        expect(
            await searchDistributedArtifactEvidenceWindow(catalog, {
                query: { query: fixture.needles.results.last }
            })
        ).toMatchObject({ ok: true, window: { counts: { retainedMatches: 1 } } });
        expect(
            await searchDistributedArtifactEvidenceWindow(catalog, {
                query: { query: fixture.needles.events.first }
            })
        ).toMatchObject({ ok: true, window: { counts: { retainedMatches: 0 } } });
        const lastNeedle = await searchDistributedArtifactEvidenceWindow(catalog, {
            query: { query: fixture.needles.events.last }
        });
        if (!lastNeedle.ok) {
            throw new Error(lastNeedle.rejection.message);
        }
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
        const firstCollections = await computeDistributedArtifactEvidenceCollections(input);
        const first = await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
            query: { query: 'scale' },
            windowSize: 10
        });
        if (!first.ok || !first.window.nextCursor) {
            throw new Error('Expected a next cursor.');
        }
        const cursor = first.window.nextCursor;

        expect(
            await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
                cursor: 'not-a-cursor',
                query: { query: 'scale' },
                windowSize: 10
            })
        ).toMatchObject({ ok: false, rejection: { code: 'cursor-malformed' } });
        const [cursorBody, cursorSignature] = cursor.split('.');
        const signatureBytes = Buffer.from(cursorSignature ?? '', 'base64url');
        signatureBytes[0] = (signatureBytes[0] ?? 0) ^ 0xff;
        const tamperedSignature = `${cursorBody}.${signatureBytes.toString('base64url')}`;
        const tamperedWatch = startWindowWorkWatch(firstCollections.catalog);
        // A query no earlier window matched, so any matching before the signature check would read the catalog.
        const tampered = await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
            cursor: tamperedSignature,
            query: { query: 'scale unmatched probe' },
            windowSize: 10
        });
        tamperedWatch.stop();
        expect(tampered).toMatchObject({ ok: false, rejection: { code: 'cursor-tampered' } });
        expect(tamperedWatch.work, 'a tampered cursor is refused before any evidence is matched').toEqual({
            cursorVerifications: 1,
            entryReads: 0
        });
        expect(
            await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
                cursor,
                query: { query: 'different-query' },
                windowSize: 10
            })
        ).toMatchObject({ ok: false, rejection: { code: 'cursor-query-mismatch' } });
        const shrinking = await computeDistributedArtifactEvidenceCollections(input);
        const shrinkingFirst = await searchDistributedArtifactEvidenceWindow(shrinking.catalog, {
            query: { query: 'scale' },
            windowSize: 10
        });
        if (!shrinkingFirst.ok || !shrinkingFirst.window.nextCursor) {
            throw new Error('Expected a next cursor.');
        }
        Object.defineProperty(shrinking.catalog, 'entries', { value: shrinking.catalog.entries.slice(0, 5) });
        // Another query replaces the single cached match index, so the cursor's query is matched again.
        await searchDistributedArtifactEvidenceWindow(shrinking.catalog, { query: { query: 'other' } });
        expect(
            await searchDistributedArtifactEvidenceWindow(shrinking.catalog, {
                cursor: shrinkingFirst.window.nextCursor,
                query: { query: 'scale' },
                windowSize: 10
            }),
            'a signed cursor past the matches of a catalog whose entries changed under it'
        ).toMatchObject({ ok: false, rejection: { code: 'cursor-out-of-range' } });

        expect(Object.keys(decodeCursorBody(cursor)).sort()).toEqual([
            'a',
            'i',
            'm',
            'p',
            'q',
            'r',
            's',
            'v'
        ]);
        expect(cursor).not.toContain('scale-agent');
        expect(cursor).not.toContain('scale-command');
        expect(cursor).not.toContain('scale');

        const staleCollections = await computeDistributedArtifactEvidenceCollections(input);
        expect(
            await searchDistributedArtifactEvidenceWindow(staleCollections.catalog, {
                cursor,
                query: { query: 'scale' },
                windowSize: 10
            })
        ).toMatchObject({ ok: false, rejection: { code: 'cursor-stale-model' } });

        const foreignInput = inputForFixture(fixture);
        const foreignCollections = await computeDistributedArtifactEvidenceCollections({
            ...foreignInput,
            analysis: {
                ...foreignInput.analysis,
                distributedRunId: 'foreign-distributed-run'
            }
        });
        expect(
            await searchDistributedArtifactEvidenceWindow(foreignCollections.catalog, {
                cursor,
                query: { query: 'scale' },
                windowSize: 10
            })
        ).toMatchObject({ ok: false, rejection: { code: 'cursor-foreign-artifact' } });

        const equivalent = await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
            query: { query: '  SCALE   synthetic  ' },
            windowSize: 10
        });
        if (!equivalent.ok || !equivalent.window.nextCursor) {
            throw new Error('Expected an equivalent-query cursor.');
        }
        expect(
            await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
                cursor: equivalent.window.nextCursor,
                query: { query: 'synthetic scale' },
                windowSize: 10
            })
        ).toMatchObject({ ok: true });

        const aliasFirst = await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
            query: { query: 'SCALE', agentId: 'SCALE-AGENT-001', status: 'ok' },
            windowSize: 10
        });
        if (!aliasFirst.ok || !aliasFirst.window.nextCursor) {
            throw new Error('Expected a status-alias cursor.');
        }
        expect(
            await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
                cursor: aliasFirst.window.nextCursor,
                query: { query: ' scale ', agentId: 'scale-agent-001', status: 'PASSED' },
                windowSize: 10
            })
        ).toMatchObject({ ok: true });
        const absentAgent = await searchDistributedArtifactEvidenceWindow(
            firstCollections.catalog,
            { query: { query: 'scale' } }
        );
        const emptyAgent = await searchDistributedArtifactEvidenceWindow(
            firstCollections.catalog,
            { query: { query: 'scale', agentId: '' } }
        );
        expect(absentAgent.ok && absentAgent.window.counts.retainedMatches)
            .toBeGreaterThan(emptyAgent.ok ? emptyAgent.window.counts.retainedMatches : -1);

        for (
            const query of [
                { query: 'other' },
                { query: 'scale', agentId: '' },
                { query: 'scale', recipeId: 'recipe' },
                { query: 'scale', commandId: 'command' },
                { query: 'scale', status: 'passed' },
                { query: 'scale', severity: 'error' },
                { query: 'scale', transport: 'http' },
                { query: 'scale', category: 'event' },
                { query: 'scale', fromEpochMs: 0 },
                { query: 'scale', toEpochMs: Number.NaN }
            ]
        ) {
            expect(
                await searchDistributedArtifactEvidenceWindow(firstCollections.catalog, {
                    cursor,
                    query,
                    windowSize: 10
                }),
                JSON.stringify(query)
            ).toMatchObject({
                ok: false,
                rejection: { code: 'cursor-query-mismatch' }
            });
        }
    }, 60_000);

    it('preserves distinct stable-ID collisions while the index keeps one row per id', async () => {
        const fixture = createRecipeConsoleScaleFixture({ artifactRowCount: 6 });
        const eventRows = (fixture.files['events.jsonl'] ?? '').split('\n').map((line) => JSON.parse(line) as JsonRecord);
        const sourceEvent = eventRows[0] ?? {};
        const sourceValue = sourceEvent.value as JsonRecord;
        eventRows[0] = {
            ...sourceEvent,
            value: { ...sourceValue, message: 'catalog collision alphaunique' }
        };
        eventRows.splice(1, 0, {
            ...sourceEvent,
            value: { ...sourceValue, message: 'catalog collision betaunique' }
        });
        const collisionFixture: RecipeConsoleScaleFixture = {
            ...fixture,
            files: {
                ...fixture.files,
                'events.jsonl': eventRows.map((row) => JSON.stringify(row)).join('\n')
            }
        };
        const input = inputForFixture(collisionFixture);
        const collections = await computeDistributedArtifactEvidenceCollections(input);
        const repeated = await computeDistributedArtifactEvidenceCollections(input);
        const legacy = computeDistributedArtifactEvidenceIndex(input);

        expect(collections.index).toEqual(legacy);
        expect(searchDistributedArtifactEvidence(collections.index, {
            query: 'catalog collision alphaunique'
        })).toEqual(searchDistributedArtifactEvidence(legacy, {
            query: 'catalog collision alphaunique'
        }));
        const first = await searchDistributedArtifactEvidenceWindow(collections.catalog, {
            query: { query: 'catalog collision alphaunique' }
        });
        const second = await searchDistributedArtifactEvidenceWindow(collections.catalog, {
            query: { query: 'catalog collision betaunique' }
        });
        expect(first).toMatchObject({ ok: true, window: { counts: { retainedMatches: 1 } } });
        expect(second).toMatchObject({ ok: true, window: { counts: { retainedMatches: 1 } } });
        if (first.ok && second.ok) {
            const collidingIds = [first.window.entries[0]?.id, second.window.entries[0]?.id];
            expect(collidingIds[0]).not.toBe(collidingIds[1]);
            expect(collidingIds.filter((id) => /:collision:[A-Za-z0-9_-]{43}$/.test(id ?? ''))).toHaveLength(1);
        }
        expect(repeated.catalog.entries.map((entry) => entry.id)).toEqual(collections.catalog.entries.map((entry) => entry.id));
    });

    it('associates high-collision searches with linear bounded catalog work', async () => {
        const fixture = createRecipeConsoleScaleFixture({ artifactRowCount: 6 });
        const eventRows = (fixture.files['events.jsonl'] ?? '').split('\n').map((line) => JSON.parse(line) as JsonRecord);
        const sourceEvent = eventRows[0] ?? {};
        const sourceValue = sourceEvent.value as JsonRecord;
        const collisions = Array.from({ length: 2_000 }, (_, index) => ({
            ...sourceEvent,
            value: {
                ...sourceValue,
                message: `catalog high-collision-${String(index).padStart(6, '0')}`
            }
        }));
        eventRows.splice(0, 1, ...collisions);
        const collisionFixture: RecipeConsoleScaleFixture = {
            ...fixture,
            files: {
                ...fixture.files,
                'events.jsonl': eventRows.map((row) => JSON.stringify(row)).join('\n')
            }
        };
        const input = inputForFixture(collisionFixture);
        const sourceRowCount = computeDistributedArtifactEvidenceSource(input).rawEntries.length;
        const { catalog, digests } = await computeCatalogWatchingDigests(input);

        for (const index of [0, 1_000, 1_999]) {
            const result = await searchDistributedArtifactEvidenceWindow(catalog, {
                query: {
                    query: `catalog high-collision-${String(index).padStart(6, '0')}`
                }
            });
            expect(result, String(index)).toMatchObject({
                ok: true,
                window: { counts: { retainedMatches: 1 } }
            });
        }
        expect(sourceRowCount).toBe(2_008);
        expect(catalog.totalEntries).toBe(sourceRowCount);
        expect(catalog.entries).toHaveLength(sourceRowCount);
        expect(digests.calls).toBeGreaterThanOrEqual(sourceRowCount);
        expect(digests.calls).toBeLessThanOrEqual(sourceRowCount + 2);
        expect(digests.peakInFlight).toBe(128);
    }, 60_000);

    it('keeps raw-distinct bounded-identical rows while dropping a true repeat', async () => {
        const fixture = createRecipeConsoleScaleFixture({ artifactRowCount: 6 });
        const eventRows = (fixture.files['events.jsonl'] ?? '').split('\n').map((line) => JSON.parse(line) as JsonRecord);
        const sourceEvent = eventRows[0] ?? {};
        const sourceValue = sourceEvent.value as JsonRecord;
        const rawVariant = (token: string): Record<string, unknown> => ({
            ...sourceEvent,
            value: {
                ...sourceValue,
                message: 'Catalog bounded identity probe.',
                aFiller: 'x'.repeat(700),
                rawOnlyToken: token
            }
        });
        const alpha = rawVariant('raw-identity-alphaunique');
        const pastSearchLimit = {
            ...sourceEvent,
            value: { ...sourceValue, message: 'Catalog raw search limit probe.', aFiller: 'x'.repeat(2_100), rawOnlyToken: 'raw-identity-gammaunique' }
        };
        eventRows.splice(0, 1, alpha, { ...alpha }, rawVariant('raw-identity-betaunique'), pastSearchLimit);
        const rawIdentityFixture: RecipeConsoleScaleFixture = {
            ...fixture,
            files: {
                ...fixture.files,
                'events.jsonl': eventRows.map((row) => JSON.stringify(row)).join('\n')
            }
        };
        const input = inputForFixture(rawIdentityFixture);
        const collections = await computeDistributedArtifactEvidenceCollections(input);

        expect(collections.index).toEqual(computeDistributedArtifactEvidenceIndex(input));
        for (
            const token of [
                'raw-identity-alphaunique',
                'raw-identity-betaunique'
            ]
        ) {
            expect(
                await searchDistributedArtifactEvidenceWindow(collections.catalog, {
                    query: { query: token }
                }),
                token
            ).toMatchObject({
                ok: true,
                window: { counts: { retainedMatches: 1 } }
            });
        }
        expect(
            await searchDistributedArtifactEvidenceWindow(collections.catalog, {
                query: { query: 'raw-identity-gammaunique' }
            }),
            'a raw value is searched only up to the text limit'
        ).toMatchObject({ ok: true, window: { counts: { retainedMatches: 0 } } });
        const matchingRows = collections.catalog.entries.filter((entry) => entry.summary === 'Catalog bounded identity probe.');
        expect(matchingRows).toHaveLength(2);
        expect(new Set(matchingRows.map((entry) => entry.id)).size).toBe(2);
        expect(collections.catalog.totalEntries).toBe(computeDistributedArtifactEvidenceSource(input).rawEntries.length - 1);
    });

    it('keeps generic artifact-index compaction in its standalone reader', async () => {
        const text = await readFile(
            new URL(
                '../../../packages/shared-test/black-box-runner/fixtures/schema/v1/artifact-bundle/artifact-index.json',
                import.meta.url
            ),
            'utf8'
        );
        const parsed = parseBlackBoxRunnerArtifactIndex(text);

        expect(parsed.ok).toBe(true);
        expect(parsed.value).toMatchObject({
            compaction: { compacted: true },
            truncation: {
                totalEvents: 7,
                emittedEvents: 4,
                omittedEvents: 3,
                truncated: true
            }
        });
    });
});
