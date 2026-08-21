import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { RtcBaselineAcceptedWorker } from '../../../baseline/acceptance/rtc-baseline-worker-protocol.ts';
import type { RtcBaselineResult, RtcBaselineSampleDto } from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import * as CacheFallback from '../../../workloads/group-coordination/webrtc-group-cache-fallback-bench.ts';
import * as PeerOwners from '../../../workloads/group-coordination/webrtc-group-manager-peer-owners-bench.ts';
import * as ManagerState from '../../../workloads/group-coordination/webrtc-group-manager-state-bench.ts';
import * as Heartbeat from '../../../workloads/group-coordination/webrtc-heartbeat-callback-churn-bench.ts';

const baselineId = '20260807-0123456789ab-e1-local';

interface WorkerFixture {
    readonly caseId: string;
    readonly sampleIds: readonly string[];
    readonly arguments: readonly string[];
}

function createWorkerFixture(
    caseId: string,
    capabilityArguments: readonly string[]
): WorkerFixture {
    const prefix = `rtc-b04-${caseId}-fixed-retained-001`;
    const sampleIds = Array.from(
        { length: 5 },
        (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`
    );
    return {
        caseId,
        sampleIds,
        arguments: [
            '--capture=worker',
            `--baseline-id=${baselineId}`,
            '--workload=RTC-B04',
            `--case-id=${caseId}`,
            '--input-key=fixed',
            '--intended-phase=retained',
            '--outer-ordinal=1',
            `--sample-ids=${sampleIds.join(',')}`,
            '--rtc-inner-runs=5',
            ...capabilityArguments
        ]
    };
}

function readAcceptedWorker<Accepted>(
    parsed: RtcBaselineResult<{ readonly mode: string; }>
): Accepted {
    if (!parsed.ok || parsed.value.mode !== 'accepted') {
        throw new Error('Expected exact RTC-B04 accepted worker arguments.');
    }
    return parsed.value as Accepted;
}

function expectPassedSamples(
    samples: readonly RtcBaselineSampleDto[],
    fixture: WorkerFixture,
    metricNames: readonly string[]
): void {
    expect(samples.map((sample) => sample.identity)).toEqual(
        fixture.sampleIds.map((sampleId, index) => ({
            sampleId,
            workloadId: 'RTC-B04',
            caseId: fixture.caseId,
            inputKey: 'fixed',
            intendedPhase: 'retained',
            outerOrdinal: 1,
            innerOrdinal: index + 1
        }))
    );
    expect(samples.map((sample) => sample.outcome)).toEqual(Array(5).fill('passed'));
    expect(samples[0]).toMatchObject({
        schema: 'rallar.rtc-baseline.sample.v1',
        evidenceClass: 'synthetic-path',
        rawReferences: [],
        runtimeObservation: null
    });
    expect(samples[0]?.metrics.map((metric) => metric.metric)).toEqual(metricNames);
}

function expectRejectedWorkerMutations(
    parse: (arguments_: readonly string[]) => RtcBaselineResult<{ readonly mode: string; }>,
    fixture: WorkerFixture,
    alternateNumericMutations: readonly [string, string][]
): void {
    const mutations: readonly [string, string][] = [
        ['--workload=RTC-B04', '--workload=RTC-B03'],
        [`--case-id=${fixture.caseId}`, '--case-id=wrong'],
        ['--input-key=fixed', '--input-key=wrong'],
        ['--intended-phase=retained', '--intended-phase=wrong'],
        ['--outer-ordinal=1', '--outer-ordinal=01'],
        [`--sample-ids=${fixture.sampleIds.join(',')}`, '--sample-ids=wrong'],
        ['--rtc-inner-runs=5', '--rtc-inner-runs=05'],
        ...alternateNumericMutations,
        ['--rtc-inner-runs=5', '--unexpected=1']
    ];
    for (const [expected, replacement] of mutations) {
        expect(
            parse(fixture.arguments.map((argument) => argument === expected ? replacement : argument)).ok
        ).toBe(false);
    }
    for (let index = 0; index < fixture.arguments.length; index += 1) {
        if (fixture.arguments[index]?.startsWith('--capture=')) {
            continue;
        }
        expect(parse(fixture.arguments.filter((_argument, offset) => offset !== index)).ok).toBe(false);
    }
}

async function expectFirstFailureStopsAcceptedWorker(
    fixture: WorkerFixture,
    runAccepted: () => Promise<readonly RtcBaselineSampleDto[]>,
    executionCount: () => number
): Promise<void> {
    const samples = await runAccepted();
    expect(executionCount()).toBe(1);
    expect(samples.map((sample) => [sample.identity.sampleId, sample.outcome])).toEqual([
        [fixture.sampleIds[0], 'failed'],
        ...fixture.sampleIds.slice(1).map((sampleId) => [sampleId, 'not-run'])
    ]);
    expect(samples.slice(1).map((sample) => sample.issues[0])).toEqual(
        fixture.sampleIds.slice(1).map(() => ({
            path: '$.rawEvidence',
            code: 'causal-not-run',
            message: fixture.sampleIds[0]
        }))
    );
}

function createNonFiniteMutations<Result extends object>(
    result: Result,
    keys: readonly (keyof Result)[]
) {
    return keys.map((key) => ({ key, result: { ...result, [key]: Number.POSITIVE_INFINITY } }));
}

async function expectNonFiniteNumbersRejected<Result extends object>(
    fixture: WorkerFixture,
    mutations: readonly { readonly key: keyof Result; readonly result: Result; }[],
    runAccepted: (result: Result) => Promise<readonly RtcBaselineSampleDto[]>
): Promise<void> {
    for (const mutation of mutations) {
        const samples = await runAccepted(mutation.result);
        expect(samples.map((sample) => [sample.identity.sampleId, sample.outcome])).toEqual([
            [fixture.sampleIds[0], 'failed'],
            ...fixture.sampleIds.slice(1).map((sampleId) => [sampleId, 'not-run'])
        ]);
        expect(samples.slice(1).map((sample) => sample.issues[0]?.message)).toEqual(
            Array(4).fill(fixture.sampleIds[0])
        );
        expect((samples[0]?.rawEvidence as Record<string, unknown>)[String(mutation.key)]).toBe(null);
        expect(() => JSON.parse(JSON.stringify(samples))).not.toThrow();
    }
}

function expectDiagnosticArguments(
    parsed: RtcBaselineResult<{ readonly mode: string; }>,
    expected: object
): void {
    if (!parsed.ok || parsed.value.mode !== 'diagnostic') {
        throw new Error('Expected legacy direct diagnostic arguments.');
    }
    expect(parsed.value).toMatchObject(expected);
}

const cacheFallback = {
    fixture: createWorkerFixture('group-cache-fallback', [
        '--rtc-snapshots=20000',
        '--rtc-matching-versions=5000',
        '--rtc-lookups=500'
    ]),
    result: {
        durationMs: 1,
        snapshotCount: 20000,
        matchingVersions: 5000,
        lookups: 500,
        readCalls: 1000,
        peekCalls: 0,
        readAllValuesCalls: 1000,
        latestVersion: 5000,
        targetPeerCount: 1
    } satisfies CacheFallback.WebRtcGroupCacheFallbackResult
};

describe('RTC-B04 group cache fallback worker', () => {
    const { fixture, result } = cacheFallback;

    it('emits exact samples from deterministic accepted results', async () => {
        const worker = readAcceptedWorker<RtcBaselineAcceptedWorker<CacheFallback.WebRtcGroupCacheFallbackInput>>(
            CacheFallback.parseWebRtcGroupCacheFallbackArguments(fixture.arguments)
        );
        const samples = await CacheFallback.runWebRtcGroupCacheFallbackAcceptedSamples({
            worker,
            run: () => result
        });
        expectPassedSamples(samples, fixture, ['durationMs']);
        expect(samples[0]?.rawEvidence).toEqual(result);
    });

    it('rejects malformed workers and stops after invalid counter evidence', async () => {
        expectRejectedWorkerMutations(
            CacheFallback.parseWebRtcGroupCacheFallbackArguments,
            fixture,
            [
                ['--rtc-snapshots=20000', '--rtc-snapshots=020000'],
                ['--rtc-matching-versions=5000', '--rtc-matching-versions=05000'],
                ['--rtc-lookups=500', '--rtc-lookups=0500']
            ]
        );
        let executions = 0;
        await expectFirstFailureStopsAcceptedWorker(
            fixture,
            () =>
                CacheFallback.runWebRtcGroupCacheFallbackAcceptedSamples({
                    worker: readAcceptedWorker(
                        CacheFallback.parseWebRtcGroupCacheFallbackArguments(fixture.arguments)
                    ),
                    run: () => {
                        executions += 1;
                        return { ...result, readCalls: 499 };
                    }
                }),
            () => executions
        );
        await expectNonFiniteNumbersRejected(
            fixture,
            createNonFiniteMutations(result, Object.keys(result) as (keyof typeof result)[]),
            (invalidResult) =>
                CacheFallback.runWebRtcGroupCacheFallbackAcceptedSamples({
                    worker: readAcceptedWorker(
                        CacheFallback.parseWebRtcGroupCacheFallbackArguments(fixture.arguments)
                    ),
                    run: () => invalidResult
                })
        );
    });
});

const managerState = {
    fixture: createWorkerFixture('group-manager-state', [
        '--rtc-clients=5000',
        '--rtc-desired=1000',
        '--rtc-lookups=20'
    ]),
    result: {
        durationMs: 2,
        clientCount: 5000,
        desiredPeerCount: 1000,
        lookups: 20,
        keysCalls: 20,
        readCalls: 100000,
        onlineDesiredPeerCount: 1000,
        onlinePeerCount: 5000
    } satisfies ManagerState.WebRtcGroupManagerStateResult
};

describe('RTC-B04 group manager state worker', () => {
    const { fixture, result } = managerState;

    it('emits exact samples from deterministic accepted results', async () => {
        const worker = readAcceptedWorker<RtcBaselineAcceptedWorker<ManagerState.WebRtcGroupManagerStateInput>>(
            ManagerState.parseWebRtcGroupManagerStateArguments(fixture.arguments)
        );
        const samples = await ManagerState.runWebRtcGroupManagerStateAcceptedSamples({
            worker,
            run: () => result
        });
        expectPassedSamples(samples, fixture, ['durationMs']);
        expect(samples[0]?.rawEvidence).toEqual(result);
    });

    it('rejects malformed workers and stops after invalid state evidence', async () => {
        expectRejectedWorkerMutations(
            ManagerState.parseWebRtcGroupManagerStateArguments,
            fixture,
            [
                ['--rtc-clients=5000', '--rtc-clients=05000'],
                ['--rtc-desired=1000', '--rtc-desired=01000'],
                ['--rtc-lookups=20', '--rtc-lookups=020']
            ]
        );
        let executions = 0;
        await expectFirstFailureStopsAcceptedWorker(
            fixture,
            () =>
                ManagerState.runWebRtcGroupManagerStateAcceptedSamples({
                    worker: readAcceptedWorker(
                        ManagerState.parseWebRtcGroupManagerStateArguments(fixture.arguments)
                    ),
                    run: () => {
                        executions += 1;
                        return { ...result, onlinePeerCount: 999 };
                    }
                }),
            () => executions
        );
        await expectNonFiniteNumbersRejected(
            fixture,
            createNonFiniteMutations(result, Object.keys(result) as (keyof typeof result)[]),
            (invalidResult) =>
                ManagerState.runWebRtcGroupManagerStateAcceptedSamples({
                    worker: readAcceptedWorker(
                        ManagerState.parseWebRtcGroupManagerStateArguments(fixture.arguments)
                    ),
                    run: () => invalidResult
                })
        );
    });
});

const peerOwners = {
    fixture: createWorkerFixture('group-manager-peer-owners', [
        '--rtc-groups=1000',
        '--rtc-peers-per-group=10',
        '--rtc-lookups=1000'
    ]),
    result: {
        durationMs: 3,
        groupCount: 1000,
        peersPerGroup: 10,
        lookups: 1000,
        ownedLookups: 1000,
        totalOwnerGroups: 10000,
        desiredPeerCount: 1000
    } satisfies PeerOwners.WebRtcGroupManagerPeerOwnersResult
};

describe('RTC-B04 group peer ownership worker', () => {
    const { fixture, result } = peerOwners;

    it('emits exact samples from deterministic accepted results', async () => {
        const worker = readAcceptedWorker<RtcBaselineAcceptedWorker<PeerOwners.WebRtcGroupManagerPeerOwnersInput>>(
            PeerOwners.parseWebRtcGroupManagerPeerOwnersArguments(fixture.arguments)
        );
        const samples = await PeerOwners.runWebRtcGroupManagerPeerOwnersAcceptedSamples({
            worker,
            run: () => result
        });
        expectPassedSamples(samples, fixture, ['durationMs']);
        expect(samples[0]?.rawEvidence).toEqual(result);
    });

    it('rejects malformed workers and stops after invalid ownership evidence', async () => {
        expectRejectedWorkerMutations(
            PeerOwners.parseWebRtcGroupManagerPeerOwnersArguments,
            fixture,
            [
                ['--rtc-groups=1000', '--rtc-groups=01000'],
                ['--rtc-peers-per-group=10', '--rtc-peers-per-group=010'],
                ['--rtc-lookups=1000', '--rtc-lookups=01000']
            ]
        );
        let executions = 0;
        await expectFirstFailureStopsAcceptedWorker(
            fixture,
            () =>
                PeerOwners.runWebRtcGroupManagerPeerOwnersAcceptedSamples({
                    worker: readAcceptedWorker(
                        PeerOwners.parseWebRtcGroupManagerPeerOwnersArguments(fixture.arguments)
                    ),
                    run: () => {
                        executions += 1;
                        return { ...result, ownedLookups: 999 };
                    }
                }),
            () => executions
        );
        await expectNonFiniteNumbersRejected(
            fixture,
            createNonFiniteMutations(result, Object.keys(result) as (keyof typeof result)[]),
            (invalidResult) =>
                PeerOwners.runWebRtcGroupManagerPeerOwnersAcceptedSamples({
                    worker: readAcceptedWorker(
                        PeerOwners.parseWebRtcGroupManagerPeerOwnersArguments(fixture.arguments)
                    ),
                    run: () => invalidResult
                })
        );
    });
});

describe('RTC-B04 heartbeat callback churn worker', () => {
    const fixture = createWorkerFixture('heartbeat-callback-churn', ['--rtc-channels=10000']);
    const result: Heartbeat.WebRtcHeartbeatCallbackChurnResult = {
        durationMs: 4,
        channelCount: 10000,
        retainedCallbacks: 0,
        maxCallbacksPerChannel: 0
    };

    it('emits exact samples from deterministic accepted results', async () => {
        const worker = readAcceptedWorker<RtcBaselineAcceptedWorker<Heartbeat.WebRtcHeartbeatCallbackChurnInput>>(
            Heartbeat.parseWebRtcHeartbeatCallbackChurnArguments(fixture.arguments)
        );
        const samples = await Heartbeat.runWebRtcHeartbeatCallbackChurnAcceptedSamples({
            worker,
            run: () => result
        });
        expectPassedSamples(samples, fixture, ['durationMs']);
        expect(samples[0]?.rawEvidence).toEqual(result);
    });

    it('rejects malformed workers and stops after retained callback evidence', async () => {
        expectRejectedWorkerMutations(
            Heartbeat.parseWebRtcHeartbeatCallbackChurnArguments,
            fixture,
            [['--rtc-channels=10000', '--rtc-channels=010000']]
        );
        let executions = 0;
        await expectFirstFailureStopsAcceptedWorker(
            fixture,
            () =>
                Heartbeat.runWebRtcHeartbeatCallbackChurnAcceptedSamples({
                    worker: readAcceptedWorker(
                        Heartbeat.parseWebRtcHeartbeatCallbackChurnArguments(fixture.arguments)
                    ),
                    run: () => {
                        executions += 1;
                        return { ...result, retainedCallbacks: 1 };
                    }
                }),
            () => executions
        );
        await expectNonFiniteNumbersRejected(
            fixture,
            createNonFiniteMutations(result, Object.keys(result) as (keyof typeof result)[]),
            (invalidResult) =>
                Heartbeat.runWebRtcHeartbeatCallbackChurnAcceptedSamples({
                    worker: readAcceptedWorker(
                        Heartbeat.parseWebRtcHeartbeatCallbackChurnArguments(fixture.arguments)
                    ),
                    run: () => invalidResult
                })
        );
    });
});

it('keeps one-item direct diagnostics import-safe, nested, and overwrite-capable', () => {
    mkdirSync('tmp', { recursive: true });
    const directory = mkdtempSync(join('tmp', 'rtc-b04-group-diagnostic-'));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const diagnostics = [
        [
            'webrtc-group-cache-fallback-bench.ts',
            '--snapshots=1',
            '--matching-versions=1',
            '--lookups=1'
        ],
        ['webrtc-group-manager-state-bench.ts', '--clients=1', '--desired=1', '--lookups=1'],
        [
            'webrtc-group-manager-peer-owners-bench.ts',
            '--groups=1',
            '--peers-per-group=1',
            '--lookups=1'
        ],
        ['webrtc-heartbeat-callback-churn-bench.ts', '--channels=1']
    ];
    for (const [index, [entry, ...capabilityArguments]] of diagnostics.entries()) {
        const output = join(directory, String(index), 'result.json');
        const command = [
            'run',
            '--config=packages/shared-rtc-bench/deno.json',
            '--allow-read',
            '--allow-write',
            `packages/shared-rtc-bench/workloads/group-coordination/${entry}`,
            ...capabilityArguments,
            '--runs=1',
            `--out=${output}`
        ];
        expect(spawnSync('deno', command, { encoding: 'utf8' }).status).toBe(0);
        expect(spawnSync('deno', command, { encoding: 'utf8' }).status).toBe(0);
        expect(JSON.parse(readFileSync(output, 'utf8')).results).toHaveLength(1);
    }
});

it('preserves first-match permissive Number grammar for every group diagnostic', () => {
    const common = ['--unknown=ignored', '--runs=6.5', '--runs=1'];
    expectDiagnosticArguments(
        CacheFallback.parseWebRtcGroupCacheFallbackArguments([
            '--snapshots=1.5',
            '--snapshots=2',
            '--matching-versions=NaN',
            '--lookups=3',
            ...common
        ]),
        { input: { snapshots: 1.5, matchingVersions: Number.NaN, lookups: 3 }, runs: 6.5 }
    );
    expectDiagnosticArguments(
        ManagerState.parseWebRtcGroupManagerStateArguments([
            '--clients=1.5',
            '--clients=2',
            '--desired=NaN',
            '--lookups=3',
            ...common
        ]),
        { input: { clients: 1.5, desired: Number.NaN, lookups: 3 }, runs: 6.5 }
    );
    expectDiagnosticArguments(
        PeerOwners.parseWebRtcGroupManagerPeerOwnersArguments([
            '--groups=1.5',
            '--groups=2',
            '--peers-per-group=NaN',
            '--lookups=3',
            ...common
        ]),
        { input: { groups: 1.5, peersPerGroup: Number.NaN, lookups: 3 }, runs: 6.5 }
    );
    expectDiagnosticArguments(
        Heartbeat.parseWebRtcHeartbeatCallbackChurnArguments([
            '--channels=1.5',
            '--channels=2',
            ...common
        ]),
        { input: { channels: 1.5 }, runs: 6.5 }
    );
});
