export type BlackBoxRunnerExecutionMode = 'run' | 'dry-run';

export type BlackBoxRunnerExpectedResult = 'pass' | 'expected-failure';

export type BlackBoxRunnerProviderMode =
    | 'rallar-memory'
    | 'rallar-server'
    | 'rallar-browser'
    | 'rallar-remote-browser'
    | 'rallar-signaling'
    | 'dry-run'
    | 'mixed'
    | 'unknown';

export type BlackBoxRunnerLiveSupport = 'offline' | 'dry-run-only' | 'gated-live';

export type BlackBoxRunnerHttpServiceRequirement = Readonly<{
    name: string;
    env: string;
    default?: string;
}>;

export type BlackBoxRunnerRecipeRequirement = Readonly<{
    env?: readonly string[];
    httpServices?: readonly BlackBoxRunnerHttpServiceRequirement[];
    playwright?: boolean;
}>;

export type BlackBoxRunnerRecipeMatrixEntry = Readonly<{
    id: string;
    recipe: string;
    category: string;
    mode: BlackBoxRunnerExecutionMode;
    profiles: readonly string[];
    expectedExitCode: 0 | 1;
    artifactName?: string;
    description?: string;
    env?: Readonly<Record<string, string>>;
    requires?: BlackBoxRunnerRecipeRequirement;
}>;

export type BlackBoxRunnerRecipeMatrix = Readonly<{
    version: number;
    description?: string;
    entries: readonly BlackBoxRunnerRecipeMatrixEntry[];
}>;

export type BlackBoxRunnerCommandSnippet = Readonly<{
    label: string;
    command: string;
    description: string;
}>;

export type BlackBoxRunnerRecipeCatalogEntry = Readonly<{
    id: string;
    title: string;
    description: string;
    recipePath: string;
    category: string;
    providerMode: BlackBoxRunnerProviderMode;
    executionMode: BlackBoxRunnerExecutionMode;
    expectedResult: BlackBoxRunnerExpectedResult;
    liveSupport: BlackBoxRunnerLiveSupport;
    profiles: readonly string[];
    artifactName: string;
    prerequisites: Readonly<{
        requiredEnvVars: readonly string[];
        httpServices: readonly BlackBoxRunnerHttpServiceRequirement[];
        requiresPlaywright: boolean;
        injectedEnv: Readonly<Record<string, string>>;
    }>;
    support: Readonly<{
        deterministic: boolean;
        dryRun: boolean;
        live: boolean;
        remoteBrowser: boolean;
        artifacts: boolean;
        replayArtifacts: boolean;
    }>;
    commands: readonly BlackBoxRunnerCommandSnippet[];
    uiHints: Readonly<{
        badges: readonly string[];
        recommendedSurface: 'recipe-catalog' | 'artifact-browser' | 'live-runbook';
    }>;
}>;

export type BlackBoxRunnerRecipeCatalog = Readonly<{
    version: number;
    generatedFrom: 'recipe-matrix' | 'static-fixture';
    entries: readonly BlackBoxRunnerRecipeCatalogEntry[];
}>;

export type BlackBoxRunnerArtifactFileName =
    | 'report.json'
    | 'events.jsonl'
    | 'failures.json'
    | 'metadata.json'
    | 'expanded-plan.json'
    | 'matrix-summary.json';

export type BlackBoxRunnerArtifactBundleContract = Readonly<{
    version: number;
    requiredFiles: readonly BlackBoxRunnerArtifactFileName[];
    optionalFiles: readonly BlackBoxRunnerArtifactFileName[];
    eventStream: Readonly<{
        file: 'events.jsonl';
        format: 'jsonl';
        eventKinds: readonly string[];
        truncationEventKind: 'artifact-truncated';
    }>;
    redaction: Readonly<{
        placeholderPattern: '<redacted:name>';
        appliesToFiles: readonly BlackBoxRunnerArtifactFileName[];
    }>;
}>;

export type BlackBoxRunnerCoverageOwner =
    | 'black-box-runner'
    | 'rallar-bb-test'
    | 'rallar-black-box-spa'
    | 'rallar-black-box-control-server'
    | 'shared-web-shared-server';

export type BlackBoxRunnerCoverageHandoff = Readonly<{
    owner: BlackBoxRunnerCoverageOwner;
    owns: readonly string[];
    doesNotOwn: readonly string[];
}>;

const MATRIX_PROFILE_COMMANDS: Readonly<Record<string, string>> = {
    quick: 'test:shared-black-box:matrix:quick',
    dry: 'test:shared-black-box:matrix:dry',
    deterministic: 'test:shared-black-box:matrix:deterministic',
    soak: 'test:shared-black-box:matrix:soak',
    traffic: 'test:shared-black-box:matrix:traffic',
    parallel: 'test:shared-black-box:matrix:parallel',
    live: 'test:shared-black-box:matrix:live',
    'live-soak': 'test:shared-black-box:matrix:live:soak',
    'live-traffic': 'test:shared-black-box:matrix:live:traffic',
    'live-parallel': 'test:shared-black-box:matrix:live:parallel',
};

export const BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT: BlackBoxRunnerArtifactBundleContract = {
    version: 1,
    requiredFiles: [
        'report.json',
        'events.jsonl',
        'failures.json',
        'metadata.json',
    ],
    optionalFiles: [
        'expanded-plan.json',
        'matrix-summary.json',
    ],
    eventStream: {
        file: 'events.jsonl',
        format: 'jsonl',
        eventKinds: [
            'step-result',
            'ws-message',
            'ws-close',
            'rtc-message',
            'rtc-diagnostic',
            'rtc-close',
            'artifact-truncated',
        ],
        truncationEventKind: 'artifact-truncated',
    },
    redaction: {
        placeholderPattern: '<redacted:name>',
        appliesToFiles: [
            'report.json',
            'events.jsonl',
            'failures.json',
            'metadata.json',
            'expanded-plan.json',
            'matrix-summary.json',
        ],
    },
};

export const BLACK_BOX_RUNNER_COVERAGE_HANDOFF: readonly BlackBoxRunnerCoverageHandoff[] = [
    {
        owner: 'black-box-runner',
        owns: [
            'JSON recipes for observable HTTP, WS, RTC, ASSERT, and SET behavior',
            'recipe matrix classification, live gates, and artifact bundles',
            'provider-neutral report, failure, event, and expanded-plan shapes',
        ],
        doesNotOwn: [
            'Rallar facade correctness beyond provider-observed network behavior',
            'SPA-only manual workflow ergonomics',
        ],
    },
    {
        owner: 'rallar-bb-test',
        owns: [
            'browser command runtime',
            'remote browser/control-agent command execution',
            'portable browser command recipes used by the command center',
        ],
        doesNotOwn: [
            'generic JSON recipe matrix execution',
            'Rallar Server implementation correctness',
        ],
    },
    {
        owner: 'rallar-black-box-spa',
        owns: [
            'manual command-center workflows',
            'recipe catalog display and artifact browsing',
            'visual diagnostics for auth, rooms, WS, RTC, topology, and event streams',
        ],
        doesNotOwn: [
            'shell execution of shared-test commands from the browser',
            'duplicating black-box-runner assertions or provider internals',
        ],
    },
    {
        owner: 'rallar-black-box-control-server',
        owns: [
            'agent registration and command orchestration',
            'run snapshots, reports, and uploaded command-center artifacts',
        ],
        doesNotOwn: [
            'long-term artifact retention policy unless explicitly configured',
            'Rallar routing or WebRTC behavior',
        ],
    },
    {
        owner: 'shared-web-shared-server',
        owns: [
            'facade and server unit/integration correctness',
            'domain behavior that should be tested below the command-center layer',
        ],
        doesNotOwn: [
            'black-box recipe catalog display',
            'manual browser orchestration UX',
        ],
    },
];

function titleFromId(id: string): string {
    return id
        .split(/[-_]/g)
        .filter(Boolean)
        .map(part => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join(' ');
}

function toProviderMode(entry: BlackBoxRunnerRecipeMatrixEntry): BlackBoxRunnerProviderMode {
    if (entry.profiles.includes('remote-live') || entry.category === 'rallar-remote-browser') {
        return 'rallar-remote-browser';
    }

    if (entry.profiles.includes('browser-live') || entry.category === 'rallar-browser') {
        return 'rallar-browser';
    }

    if (entry.profiles.includes('rallar-server-live') || entry.category.includes('server')) {
        return 'rallar-server';
    }

    if (entry.profiles.includes('signaling-live')) {
        return 'rallar-signaling';
    }

    if (entry.category === 'generic-runner-semantics') {
        return 'rallar-memory';
    }

    if (entry.mode === 'dry-run') {
        return 'dry-run';
    }

    return 'unknown';
}

function toLiveSupport(entry: BlackBoxRunnerRecipeMatrixEntry): BlackBoxRunnerLiveSupport {
    if (entry.profiles.includes('live') || entry.profiles.some(profile => profile.endsWith('-live'))) {
        return 'gated-live';
    }

    if (entry.mode === 'dry-run') {
        return 'dry-run-only';
    }

    return 'offline';
}

function primaryProfile(entry: BlackBoxRunnerRecipeMatrixEntry): string {
    return entry.profiles.find(profile => MATRIX_PROFILE_COMMANDS[profile] !== undefined) ||
        entry.profiles[0] ||
        'quick';
}

function toCommandSnippets(entry: BlackBoxRunnerRecipeMatrixEntry): readonly BlackBoxRunnerCommandSnippet[] {
    const profile = primaryProfile(entry);
    const rootScript = MATRIX_PROFILE_COMMANDS[profile];
    const snippets: BlackBoxRunnerCommandSnippet[] = [];

    if (rootScript) {
        snippets.push({
            label: 'Root matrix entry',
            command: `npm run ${rootScript} -- --id=${entry.id}`,
            description: 'Runs this recipe through the shared-test recipe matrix and writes an artifact bundle.',
        });
    }

    snippets.push({
        label: 'Direct scenario',
        command: [
            'deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts',
            `-c packages/shared-test/black-box-runner/${entry.recipe}`,
            entry.mode === 'dry-run' ? '--dry-run' : '',
            `--artifact-dir=.artifacts/shared-test/${entry.artifactName || entry.id}`,
        ].filter(Boolean).join(' '),
        description: 'Runs the scenario CLI directly for this recipe.',
    });

    return snippets;
}

function toBadges(entry: BlackBoxRunnerRecipeMatrixEntry): readonly string[] {
    return [
        entry.mode,
        entry.expectedExitCode === 0 ? 'expected-pass' : 'expected-failure',
        ...entry.profiles,
    ];
}

export function toBlackBoxRunnerRecipeCatalogEntry(
    entry: BlackBoxRunnerRecipeMatrixEntry,
): BlackBoxRunnerRecipeCatalogEntry {
    const requiredEnvVars = entry.requires?.env || [];
    const httpServices = entry.requires?.httpServices || [];
    const providerMode = toProviderMode(entry);
    const liveSupport = toLiveSupport(entry);

    return {
        id: entry.id,
        title: titleFromId(entry.id),
        description: entry.description || titleFromId(entry.id),
        recipePath: entry.recipe,
        category: entry.category,
        providerMode,
        executionMode: entry.mode,
        expectedResult: entry.expectedExitCode === 0 ? 'pass' : 'expected-failure',
        liveSupport,
        profiles: entry.profiles,
        artifactName: entry.artifactName || entry.id,
        prerequisites: {
            requiredEnvVars,
            httpServices,
            requiresPlaywright: entry.requires?.playwright === true,
            injectedEnv: entry.env || {},
        },
        support: {
            deterministic: entry.profiles.includes('deterministic'),
            dryRun: entry.mode === 'dry-run' || entry.profiles.includes('dry'),
            live: liveSupport === 'gated-live',
            remoteBrowser: providerMode === 'rallar-remote-browser',
            artifacts: true,
            replayArtifacts: entry.profiles.includes('traffic') || entry.id.includes('traffic'),
        },
        commands: toCommandSnippets(entry),
        uiHints: {
            badges: toBadges(entry),
            recommendedSurface: liveSupport === 'gated-live'
                ? 'live-runbook'
                : 'recipe-catalog',
        },
    };
}

export function toBlackBoxRunnerRecipeCatalog(
    matrix: BlackBoxRunnerRecipeMatrix,
): BlackBoxRunnerRecipeCatalog {
    return {
        version: 1,
        generatedFrom: 'recipe-matrix',
        entries: matrix.entries.map(toBlackBoxRunnerRecipeCatalogEntry),
    };
}

export const BLACK_BOX_RUNNER_COMMAND_CENTER_FIXTURE_CATALOG: BlackBoxRunnerRecipeCatalog = {
    version: 1,
    generatedFrom: 'static-fixture',
    entries: [
        toBlackBoxRunnerRecipeCatalogEntry({
            id: 'memory-delivery',
            recipe: 'examples/rtc-rallar-memory-delivery-semantics.json',
            category: 'generic-runner-semantics',
            mode: 'run',
            profiles: ['quick', 'deterministic'],
            expectedExitCode: 0,
            artifactName: 'memory-delivery',
            description: 'Deterministic in-memory direct and broadcast delivery smoke.',
        }),
        toBlackBoxRunnerRecipeCatalogEntry({
            id: 'memory-same-connection-soak',
            recipe: 'examples/rtc-rallar-memory-same-connection-soak.json',
            category: 'generic-runner-semantics',
            mode: 'run',
            profiles: ['deterministic', 'soak'],
            expectedExitCode: 0,
            artifactName: 'memory-same-connection-soak',
            description: 'Same-connection deterministic RTC soak with bounded artifacts.',
        }),
        toBlackBoxRunnerRecipeCatalogEntry({
            id: 'memory-seeded-traffic',
            recipe: 'examples/rtc-rallar-memory-seeded-traffic.json',
            category: 'generic-runner-semantics',
            mode: 'run',
            profiles: ['deterministic', 'traffic'],
            expectedExitCode: 0,
            artifactName: 'memory-seeded-traffic',
            description: 'Seeded weighted RTC traffic with expanded-plan replay artifacts.',
        }),
        toBlackBoxRunnerRecipeCatalogEntry({
            id: 'memory-parallel-groups',
            recipe: 'examples/rtc-rallar-memory-parallel-groups.json',
            category: 'generic-runner-semantics',
            mode: 'run',
            profiles: ['deterministic', 'parallel'],
            expectedExitCode: 0,
            artifactName: 'memory-parallel-groups',
            description: 'Bounded parallel RTC groups for direct, broadcast, close, and reconnect behavior.',
        }),
        toBlackBoxRunnerRecipeCatalogEntry({
            id: 'rallar-server-auth-group-ws-smoke-live',
            recipe: 'examples/rallar-server-auth-group-ws-smoke.json',
            category: 'rallar-server',
            mode: 'run',
            profiles: ['rallar-server-live', 'live'],
            expectedExitCode: 0,
            artifactName: 'rallar-server-auth-group-ws-smoke-live',
            description: 'Live Rallar Server auth, group setup, presence, and authenticated WS smoke.',
            requires: {
                env: ['RALLAR_API_BASE_URL'],
                httpServices: [
                    {
                        name: 'Rallar API',
                        env: 'RALLAR_API_BASE_URL',
                        default: 'http://localhost:8080',
                    },
                ],
            },
        }),
        toBlackBoxRunnerRecipeCatalogEntry({
            id: 'browser-messages-rtc-same-connection-soak-live',
            recipe: 'examples/rtc-rallar-browser-messages-rtc-same-connection-soak.json',
            category: 'rallar-browser',
            mode: 'run',
            profiles: ['live-soak', 'browser-live', 'live'],
            expectedExitCode: 0,
            artifactName: 'browser-messages-rtc-same-connection-soak-live',
            description: 'Gated live browser-backed messages.rtc same-connection soak.',
            requires: {
                env: [
                    'RALLAR_API_BASE_URL',
                    'RALLAR_ALICE_USERNAME',
                    'RALLAR_ALICE_PASSWORD',
                    'RALLAR_BOB_USERNAME',
                    'RALLAR_BOB_PASSWORD',
                ],
                httpServices: [
                    {
                        name: 'Rallar API',
                        env: 'RALLAR_API_BASE_URL',
                        default: 'http://localhost:8080',
                    },
                ],
                playwright: true,
            },
        }),
        toBlackBoxRunnerRecipeCatalogEntry({
            id: 'browser-messages-rtc-seeded-traffic-live',
            recipe: 'examples/rtc-rallar-browser-messages-rtc-seeded-traffic.json',
            category: 'rallar-browser',
            mode: 'run',
            profiles: ['live-traffic', 'browser-live', 'live'],
            expectedExitCode: 0,
            artifactName: 'browser-messages-rtc-seeded-traffic-live',
            description: 'Gated live browser-backed seeded messages.rtc traffic with expanded-plan artifacts.',
            requires: {
                env: [
                    'RALLAR_API_BASE_URL',
                    'RALLAR_ALICE_USERNAME',
                    'RALLAR_ALICE_PASSWORD',
                    'RALLAR_BOB_USERNAME',
                    'RALLAR_BOB_PASSWORD',
                ],
                httpServices: [
                    {
                        name: 'Rallar API',
                        env: 'RALLAR_API_BASE_URL',
                        default: 'http://localhost:8080',
                    },
                ],
                playwright: true,
            },
        }),
        toBlackBoxRunnerRecipeCatalogEntry({
            id: 'browser-messages-rtc-parallel-groups-live',
            recipe: 'examples/rtc-rallar-browser-messages-rtc-parallel-groups.json',
            category: 'rallar-browser',
            mode: 'run',
            profiles: ['live-parallel', 'browser-live', 'live'],
            expectedExitCode: 0,
            artifactName: 'browser-messages-rtc-parallel-groups-live',
            description: 'Gated live browser-backed bounded parallel messages.rtc traffic.',
            requires: {
                env: [
                    'RALLAR_API_BASE_URL',
                    'RALLAR_ALICE_USERNAME',
                    'RALLAR_ALICE_PASSWORD',
                    'RALLAR_BOB_USERNAME',
                    'RALLAR_BOB_PASSWORD',
                ],
                httpServices: [
                    {
                        name: 'Rallar API',
                        env: 'RALLAR_API_BASE_URL',
                        default: 'http://localhost:8080',
                    },
                ],
                playwright: true,
            },
        }),
    ],
};
