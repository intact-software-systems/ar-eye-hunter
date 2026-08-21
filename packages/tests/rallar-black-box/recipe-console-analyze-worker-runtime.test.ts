import { describe, expect, it } from 'vitest';
import {
    ANALYZE_PROJECTION_MAX_ARRAY_LENGTH,
    ANALYZE_PROJECTION_MAX_SERIALIZED_BYTES,
    ANALYZE_PROJECTION_MAX_TEXT_BYTES
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-artifact-projection.ts';
import { createAnalyzeControlIdentityDigest } from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-control-identity-digest.ts';
import type { AnalyzeWorkerEnvelope, AnalyzeWorkerResponse } from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-contract.ts';
import {
    ANALYZE_WORKER_MAX_LABEL_BYTES,
    ANALYZE_WORKER_MAX_REQUEST_TEXT_BYTES
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-request-boundary.ts';
import { createAnalyzeWorkerRuntime } from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-runtime.ts';
import { createRecipeConsoleScaleFixture } from '../../../packages/shared-test/rallar-bb-test/scale-fixture.ts';

describe('Recipe Console Analyze worker runtime', () => {
    it('accepts transferred bytes without parsing and derives one bounded model only after start', async () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 60, resultCount: 20 });
        const posted: AnalyzeWorkerEnvelope[] = [];
        const runtime = createAnalyzeWorkerRuntime({
            postMessage(message, transfer) {
                posted.push({ message, transfer });
            }
        }, { now: () => 10 });
        let parseCount = 0;
        const originalParse = JSON.parse;
        JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
            parseCount += 1;
            return originalParse(...args);
        }) as typeof JSON.parse;

        try {
            await runtime.handle({
                type: 'offer',
                operationGeneration: 7,
                artifact: {
                    source: 'local-files',
                    label: 'Scale artifact',
                    generatedAtEpochMs: fixture.generatedAtEpochMs,
                    artifactSchemaVersion: fixture.artifactSchemaVersion,
                    files: transferFiles(fixture.files)
                }
            });
            expect(messages(posted)).toEqual([{
                type: 'accepted',
                operationGeneration: 7
            }]);
            expect(parseCount).toBe(0);

            await runtime.handle({ type: 'start', operationGeneration: 7 });

            const complete = messages(posted).find(
                (message): message is Extract<AnalyzeWorkerResponse, { type: 'complete'; }> => message.type === 'complete'
            );
            expect(complete).toBeDefined();
            expect(complete?.projection.identity).toEqual({
                distributedRunId: 'recipe-console-scale-distributed-run',
                controlRunId: 'recipe-console-scale-control-run'
            });
            expect(complete?.initialWindow.entries.length).toBeLessThanOrEqual(64);
            expect(complete?.telemetry).toMatchObject({
                parseDurationMs: expect.any(Number),
                sourceFileCount: Object.keys(fixture.files).length,
                sourceBytes: fixture.bytes.total,
                pipelinePassCount: 1,
                sourceCollectionPassCount: 1,
                sourceFileVisitCount: Object.keys(fixture.files).length,
                documentParseCount: 6,
                jsonlFilePassCount: 2,
                jsonlRowParseCount: fixture.counts.sourceRows
            });
            expect(allNumbersFinite(complete?.telemetry)).toBe(true);
            expect(posted.find((row) => row.message.type === 'complete')?.transfer)
                .toEqual([complete?.exportBytes]);
        }
        finally {
            JSON.parse = originalParse;
            runtime.dispose();
        }
    });

    it('parses a raw Control artifact envelope only after start and enforces file-count bounds in-worker', async () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const harness = runtimeHarness();
        const envelopeBytes = new TextEncoder().encode(JSON.stringify({
            artifactSchemaVersion: fixture.artifactSchemaVersion,
            distributedRunId: 'recipe-console-scale-distributed-run',
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            files: fixture.files
        })).buffer as ArrayBuffer;
        const expectedControlIdentity = await createAnalyzeControlIdentityDigest({
            distributedRunId: 'recipe-console-scale-distributed-run'
        });

        await harness.runtime.handle({
            type: 'offer',
            operationGeneration: 4,
            artifact: {
                source: 'control',
                label: 'Raw Control artifact',
                files: [],
                controlEnvelope: envelopeBytes,
                expectedControlIdentity
            }
        });
        expect(harness.messages).toEqual([{
            type: 'accepted',
            operationGeneration: 4
        }]);
        await harness.runtime.handle({ type: 'start', operationGeneration: 4 });
        expect(harness.messages.at(-1)).toMatchObject({
            type: 'complete',
            projection: {
                identity: {
                    distributedRunId: 'recipe-console-scale-distributed-run'
                }
            },
            telemetry: {
                sourceFileCount: Object.keys(fixture.files).length,
                sourceBytes: fixture.bytes.total
            }
        });

        const excessive = runtimeHarness();
        const files = Object.fromEntries(Array.from(
            { length: 25 },
            (_, index) => [`candidate-${index}.json`, '{}']
        ));
        await excessive.runtime.handle({
            type: 'offer',
            operationGeneration: 5,
            artifact: {
                source: 'control',
                label: 'Too many files',
                files: [],
                expectedControlIdentity: await createAnalyzeControlIdentityDigest({
                    distributedRunId: 'too-many'
                }),
                controlEnvelope: new TextEncoder().encode(JSON.stringify({
                    artifactSchemaVersion: 2,
                    distributedRunId: 'too-many',
                    generatedAtEpochMs: 1,
                    files
                })).buffer as ArrayBuffer
            }
        });
        await excessive.runtime.handle({ type: 'start', operationGeneration: 5 });
        expect(excessive.messages.at(-1)).toMatchObject({
            type: 'failed',
            operationGeneration: 5,
            error: { code: 'invalid-artifact', stage: 'parse', recoverable: true }
        });

        const mismatched = runtimeHarness();
        await mismatched.runtime.handle({
            type: 'offer',
            operationGeneration: 6,
            artifact: {
                source: 'control',
                label: 'Mismatched outer identity',
                files: [],
                expectedControlIdentity: await createAnalyzeControlIdentityDigest({
                    distributedRunId: 'outer-other-run'
                }),
                controlEnvelope: new TextEncoder().encode(JSON.stringify({
                    artifactSchemaVersion: fixture.artifactSchemaVersion,
                    distributedRunId: 'outer-other-run',
                    generatedAtEpochMs: fixture.generatedAtEpochMs,
                    files: fixture.files
                })).buffer as ArrayBuffer
            }
        });
        await mismatched.runtime.handle({ type: 'start', operationGeneration: 6 });
        expect(mismatched.messages.at(-1)).toMatchObject({
            type: 'failed',
            operationGeneration: 6,
            error: { code: 'identity-mismatch', stage: 'model', recoverable: true }
        });
        harness.runtime.dispose();
        excessive.runtime.dispose();
        mismatched.runtime.dispose();
    });

    it('enforces the existing v2 Control artifact base-file contract in-worker', async () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const invalidArtifacts = [
            {
                ...fixture,
                artifactSchemaVersion: 3
            },
            {
                ...fixture,
                files: Object.fromEntries(
                    Object.entries(fixture.files).filter(
                        ([name]) => name !== 'control-run.json'
                    )
                )
            }
        ];

        for (const [index, artifact] of invalidArtifacts.entries()) {
            const harness = runtimeHarness();
            await harness.runtime.handle({
                type: 'offer',
                operationGeneration: index + 1,
                artifact: {
                    source: 'control',
                    label: 'Contract-invalid Control artifact',
                    files: [],
                    expectedControlIdentity: await createAnalyzeControlIdentityDigest({
                        distributedRunId: 'recipe-console-scale-distributed-run'
                    }),
                    controlEnvelope: new TextEncoder().encode(JSON.stringify({
                        artifactSchemaVersion: artifact.artifactSchemaVersion,
                        distributedRunId: 'recipe-console-scale-distributed-run',
                        generatedAtEpochMs: artifact.generatedAtEpochMs,
                        files: artifact.files
                    })).buffer as ArrayBuffer
                }
            });
            await harness.runtime.handle({
                type: 'start',
                operationGeneration: index + 1
            });

            expect(harness.messages.at(-1)).toMatchObject({
                type: 'failed',
                error: { code: 'invalid-artifact', stage: 'parse', recoverable: true }
            });
            harness.runtime.dispose();
        }
    });

    it('validates exact long Control identities independently of bounded display fields', async () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const distributedRunId = `distributed-${'界'.repeat(600)}`;
        const controlRunId = `control-${'é'.repeat(600)}`;
        const files = Object.fromEntries(
            Object.entries(fixture.files).map(
                ([name, content]): [string, string | undefined] => [
                    name,
                    content
                        ?.replaceAll('recipe-console-scale-distributed-run', distributedRunId)
                        .replaceAll('recipe-console-scale-control-run', controlRunId)
                ]
            )
        );
        const envelope = {
            artifactSchemaVersion: 2,
            distributedRunId,
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            files
        };
        const expectedControlIdentity = await createAnalyzeControlIdentityDigest({
            distributedRunId,
            controlRunId
        });
        const harness = runtimeHarness();

        await harness.runtime.handle({
            type: 'offer',
            operationGeneration: 1,
            artifact: {
                source: 'control',
                label: 'Long identity Control artifact',
                files: [],
                expectedControlIdentity,
                controlEnvelope: new TextEncoder().encode(JSON.stringify(envelope)).buffer
            }
        });
        await harness.runtime.handle({ type: 'start', operationGeneration: 1 });

        const complete = harness.messages.find(
            (message): message is Extract<AnalyzeWorkerResponse, { type: 'complete'; }> => message.type === 'complete'
        );
        expect(complete?.controlIdentityValidated).toBe(true);
        expect(complete?.projection.identity.distributedRunId).not.toBe(distributedRunId);
        expect(complete?.projection.identity).toMatchObject({
            distributedRunIdExact: false,
            controlRunIdExact: false
        });

        const mismatch = runtimeHarness();
        await mismatch.runtime.handle({
            type: 'offer',
            operationGeneration: 1,
            artifact: {
                source: 'control',
                label: 'Wrong expected identity',
                files: [],
                expectedControlIdentity: await createAnalyzeControlIdentityDigest({
                    distributedRunId: `${distributedRunId}-other`,
                    controlRunId
                }),
                controlEnvelope: new TextEncoder().encode(JSON.stringify(envelope)).buffer
            }
        });
        await mismatch.runtime.handle({ type: 'start', operationGeneration: 1 });
        expect(mismatch.messages.at(-1)).toMatchObject({
            type: 'failed',
            error: { code: 'identity-mismatch', stage: 'model', recoverable: true }
        });
        harness.runtime.dispose();
        mismatch.runtime.dispose();
    });

    it('classifies an unusable distributed envelope without crossing artifact payload text', async () => {
        const harness = runtimeHarness();
        const secret = 'unusable-envelope-secret';
        await harness.runtime.handle({
            type: 'offer',
            operationGeneration: 8,
            artifact: {
                source: 'local-files',
                label: 'Malformed envelope',
                files: transferFiles({
                    'malformed-artifact-envelope.json': JSON.stringify({
                        artifactSchemaVersion: '2',
                        distributedRunId: 'distributed-a',
                        generatedAtEpochMs: 1,
                        files: { 'secret.json': secret }
                    })
                })
            }
        });
        await harness.runtime.handle({ type: 'start', operationGeneration: 8 });

        expect(harness.messages.at(-1)).toMatchObject({
            type: 'failed',
            operationGeneration: 8,
            error: { code: 'unusable-artifact', stage: 'model', recoverable: true }
        });
        expect(JSON.stringify(harness.messages)).not.toContain(secret);
        harness.runtime.dispose();
    });

    it('rejects a regressive artifact generation and preserves the newest candidate', async () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const harness = runtimeHarness();
        await harness.runtime.handle(offer(2, fixture));
        await harness.runtime.handle(offer(1, fixture));
        await harness.runtime.handle({ type: 'start', operationGeneration: 2 });

        expect(harness.messages.map((message) => message.type)).toEqual([
            'accepted',
            'failed',
            'complete'
        ]);
        expect(harness.messages[1]).toMatchObject({
            type: 'failed',
            operationGeneration: 1,
            error: { code: 'stale-generation', stage: 'offer' }
        });
        harness.runtime.dispose();
    });

    it('resets query/window authority for a newly accepted model generation', async () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const harness = runtimeHarness();
        await harness.runtime.handle(offer(1, fixture));
        await harness.runtime.handle({ type: 'start', operationGeneration: 1 });
        await harness.runtime.handle(search(1, 100, 100, fixture.needles.events.first));

        await harness.runtime.handle(offer(2, fixture));
        await harness.runtime.handle({ type: 'start', operationGeneration: 2 });
        await harness.runtime.handle(search(2, 1, 101, fixture.needles.events.last));

        expect(harness.messages).toContainEqual(expect.objectContaining({
            type: 'search-complete',
            modelGeneration: 2,
            queryGeneration: 1
        }));
        harness.runtime.dispose();
    });

    it('finds first, middle, and last scale evidence and returns only bounded worker projections', async () => {
        const fixture = createRecipeConsoleScaleFixture();
        const harness = runtimeHarness();
        await harness.runtime.handle(offer(9, fixture));
        await harness.runtime.handle({ type: 'start', operationGeneration: 9 });

        for (
            const [index, needle] of [
                fixture.needles.events.first,
                fixture.needles.events.middle,
                fixture.needles.events.last,
                fixture.needles.results.first,
                fixture.needles.results.middle,
                fixture.needles.results.last
            ].entries()
        ) {
            await harness.runtime.handle(search(9, index + 1, 200 + index, needle));
            const response = harness.messages.findLast((message) => message.type === 'search-complete');
            expect(response).toMatchObject({
                type: 'search-complete',
                window: { entries: [expect.objectContaining({})] }
            });
            expect(response).toMatchObject({
                window: { counts: { retainedMatches: 1 } }
            });
            expect(JSON.stringify(response).length).toBeLessThan(10_000);
        }

        const complete = harness.messages.find(
            (message): message is Extract<AnalyzeWorkerResponse, { type: 'complete'; }> => message.type === 'complete'
        );
        expect(complete).toBeDefined();
        expect(maxArrayLength(complete?.projection)).toBeLessThanOrEqual(64);
        expectBoundedWorkerProjection(complete?.projection);
        expectBoundedWorkerProjection(complete?.initialWindow);
        expectBoundedWorkerProjection(complete?.selected);
        expect(recursiveKeys(complete?.projection)).not.toEqual(expect.arrayContaining([
            'files',
            'snapshots',
            'catalog',
            'events',
            'results'
        ]));
        expect(recursiveKeys(complete?.projection).some((key) => key.toLocaleLowerCase().startsWith('raw'))).toBe(false);
        expect(JSON.parse(new TextDecoder().decode(complete?.exportBytes)))
            .toMatchObject({
                distributedRunId: complete?.projection.distributedRunId,
                files: expect.any(Object)
            });

        await harness.runtime.handle(search(9, 7, 299, ''));
        const allEvidence = harness.messages.findLast(
            (message): message is Extract<AnalyzeWorkerResponse, { type: 'search-complete'; }> => message.type === 'search-complete'
        );
        const initialNext = allEvidence?.window.nextCursor;
        expect(initialNext).toBeTruthy();
        if (initialNext) {
            await harness.runtime.handle({
                type: 'window',
                modelGeneration: 9,
                queryGeneration: 7,
                windowGeneration: 1,
                requestId: 300,
                query: {},
                cursor: initialNext,
                windowSize: 10_000
            });
        }
        const nextWindow = harness.messages.find(
            (message): message is Extract<AnalyzeWorkerResponse, { type: 'window-complete'; }> => message.type === 'window-complete'
        );
        expect(nextWindow?.window.entries).toHaveLength(64);
        expect(nextWindow?.window.windowSize).toBe(64);

        const selectedId = complete?.initialWindow.entries[0]?.id;
        await harness.runtime.handle({
            type: 'select',
            modelGeneration: 9,
            selectionGeneration: 1,
            requestId: 301,
            evidenceId: selectedId
        });
        expect(harness.messages).toContainEqual(expect.objectContaining({
            type: 'selection-complete',
            selected: expect.objectContaining({ id: selectedId })
        }));
        const selectionComplete = harness.messages.findLast(
            (message): message is Extract<AnalyzeWorkerResponse, {
                type: 'selection-complete';
            }> => message.type === 'selection-complete'
        );
        expectBoundedWorkerProjection(selectionComplete?.selected);

        await harness.runtime.handle({
            type: 'tune',
            modelGeneration: 9,
            tuneGeneration: 1,
            requestId: 302,
            focusRunId: complete?.projection.distributedRunId
        });
        const tune = harness.messages.find(
            (message): message is Extract<AnalyzeWorkerResponse, { type: 'tune-complete'; }> => message.type === 'tune-complete'
        );
        expect(tune?.facade.identity).toEqual(complete?.projection.identity);
        expect(tune?.facade).not.toHaveProperty('manifest');
        expect(tune?.facade.manifestSummary.recipeIds.entries.length)
            .toBeLessThanOrEqual(100);
        expect(tune?.facade.tuningInventory.knobs.length).toBeLessThanOrEqual(100);
        expect(tune?.facade.tuningInventory.totalKnobs).toBe(
            (tune?.facade.tuningInventory.knobs.length ?? 0) +
                (tune?.facade.tuningInventory.omittedKnobs ?? 0)
        );
        expect(tune?.facade.distributedRun.targetAgentIds.entries.length)
            .toBeLessThanOrEqual(100);
        expect(tune?.facade.receivedMessageDeltas.entries.length)
            .toBeLessThanOrEqual(100);
        expect(tune?.facade.selection.artifactRole).toBe('focus');
        expect(tune?.facade.analysis.spa?.verdict)
            .toEqual(complete?.projection.analysis.spa?.verdict);
        expect(tune?.facade.analysis.spa).not.toHaveProperty('report');
        expectBoundedWorkerProjection(tune?.facade);
        expect(recursiveKeys(tune?.facade)).not.toEqual(expect.arrayContaining([
            'files',
            'snapshots',
            'catalog',
            'events',
            'results'
        ]));
        expect(allNumbersFinite(tune?.telemetry)).toBe(true);

        await harness.runtime.handle({
            type: 'tune',
            modelGeneration: 9,
            tuneGeneration: 2,
            requestId: 303,
            focusRunId: 'different-focus',
            compareLeft: complete?.projection.distributedRunId,
            compareRight: 'different-focus'
        });
        const compareLeftFacade = harness.messages.findLast(
            (message): message is Extract<AnalyzeWorkerResponse, { type: 'tune-complete'; }> => message.type === 'tune-complete'
        );
        expect(compareLeftFacade).toMatchObject({
            type: 'tune-complete',
            requestId: 303,
            facade: { selection: { artifactRole: 'compare-left' } }
        });
        harness.runtime.dispose();
    }, 20_000);

    it('round-trips oversized evidence authority through a bounded opaque handle', async () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 3, resultCount: 3 });
        const eventLines = fixture.files['events.jsonl']?.split('\n') ?? [];
        const firstEvent = JSON.parse(eventLines[0] ?? '{}') as Record<string, unknown>;
        firstEvent.eventId = `${'oversized-evidence-id-'.repeat(100_000)}tail`;
        eventLines[0] = JSON.stringify(firstEvent);
        const hostileFixture = {
            ...fixture,
            files: { ...fixture.files, 'events.jsonl': eventLines.join('\n') }
        };
        const harness = runtimeHarness();

        await harness.runtime.handle(offer(3, hostileFixture));
        await harness.runtime.handle({ type: 'start', operationGeneration: 3 });
        const complete = harness.messages.find(
            (message): message is Extract<AnalyzeWorkerResponse, { type: 'complete'; }> => message.type === 'complete'
        );
        const handle = complete?.initialWindow.entries.find((entry) => entry.id.startsWith('opaque-id:'))?.id;
        expect(handle).toMatch(/^opaque-id:/);
        if (handle) {
            await harness.runtime.handle({
                type: 'select',
                modelGeneration: 3,
                selectionGeneration: 1,
                requestId: 303,
                evidenceId: handle
            });
        }

        expect(harness.messages).toContainEqual(expect.objectContaining({
            type: 'selection-complete',
            requestId: 303,
            selected: expect.objectContaining({ id: handle })
        }));
        harness.runtime.dispose();
    }, 20_000);

    it('returns typed payload-free failures and releases all authority on disposal', async () => {
        const harness = runtimeHarness();
        const secret = 'Bearer should-never-cross-the-worker-boundary';
        const bytes = new TextEncoder().encode(`{${secret}`);
        await harness.runtime.handle({
            type: 'offer',
            operationGeneration: 1,
            artifact: {
                source: 'local-files',
                label: secret,
                files: [{ name: 'secret.json', bytes: bytes.buffer as ArrayBuffer }]
            }
        });
        await harness.runtime.handle({ type: 'start', operationGeneration: 1 });
        const failed = harness.messages.find((message) => message.type === 'failed');
        expect(failed).toMatchObject({
            type: 'failed',
            error: { code: 'invalid-artifact', recoverable: true }
        });
        expect(JSON.stringify(failed)).not.toContain(secret);

        await harness.runtime.handle({ type: 'dispose', reason: 'clear' });
        await harness.runtime.handle(offer(
            2,
            createRecipeConsoleScaleFixture({
                eventCount: 6,
                resultCount: 3
            })
        ));
        expect(harness.messages.at(-1)).toMatchObject({
            type: 'failed',
            error: { code: 'worker-disposed', recoverable: false }
        });
    });

    it('rejects malformed wire requests with a typed secret-free boundary error', async () => {
        const harness = runtimeHarness();
        const secret = 'request-payload-secret';

        await harness.runtime.handle({
            type: 'not-a-worker-operation',
            payload: secret
        } as never);

        expect(harness.messages).toEqual([{
            type: 'failed',
            error: {
                code: 'invalid-request',
                stage: 'offer',
                recoverable: true
            }
        }]);
        expect(JSON.stringify(harness.messages)).not.toContain(secret);
        harness.runtime.dispose();
    });

    it('rejects malformed nested query and Tune fields without throwing or leaking payloads', async () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const harness = runtimeHarness();
        await harness.runtime.handle(offer(1, fixture));
        await harness.runtime.handle({ type: 'start', operationGeneration: 1 });
        const secret = 'nested-wire-secret';

        await expect(harness.runtime.handle({
            type: 'search',
            modelGeneration: 1,
            queryGeneration: 1,
            requestId: 81,
            query: { query: { secret } },
            windowSize: 64
        } as never)).resolves.toBeUndefined();
        await expect(harness.runtime.handle({
            type: 'tune',
            modelGeneration: 1,
            tuneGeneration: 1,
            requestId: 82,
            timingMetric: { secret }
        } as never)).resolves.toBeUndefined();

        expect(harness.messages.slice(-2)).toEqual([
            {
                type: 'failed',
                error: { code: 'invalid-request', stage: 'search', recoverable: true }
            },
            {
                type: 'failed',
                error: { code: 'invalid-request', stage: 'tune', recoverable: true }
            }
        ]);
        expect(JSON.stringify(harness.messages.slice(-2))).not.toContain(secret);
        harness.runtime.dispose();
    });

    it('rejects oversized offer metadata and RPC text before derivation', async () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const offerHarness = runtimeHarness();
        const oversizedLabel = 'l'.repeat(ANALYZE_WORKER_MAX_LABEL_BYTES + 1);
        await offerHarness.runtime.handle({
            ...offer(1, fixture),
            artifact: { ...offer(1, fixture).artifact, label: oversizedLabel }
        });
        expect(offerHarness.messages.at(-1)).toMatchObject({
            type: 'failed',
            error: { code: 'invalid-request', stage: 'offer', recoverable: true }
        });
        await offerHarness.runtime.handle({
            ...offer(1, fixture),
            artifact: {
                ...offer(1, fixture).artifact,
                ignoredFiles: Array.from({ length: 25 }, (_, index) => ({
                    basename: `ignored-${index}.txt`,
                    sourcePath: `ignored-${index}.txt`,
                    reason: 'unsupported-extension'
                }))
            }
        });
        expect(offerHarness.messages.at(-1)).toMatchObject({
            type: 'failed',
            error: { code: 'invalid-request', stage: 'offer', recoverable: true }
        });
        const digest = await createAnalyzeControlIdentityDigest({
            distributedRunId: 'distributed-a'
        });
        await offerHarness.runtime.handle({
            type: 'offer',
            operationGeneration: 1,
            artifact: {
                source: 'control',
                label: 'Digest with smuggled metadata',
                files: [],
                controlEnvelope: new ArrayBuffer(0),
                expectedControlIdentity: {
                    ...digest,
                    smuggled: 'must-not-cross'
                }
            }
        } as never);
        expect(offerHarness.messages.at(-1)).toMatchObject({
            type: 'failed',
            error: { code: 'invalid-request', stage: 'offer', recoverable: true }
        });
        expect(JSON.stringify(offerHarness.messages)).not.toContain('must-not-cross');

        const harness = runtimeHarness();
        await harness.runtime.handle(offer(1, fixture));
        await harness.runtime.handle({ type: 'start', operationGeneration: 1 });
        const oversized = '界'.repeat(ANALYZE_WORKER_MAX_REQUEST_TEXT_BYTES + 1);
        const requests = [
            {
                type: 'search',
                modelGeneration: 1,
                queryGeneration: 1,
                requestId: 91,
                query: { query: oversized },
                windowSize: 64
            },
            {
                type: 'window',
                modelGeneration: 1,
                queryGeneration: 1,
                windowGeneration: 1,
                requestId: 92,
                query: {},
                cursor: oversized,
                windowSize: 64
            },
            {
                type: 'select',
                modelGeneration: 1,
                selectionGeneration: 1,
                requestId: 93,
                evidenceId: oversized
            },
            {
                type: 'tune',
                modelGeneration: 1,
                tuneGeneration: 1,
                requestId: 94,
                focusRunId: oversized
            }
        ] as const;
        for (const request of requests) {
            await harness.runtime.handle(request);
        }

        expect(harness.messages.slice(-requests.length)).toEqual([
            expect.objectContaining({
                type: 'failed',
                error: expect.objectContaining({ stage: 'search' })
            }),
            expect.objectContaining({
                type: 'failed',
                error: expect.objectContaining({ stage: 'window' })
            }),
            expect.objectContaining({
                type: 'failed',
                error: expect.objectContaining({ stage: 'selection' })
            }),
            expect.objectContaining({
                type: 'failed',
                error: expect.objectContaining({ stage: 'tune' })
            })
        ]);
        expect(JSON.stringify(harness.messages.slice(-requests.length)))
            .not.toContain(oversized);
        offerHarness.runtime.dispose();
        harness.runtime.dispose();
    });

    it('suppresses late search and window replies by independent generation', async () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 60, resultCount: 20 });
        const harness = runtimeHarness();
        await harness.runtime.handle(offer(1, fixture));
        await harness.runtime.handle({ type: 'start', operationGeneration: 1 });
        const searchStart = harness.messages.length;
        await Promise.all([
            harness.runtime.handle(search(1, 1, 401, fixture.needles.events.first)),
            harness.runtime.handle(search(1, 2, 402, fixture.needles.events.last))
        ]);
        expect(
            harness.messages.slice(searchStart).filter(
                (message) => message.type === 'search-complete'
            )
        ).toEqual([expect.objectContaining({
            type: 'search-complete',
            queryGeneration: 2,
            requestId: 402
        })]);

        await harness.runtime.handle(search(1, 3, 403, ''));
        const page = harness.messages.findLast(
            (message): message is Extract<AnalyzeWorkerResponse, { type: 'search-complete'; }> => message.type === 'search-complete'
        );
        const cursor = page?.window.nextCursor;
        expect(cursor).toBeTruthy();
        if (cursor) {
            const windowStart = harness.messages.length;
            await Promise.all([
                harness.runtime.handle({
                    type: 'window',
                    modelGeneration: 1,
                    queryGeneration: 3,
                    windowGeneration: 1,
                    requestId: 404,
                    query: {},
                    cursor,
                    windowSize: 64
                }),
                harness.runtime.handle({
                    type: 'window',
                    modelGeneration: 1,
                    queryGeneration: 3,
                    windowGeneration: 2,
                    requestId: 405,
                    query: {},
                    cursor,
                    windowSize: 64
                })
            ]);
            expect(
                harness.messages.slice(windowStart).filter(
                    (message) => message.type === 'window-complete'
                )
            ).toEqual([expect.objectContaining({
                type: 'window-complete',
                windowGeneration: 2,
                requestId: 405
            })]);

            await harness.runtime.handle(search(
                1,
                4,
                406,
                fixture.needles.events.middle
            ));
            const crossQueryStart = harness.messages.length;
            await harness.runtime.handle({
                type: 'window',
                modelGeneration: 1,
                queryGeneration: 3,
                windowGeneration: 3,
                requestId: 407,
                query: {},
                cursor,
                windowSize: 64
            });
            expect(
                harness.messages.slice(crossQueryStart).filter(
                    (message) => message.type === 'window-complete'
                )
            ).toEqual([]);
        }
        harness.runtime.dispose();
    });

    it('reimports the transferred portable envelope with equivalent identity and counts', async () => {
        const fixture = createRecipeConsoleScaleFixture({ eventCount: 6, resultCount: 3 });
        const source = runtimeHarness();
        await source.runtime.handle(offer(1, fixture));
        await source.runtime.handle({ type: 'start', operationGeneration: 1 });
        const exported = source.messages.find(
            (message): message is Extract<AnalyzeWorkerResponse, { type: 'complete'; }> => message.type === 'complete'
        );
        expect(exported).toBeDefined();

        const reimported = runtimeHarness();
        if (exported) {
            await reimported.runtime.handle({
                type: 'offer',
                operationGeneration: 2,
                artifact: {
                    source: 'local-files',
                    label: 'Reimported envelope',
                    files: [{ name: 'portable.json', bytes: exported.exportBytes }]
                }
            });
            await reimported.runtime.handle({ type: 'start', operationGeneration: 2 });
        }
        const complete = reimported.messages.find(
            (message): message is Extract<AnalyzeWorkerResponse, { type: 'complete'; }> => message.type === 'complete'
        );
        expect(complete?.projection.identity).toEqual(exported?.projection.identity);
        expect(complete?.projection.workspace.source).toBe('bundle-envelope');
        expect(complete?.telemetry.totalEntryCount)
            .toBe(exported?.telemetry.totalEntryCount);
        source.runtime.dispose();
        reimported.runtime.dispose();
    });
});

type ScaleFixture = ReturnType<typeof createRecipeConsoleScaleFixture>;

function runtimeHarness() {
    const envelopes: AnalyzeWorkerEnvelope[] = [];
    const runtime = createAnalyzeWorkerRuntime({
        postMessage(message, transfer) {
            envelopes.push({ message, transfer });
        }
    }, { now: () => 10 });
    return {
        runtime,
        envelopes,
        get messages(): AnalyzeWorkerResponse[] {
            return messages(envelopes);
        }
    };
}

function offer(
    operationGeneration: number,
    fixture: ScaleFixture
): Extract<import('../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-contract.ts').AnalyzeWorkerRequest, { type: 'offer'; }> {
    return {
        type: 'offer',
        operationGeneration,
        artifact: {
            source: 'local-files',
            label: `Scale ${operationGeneration}`,
            generatedAtEpochMs: fixture.generatedAtEpochMs,
            artifactSchemaVersion: fixture.artifactSchemaVersion,
            files: transferFiles(fixture.files)
        }
    };
}

function search(
    modelGeneration: number,
    queryGeneration: number,
    requestId: number,
    query: string
): Extract<import('../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-contract.ts').AnalyzeWorkerRequest, { type: 'search'; }> {
    return {
        type: 'search',
        modelGeneration,
        queryGeneration,
        requestId,
        query: { query },
        windowSize: 64
    };
}

function transferFiles(
    files: Readonly<Record<string, string | undefined>>
): readonly Readonly<{ name: string; bytes: ArrayBuffer; }>[] {
    return Object.entries(files).flatMap(([name, value]) => {
        if (value === undefined) {
            return [];
        }
        const bytes = new TextEncoder().encode(value);
        return [{
            name,
            bytes: bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength
            ) as ArrayBuffer
        }];
    });
}

function messages(rows: readonly AnalyzeWorkerEnvelope[]): AnalyzeWorkerResponse[] {
    return rows.map((row) => row.message);
}

function allNumbersFinite(value: unknown): boolean {
    if (!value || typeof value !== 'object') {
        return false;
    }
    return Object.values(value).every((item) => typeof item !== 'number' || Number.isFinite(item));
}

function recursiveKeys(value: unknown): string[] {
    if (!value || typeof value !== 'object') {
        return [];
    }
    if (Array.isArray(value)) {
        return value.flatMap(recursiveKeys);
    }
    return Object.entries(value).flatMap(([key, child]) => [
        key,
        ...recursiveKeys(child)
    ]);
}

function maxArrayLength(value: unknown): number {
    if (!value || typeof value !== 'object') {
        return 0;
    }
    if (Array.isArray(value)) {
        return Math.max(value.length, ...value.map(maxArrayLength));
    }
    return Math.max(0, ...Object.values(value).map(maxArrayLength));
}

function expectBoundedWorkerProjection(value: unknown): void {
    expect(maxArrayLength(value)).toBeLessThanOrEqual(
        ANALYZE_PROJECTION_MAX_ARRAY_LENGTH
    );
    expect(maxUtf8StringBytes(value)).toBeLessThanOrEqual(
        ANALYZE_PROJECTION_MAX_TEXT_BYTES
    );
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength)
        .toBeLessThanOrEqual(ANALYZE_PROJECTION_MAX_SERIALIZED_BYTES);
}

function maxUtf8StringBytes(value: unknown): number {
    if (typeof value === 'string') {
        return new TextEncoder().encode(value).byteLength;
    }
    if (!value || typeof value !== 'object') {
        return 0;
    }
    if (Array.isArray(value)) {
        return Math.max(0, ...value.map(maxUtf8StringBytes));
    }
    return Math.max(
        0,
        ...Object.entries(value).flatMap(([key, child]) => [
            new TextEncoder().encode(key).byteLength,
            maxUtf8StringBytes(child)
        ])
    );
}
