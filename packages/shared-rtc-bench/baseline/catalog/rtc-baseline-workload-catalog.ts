import { FULL_STACK_RTC_ICE_FIXTURE_POLICIES } from '../../../shared-test/black-box-runner/fixtures/full-stack-rtc-ice-fixture-policy.ts';
import { FULL_STACK_RTC_PRODUCTION_POLICY } from '../../../shared-test/black-box-runner/fixtures/rtc-production/full-stack-rtc-production-proof.ts';

import type {
    RtcBaselineCaseKeyDto,
    RtcBaselineConfigurationFieldDescriptorDto,
    RtcBaselineWorkloadId
} from '../contracts/rtc-baseline-contracts.ts';
type RtcBaselineSyntheticField = readonly [
    field: string,
    flag: string,
    scalarKind: RtcBaselineConfigurationFieldDescriptorDto['scalarKind'],
    defaultValue: RtcBaselineConfigurationFieldDescriptorDto['defaultValue']
];
interface RtcBaselineWorkloadCase {
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

interface RtcBaselineDescriptorInput {
    caseKey: RtcBaselineCaseKeyDto;
    field: string;
    flag: string;
    scalarKind: RtcBaselineConfigurationFieldDescriptorDto['scalarKind'];
    defaultValue: RtcBaselineConfigurationFieldDescriptorDto['defaultValue'];
    environment?: string | null;
    unset?: 'reject' | null;
}

function toRtcBaselineConfigurationDescriptor(
    input: RtcBaselineDescriptorInput
): RtcBaselineConfigurationFieldDescriptorDto {
    const { environment = null, unset = null, ...fields } = input;
    return { ...fields, allowlistedEnvironmentVariable: environment, environmentUnsetBehavior: unset };
}

interface RtcBaselineSyntheticCaseInput {
    workloadId: RtcBaselineWorkloadId;
    caseId: string;
    inputKey: string;
    sourcePath: string;
    fields: readonly RtcBaselineSyntheticField[];
    attempts?: [number, number];
}

function toRtcBaselineSyntheticCase(input: RtcBaselineSyntheticCaseInput): RtcBaselineWorkloadCase {
    const { workloadId, caseId, inputKey, sourcePath, fields, attempts } = input;
    const caseKey = { workloadId, caseId, inputKey };
    return {
        caseId,
        inputKey,
        runtime: { executable: 'deno', prefixArguments: [...syntheticPrefix, sourcePath] },
        sourcePaths: [sourcePath],
        configPaths: ['packages/shared-rtc-bench/deno.json'],
        configuration: fields.map(([field, flag, kind, value]) =>
            toRtcBaselineConfigurationDescriptor({ caseKey, field, flag, scalarKind: kind, defaultValue: value })
        ),
        ...(attempts === undefined
            ? {}
            : { warmupOuterAttempts: attempts[0], retainedOuterAttempts: attempts[1] })
    };
}

const b01Cases: RtcBaselineWorkloadCase[] = [
    toRtcBaselineSyntheticCase({
        workloadId: 'RTC-B01',
        caseId: 'peer-connection-diagnostics-burst',
        inputKey: 'pairs-500',
        sourcePath: 'packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-burst.ts',
        fields: [
            ['peers', '--rtc-peers', 'nonnegative-integer', 500],
            ['iceCandidatesPerPeer', '--rtc-ice-candidates-per-peer', 'nonnegative-integer', 5],
            ['offerCollisionsPerPeer', '--rtc-offer-collisions-per-peer', 'nonnegative-integer', 3],
            ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
        ]
    }),
    toRtcBaselineSyntheticCase({
        workloadId: 'RTC-B01',
        caseId: 'ice-candidate-queue',
        inputKey: 'candidates-25000',
        sourcePath: 'packages/shared-rtc-bench/workloads/signaling/rtc-ice-candidate-queue-bench.ts',
        fields: [
            ['candidates', '--rtc-candidates', 'nonnegative-integer', 25000],
            ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
        ]
    }),
    toRtcBaselineSyntheticCase({
        workloadId: 'RTC-B01',
        caseId: 'peer-listener-cleanup',
        inputKey: 'peers-10000',
        sourcePath: 'packages/shared-rtc-bench/workloads/signaling/rtc-peer-listener-cleanup-bench.ts',
        fields: [
            ['peers', '--rtc-peers', 'nonnegative-integer', 10000],
            ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
        ]
    })
];

const replaceCases = [32, 1000, 5000].map((depth) =>
    toRtcBaselineSyntheticCase({
        workloadId: 'RTC-B02',
        caseId: 'data-channel-replace-key',
        inputKey: `depth-${depth}`,
        sourcePath: 'packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-replace-key-bench.ts',
        fields: [
            ['queueDepth', '--rtc-queue-depth', 'nonnegative-integer', depth],
            ['replacements', '--rtc-replacements', 'nonnegative-integer', 25000],
            ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
        ]
    })
);
const drainCases = [32, 1000, 5000].map((depth) =>
    toRtcBaselineSyntheticCase({
        workloadId: 'RTC-B02',
        caseId: 'data-channel-drain',
        inputKey: `depth-${depth}`,
        sourcePath: 'packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-drain-bench.ts',
        fields: [
            ['queueDepth', '--rtc-queue-depth', 'nonnegative-integer', depth],
            ['payloadBytes', '--rtc-payload-bytes', 'nonnegative-integer', 256],
            ['highWatermarkBytes', '--rtc-high-watermark-bytes', 'nonnegative-integer', 1],
            ['lowWatermarkBytes', '--rtc-low-watermark-bytes', 'nonnegative-integer', 0],
            ['overflow', '--rtc-overflow', 'string', 'replace-by-key'],
            ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
        ]
    })
);
const b02Cases = [
    ...replaceCases,
    ...drainCases,
    toRtcBaselineSyntheticCase({
        workloadId: 'RTC-B02',
        caseId: 'data-channel-close-retention',
        inputKey: 'queue-32',
        sourcePath: 'packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-close-retention-bench.ts',
        fields: [
            ['queueDepth', '--rtc-queue-depth', 'nonnegative-integer', 32],
            ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
        ]
    }),
    toRtcBaselineSyntheticCase({
        workloadId: 'RTC-B02',
        caseId: 'data-channel-error-reference',
        inputKey: 'fixed',
        sourcePath: 'packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-error-reference-bench.ts',
        fields: [['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]]
    })
];

function toRtcBaselineSessionCases(
    caseId: string,
    sourcePath: string,
    extras: Array<[string, string, 'nonnegative-integer', number]> = []
): RtcBaselineWorkloadCase[] {
    return [30, 100, 300].map((sessions) =>
        toRtcBaselineSyntheticCase({
            workloadId: 'RTC-B03',
            caseId,
            inputKey: `sessions-${sessions}`,
            sourcePath,
            fields: [
                ['sessions', '--rtc-sessions', 'nonnegative-integer', sessions],
                ...extras,
                ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
            ]
        })
    );
}

const repositoryCases = [5, 30].flatMap((roomSessions) =>
    [1000, 10000, 100000].map((globalMeasurements) =>
        toRtcBaselineSyntheticCase({
            workloadId: 'RTC-B03',
            caseId: 'rtt-repository-filter',
            inputKey: `room-${roomSessions}-global-${globalMeasurements}`,
            sourcePath: 'packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts',
            fields: [
                ['roomSessions', '--rtc-room-sessions', 'nonnegative-integer', roomSessions],
                [
                    'globalMeasurements',
                    '--rtc-global-measurements',
                    'nonnegative-integer',
                    globalMeasurements
                ],
                ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
            ]
        })
    )
);
const b03Cases = [
    ...toRtcBaselineSessionCases(
        'topology-star',
        'packages/shared-rtc-bench/workloads/topology/rtc-topology-star-bench.ts'
    ),
    ...toRtcBaselineSessionCases(
        'topology-tree',
        'packages/shared-rtc-bench/workloads/topology/rtc-topology-tree-no-rtt-bench.ts',
        [['degreeLimit', '--rtc-degree-limit', 'nonnegative-integer', 5]]
    ),
    ...toRtcBaselineSessionCases(
        'topology-mesh',
        'packages/shared-rtc-bench/workloads/topology/rtc-topology-mesh-no-rtt-bench.ts',
        [['meshParamK', '--rtc-mesh-param-k', 'nonnegative-integer', 2]]
    ),
    ...toRtcBaselineSessionCases(
        'room-graph-rtt-sparse',
        'packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts',
        [['sparseDegree', '--rtc-sparse-degree', 'nonnegative-integer', 4]]
    ),
    ...toRtcBaselineSessionCases(
        'room-graph-rtt-complete',
        'packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts'
    ),
    ...repositoryCases,
    ...(['retain', 'cleanup'] as const).map((mode) =>
        toRtcBaselineSyntheticCase({
            workloadId: 'RTC-B03',
            caseId: 'topology-inactive-churn',
            inputKey: `mode-${mode}`,
            sourcePath: 'packages/shared-rtc-bench/workloads/topology/rtc-topology-inactive-churn-bench.ts',
            fields: [
                ['mode', '--rtc-mode', 'string', mode],
                ['groups', '--rtc-groups', 'nonnegative-integer', 10000],
                ['sessionsPerGroup', '--rtc-sessions-per-group', 'nonnegative-integer', 5],
                ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 3]
            ],
            attempts: [1, 5]
        })
    )
];

const multicastCases = [10, 100, 1000].flatMap((peers) =>
    [4096, 65536].map((payloadBytes) =>
        toRtcBaselineSyntheticCase({
            workloadId: 'RTC-B04',
            caseId: 'multicast-serialization',
            inputKey: `peers-${peers}-payload-${payloadBytes}`,
            sourcePath: 'packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts',
            fields: [
                ['peers', '--rtc-peers', 'nonnegative-integer', peers],
                ['payloadBytes', '--rtc-payload-bytes', 'nonnegative-integer', payloadBytes],
                ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
            ]
        })
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
        toRtcBaselineSyntheticCase({
            workloadId: 'RTC-B04',
            caseId,
            inputKey: 'fixed',
            sourcePath,
            fields: [
                ...fields,
                ['innerRuns', '--rtc-inner-runs', 'nonnegative-integer', 5]
            ]
        })
    )
];
const b05Key = {
    workloadId: 'RTC-B05' as const,
    caseId: 'browser-data-channel-lifecycle',
    inputKey: 'iterations-25'
};
const b05Cases: RtcBaselineWorkloadCase[] = [
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
            toRtcBaselineConfigurationDescriptor({
                caseKey: b05Key,
                field: 'iterations',
                flag: '--rtc-iterations',
                scalarKind: 'nonnegative-integer',
                defaultValue: 25
            })
        ]
    }
];

function toRtcBaselineFullStackRuntimeScript(
    database: 'memory' | 'postgres',
    allScenarios: boolean
): string {
    if (database === 'memory') {
        return 'test:rallar:full-stack:memory:live-rtc-3';
    }
    return allScenarios
        ? 'test:rallar:full-stack:postgres:live-rtc-3:all'
        : 'test:rallar:full-stack:postgres:live-rtc-3';
}

interface RtcBaselineFullStackCaseInput {
    caseId: string;
    inputKey: string;
    database: 'memory' | 'postgres';
    allScenarios: boolean;
    retention: boolean;
}

const fullStackSourcePaths = [
    'tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts',
    'tests/playwright/rallar-black-box/create-group-formation-lifecycle-driver.ts',
    'tests/playwright/rallar-black-box/live-rtc-formation-operations.ts',
    'tests/playwright/rallar-black-box/live-rtc-delivery-operations.ts',
    'tests/playwright/rallar-black-box/live-rtc-agent-environment.ts',
    'tests/playwright/rallar-black-box/live-rtc-control-client.ts',
    'tests/playwright/rallar-black-box/live-rtc-browser-agents.ts',
    'tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts',
    'tests/playwright/rallar-black-box/live-rtc-evidence-json.ts',
    'tests/playwright/rallar-black-box/to-live-rtc-native-acquisition.ts',
    'packages/shared/webrtc/rtc-capture-configuration.ts',
    'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts',
    'packages/shared-web/browser/connection/to-rtc-capture-readout.ts',
    'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-connect-operation.ts',
    'packages/shared-web/browser/connection/browser-rtc-capture-intent.ts',
    'apps/rallar-black-box-control-server/src/control-artifact-recorder.ts',
    'apps/rallar-black-box-control-server/src/control-artifacts.ts'
];

const fullStackMemorySourcePaths = [
    ...fullStackSourcePaths,
    'apps/api-v1/src/main.ts',
    'apps/api-v1/src/configuration/read-api-v1-configuration.ts',
    'apps/api-v1/src/configuration/read-api-v1-configuration-environment.ts',
    'apps/api-v1/src/configuration/decode-api-v1-configuration-source.ts',
    'apps/api-v1/src/configuration/decode-api-v1-configuration.ts',
    'apps/api-v1/src/configuration/decode-api-v1-configuration-values.ts',
    'apps/api-v1/src/composition/create-api-v1-route-installers.ts',
    'apps/api-v1/src/routes/ice-route.ts',
    'packages/shared-server/http/rate-limit-service.ts',
    'packages/shared/resilience/Resilience.ts',
    'packages/shared/cache/LoanedValue.ts',
    'packages/shared-rtc-bench/baseline/observation/rtc-b06-observation-deno-runtime.ts',
    'apps/rallar-black-box/playwright-full-stack-spa-server.ts',
    'apps/rallar-black-box/rtc-production-artifacts.ts',
    'apps/rallar-black-box/scripts/rtc-production-preview.ts',
    'apps/rallar-black-box/rtc-production-serving-proof.ts',
    'packages/shared-rtc-bench/baseline/observation/validate-rtc-b06-production-serving-proof.ts',
    'packages/shared-test/black-box-runner/fixtures/rtc-production/full-stack-rtc-production-proof.ts',
    'packages/shared-test/black-box-runner/fixtures/rtc-production/read-full-stack-rtc-build-tool-inputs.ts',
    'packages/shared-test/black-box-runner/fixtures/rtc-production/full-stack-rtc-build-tool-provenance.ts',
    'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-deno-adapters.ts',
    'packages/shared-test/black-box-runner/fixtures/full-stack-rtc-ice-fixture-policy.ts',
    'packages/shared-test/black-box-runner/fixtures/read-full-stack-rtc-ice-fixture-requests.ts'
];

const fullStackMemoryConfigPaths = [
    'package.json',
    'package-lock.json',
    'apps/rallar-black-box/package.json',
    'apps/rallar-black-box/vite.config.ts',
    'node_modules/typescript/package.json',
    'node_modules/typescript/lib/tsc.js',
    'node_modules/rolldown/package.json',
    'node_modules/rolldown/dist/index.mjs',
    'node_modules/vite/package.json',
    'node_modules/vite/dist/node/cli.js',
    'node_modules/vite/dist/node/chunks/node.js',
    'apps/rallar-black-box/node_modules/@vitejs/plugin-react/package.json',
    'apps/rallar-black-box/node_modules/@vitejs/plugin-react/dist/index.js',
    'apps/rallar-black-box/playwright.full-stack.config.ts',
    'apps/rallar-black-box/playwright-full-stack-api-server.ts',
    'apps/api-v1/resources/configuration/defaults-config.json',
    'apps/api-v1/resources/configuration/prod-in-memory-config.json',
    'apps/api-v1/src/configuration/README.md'
];

function toRtcBaselineFullStackCase(input: RtcBaselineFullStackCaseInput): RtcBaselineWorkloadCase {
    const { caseId, inputKey, database, allScenarios, retention } = input;
    const postgres = database === 'postgres';
    return {
        caseId,
        inputKey,
        runtime: {
            executable: 'npm',
            prefixArguments: [
                'run',
                toRtcBaselineFullStackRuntimeScript(database, allScenarios)
            ]
        },
        sourcePaths: postgres ? fullStackSourcePaths : fullStackMemorySourcePaths,
        configPaths: postgres ? ['apps/rallar-black-box/playwright.full-stack.config.ts'] : fullStackMemoryConfigPaths,
        warmupOuterAttempts: 1,
        retainedOuterAttempts: caseId === 'default' ? 5 : 3,
        configuration: toRtcBaselineFullStackConfiguration(input),
        ...(retention ? { cohortId: `rtc-b06-${postgres ? 'e4-pg' : 'e3-memory'}-retention` } : {})
    };
}

function toRtcBaselineFullStackConfiguration(
    input: RtcBaselineFullStackCaseInput
): RtcBaselineConfigurationFieldDescriptorDto[] {
    const { caseId, inputKey, database, retention } = input;
    const caseKey = { workloadId: 'RTC-B06' as const, caseId, inputKey };
    const postgres = database === 'postgres';
    return [
        ...toRtcBaselineFullStackWorkloadConfiguration(input),
        ...(postgres
            ? []
            : Object.entries(FULL_STACK_RTC_PRODUCTION_POLICY).map(([field, value]) =>
                toRtcBaselineConfigurationDescriptor({
                    caseKey,
                    field,
                    flag: `--rtc-${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
                    scalarKind: 'string',
                    defaultValue: value
                })
            )),
        toRtcBaselineConfigurationDescriptor({
            caseKey,
            field: 'databaseProvider',
            flag: '--rtc-database-provider',
            scalarKind: 'string',
            defaultValue: database
        }),
        toRtcBaselineConfigurationDescriptor({
            caseKey,
            field: 'iceMode',
            flag: '--rtc-ice-mode',
            scalarKind: 'string',
            defaultValue: postgres ? 'local' : 'repository-default',
            environment: postgres ? 'RALLAR_ICE_MODE' : null,
            unset: postgres ? 'reject' : null
        }),
        ...(postgres ? [] : [
            toRtcBaselineConfigurationDescriptor({
                caseKey,
                field: 'iceRateLimitRequests',
                flag: '--rtc-ice-rate-limit-requests',
                scalarKind: 'nonnegative-integer',
                defaultValue: FULL_STACK_RTC_ICE_FIXTURE_POLICIES[retention ? 'retention-100' : 'default'].requests
            }),
            toRtcBaselineConfigurationDescriptor({
                caseKey,
                field: 'iceRateLimitWindowMs',
                flag: '--rtc-ice-rate-limit-window-ms',
                scalarKind: 'nonnegative-integer',
                defaultValue: FULL_STACK_RTC_ICE_FIXTURE_POLICIES.default.windowMs
            })
        ])
    ];
}

function toRtcBaselineFullStackWorkloadConfiguration(
    input: RtcBaselineFullStackCaseInput
): RtcBaselineConfigurationFieldDescriptorDto[] {
    const { caseId, inputKey, allScenarios, retention } = input;
    const caseKey = { workloadId: 'RTC-B06' as const, caseId, inputKey };
    return [
        toRtcBaselineConfigurationDescriptor({
            caseKey,
            field: 'rtcCaptureMode',
            flag: '--rtc-capture-mode',
            scalarKind: 'string',
            defaultValue: 'signaling',
            environment: 'RALLAR_BLACK_BOX_RTC_CAPTURE_MODE'
        }),
        toRtcBaselineConfigurationDescriptor({
            caseKey,
            field: 'allScenarios',
            flag: '--rtc-all-scenarios',
            scalarKind: 'boolean',
            defaultValue: allScenarios,
            environment: allScenarios ? 'RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS' : null,
            unset: allScenarios ? 'reject' : null
        }),
        toRtcBaselineConfigurationDescriptor({
            caseKey,
            field: 'retentionSoak',
            flag: '--rtc-retention-soak',
            scalarKind: 'boolean',
            defaultValue: retention,
            environment: retention ? 'RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK' : null,
            unset: retention ? 'reject' : null
        }),
        toRtcBaselineConfigurationDescriptor({
            caseKey,
            field: 'retentionCycles',
            flag: '--rtc-retention-cycles',
            scalarKind: 'nonnegative-integer',
            defaultValue: retention ? 100 : 0,
            environment: retention ? 'RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES' : null,
            unset: retention ? 'reject' : null
        })
    ];
}

const b06Cases = [
    toRtcBaselineFullStackCase({
        caseId: 'default',
        inputKey: 'e3-memory-default',
        database: 'memory',
        allScenarios: false,
        retention: false
    }),
    toRtcBaselineFullStackCase({
        caseId: 'all-scenarios',
        inputKey: 'e3-memory-all-scenarios',
        database: 'memory',
        allScenarios: true,
        retention: false
    }),
    toRtcBaselineFullStackCase({
        caseId: 'retention-100',
        inputKey: 'e3-memory-retention-100',
        database: 'memory',
        allScenarios: false,
        retention: true
    }),
    toRtcBaselineFullStackCase({
        caseId: 'default',
        inputKey: 'e4-pg-default',
        database: 'postgres',
        allScenarios: false,
        retention: false
    }),
    toRtcBaselineFullStackCase({
        caseId: 'all-scenarios',
        inputKey: 'e4-pg-all-scenarios',
        database: 'postgres',
        allScenarios: true,
        retention: false
    }),
    toRtcBaselineFullStackCase({
        caseId: 'retention-100',
        inputKey: 'e4-pg-retention-100',
        database: 'postgres',
        allScenarios: false,
        retention: true
    })
];
interface RtcBaselineWorkloadInput {
    workloadId: RtcBaselineWorkloadId;
    evidenceClass: 'synthetic-path' | 'native-browser' | 'local-full-stack';
    warmupOuterAttempts: number;
    retainedOuterAttempts: number;
    cases: readonly RtcBaselineWorkloadCase[];
}

export const RTC_BASELINE_WORKLOAD_CATALOG: readonly RtcBaselineWorkloadInput[] = [
    {
        workloadId: 'RTC-B01',
        evidenceClass: 'synthetic-path',
        warmupOuterAttempts: 1,
        retainedOuterAttempts: 5,
        cases: b01Cases
    },
    {
        workloadId: 'RTC-B02',
        evidenceClass: 'synthetic-path',
        warmupOuterAttempts: 3,
        retainedOuterAttempts: 15,
        cases: b02Cases
    },
    {
        workloadId: 'RTC-B03',
        evidenceClass: 'synthetic-path',
        warmupOuterAttempts: 3,
        retainedOuterAttempts: 15,
        cases: b03Cases
    },
    {
        workloadId: 'RTC-B04',
        evidenceClass: 'synthetic-path',
        warmupOuterAttempts: 3,
        retainedOuterAttempts: 15,
        cases: b04Cases
    },
    {
        workloadId: 'RTC-B05',
        evidenceClass: 'native-browser',
        warmupOuterAttempts: 1,
        retainedOuterAttempts: 5,
        cases: b05Cases
    },
    {
        workloadId: 'RTC-B06',
        evidenceClass: 'local-full-stack',
        warmupOuterAttempts: 1,
        retainedOuterAttempts: 5,
        cases: b06Cases
    }
] as const;
