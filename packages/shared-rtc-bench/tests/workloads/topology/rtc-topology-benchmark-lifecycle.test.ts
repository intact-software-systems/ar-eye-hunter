import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import type { RtcBaselineSampleDto } from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import * as RttGraph from '../../../workloads/topology/rtc-room-graph-rtt-bench.ts';
import * as Repository from '../../../workloads/topology/rtc-rtt-repository-filter-bench.ts';
import * as Inactive from '../../../workloads/topology/rtc-topology-inactive-churn-bench.ts';
import * as Mesh from '../../../workloads/topology/rtc-topology-mesh-no-rtt-bench.ts';
import * as Star from '../../../workloads/topology/rtc-topology-star-bench.ts';
import * as Tree from '../../../workloads/topology/rtc-topology-tree-no-rtt-bench.ts';
import { SyntheticRtcRttRuntimeStateRepository } from '../../../workloads/topology/synthetic-rtc-rtt-runtime-state-repository.ts';

const baselineId = '20260807-0123456789ab-e1-local';
const denoPrefix = words(
    'run --config=packages/shared-rtc-bench/deno.json --allow-read --allow-write'
);

function words(value: string): string[] {
    return value.trim().split(/\s+/);
}

function topologyWorker(caseId: string, key: string, flags: string[], runs = 5) {
    const prefix = `rtc-b03-${caseId}-${key}-retained-001`;
    const ids = Array.from(
        { length: runs },
        (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`
    );
    const arguments_ = words(`--capture=worker --baseline-id=${baselineId} --workload=RTC-B03
--case-id=${caseId} --input-key=${key} --intended-phase=retained --outer-ordinal=1
--sample-ids=${ids.join(',')}`);
    return { ids, arguments: [...arguments_, ...flags] };
}

type TopologyWorkerInput = ReturnType<typeof topologyWorker>;

function replaceArgument(arguments_: readonly string[], name: string, value: string): string[] {
    return arguments_.map((argument) => argument.startsWith(`--${name}=`) ? `--${name}=${value}` : argument);
}

function accepted<Result extends { readonly ok: false; } | { readonly ok: true; readonly value: { readonly mode: string; }; }>(
    result: Result
): Extract<Extract<Result, { readonly ok: true; }>['value'], { readonly mode: 'accepted'; }> {
    if (!result.ok || result.value.mode !== 'accepted') {
        throw new Error('Expected exact worker.');
    }
    return result.value as Extract<Extract<Result, { readonly ok: true; }>['value'], { readonly mode: 'accepted'; }>;
}

function expectExactWorker(
    parse: (args: readonly string[]) => { readonly ok: boolean; },
    input: TopologyWorkerInput,
    integer: string
) {
    const argument = input.arguments.find((value) => value.startsWith(`--${integer}=`));
    if (argument === undefined) {
        throw new Error(`Missing ${integer}.`);
    }
    const value = argument.slice(argument.indexOf('=') + 1);
    const rejected = [
        replaceArgument(input.arguments, integer, '0'),
        replaceArgument(input.arguments, integer, `0${value}`),
        [...input.arguments, '--rtc-alias=1'],
        replaceArgument(input.arguments, 'sample-ids', input.ids[0])
    ];
    expect([input.arguments, ...rejected].map((arguments_) => parse(arguments_).ok)).toEqual([
        true,
        ...Array(4).fill(false)
    ]);
}

interface FailureProbe {
    readonly input: TopologyWorkerInput;
    readonly execute: (noteExecution: () => void) => Promise<RtcBaselineSampleDto[]>;
}

function failureProbe<Result, Worker>(
    input: TopologyWorkerInput,
    invalid: Result,
    parsedWorker: Worker,
    runAccepted: (input: {
        readonly worker: Worker;
        readonly run: () => Promise<Result>;
    }) => Promise<RtcBaselineSampleDto[]>
): FailureProbe {
    return {
        input,
        execute: (noteExecution) =>
            runAccepted({
                worker: parsedWorker,
                run: async () => {
                    noteExecution();
                    return invalid;
                }
            })
    };
}

async function expectStopsAfterFirstFailure(probes: readonly FailureProbe[]) {
    const outcomes: RtcBaselineSampleDto[][] = [];
    for (const probe of probes) {
        let executions = 0;
        const samples = await probe.execute(() => {
            executions += 1;
        });
        expect(executions).toBe(1);
        expect(samples.map((sample) => [sample.identity.sampleId, sample.outcome])).toEqual([
            [probe.input.ids[0], 'failed'],
            ...probe.input.ids.slice(1).map((id) => [id, 'not-run'])
        ]);
        expect(
            samples.slice(1).map((sample) => [sample.issues[0]?.code, sample.issues[0]?.message])
        ).toEqual(probe.input.ids.slice(1).map(() => ['causal-not-run', probe.input.ids[0]]));
        outcomes.push(samples);
    }
    return outcomes;
}

interface Graph {
    readonly sessionIds: readonly string[];
    readonly edgePairs: readonly (readonly [string, string])[];
}

function sessionId(index: number): string {
    return `session-${String(index).padStart(3, '0')}`;
}

function sessionIds(sessions: number): string[] {
    return Array.from({ length: sessions }, (_value, index) => sessionId(index));
}

function orderedPair(left: number, right: number): readonly [string, string] {
    return left < right ? [sessionId(left), sessionId(right)] : [sessionId(right), sessionId(left)];
}

function completePairs(sessions: number): string[] {
    const pairs = [];
    for (let from = 0; from < sessions; from += 1) {
        for (let to = from + 1; to < sessions; to += 1) {
            pairs.push(`${sessionId(from)}::${sessionId(to)}`);
        }
    }
    return pairs;
}

function sparsePairs(sessions: number): string[] {
    const pairs = new Set<string>();
    for (let index = 0; index < sessions; index += 1) {
        for (const offset of [1, 2]) {
            pairs.add(orderedPair(index, (index + offset) % sessions).join('::'));
        }
    }
    return [...pairs].sort();
}

function disconnectedTreePairs(): Array<readonly [string, string]> {
    return Array.from({ length: 29 }, (_value, index) => orderedPair(index, (index + 1) % 29));
}

function disconnectedMeshPairs(): Array<readonly [string, string]> {
    const cycles: Array<readonly [string, string]> = [];
    const extra: Array<readonly [string, string]> = [];
    for (const start of [0, 15]) {
        for (let local = 0; local < 15; local += 1) {
            cycles.push(orderedPair(start + local, start + ((local + 1) % 15)));
            extra.push(orderedPair(start + local, start + ((local + 2) % 15)));
        }
    }
    return [...cycles, ...extra.slice(0, 27)];
}

function expectGraph(graph: Graph, edgeCount: number, maximumDegree: number) {
    const neighbors = new Map(graph.sessionIds.map((id) => [id, new Set<string>()]));
    expect(graph.edgePairs).toHaveLength(edgeCount);
    expect(new Set(graph.edgePairs.map(([from, to]) => `${from}::${to}`)).size).toBe(edgeCount);
    for (const [from, to] of graph.edgePairs) {
        expect(from < to).toBe(true);
        expect(neighbors.has(from) && neighbors.has(to)).toBe(true);
        neighbors.get(from)?.add(to);
        neighbors.get(to)?.add(from);
    }
    expect([...neighbors.values()].every((peers) => peers.size <= maximumDegree)).toBe(true);
    const visited = new Set<string>();
    const pending = [graph.sessionIds[0]];
    while (pending.length > 0) {
        const id = pending.pop();
        if (id === undefined || visited.has(id)) {
            continue;
        }
        visited.add(id);
        pending.push(...(neighbors.get(id) ?? []));
    }
    expect(visited.size).toBe(graph.sessionIds.length);
}

it('RTC-B03 accepts the exact graph and inactive matrices with deterministic evidence', async () => {
    const failureProbes: FailureProbe[] = [];
    const graphCases = [
        [Star.parseRtcTopologyStarArguments, 'topology-star', ''],
        [Tree.parseRtcTopologyTreeArguments, 'topology-tree', '--rtc-degree-limit=5'],
        [Mesh.parseRtcTopologyMeshArguments, 'topology-mesh', '--rtc-mesh-param-k=2'],
        [RttGraph.parseRtcRoomGraphRttArguments, 'room-graph-rtt-sparse', '--rtc-sparse-degree=4'],
        [RttGraph.parseRtcRoomGraphRttArguments, 'room-graph-rtt-complete', '']
    ] as const;
    for (const sessions of [30, 100, 300]) {
        for (const [parse, caseId, extra] of graphCases) {
            expectExactWorker(
                parse,
                topologyWorker(
                    caseId,
                    `sessions-${sessions}`,
                    words(`${extra} --rtc-inner-runs=5 --rtc-sessions=${sessions}`)
                ),
                'rtc-sessions'
            );
        }
        const star = Star.runRtcTopologyStar(sessions);
        const tree = Tree.runRtcTopologyTree(sessions, 5);
        const mesh = Mesh.runRtcTopologyMesh(sessions, 2);
        const sparse = RttGraph.runRtcRoomGraphRtt(sessions, 'sparse', 4);
        const complete = RttGraph.runRtcRoomGraphRtt(sessions, 'complete', 4);
        const expectedSessionIds = sessionIds(sessions);
        expect(star.sessionIds).toEqual(expectedSessionIds);
        expect(tree.sessionIds).toEqual(expectedSessionIds);
        expect(mesh.sessionIds).toEqual(expectedSessionIds);
        expectGraph(star, (sessions * (sessions - 1)) / 2, sessions - 1);
        expectGraph(tree, sessions - 1, 5);
        expectGraph(mesh, sessions * 2 - 3, 5);
        for (const graph of [sparse, complete]) {
            expectGraph(graph, graph.edgePairs.length, 5);
        }
        expectGraph(
            {
                sessionIds: sparse.sessionIds,
                edgePairs: sparse.measurements.map(
                    (value) => [value.sessionIdFrom, value.sessionIdTo] as const
                )
            },
            sessions * 2,
            4
        );
        expect(
            sparse.measurements.map((value) => `${value.sessionIdFrom}::${value.sessionIdTo}`)
        ).toEqual(sparsePairs(sessions));
        expect(
            complete.measurements.map((value) => `${value.sessionIdFrom}::${value.sessionIdTo}`)
        ).toEqual(completePairs(sessions));
        for (const graph of [sparse, complete]) {
            expect(
                graph.measurements.every((value, index, all) => {
                    const from = Number(value.sessionIdFrom.slice(8));
                    const to = Number(value.sessionIdTo.slice(8));
                    return (
                        value.rttMs === 5 + ((from * 31 + to * 17) % 96) &&
                        (index === 0 || all[index - 1].version < value.version)
                    );
                })
            ).toBe(true);
        }
    }

    const star = Star.runRtcTopologyStar(30);
    const tree = Tree.runRtcTopologyTree(30, 5);
    const mesh = Mesh.runRtcTopologyMesh(30, 2);
    const sparse = RttGraph.runRtcRoomGraphRtt(30, 'sparse', 4);
    const complete = RttGraph.runRtcRoomGraphRtt(30, 'complete', 4);
    const starInput = topologyWorker(
        'topology-star',
        'sessions-30',
        words('--rtc-inner-runs=5 --rtc-sessions=30')
    );
    const treeInput = topologyWorker(
        'topology-tree',
        'sessions-30',
        words('--rtc-degree-limit=5 --rtc-inner-runs=5 --rtc-sessions=30')
    );
    const meshInput = topologyWorker(
        'topology-mesh',
        'sessions-30',
        words('--rtc-inner-runs=5 --rtc-mesh-param-k=2 --rtc-sessions=30')
    );
    const sparseInput = topologyWorker(
        'room-graph-rtt-sparse',
        'sessions-30',
        words('--rtc-inner-runs=5 --rtc-sessions=30 --rtc-sparse-degree=4')
    );
    const completeInput = topologyWorker(
        'room-graph-rtt-complete',
        'sessions-30',
        words('--rtc-inner-runs=5 --rtc-sessions=30')
    );
    failureProbes.push(
        failureProbe(
            starInput,
            { ...star, edgePairs: Array(435).fill(star.edgePairs[0]) },
            accepted(Star.parseRtcTopologyStarArguments(starInput.arguments)),
            Star.runRtcTopologyStarAcceptedSamples
        ),
        failureProbe(
            treeInput,
            { ...tree, edgePairs: disconnectedTreePairs() },
            accepted(Tree.parseRtcTopologyTreeArguments(treeInput.arguments)),
            Tree.runRtcTopologyTreeAcceptedSamples
        ),
        failureProbe(
            meshInput,
            { ...mesh, edgePairs: disconnectedMeshPairs() },
            accepted(Mesh.parseRtcTopologyMeshArguments(meshInput.arguments)),
            Mesh.runRtcTopologyMeshAcceptedSamples
        ),
        failureProbe(
            sparseInput,
            { ...sparse, edgePairs: [['foreign-a', 'foreign-b'], ...sparse.edgePairs.slice(1)] },
            accepted(RttGraph.parseRtcRoomGraphRttArguments(sparseInput.arguments)),
            RttGraph.runRtcRoomGraphRttAcceptedSamples
        ),
        failureProbe(
            completeInput,
            { ...complete, edgePairs: [['foreign-a', 'foreign-b'], ...complete.edgePairs.slice(1)] },
            accepted(RttGraph.parseRtcRoomGraphRttArguments(completeInput.arguments)),
            RttGraph.runRtcRoomGraphRttAcceptedSamples
        )
    );

    for (const mode of ['retain', 'cleanup'] as const) {
        const input = topologyWorker(
            'topology-inactive-churn',
            `mode-${mode}`,
            words(`--rtc-groups=10000 --rtc-inner-runs=3 --rtc-mode=${mode} --rtc-sessions-per-group=5`),
            3
        );
        expectExactWorker(Inactive.parseRtcTopologyInactiveChurnArguments, input, 'rtc-groups');
        const removed = mode === 'cleanup' ? 10000 : 0;
        const result = Inactive.runRtcTopologyInactiveChurn(10000, 5, mode);
        expect(result).toMatchObject({
            sessionIdsPerGroup: [
                'session-000',
                'session-001',
                'session-002',
                'session-003',
                'session-004'
            ],
            finalTopologySnapshotCount: 10000 - removed,
            topologyRemovalRequestCount: removed,
            topologyRemovedCount: removed,
            topologyRemoveMissCount: 0
        });
        if (mode === 'retain') {
            failureProbes.push(
                failureProbe(
                    input,
                    { ...result, finalTopologySnapshotCount: 0 },
                    accepted(Inactive.parseRtcTopologyInactiveChurnArguments(input.arguments)),
                    Inactive.runRtcTopologyInactiveChurnAcceptedSamples
                )
            );
        }
    }
    await expectStopsAfterFirstFailure(failureProbes);
});

it('RTC-B03 filters every repository size without writes or foreign sessions', async () => {
    for (const roomSessions of [5, 30]) {
        for (const globalMeasurements of [1000, 10000, 100000]) {
            const input = topologyWorker(
                'rtt-repository-filter',
                `room-${roomSessions}-global-${globalMeasurements}`,
                words(
                    `--rtc-global-measurements=${globalMeasurements} --rtc-inner-runs=5 --rtc-room-sessions=${roomSessions}`
                )
            );
            expectExactWorker(
                Repository.parseRtcRttRepositoryFilterArguments,
                input,
                'rtc-global-measurements'
            );
            const runtimeRepository = new SyntheticRtcRttRuntimeStateRepository();
            let reads = 0;
            const result = await Repository.runRtcRttRepositoryFilter(
                { roomSessions, globalMeasurements },
                { runtimeRepository, clock: { nowEpochMs: () => 1000, monotonicNow: () => reads++ * 10 } }
            );
            const expected = completePairs(roomSessions);
            expect(result).toMatchObject({
                durationMs: 10,
                targetPairIdentities: expected,
                returnedPairIdentities: expected,
                repositoryCounts: { before: globalMeasurements, after: globalMeasurements }
            });
            expect(result.foreignPairIdentities).toHaveLength(globalMeasurements - expected.length);
            expect(
                result.returnedPairIdentities.every((pair) => pair.split('::').every((id) => Number(id.slice(8)) < roomSessions))
            ).toBe(true);
            const stored = [...runtimeRepository.data.values()].map((entry) => JSON.parse(entry.value));
            expect(
                stored
                    .slice(0, expected.length)
                    .map((value) => `${value.sessionIdFrom}::${value.sessionIdTo}`)
            ).toEqual(expected);
            expect(
                stored
                    .slice(expected.length)
                    .map((value) => `${value.sessionIdFrom}::${value.sessionIdTo}`)
            ).toEqual(result.foreignPairIdentities);
            const lexicographic = [...stored].sort((left, right) =>
                `${left.sessionIdFrom}::${left.sessionIdTo}`.localeCompare(
                    `${right.sessionIdFrom}::${right.sessionIdTo}`
                )
            );
            expect(
                lexicographic.every(
                    (value, index, all) =>
                        value.rttMs ===
                            5 +
                                ((Number(value.sessionIdFrom.slice(8)) * 31 +
                                    Number(value.sessionIdTo.slice(8)) * 17) %
                                    96) &&
                        (index === 0 || all[index - 1].version < value.version)
                )
            ).toBe(true);
            if (roomSessions === 5 && globalMeasurements === 1000) {
                const parsed = accepted(Repository.parseRtcRttRepositoryFilterArguments(input.arguments));
                const duplicates = Array(expected.length).fill(expected[0]);
                await expectStopsAfterFirstFailure([
                    failureProbe(
                        input,
                        { ...result, targetPairIdentities: duplicates, returnedPairIdentities: duplicates },
                        parsed,
                        Repository.runRtcRttRepositoryFilterAcceptedSamples
                    )
                ]);
            }
        }
    }
});

it('RTC-B03 diagnostics stay create-new beneath tmp/perf/results', () => {
    mkdirSync('tmp/perf/results', { recursive: true });
    const directory = mkdtempSync(join('tmp/perf/results', 'rtc-topology-diagnostic-'));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const cases = [
        ['packages/shared-rtc-bench/workloads/topology/rtc-topology-star-bench.ts', '--sessions=30'],
        [
            'packages/shared-rtc-bench/workloads/topology/rtc-topology-tree-no-rtt-bench.ts',
            '--sessions=30',
            '--degree-limit=5'
        ],
        [
            'packages/shared-rtc-bench/workloads/topology/rtc-topology-mesh-no-rtt-bench.ts',
            '--sessions=30',
            '--mesh-param-k=2'
        ],
        ['packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts', '--sessions=30'],
        [
            'packages/shared-rtc-bench/workloads/topology/rtc-topology-inactive-churn-bench.ts',
            '--groups=1',
            '--sessions=1'
        ],
        [
            'packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts',
            '--room-sessions=5',
            '--global-measurements=1000'
        ]
    ];
    for (const [index, arguments_] of cases.entries()) {
        const output = join(directory, `${index}.json`);
        const command = [...denoPrefix, ...arguments_, '--runs=1', `--out=${output}`];
        expect(spawnSync('deno', command, { encoding: 'utf8' }).status).toBe(0);
        const persisted = JSON.parse(readFileSync(output, 'utf8'));
        expect([persisted.schema, persisted.outcome]).toEqual([undefined, undefined]);
        expect(spawnSync('deno', command, { encoding: 'utf8' }).status).not.toBe(0);
    }
}, 30_000);
