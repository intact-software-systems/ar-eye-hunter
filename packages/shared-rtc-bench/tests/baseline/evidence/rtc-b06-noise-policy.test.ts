import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import type { RtcBaselineJson, RtcBaselineResult } from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import { createRtcBaselineFinalizedReader } from '../../../baseline/evidence/rtc-baseline-finalized-reader.ts';
import { computeRtcBaselineMetricSummary } from '../../../baseline/evidence/rtc-baseline-statistics.ts';
import { readRtcB06EvidenceReport } from '../../../baseline/observation/read-rtc-b06-evidence-report.ts';
import {
    createRtcPerformanceObservationArchive,
    verifyRtcPerformanceObservationArchive
} from '../../../baseline/observation/rtc-performance-observation-archive.ts';
import { createRtcB06FinalizedArtifacts } from '../observation/rtc-performance-observation-fixture.ts';

const primaryId = '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3';
const candidateId = '20260831T100000Z-ffffffffffff-e3-memory-gh987654322-a1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256(bytes: Uint8Array) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
    return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function candidateArtifacts() {
    const artifacts = new Map(await createRtcB06FinalizedArtifacts(candidateId));
    for (const [path, bytes] of artifacts) {
        if (path !== 'SHA256SUMS') {
            artifacts.set(
                path,
                encoder.encode(
                    decoder.decode(bytes)
                        .replaceAll('c0cadb8216cf27d82a3143755e6965f3831ea164', 'f'.repeat(40))
                        .replaceAll('d45ae178384826f49fa31ab1e52c0f66d8ff069a', 'e'.repeat(40))
                )
            );
        }
    }
    return withChecksums(artifacts);
}

async function withChecksums(artifacts: Map<string, Uint8Array>) {
    const checksums = await Promise.all(
        [...artifacts].filter(([path]) => path !== 'SHA256SUMS')
            .map(async ([path, bytes]) => `${await sha256(bytes)}  ${path}`)
    );
    artifacts.set('SHA256SUMS', encoder.encode(checksums.sort().join('\n') + '\n'));
    return artifacts;
}

async function reader() {
    const primary = await createRtcB06FinalizedArtifacts(primaryId);
    const repeatId = primaryId + '-repeat-01';
    const repeat = await createRtcB06FinalizedArtifacts(repeatId, {
        primaryBaselineId: primaryId,
        primarySummarySha256: await sha256(primary.get('summary.json')!)
    });
    const baselines = new Map([
        [primaryId, primary],
        [repeatId, repeat],
        [candidateId, await candidateArtifacts()]
    ]);
    return readerFor(baselines);
}

function readerFor(baselines: ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>) {
    async function readBytes(id: string, path: string): Promise<RtcBaselineResult<Uint8Array>> {
        const bytes = baselines.get(id)?.get(path);
        return bytes === undefined
            ? { ok: false, issues: [{ path, code: 'missing-fixture', message: 'No acquisition supplied this artifact.' }] }
            : { ok: true, value: bytes };
    }
    return createRtcBaselineFinalizedReader({
        readBytes,
        readJson: async (id, path): Promise<RtcBaselineResult<RtcBaselineJson>> => {
            const bytes = await readBytes(id, path);
            return bytes.ok ? { ok: true, value: JSON.parse(decoder.decode(bytes.value)) as RtcBaselineJson } : bytes;
        },
        listArtifactPaths: async (id) => ({ ok: true, value: [...baselines.get(id)!.keys()].filter((path) => path !== 'SHA256SUMS') }),
        sha256
    });
}

async function withNoiseMetric(artifacts: ReadonlyMap<string, Uint8Array>, noisyMetric: 'connect' | 'send' | 'none') {
    const adjusted = new Map(artifacts);
    for (const [path, bytes] of adjusted) {
        if (path === 'SHA256SUMS') {
            continue;
        }
        const artifact = JSON.parse(decoder.decode(bytes));
        if (Array.isArray(artifact.samples)) {
            for (const sample of artifact.samples) {
                sample.metrics = ['connect', 'send'].map((metric) => ({
                    metric,
                    unit: 'ms',
                    value: metric === noisyMetric ? sample.identity.outerOrdinal * 10 : 10
                }));
            }
        }
        if (Array.isArray(artifact.metricSummaries)) {
            artifact.metricSummaries = artifact.metricSummaries.flatMap((summary: { workloadId: string; caseId: string; inputKey: string; count: number; }) =>
                ['connect', 'send'].map((metric) => ({
                    workloadId: summary.workloadId,
                    caseId: summary.caseId,
                    inputKey: summary.inputKey,
                    metric,
                    unit: 'ms',
                    ...computeRtcBaselineMetricSummary(Array.from({ length: summary.count }, (_, index) => metric === noisyMetric ? (index + 1) * 10 : 10))
                }))
            );
        }
        adjusted.set(path, encoder.encode(JSON.stringify(artifact)));
    }
    return withChecksums(adjusted);
}

async function withEnvironment(artifacts: ReadonlyMap<string, Uint8Array>, environmentId: 'E3-memory' | 'E4-pg') {
    if (environmentId === 'E3-memory') {
        return artifacts;
    }
    const adjusted = new Map(
        [...artifacts].filter(([path]) => path !== 'SHA256SUMS').map((
            [path, bytes]
        ) => [
            path.replaceAll('e3-memory', 'e4-pg'),
            encoder.encode(
                decoder.decode(bytes)
                    .replaceAll('E3-memory', 'E4-pg').replaceAll('e3-memory', 'e4-pg')
                    .replaceAll('"decision":"not-required"', '"decision":"required"')
                    .replaceAll('"value":"memory"', '"value":"postgres"')
                    .replaceAll('"databaseUrl":"absent"', '"databaseUrl":"present"')
                    .replaceAll('"iceModePresent":false', '"iceModePresent":true')
                    .replaceAll('"iceModeRaw":null', '"iceModeRaw":"local"')
            )
        ])
    );
    return withChecksums(adjusted);
}

describe('B06 finalized noise policy', () => {
    it.each(['E3-memory', 'E4-pg'] as const)('keeps %s comparison inconclusive when noise shifts to another selected repeat metric', async (environmentId) => {
        const primary = await withEnvironment(await withNoiseMetric(await createRtcB06FinalizedArtifacts(primaryId), 'connect'), environmentId);
        const repeatId = primaryId + '-repeat-01';
        const repeat = await withEnvironment(
            await withNoiseMetric(
                await createRtcB06FinalizedArtifacts(repeatId, {
                    primaryBaselineId: primaryId,
                    primarySummarySha256: await sha256(primary.get('summary.json')!)
                }),
                'send'
            ),
            environmentId
        );
        const candidate = await withEnvironment(await withNoiseMetric(await candidateArtifacts(), 'none'), environmentId);
        const primaryBaselineId = primaryId.replace('e3-memory', environmentId.toLowerCase());
        const repeatBaselineId = repeatId.replace('e3-memory', environmentId.toLowerCase());
        const candidateBaselineId = candidateId.replace('e3-memory', environmentId.toLowerCase());
        const finalized = readerFor(new Map([[primaryBaselineId, primary], [repeatBaselineId, repeat], [candidateBaselineId, candidate]]));
        expect(await finalized.readRepeatRequirement({ baselineId: primaryBaselineId })).toEqual({ ok: true, value: { workloadIds: [] } });
        const result = await finalized.readPairedComparison({
            primaryBaselineId,
            primaryComparisonCohortId: repeatBaselineId,
            candidateBaselineId,
            candidateComparisonCohortId: candidateBaselineId,
            workloadId: 'RTC-B06'
        });
        expect(result).toMatchObject({
            ok: true,
            value: { outcome: 'inconclusive-still-noisy', primary: { comparisonBaselineId: repeatBaselineId, repeatRequired: false } }
        });
        if (!result.ok) {
            throw new Error('Verified noise-shift comparison must reach its descriptive outcome.');
        }
        expect(result.value.comparisons.some((comparison) => comparison.baseline.coefficientOfVariation > 0.1)).toBe(true);
        expect(result.value.comparisons.some((comparison) => comparison.baseline.coefficientOfVariation === 0)).toBe(true);
        expect(result.value.comparisons.every((comparison) => comparison.candidate.coefficientOfVariation === 0)).toBe(true);
    });
    it('does not require a fresh acquisition for a checksum-verified noisy primary', async () => {
        const finalized = await reader();
        expect(await finalized.readRepeatRequirement({ baselineId: primaryId })).toEqual({ ok: true, value: { workloadIds: [] } });
        expect(await finalized.readVerifiedRepeatPrimary({ baselineId: primaryId })).toMatchObject({ ok: true, value: { triggeredWorkloadIds: ['RTC-B06'] } });
    });

    it('permits an independently selected exact linked repeat without automatically requiring it', async () => {
        const finalized = await reader();
        expect(
            await finalized.readPairedComparison({
                primaryBaselineId: primaryId,
                primaryComparisonCohortId: primaryId + '-repeat-01',
                candidateBaselineId: candidateId,
                candidateComparisonCohortId: candidateId,
                workloadId: 'RTC-B06'
            })
        ).toMatchObject({
            ok: true,
            value: { outcome: 'inconclusive-still-noisy', primary: { comparisonBaselineId: primaryId + '-repeat-01', repeatRequired: false } }
        });
    });

    it('retains warning evidence through archive integrity verification and report consumption', async () => {
        const artifacts = new Map(await createRtcB06FinalizedArtifacts(primaryId));
        const path = 'results/external-cohorts/rtc-b06-e3-memory-retention.json';
        const cohort = JSON.parse(decoder.decode(artifacts.get(path)!));
        const ids = cohort.identity.memberSampleIds.slice(0, 2);
        cohort.rawEvidence = {
            retainedAttemptCount: 3,
            requiredHeapBreachCount: 2,
            heapBreachingSampleIds: ids,
            stateDriftSampleIds: [],
            failedMemberSampleIds: [],
            warnings: [{
                path: '$.rawEvidence.heapBreachingSampleIds',
                code: 'retention-heap-threshold-breached',
                message: '2 retained attempts breached the 2-attempt heap threshold.'
            }]
        };
        artifacts.set(path, encoder.encode(JSON.stringify(cohort)));
        await withChecksums(artifacts);
        const observation = {
            schema: 'rallar.rtc-b06-performance-observation.v1' as const,
            observationId: primaryId,
            startedAt: '2026-08-30T10:00:00.417Z',
            completedAt: '2026-08-30T10:30:00.417Z',
            source: { commit: 'c0cadb8216cf27d82a3143755e6965f3831ea164', tree: 'd45ae178384826f49fa31ab1e52c0f66d8ff069a', ref: 'main' },
            workflow: { runId: 987654321, runAttempt: 3, url: 'https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/987654321' },
            primary: { outcome: 'passed' as const, acceptedMetrics: true },
            repeat: { decision: 'not-required' as const, outcome: 'not-run' as const }
        };
        const archive = await createRtcPerformanceObservationArchive({ observation, primaryArtifacts: artifacts });
        expect(await verifyRtcPerformanceObservationArchive({ bytes: archive.bytes, indexEntry: archive.indexEntry })).toEqual({
            ok: true,
            value: observation
        });
        const entries = unzipSync(archive.bytes);
        const restored = new Map(
            Object.entries(entries).filter(([name]) => name.startsWith('primary/' + primaryId + '/')).map((
                [name, bytes]
            ) => [name.slice(('primary/' + primaryId + '/').length), bytes])
        );
        const summary = JSON.parse(decoder.decode(restored.get('summary.json')!));
        expect(readRtcB06EvidenceReport({ artifacts: restored, metricSummaries: summary.metricSummaries })).toMatchObject({
            ok: true,
            value: { metricOutcome: 'inconclusive', warnings: [{ code: 'retention-heap-threshold-breached' }] }
        });
        const stableDuration = {
            workloadId: 'RTC-B06' as const,
            caseId: 'retention-100',
            inputKey: 'e3-memory-retention-100',
            metric: 'reconnect-ready.messages-rtc',
            unit: 'milliseconds',
            ...computeRtcBaselineMetricSummary([10, 10, 10])
        };
        const noisyHeap = { ...stableDuration, metric: 'post-gc-heap.cycle-100', unit: 'bytes', ...computeRtcBaselineMetricSummary([100, 200, 300]) };
        expect(readRtcB06EvidenceReport({ artifacts: restored, metricSummaries: [stableDuration, noisyHeap] })).toMatchObject({
            ok: true,
            value: { metricOutcome: 'inconclusive' }
        });
        const equivalent = new Map(restored);
        equivalent.set(
            path,
            encoder.encode(
                JSON.stringify({
                    ...cohort,
                    rawEvidence: {
                        ...cohort.rawEvidence,
                        warnings: [{
                            message: '2 retained attempts breached the 2-attempt heap threshold.',
                            code: 'retention-heap-threshold-breached',
                            path: '$.rawEvidence.heapBreachingSampleIds'
                        }]
                    }
                })
            )
        );
        expect(readRtcB06EvidenceReport({ artifacts: equivalent, metricSummaries: summary.metricSummaries })).toMatchObject({ ok: true });
        const unsupported = new Map(restored);
        const wrongEnvironment = JSON.parse(decoder.decode(unsupported.get('environment.json')!));
        wrongEnvironment.environmentId = 'E2-browser';
        unsupported.set('environment.json', encoder.encode(JSON.stringify(wrongEnvironment)));
        expect(readRtcB06EvidenceReport({ artifacts: unsupported, metricSummaries: summary.metricSummaries })).toMatchObject({ ok: false });
        const corrupted = new Map(restored);
        corrupted.set(path, encoder.encode(JSON.stringify({ ...cohort, rawEvidence: { ...cohort.rawEvidence, warnings: [{ code: 'unsupported-warning' }] } })));
        expect(readRtcB06EvidenceReport({ artifacts: corrupted, metricSummaries: summary.metricSummaries })).toMatchObject({
            ok: false,
            issues: [{ code: 'invalid-retention-warnings' }]
        });
    });

    it('reports noisy original cohorts as inconclusive rather than comparative optimization evidence', async () => {
        const finalized = await reader();
        expect(
            await finalized.readPairedComparison({
                primaryBaselineId: primaryId,
                primaryComparisonCohortId: primaryId,
                candidateBaselineId: candidateId,
                candidateComparisonCohortId: candidateId,
                workloadId: 'RTC-B06'
            })
        ).toMatchObject({ ok: true, value: { outcome: 'inconclusive-still-noisy', primary: { repeatRequired: false }, candidate: { repeatRequired: false } } });
    });
});
