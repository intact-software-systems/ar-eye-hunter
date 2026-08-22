import type {
    RtcBaselineCaseKeyDto,
    RtcBaselineConfigurationFieldDescriptorDto,
    RtcBaselineWorkloadId
} from '../contracts/rtc-baseline-contracts.ts';
type Scalar = boolean | number | string;
type ScalarKind = RtcBaselineConfigurationFieldDescriptorDto['scalarKind'];
type Field = readonly [string, string, ScalarKind, Scalar];
interface Case {
    caseId: string;
    inputKey: string;
    runtime: { executable: string; prefixArguments: string[]; };
    sourcePaths: string[];
    configPaths: string[];
    configuration: RtcBaselineConfigurationFieldDescriptorDto[];
    warmupOuterAttempts?: number;
    retainedOuterAttempts?: number;
    cohortId?: string;
}
const syntheticPrefix = [
    'run',
    '--config=packages/shared-rtc-bench/deno.json',
    '--allow-read',
    '--allow-write'
];

function descriptor(
    ...input: readonly [
        caseKey: RtcBaselineCaseKeyDto,
        field: string,
        flag: string,
        scalarKind: ScalarKind,
        defaultValue: Scalar,
        environment?: string | null,
        unset?: 'reject' | null
    ]
): RtcBaselineConfigurationFieldDescriptorDto {
    const [caseKey, field, flag, scalarKind, defaultValue, environment = null, unset = null] = input;
    return {
        caseKey,
        field,
        flag,
        scalarKind,
        defaultValue,
        allowlistedEnvironmentVariable: environment,
        environmentUnsetBehavior: unset
    };
}

function syntheticCase(
    ...input: readonly [
        workloadId: RtcBaselineWorkloadId,
        caseId: string,
        inputKey: string,
        sourcePath: string,
        fields: readonly Field[],
        attempts?: [number, number]
    ]
): Case {
    const [workloadId, caseId, inputKey, sourcePath, fields, attempts] = input;
    const caseKey = { workloadId, caseId, inputKey };
    return {
        caseId,
        inputKey,
        runtime: { executable: 'deno', prefixArguments: [...syntheticPrefix, sourcePath] },
        sourcePaths: [sourcePath],
        configPaths: ['packages/shared-rtc-bench/deno.json'],
        configuration: fields.map(([field, flag, kind, value]) => descriptor(caseKey, field, flag, kind, value)),
        ...(attempts === undefined
            ? {}
            : { warmupOuterAttempts: attempts[0], retainedOuterAttempts: attempts[1] })
    };
}

const b01Cases: Case[] = [
    syntheticCase(
        'RTC-B01',
        'peer-connection-diagnostics-burst',
        'pairs-500',
        'packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-burst.ts',
        [
            ['peers', '--rtc-peers', 'nonnegative-integer', 500],
            ['iceCandidatesPerPeer', '--rtc-ice-candidates-per-peer', 'nonnegative-integer', 5],
            ['offerCollisionsPerPeer', '--rtc-offer-collisions-per-peer', 'nonnegative-integer', 3],
            ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
        ]
    ),
    syntheticCase(
        'RTC-B01',
        'ice-candidate-queue',
        'candidates-25000',
        'packages/shared-rtc-bench/workloads/signaling/rtc-ice-candidate-queue-bench.ts',
        [
            ['candidates', '--rtc-candidates', 'nonnegative-integer', 25000],
            ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
        ]
    ),
    syntheticCase(
        'RTC-B01',
        'peer-listener-cleanup',
        'peers-10000',
        'packages/shared-rtc-bench/workloads/signaling/rtc-peer-listener-cleanup-bench.ts',
        [
            ['peers', '--rtc-peers', 'nonnegative-integer', 10000],
            ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
        ]
    )
];

const replaceCases = [32, 1000, 5000].map((depth) =>
    syntheticCase(
        'RTC-B02',
        'data-channel-replace-key',
        `depth-${depth}`,
        'packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-replace-key-bench.ts',
        [
            ['queueDepth', '--rtc-queue-depth', 'nonnegative-integer', depth],
            ['replacements', '--rtc-replacements', 'nonnegative-integer', 25000],
            ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
        ]
    )
);
const drainCases = [32, 1000, 5000].map((depth) =>
    syntheticCase(
        'RTC-B02',
        'data-channel-drain',
        `depth-${depth}`,
        'packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-drain-bench.ts',
        [
            ['queueDepth', '--rtc-queue-depth', 'nonnegative-integer', depth],
            ['payloadBytes', '--rtc-payload-bytes', 'nonnegative-integer', 256],
            ['highWatermarkBytes', '--rtc-high-watermark-bytes', 'nonnegative-integer', 1],
            ['lowWatermarkBytes', '--rtc-low-watermark-bytes', 'nonnegative-integer', 0],
            ['overflow', '--rtc-overflow', 'string', 'replace-by-key'],
            ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
        ]
    )
);
const b02Cases = [
    ...replaceCases,
    ...drainCases,
    syntheticCase(
        'RTC-B02',
        'data-channel-close-retention',
        'queue-32',
        'packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-close-retention-bench.ts',
        [
            ['queueDepth', '--rtc-queue-depth', 'nonnegative-integer', 32],
            ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
        ]
    ),
    syntheticCase(
        'RTC-B02',
        'data-channel-error-reference',
        'fixed',
        'packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-error-reference-bench.ts',
        [['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]]
    )
];

function sessionCases(
    caseId: string,
    sourcePath: string,
    extras: Array<[string, string, 'nonnegative-integer', number]> = []
) {
    return [30, 100, 300].map((sessions) =>
        syntheticCase('RTC-B03', caseId, `sessions-${sessions}`, sourcePath, [
            ['sessions', '--rtc-sessions', 'nonnegative-integer', sessions],
            ...extras,
            ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
        ])
    );
}

const repositoryCases = [5, 30].flatMap((roomSessions) =>
    [1000, 10000, 100000].map((globalMeasurements) =>
        syntheticCase(
            'RTC-B03',
            'rtt-repository-filter',
            `room-${roomSessions}-global-${globalMeasurements}`,
            'packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts',
            [
                ['roomSessions', '--rtc-room-sessions', 'nonnegative-integer', roomSessions],
                [
                    'globalMeasurements',
                    '--rtc-global-measurements',
                    'nonnegative-integer',
                    globalMeasurements
                ],
                ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
            ]
        )
    )
);
const b03Cases = [
    ...sessionCases(
        'topology-star',
        'packages/shared-rtc-bench/workloads/topology/rtc-topology-star-bench.ts'
    ),
    ...sessionCases(
        'topology-tree',
        'packages/shared-rtc-bench/workloads/topology/rtc-topology-tree-no-rtt-bench.ts',
        [['degreeLimit', '--rtc-degree-limit', 'nonnegative-integer', 5]]
    ),
    ...sessionCases(
        'topology-mesh',
        'packages/shared-rtc-bench/workloads/topology/rtc-topology-mesh-no-rtt-bench.ts',
        [['meshParamK', '--rtc-mesh-param-k', 'nonnegative-integer', 2]]
    ),
    ...sessionCases(
        'room-graph-rtt-sparse',
        'packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts',
        [['sparseDegree', '--rtc-sparse-degree', 'nonnegative-integer', 4]]
    ),
    ...sessionCases(
        'room-graph-rtt-complete',
        'packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts'
    ),
    ...repositoryCases,
    ...(['retain', 'cleanup'] as const).map((mode) =>
        syntheticCase(
            'RTC-B03',
            'topology-inactive-churn',
            `mode-${mode}`,
            'packages/shared-rtc-bench/workloads/topology/rtc-topology-inactive-churn-bench.ts',
            [
                ['mode', '--rtc-mode', 'string', mode],
                ['groups', '--rtc-groups', 'nonnegative-integer', 10000],
                ['sessionsPerGroup', '--rtc-sessions-per-group', 'nonnegative-integer', 5],
                ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 3]
            ],
            [1, 5]
        )
    )
];

const multicastCases = [10, 100, 1000].flatMap((peers) =>
    [4096, 65536].map((payloadBytes) =>
        syntheticCase(
            'RTC-B04',
            'multicast-serialization',
            `peers-${peers}-payload-${payloadBytes}`,
            'packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts',
            [
                ['peers', '--rtc-peers', 'nonnegative-integer', peers],
                ['payloadBytes', '--rtc-payload-bytes', 'nonnegative-integer', payloadBytes],
                ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
            ]
        )
    )
);
const fixedB04 = [
    [
        'group-cache-fallback',
        'packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-cache-fallback-bench.ts',
        [
            ['snapshots', '--rtc-snapshots', 'nonnegative-integer', 20000],
            ['matchingVersions', '--rtc-matching-versions', 'nonnegative-integer', 5000],
            ['lookups', '--rtc-lookups', 'nonnegative-integer', 500]
        ]
    ],
    [
        'group-manager-state',
        'packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-manager-state-bench.ts',
        [
            ['clients', '--rtc-clients', 'nonnegative-integer', 5000],
            ['desired', '--rtc-desired', 'nonnegative-integer', 1000],
            ['lookups', '--rtc-lookups', 'nonnegative-integer', 20]
        ]
    ],
    [
        'group-manager-peer-owners',
        'packages/shared-rtc-bench/workloads/group-coordination/' +
        'webrtc-group-manager-peer-owners-bench.ts',
        [
            ['groups', '--rtc-groups', 'nonnegative-integer', 1000],
            ['peersPerGroup', '--rtc-peers-per-group', 'nonnegative-integer', 10],
            ['lookups', '--rtc-lookups', 'nonnegative-integer', 1000]
        ]
    ],
    [
        'heartbeat-callback-churn',
        'packages/shared-rtc-bench/workloads/group-coordination/' +
        'webrtc-heartbeat-callback-churn-bench.ts',
        [['channels', '--rtc-channels', 'nonnegative-integer', 10000]]
    ]
] as const;
const b04Cases = [
    ...multicastCases,
    ...fixedB04.map(([caseId, sourcePath, fields]) =>
        syntheticCase('RTC-B04', caseId, 'fixed', sourcePath, [
            ...fields,
            ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
        ])
    )
];
const b05Key = {
    workloadId: 'RTC-B05' as const,
    caseId: 'browser-data-channel-lifecycle',
    inputKey: 'iterations-25'
};
const b05Cases: Case[] = [
    {
        ...b05Key,
        runtime: {
            executable: 'node',
            prefixArguments: [
                'packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs'
            ]
        },
        sourcePaths: [
            'packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs'
        ],
        configPaths: ['apps/rallar-black-box/playwright.config.ts'],
        configuration: [
            descriptor(b05Key, 'iterations', '--rtc-iterations', 'nonnegative-integer', 25)
        ]
    }
];
function fullStackCase(
    ...input: readonly [
        caseId: string,
        inputKey: string,
        database: 'memory' | 'postgres',
        all: boolean,
        retention: boolean
    ]
): Case {
    const [caseId, inputKey, database, all, retention] = input;
    const caseKey = { workloadId: 'RTC-B06' as const, caseId, inputKey };
    const postgres = database === 'postgres';
    return {
        caseId,
        inputKey,
        runtime: {
            executable: 'npm',
            prefixArguments: [
                'run',
                postgres
                    ? 'test:rallar:full-stack:postgres:live-rtc-3:all'
                    : 'test:rallar:full-stack:memory:live-rtc-3'
            ]
        },
        sourcePaths: [
            'tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts'
        ],
        configPaths: ['apps/rallar-black-box/playwright.config.ts'],
        warmupOuterAttempts: 1,
        retainedOuterAttempts: caseId === 'default' ? 5 : 3,
        configuration: [
            descriptor(
                caseKey,
                'allScenarios',
                '--rtc-all-scenarios',
                'boolean',
                all,
                all ? 'RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS' : null,
                all ? 'reject' : null
            ),
            descriptor(
                caseKey,
                'retentionSoak',
                '--rtc-retention-soak',
                'boolean',
                retention,
                retention ? 'RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK' : null,
                retention ? 'reject' : null
            ),
            descriptor(
                caseKey,
                'retentionCycles',
                '--rtc-retention-cycles',
                'nonnegative-integer',
                retention ? 100 : 0,
                retention ? 'RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES' : null,
                retention ? 'reject' : null
            ),
            descriptor(caseKey, 'databaseProvider', '--rtc-database-provider', 'string', database),
            descriptor(
                caseKey,
                'iceMode',
                '--rtc-ice-mode',
                'string',
                postgres ? 'local' : 'repository-default',
                postgres ? 'RALLAR_ICE_MODE' : null,
                postgres ? 'reject' : null
            )
        ],
        ...(retention ? { cohortId: `rtc-b06-${postgres ? 'e4-pg' : 'e3-memory'}-retention` } : {})
    };
}

const b06Cases = [
    fullStackCase('default', 'e3-memory-default', 'memory', false, false),
    fullStackCase('all-scenarios', 'e3-memory-all-scenarios', 'memory', true, false),
    fullStackCase('retention-100', 'e3-memory-retention-100', 'memory', false, true),
    fullStackCase('default', 'e4-pg-default', 'postgres', false, false),
    fullStackCase('all-scenarios', 'e4-pg-all-scenarios', 'postgres', true, false),
    fullStackCase('retention-100', 'e4-pg-retention-100', 'postgres', false, true)
];
function workload(
    ...input: readonly [
        workloadId: RtcBaselineWorkloadId,
        evidenceClass: 'synthetic-path' | 'native-browser' | 'local-full-stack',
        warmupOuterAttempts: number,
        retainedOuterAttempts: number,
        cases: readonly Case[]
    ]
) {
    const [workloadId, evidenceClass, warmupOuterAttempts, retainedOuterAttempts, cases] = input;
    return { workloadId, evidenceClass, warmupOuterAttempts, retainedOuterAttempts, cases };
}
export const RTC_BASELINE_WORKLOAD_CATALOG = [
    workload('RTC-B01', 'synthetic-path', 1, 5, b01Cases),
    workload('RTC-B02', 'synthetic-path', 3, 15, b02Cases),
    workload('RTC-B03', 'synthetic-path', 3, 15, b03Cases),
    workload('RTC-B04', 'synthetic-path', 3, 15, b04Cases),
    workload('RTC-B05', 'native-browser', 1, 5, b05Cases),
    workload('RTC-B06', 'local-full-stack', 1, 5, b06Cases)
] as const;
