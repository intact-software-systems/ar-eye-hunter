import { describe, expect, it } from 'vitest';

import {
    computeRtcBaselineExpectedSampleIdentities,
    deriveRtcBaselineCaptureManifest,
    deriveRtcBaselineOuterAttempts,
    deriveRtcBaselineRepeatManifest,
    locateRtcBaselineExternalAttempt
} from '../../../baseline/catalog/rtc-baseline-workload-manifest.ts';
import type { RtcBaselineJson } from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import { canonicalizeRtcBaselineRawReferences, classifyRtcBaselineArtifactPath } from '../../../baseline/evidence/rtc-baseline-evidence-layout.ts';
import { evaluateRtcBaselineWorkloadRepeatOutcome, rtcBaselineRepeatWorkloadIds } from '../../../baseline/evidence/rtc-baseline-statistics.ts';

const primaryRequest = {
    schema: 'rallar.rtc-baseline.capture-request.v1' as const,
    baselineId: '20260807-0123456789ab-e2-browser',
    workloadIds: ['RTC-B05'] as const,
    environmentId: 'E2-browser' as const,
    retainedSampleMultiplier: 1 as const,
    repeatLink: null,
    conditionalEnvironmentDecisions: []
};

function rows(text: string) {
    return text
        .trim()
        .split('\n')
        .map((line) => line.split('\t'));
}

const syntheticExpansionFacts = rows(`
RTC-B01\tpeer-connection-diagnostics-burst\tpairs-500\tW1/R1-5\t1/5\trtc-b01-peer-connection-diagnostics-burst-pairs-500
RTC-B01\tice-candidate-queue\tcandidates-25000\tW1/R1-5\t1/5\trtc-b01-ice-candidate-queue-candidates-25000
RTC-B01\tpeer-listener-cleanup\tpeers-10000\tW1/R1-5\t1/5\trtc-b01-peer-listener-cleanup-peers-10000
RTC-B02\tdata-channel-replace-key\tdepth-32\tW1-3/R1-15\t3/15\trtc-b02-data-channel-replace-key-depth-32
RTC-B02\tdata-channel-replace-key\tdepth-1000\tW1-3/R1-15\t3/15\trtc-b02-data-channel-replace-key-depth-1000
RTC-B02\tdata-channel-replace-key\tdepth-5000\tW1-3/R1-15\t3/15\trtc-b02-data-channel-replace-key-depth-5000
RTC-B02\tdata-channel-drain\tdepth-32\tW1-3/R1-15\t3/15\trtc-b02-data-channel-drain-depth-32
RTC-B02\tdata-channel-drain\tdepth-1000\tW1-3/R1-15\t3/15\trtc-b02-data-channel-drain-depth-1000
RTC-B02\tdata-channel-drain\tdepth-5000\tW1-3/R1-15\t3/15\trtc-b02-data-channel-drain-depth-5000
RTC-B02\tdata-channel-close-retention\tqueue-32\tW1-3/R1-15\t3/15\trtc-b02-data-channel-close-retention-queue-32
RTC-B02\tdata-channel-error-reference\tfixed\tW1-3/R1-15\t3/15\trtc-b02-data-channel-error-reference-fixed
RTC-B03\ttopology-star\tsessions-30\tW1-3/R1-15\t3/15\trtc-b03-topology-star-sessions-30
RTC-B03\ttopology-star\tsessions-100\tW1-3/R1-15\t3/15\trtc-b03-topology-star-sessions-100
RTC-B03\ttopology-star\tsessions-300\tW1-3/R1-15\t3/15\trtc-b03-topology-star-sessions-300
RTC-B03\ttopology-tree\tsessions-30\tW1-3/R1-15\t3/15\trtc-b03-topology-tree-sessions-30
RTC-B03\ttopology-tree\tsessions-100\tW1-3/R1-15\t3/15\trtc-b03-topology-tree-sessions-100
RTC-B03\ttopology-tree\tsessions-300\tW1-3/R1-15\t3/15\trtc-b03-topology-tree-sessions-300
RTC-B03\ttopology-mesh\tsessions-30\tW1-3/R1-15\t3/15\trtc-b03-topology-mesh-sessions-30
RTC-B03\ttopology-mesh\tsessions-100\tW1-3/R1-15\t3/15\trtc-b03-topology-mesh-sessions-100
RTC-B03\ttopology-mesh\tsessions-300\tW1-3/R1-15\t3/15\trtc-b03-topology-mesh-sessions-300
RTC-B03\troom-graph-rtt-sparse\tsessions-30\tW1-3/R1-15\t3/15\trtc-b03-room-graph-rtt-sparse-sessions-30
RTC-B03\troom-graph-rtt-sparse\tsessions-100\tW1-3/R1-15\t3/15\trtc-b03-room-graph-rtt-sparse-sessions-100
RTC-B03\troom-graph-rtt-sparse\tsessions-300\tW1-3/R1-15\t3/15\trtc-b03-room-graph-rtt-sparse-sessions-300
RTC-B03\troom-graph-rtt-complete\tsessions-30\tW1-3/R1-15\t3/15\trtc-b03-room-graph-rtt-complete-sessions-30
RTC-B03\troom-graph-rtt-complete\tsessions-100\tW1-3/R1-15\t3/15\trtc-b03-room-graph-rtt-complete-sessions-100
RTC-B03\troom-graph-rtt-complete\tsessions-300\tW1-3/R1-15\t3/15\trtc-b03-room-graph-rtt-complete-sessions-300
RTC-B03\trtt-repository-filter\troom-5-global-1000\tW1-3/R1-15\t3/15\trtc-b03-rtt-repository-filter-room-5-global-1000
RTC-B03\trtt-repository-filter\troom-5-global-10000\tW1-3/R1-15\t3/15\trtc-b03-rtt-repository-filter-room-5-global-10000
RTC-B03\trtt-repository-filter\troom-5-global-100000\tW1-3/R1-15\t3/15\trtc-b03-rtt-repository-filter-room-5-global-100000
RTC-B03\trtt-repository-filter\troom-30-global-1000\tW1-3/R1-15\t3/15\trtc-b03-rtt-repository-filter-room-30-global-1000
RTC-B03\trtt-repository-filter\troom-30-global-10000\tW1-3/R1-15\t3/15\trtc-b03-rtt-repository-filter-room-30-global-10000
RTC-B03\trtt-repository-filter\troom-30-global-100000\tW1-3/R1-15\t3/15\trtc-b03-rtt-repository-filter-room-30-global-100000
RTC-B03\ttopology-inactive-churn\tmode-retain\tW1/R1-5\t1/5\trtc-b03-topology-inactive-churn-mode-retain\t3
RTC-B03\ttopology-inactive-churn\tmode-cleanup\tW1/R1-5\t1/5\trtc-b03-topology-inactive-churn-mode-cleanup\t3
RTC-B04\tmulticast-serialization\tpeers-10-payload-4096\tW1-3/R1-15\t3/15\trtc-b04-multicast-serialization-peers-10-payload-4096
RTC-B04\tmulticast-serialization\tpeers-10-payload-65536\tW1-3/R1-15\t3/15\trtc-b04-multicast-serialization-peers-10-payload-65536
RTC-B04\tmulticast-serialization\tpeers-100-payload-4096\tW1-3/R1-15\t3/15\trtc-b04-multicast-serialization-peers-100-payload-4096
RTC-B04\tmulticast-serialization\tpeers-100-payload-65536\tW1-3/R1-15\t3/15\trtc-b04-multicast-serialization-peers-100-payload-65536
RTC-B04\tmulticast-serialization\tpeers-1000-payload-4096\tW1-3/R1-15\t3/15\trtc-b04-multicast-serialization-peers-1000-payload-4096
RTC-B04\tmulticast-serialization\tpeers-1000-payload-65536\tW1-3/R1-15\t3/15\trtc-b04-multicast-serialization-peers-1000-payload-65536
RTC-B04\tgroup-cache-fallback\tfixed\tW1-3/R1-15\t3/15\trtc-b04-group-cache-fallback-fixed
RTC-B04\tgroup-manager-state\tfixed\tW1-3/R1-15\t3/15\trtc-b04-group-manager-state-fixed
RTC-B04\tgroup-manager-peer-owners\tfixed\tW1-3/R1-15\t3/15\trtc-b04-group-manager-peer-owners-fixed
RTC-B04\theartbeat-callback-churn\tfixed\tW1-3/R1-15\t3/15\trtc-b04-heartbeat-callback-churn-fixed
`);

function expandOuterRange(range: string) {
    const units: Array<{ intendedPhase: 'warmup' | 'retained'; outerOrdinal: number; }> = [];
    for (const token of range.split('/')) {
        const intendedPhase = token.startsWith('W') ? 'warmup' : 'retained';
        const [firstText, lastText = firstText] = token.slice(1).split('-');
        for (let ordinal = Number(firstText); ordinal <= Number(lastText); ordinal += 1) {
            units.push({ intendedPhase, outerOrdinal: ordinal });
        }
    }
    return units;
}

describe('RTC baseline workload manifests', () => {
    it('derives every ordered B06 outer unit and every predeclared sample identity', () => {
        const manifest = deriveRtcBaselineCaptureManifest({
            ...primaryRequest,
            baselineId: '20260807-0123456789ab-e3-memory',
            workloadIds: ['RTC-B06'],
            environmentId: 'E3-memory'
        });
        const outerRows = manifest.outerAttempts.map(
            (outer) => `${outer.caseId}/${outer.inputKey}/${outer.intendedPhase}/${outer.outerOrdinal}/${outer.sampleIds.join(',')}`
        );
        expect(outerRows).toEqual([
            'default/e3-memory-default/warmup/1/rtc-b06-default-e3-memory-default-warmup-001-001',
            'default/e3-memory-default/retained/1/rtc-b06-default-e3-memory-default-retained-001-001',
            'default/e3-memory-default/retained/2/rtc-b06-default-e3-memory-default-retained-002-001',
            'default/e3-memory-default/retained/3/rtc-b06-default-e3-memory-default-retained-003-001',
            'default/e3-memory-default/retained/4/rtc-b06-default-e3-memory-default-retained-004-001',
            'default/e3-memory-default/retained/5/rtc-b06-default-e3-memory-default-retained-005-001',
            'all-scenarios/e3-memory-all-scenarios/warmup/1/rtc-b06-all-scenarios-e3-memory-all-scenarios-warmup-001-001',
            'all-scenarios/e3-memory-all-scenarios/retained/1/rtc-b06-all-scenarios-e3-memory-all-scenarios-retained-001-001',
            'all-scenarios/e3-memory-all-scenarios/retained/2/rtc-b06-all-scenarios-e3-memory-all-scenarios-retained-002-001',
            'all-scenarios/e3-memory-all-scenarios/retained/3/rtc-b06-all-scenarios-e3-memory-all-scenarios-retained-003-001',
            'retention-100/e3-memory-retention-100/warmup/1/rtc-b06-retention-100-e3-memory-retention-100-warmup-001-001',
            'retention-100/e3-memory-retention-100/retained/1/rtc-b06-retention-100-e3-memory-retention-100-retained-001-001',
            'retention-100/e3-memory-retention-100/retained/2/rtc-b06-retention-100-e3-memory-retention-100-retained-002-001',
            'retention-100/e3-memory-retention-100/retained/3/rtc-b06-retention-100-e3-memory-retention-100-retained-003-001'
        ]);
        expect(
            computeRtcBaselineExpectedSampleIdentities(manifest).map(
                (identity) =>
                    `${identity.sampleId}/${identity.workloadId}/${identity.caseId}/${identity.inputKey}/${identity.intendedPhase}/${identity.outerOrdinal}/${identity.innerOrdinal}`
            )
        ).toEqual([
            'rtc-b06-default-e3-memory-default-warmup-001-001/RTC-B06/default/e3-memory-default/warmup/1/1',
            'rtc-b06-default-e3-memory-default-retained-001-001/RTC-B06/default/e3-memory-default/retained/1/1',
            'rtc-b06-default-e3-memory-default-retained-002-001/RTC-B06/default/e3-memory-default/retained/2/1',
            'rtc-b06-default-e3-memory-default-retained-003-001/RTC-B06/default/e3-memory-default/retained/3/1',
            'rtc-b06-default-e3-memory-default-retained-004-001/RTC-B06/default/e3-memory-default/retained/4/1',
            'rtc-b06-default-e3-memory-default-retained-005-001/RTC-B06/default/e3-memory-default/retained/5/1',
            'rtc-b06-all-scenarios-e3-memory-all-scenarios-warmup-001-001/RTC-B06/all-scenarios/e3-memory-all-scenarios/warmup/1/1',
            'rtc-b06-all-scenarios-e3-memory-all-scenarios-retained-001-001/RTC-B06/all-scenarios/e3-memory-all-scenarios/retained/1/1',
            'rtc-b06-all-scenarios-e3-memory-all-scenarios-retained-002-001/RTC-B06/all-scenarios/e3-memory-all-scenarios/retained/2/1',
            'rtc-b06-all-scenarios-e3-memory-all-scenarios-retained-003-001/RTC-B06/all-scenarios/e3-memory-all-scenarios/retained/3/1',
            'rtc-b06-retention-100-e3-memory-retention-100-warmup-001-001/RTC-B06/retention-100/e3-memory-retention-100/warmup/1/1',
            'rtc-b06-retention-100-e3-memory-retention-100-retained-001-001/RTC-B06/retention-100/e3-memory-retention-100/retained/1/1',
            'rtc-b06-retention-100-e3-memory-retention-100-retained-002-001/RTC-B06/retention-100/e3-memory-retention-100/retained/2/1',
            'rtc-b06-retention-100-e3-memory-retention-100-retained-003-001/RTC-B06/retention-100/e3-memory-retention-100/retained/3/1'
        ]);
    });
    it('derives one linked repeat with every doubled retained outer attempt in order', () => {
        const primary = deriveRtcBaselineCaptureManifest(primaryRequest);
        const repeat = deriveRtcBaselineRepeatManifest(primary, {
            ...primaryRequest,
            baselineId: '20260807-0123456789ab-e2-browser-repeat-01',
            retainedSampleMultiplier: 2,
            repeatLink: {
                primaryBaselineId: primaryRequest.baselineId,
                primarySummarySha256: 'c'.repeat(64)
            }
        });
        expect(
            deriveRtcBaselineOuterAttempts(repeat).map(
                (outer) => `${outer.intendedPhase}/${outer.outerOrdinal}/${outer.sampleIds.join(',')}`
            )
        ).toEqual([
            'warmup/1/rtc-b05-browser-data-channel-lifecycle-iterations-25-warmup-001-001',
            'retained/1/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-001-001',
            'retained/2/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-002-001',
            'retained/3/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-003-001',
            'retained/4/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-004-001',
            'retained/5/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-005-001',
            'retained/6/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-006-001',
            'retained/7/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-007-001',
            'retained/8/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-008-001',
            'retained/9/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-009-001',
            'retained/10/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-010-001'
        ]);
        expect(repeat.repeatLink).toEqual({
            primaryBaselineId: '20260807-0123456789ab-e2-browser',
            primarySummarySha256: 'c'.repeat(64)
        });
    });
    it('locates the complete typed external attempt and rejects incomplete or unknown locators', () => {
        const manifest = deriveRtcBaselineCaptureManifest(primaryRequest);
        expect(
            locateRtcBaselineExternalAttempt(manifest, {
                workloadId: 'RTC-B05',
                caseId: 'browser-data-channel-lifecycle',
                inputKey: 'iterations-25',
                intendedPhase: 'retained',
                outerOrdinal: 3
            })
        ).toEqual({
            ok: true,
            value: {
                workloadId: 'RTC-B05',
                caseId: 'browser-data-channel-lifecycle',
                inputKey: 'iterations-25',
                intendedPhase: 'retained',
                outerOrdinal: 3,
                environmentId: 'E2-browser',
                rawResultRelativePath: 'artifacts/staging/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-003.json'
            }
        });
        const missingInputKeyLocator = {
            workloadId: 'RTC-B05',
            caseId: 'browser-data-channel-lifecycle',
            intendedPhase: 'retained',
            outerOrdinal: 3
        } as const satisfies RtcBaselineJson;
        expect(locateRtcBaselineExternalAttempt(manifest, missingInputKeyLocator)).toEqual({
            ok: false,
            issues: [
                {
                    path: '$.locator.inputKey',
                    code: 'missing-field',
                    message: 'External attempt locator requires inputKey.'
                }
            ]
        });
        expect(
            locateRtcBaselineExternalAttempt(manifest, {
                workloadId: 'RTC-B05',
                caseId: 'browser-data-channel-lifecycle',
                inputKey: 'wrong',
                intendedPhase: 'retained',
                outerOrdinal: 6
            })
        ).toEqual({
            ok: false,
            issues: [
                {
                    path: '$.locator',
                    code: 'unknown-external-attempt',
                    message: 'External attempt locator is not predeclared by the initialized manifest.'
                }
            ]
        });
    });
    it('inherits the exact conditional decision and repeat link', () => {
        const decision = {
            environmentId: 'E4-pg' as const,
            decision: 'not-required' as const,
            reason: 'Native browser lifecycle does not traverse persistence.'
        };
        const primary = deriveRtcBaselineCaptureManifest({
            ...primaryRequest,
            conditionalEnvironmentDecisions: [decision]
        });
        const repeat = deriveRtcBaselineRepeatManifest(primary, {
            ...primaryRequest,
            baselineId: '20260807-0123456789ab-e2-browser-repeat-01',
            retainedSampleMultiplier: 2,
            repeatLink: {
                primaryBaselineId: primaryRequest.baselineId,
                primarySummarySha256: 'e'.repeat(64)
            },
            conditionalEnvironmentDecisions: [decision]
        });
        expect({
            decisions: repeat.request.conditionalEnvironmentDecisions,
            link: repeat.repeatLink
        }).toEqual({
            decisions: [
                {
                    environmentId: 'E4-pg',
                    decision: 'not-required',
                    reason: 'Native browser lifecycle does not traverse persistence.'
                }
            ],
            link: {
                primaryBaselineId: '20260807-0123456789ab-e2-browser',
                primarySummarySha256: 'e'.repeat(64)
            }
        });
    });

    it('visits all 732 ordered B01-B04 outers with each case-owned inner count', () => {
        const manifest = deriveRtcBaselineCaptureManifest({
            ...primaryRequest,
            baselineId: '20260807-0123456789ab-e3-memory',
            workloadIds: ['RTC-B01', 'RTC-B02', 'RTC-B03', 'RTC-B04'],
            environmentId: 'E3-memory'
        });
        let outerIndex = 0;
        for (
            const [
                workloadId,
                caseId,
                inputKey,
                phaseRange,
                counts,
                sampleStem,
                innerCount = '5'
            ] of syntheticExpansionFacts
        ) {
            const units = expandOuterRange(phaseRange!);
            expect(
                `${units.filter((unit) => unit.intendedPhase === 'warmup').length}/${units.filter((unit) => unit.intendedPhase === 'retained').length}`
            ).toBe(counts);
            for (const unit of units) {
                const actual = manifest.outerAttempts[outerIndex];
                expect(actual).toEqual({
                    workloadId,
                    caseId,
                    inputKey,
                    environmentId: 'E3-memory',
                    intendedPhase: unit.intendedPhase,
                    outerOrdinal: unit.outerOrdinal,
                    sampleIds: { '3': ['001', '002', '003'], '5': ['001', '002', '003', '004', '005'] }[
                        innerCount
                    ]!.map(
                        (inner) => `${sampleStem}-${unit.intendedPhase}-${String(unit.outerOrdinal).padStart(3, '0')}-${inner}`
                    )
                });
                outerIndex += 1;
            }
        }
        expect(outerIndex).toBe(732);
        expect(manifest.outerAttempts).toHaveLength(732);
    });
    it('orders noisy workloads by manifest and scopes repeat evaluation to matching metrics', () => {
        const metric = {
            caseId: 'case',
            inputKey: 'input',
            metric: 'durationMs',
            unit: 'ms',
            count: 1,
            minimum: 10,
            median: 10,
            maximum: 10,
            mad: 0
        };
        const b01 = { ...metric, workloadId: 'RTC-B01' as const, coefficientOfVariation: 0.05 };
        const b02 = { ...metric, workloadId: 'RTC-B02' as const, coefficientOfVariation: 0.3 };
        expect(
            rtcBaselineRepeatWorkloadIds([{ ...b01, coefficientOfVariation: 0.4 }, b02], 'local', [
                'RTC-B02',
                'RTC-B01'
            ])
        ).toEqual(['RTC-B02', 'RTC-B01']);
        expect(
            evaluateRtcBaselineWorkloadRepeatOutcome({
                primaryMetrics: [b01, b02],
                repeatMetrics: [b01, b02],
                workloadId: 'RTC-B01',
                executionContext: 'local'
            })
        ).toEqual({ ok: true, value: { repeatRequired: false, stillNoisy: false } });
        expect(
            evaluateRtcBaselineWorkloadRepeatOutcome({
                primaryMetrics: [b01, b02],
                repeatMetrics: [b01, b02],
                workloadId: 'RTC-B02',
                executionContext: 'local'
            })
        ).toEqual({ ok: true, value: { repeatRequired: true, stillNoisy: true } });
    });
    it('orders and deduplicates raw references while rejecting conflicting metadata', () => {
        expect(
            [
                'results/samples/a.json',
                'results/external-attempts/a.json',
                'results/external-cohorts/a.json',
                'results/failures/a.json',
                'results/finalization-failures/a.json',
                'artifacts/raw/a.bin',
                'artifacts/staging/a.json'
            ]
                .map(classifyRtcBaselineArtifactPath)
                .join('\n')
        ).toBe(
            'sample\nexternal-attempt\nexternal-cohort\nfailure-outcome\nfinalization-failure\nraw\n'
        );
        const raw = {
            relativePath: 'artifacts/b.bin',
            sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            bytes: 1
        };
        const canonical = canonicalizeRtcBaselineRawReferences([
            raw,
            {
                relativePath: 'artifacts/a.bin',
                sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                bytes: 2
            },
            raw
        ]);
        expect(canonical.ok ? canonical.value.map((value) => value.relativePath) : canonical).toEqual([
            'artifacts/a.bin',
            'artifacts/b.bin'
        ]);
        expect(canonicalizeRtcBaselineRawReferences([raw, { ...raw, bytes: 3 }])).toEqual({
            ok: false,
            issues: [
                {
                    path: '$.rawReferences',
                    code: 'conflicting-raw-reference',
                    message: 'Raw reference metadata conflicts for artifacts/b.bin.'
                }
            ]
        });
    });
});
