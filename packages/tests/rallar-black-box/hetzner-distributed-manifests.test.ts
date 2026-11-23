import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';

import { decodeStringLeaves } from '@shared-test/rallar-bb-test/browser/browser-command-placeholders.ts';
import { computeDistributedRunTerminalTimeoutSeconds } from '@shared-test/rallar-bb-test/distributed-recipe-targeting/compute-distributed-run-terminal-timeout-seconds.ts';
import { decodeDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRtcConnectCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { createHetznerDistributedManifestCatalog } from '../../../apps/rallar-black-box/src/create-hetzner-distributed-manifest-catalog.ts';
import { distributedRecipePreflight } from '../../../apps/rallar-black-box/src/distributed-recipes.ts';
import {
    HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER,
    HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER
} from '../../../apps/rallar-black-box/src/hetzner/hetzner-manifest-entry.ts';
import { createWorldFleetDistributedManifestCatalog } from '../../../apps/rallar-black-box/src/world-fleet-distributed-manifests.ts';
import { toHetznerManifestCommands, toHetznerRecipeCommands } from './hetzner-manifest-test-commands.ts';

interface ExpectedStream {
    readonly rateHz: number;
    readonly intervalMs: number;
    readonly durationSeconds: number;
    readonly frameCount: number;
    readonly maxDroppedFrames: number;
    readonly maxP95SendDurationMs?: number;
    readonly maxP99SendDurationMs?: number;
    readonly minSendSuccessRatio: number;
    readonly maxInFlight: number;
}

const repoRoot = path.resolve(__dirname, '../../..');

// Every multi-agent Hetzner manifest must carry the standard barrier so agents start synchronized;
// only these two are exempt, because neither drives RTC traffic between peers. A new manifest
// without a barrier fails this test until it is either given one or added here deliberately.
const BARRIER_EXEMPT_MANIFEST_PATHS: ReadonlySet<string> = new Set([
    'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/02-composite-evidence-2-agent.json'
]);

// The terminal wait the hosted runner workflow, the dispatch script and the controller script fall back to when a
// manifest recommends none.
const HOSTED_DEFAULT_TERMINAL_TIMEOUT_SECONDS = 300;

// The ALM conformance entries keep their recorded terminal timeouts, which sit far below their worst-case sums
// (15,615 s and 2,247 s): manifest 18's 1,800 s is also each combined root's execution budget, pinned by the hosted
// reload tests, and both stay as recorded until the maintainer rules on them. Nothing else may be short.
const RECORDED_SHORT_TERMINAL_TIMEOUT_PATHS: readonly string[] = [
    'apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/22-alm-conformance-3-agent.json'
];

function toWorstCaseTerminalSeconds(manifest: RallarBlackBoxDistributedRunManifest): number {
    return computeDistributedRunTerminalTimeoutSeconds({
        recipes: manifest.recipes.flatMap((selection) => selection.recipe === undefined ? [] : [selection.recipe]),
        ackTimeoutMs: manifest.ackTimeoutMs,
        barrier: manifest.barrier
    });
}

function toHostedTerminalTimeoutSeconds(manifest: RallarBlackBoxDistributedRunManifest): number {
    const recommended = manifest.metadata.recommendedTerminalTimeoutSeconds;
    return typeof recommended === 'number' ? recommended : HOSTED_DEFAULT_TERMINAL_TIMEOUT_SECONDS;
}

describe('hosted distributed manifest terminal timeouts', () => {
    // Manifest 17's worst case rose to 392 s against the 300 s default; 05b-05e sat 4 to 5 s under it.
    it('covers every hosted manifest\'s worst-case sum by its recommendation or the default', () => {
        const short = [...createHetznerDistributedManifestCatalog(), ...createWorldFleetDistributedManifestCatalog()]
            .filter((entry) => toHostedTerminalTimeoutSeconds(entry.manifest) < toWorstCaseTerminalSeconds(entry.manifest))
            .map((entry) => entry.filePath);

        expect(short).toEqual(RECORDED_SHORT_TERMINAL_TIMEOUT_PATHS);
    });

    // Every entry carries its derived recommendation, so no manifest relies on a default that may be short.
    it('recommends every other Hetzner entry exactly the terminal timeout its budgets add up to', () => {
        for (const entry of createHetznerDistributedManifestCatalog()) {
            if (RECORDED_SHORT_TERMINAL_TIMEOUT_PATHS.includes(entry.filePath)) {
                continue;
            }
            expect(entry.manifest.metadata.recommendedTerminalTimeoutSeconds, entry.filePath)
                .toBe(toWorstCaseTerminalSeconds(entry.manifest));
        }
    });

    it('recommends the rising RTC and group-assertion entries their derived values', () => {
        const recommended = Object.fromEntries(
            createHetznerDistributedManifestCatalog().map((entry) => [
                path.basename(entry.filePath, '.json'),
                entry.manifest.metadata.recommendedTerminalTimeoutSeconds
            ])
        );
        expect(recommended).toMatchObject({
            '01-health-2-agent': 30,
            '03-rtc-smoke-2-agent': 263,
            '05b-rtc-realtime-stability-2-agent-30s': 295,
            '05d-rtc-realtime-stability-2-agent-30s-15hz': 296,
            '17-group-assertions-2-agent': 392,
            '24-view-push-2-agent': 175
        });
    });
});

describe('Hetzner distributed manifest catalog', () => {
    it('defines the mainline green, extended, and diagnostic manifest groups separately', () => {
        const catalog = createHetznerDistributedManifestCatalog();
        const greenPaths = catalog.filter((entry) => entry.mainline).map((entry) => entry.filePath);
        const extendedPaths = catalog.filter((entry) => !entry.mainline && !entry.diagnostic).map((entry) => entry.filePath);
        const diagnosticPaths = catalog.filter((entry) => entry.diagnostic).map((entry) => entry.filePath);

        expect(greenPaths).toEqual(HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER);
        expect(greenPaths).toEqual([
            'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/02-composite-evidence-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json'
        ]);
        expect(extendedPaths).toEqual(HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER);
        expect(extendedPaths).toEqual([
            'apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json',
            'apps/rallar-black-box/manifests/hetzner/05b-rtc-realtime-stability-2-agent-30s.json',
            'apps/rallar-black-box/manifests/hetzner/05c-rtc-realtime-stability-2-agent-30s-10hz.json',
            'apps/rallar-black-box/manifests/hetzner/05d-rtc-realtime-stability-2-agent-30s-15hz.json',
            'apps/rallar-black-box/manifests/hetzner/05e-rtc-realtime-stability-2-agent-30s-20hz.json',
            'apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json',
            'apps/rallar-black-box/manifests/hetzner/07-rtc-messages-principal-50-agent-30s-20hz-tree.json',
            'apps/rallar-black-box/manifests/hetzner/08-rtc-messages-principal-50-agent-30s-20hz-mesh.json',
            'apps/rallar-black-box/manifests/hetzner/09-rtc-messages-all-peer-50-agent-30s-5hz-tree.json',
            'apps/rallar-black-box/manifests/hetzner/10-rtc-messages-principal-15-agent-30s-20hz-tree.json',
            'apps/rallar-black-box/manifests/hetzner/11-rtc-messages-principal-15-agent-30s-20hz-mesh.json',
            'apps/rallar-black-box/manifests/hetzner/12-rtc-messages-all-peer-15-agent-30s-5hz-tree.json',
            'apps/rallar-black-box/manifests/hetzner/13-rtc-messages-principal-30-agent-30s-20hz-tree.json',
            'apps/rallar-black-box/manifests/hetzner/14-rtc-messages-principal-30-agent-30s-20hz-mesh.json',
            'apps/rallar-black-box/manifests/hetzner/15-rtc-messages-all-peer-30-agent-30s-5hz-tree.json',
            'apps/rallar-black-box/manifests/hetzner/16-rtc-absence-wait-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/17-group-assertions-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json',
            'apps/rallar-black-box/manifests/hetzner/20-alm-conformance-30-agent-30s.json',
            'apps/rallar-black-box/manifests/hetzner/21-alm-conformance-50-agent-30s.json',
            'apps/rallar-black-box/manifests/hetzner/22-alm-conformance-3-agent.json',
            'apps/rallar-black-box/manifests/hetzner/23-rtc-messages-principal-15-agent-78m-2hz-tree.json',
            'apps/rallar-black-box/manifests/hetzner/24-view-push-2-agent.json'
        ]);
        expect(diagnosticPaths.filter((filePath) => !filePath.includes('/matrix/'))).toEqual([
            'apps/rallar-black-box/manifests/hetzner/diagnostic/alm-conformance-6-agent-30s.json',
            'apps/rallar-black-box/manifests/hetzner/diagnostic/alm-conformance-11-agent-30s.json',
            'apps/rallar-black-box/manifests/hetzner/diagnostic/barrier-health-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/diagnostic/expected-failure-1-agent.json',
            'apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-realtime-2-agent-20hz-stress.json',
            'apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-all-peer-50-agent-30s-20hz-tree.json',
            'apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-principal-50-agent-60m-20hz-tree.json',
            'apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-all-peer-50-agent-60m-5hz-tree.json',
            'apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-all-peer-50-agent-60m-10hz-tree.json',
            'apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-all-peer-50-agent-60m-20hz-tree.json'
        ]);
    });

    it('writes checked-in JSON that matches the generated catalog exactly', async () => {
        for (const entry of createHetznerDistributedManifestCatalog()) {
            const expectedJson = `${JSON.stringify(entry.manifest, null, 2)}\n`;
            const actualJson = await readFile(path.join(repoRoot, entry.filePath), 'utf8');
            expect(actualJson).toBe(expectedJson);
        }
    });

    it('validates every checked-in manifest against schema and contract', async () => {
        for (const entry of createHetznerDistributedManifestCatalog()) {
            const decoded = decodeDistributedRunManifest(
                JSON.parse(await readFile(path.join(repoRoot, entry.filePath), 'utf8'))
            );
            expect(decoded.left, entry.filePath).toBeUndefined();
            const manifest = decoded.right;
            if (manifest === undefined) {
                throw new Error(`Expected a valid checked-in manifest: ${entry.filePath}`);
            }
            expect(manifest.group).toEqual({
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'hetzner-headless-room'
            });
            if (
                entry.filePath.endsWith('/05e-rtc-realtime-stability-2-agent-30s-20hz.json') ||
                entry.filePath.endsWith('/18-alm-conformance-2-agent.json')
            ) {
                expect(manifest.targetPolicy).toMatchObject({
                    mode: 'role-map',
                    expectedParticipantCount: entry.agentCount,
                    roles: {
                        sender: ['controller-01'],
                        receiver: ['controller-02']
                    }
                });
                expect(manifest.roleAssignments).toEqual([
                    { role: 'sender', agentId: 'controller-01', recipeIds: [], variables: {} },
                    { role: 'receiver', agentId: 'controller-02', recipeIds: [], variables: {} }
                ]);
                expect(manifest.recipes.map((selection) => selection.role)).toEqual(['sender', 'receiver']);
            }
            else if (entry.filePath.endsWith('/22-alm-conformance-3-agent.json')) {
                expect(manifest.targetPolicy).toMatchObject({
                    mode: 'role-map',
                    expectedParticipantCount: 3,
                    roles: { sender: ['controller-01'], receiver: ['controller-02'], 'recipient-b': ['controller-03'] }
                });
                expect(manifest.recipes.map((selection) => selection.role)).toEqual([
                    'sender',
                    'receiver',
                    'recipient-b'
                ]);
            }
            else if (
                entry.filePath.includes('rtc-messages-principal-') ||
                (entry.filePath.includes('alm-conformance') && entry.agentCount > 2)
            ) {
                const receivers = Array.from(
                    { length: entry.agentCount - 1 },
                    (_, index) => `controller-${String(index + 2).padStart(2, '0')}`
                );

                expect(manifest.targetPolicy).toMatchObject({
                    mode: 'role-map',
                    expectedParticipantCount: entry.agentCount,
                    roles: {
                        sender: ['controller-01'],
                        receiver: receivers
                    }
                });
                expect(manifest.roleAssignments).toHaveLength(entry.agentCount);
                expect(manifest.roleAssignments.at(0)).toEqual({
                    role: 'sender',
                    agentId: 'controller-01',
                    recipeIds: [],
                    variables: {}
                });
                expect(manifest.roleAssignments.slice(1).map((assignment) => assignment.agentId)).toEqual(receivers);
                expect(manifest.recipes.map((selection) => selection.role)).toEqual(['sender', 'receiver']);
            }
            else {
                expect(manifest.targetPolicy).toMatchObject({
                    mode: 'all-online-group-members',
                    expectedParticipantCount: entry.agentCount
                });
            }
            expect(manifest.recipes.length).toBeGreaterThan(0);
            expect(manifest.recipes.every((selection) => Boolean(selection.recipe))).toBe(true);
        }
    });

    it('names the Hetzner manifest catalog as the creator of every manifest', () => {
        expect(new Set(createHetznerDistributedManifestCatalog().map((entry) => entry.manifest.metadata.createdBy)))
            .toEqual(new Set(['rallar-black-box-hetzner-manifest-catalog']));
    });

    it('keeps mainline green manifests secret-free and marks the expected-failure diagnostic only', () => {
        const catalog = createHetznerDistributedManifestCatalog();
        const greenEntries = catalog.filter((entry) => entry.mainline);
        const expectedFailure = catalog.find((entry) => entry.filePath.endsWith('/expected-failure-1-agent.json'));

        expect(expectedFailure?.manifest.metadata).toMatchObject({
            diagnostic: true,
            expectedFailure: true
        });
        expect(greenEntries.every((entry) => entry.manifest.metadata?.expectedFailure !== true)).toBe(true);

        for (const entry of catalog) {
            const strings = decodeStringLeaves(entry.manifest);
            expect(strings.some((value) => /bearer|password|secret|token/i.test(value)), entry.filePath).toBe(false);
        }
    });

    it('matches expected participant counts in filenames', () => {
        for (const entry of createHetznerDistributedManifestCatalog()) {
            const match = entry.filePath.match(/-(\d+)-agent/);
            expect(match?.[1], entry.filePath).toBe(String(entry.agentCount));
            expect(entry.manifest.targetPolicy.expectedParticipantCount).toBe(entry.agentCount);
        }
    });

    it('configures matching selectors for every messages.rtc connection', () => {
        // The alm-conformance family intentionally connects messages.rtc with its own per-scenario
        // typeId and the room.alm-conformance topic, not the shared multicast-position selector.
        for (const entry of createHetznerDistributedManifestCatalog()) {
            if (['alm-conformance', 'alm-scale'].includes(String(entry.manifest.metadata?.family))) {
                continue;
            }
            for (const command of toHetznerManifestCommands(entry.manifest)) {
                if (command.kind !== 'rtc.connect' || command.transport !== 'messages.rtc') {
                    continue;
                }

                expect(command.rallar, entry.filePath).toMatchObject({
                    typeId: 'black-box.group.multicast.position',
                    topicId: 'black-box.group.multicast.position'
                });
            }
        }
    });

    it('bounds every room-joining connect by the SDK timeout it names, twice for the connect and the join', () => {
        // The ALM conformance connects keep their harness budgets, so only the other families are held to this rule.
        const checked = createHetznerDistributedManifestCatalog()
            .filter((entry) => entry.manifest.metadata.family !== 'alm-conformance')
            .flatMap((entry) =>
                toHetznerManifestCommands(entry.manifest)
                    .filter((command): command is RallarBlackBoxTestRtcConnectCommand => command.kind === 'rtc.connect' && command.roomId !== undefined)
                    .map((connect) => ({ filePath: entry.filePath, connect }))
            );

        expect(checked.length).toBeGreaterThan(0);
        for (const { filePath, connect } of checked) {
            const sdkTimeoutMs = connect.rallar?.timeoutMs;
            expect(sdkTimeoutMs, `${filePath} ${connect.commandId}`).toEqual(expect.any(Number));
            expect(connect.timeoutMs, `${filePath} ${connect.commandId}`).toBe(2 * Number(sdkTimeoutMs) + 5_000);
        }
    });

    it('gives the live RTC smoke, parity, realtime and room-proof connects the establishment SDK timeout', () => {
        const paths = [
            'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json',
            'apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json',
            'apps/rallar-black-box/manifests/hetzner/05b-rtc-realtime-stability-2-agent-30s.json',
            'apps/rallar-black-box/manifests/hetzner/05c-rtc-realtime-stability-2-agent-30s-10hz.json',
            'apps/rallar-black-box/manifests/hetzner/05d-rtc-realtime-stability-2-agent-30s-15hz.json',
            'apps/rallar-black-box/manifests/hetzner/05e-rtc-realtime-stability-2-agent-30s-20hz.json',
            'apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json',
            'apps/rallar-black-box/manifests/hetzner/16-rtc-absence-wait-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/17-group-assertions-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-realtime-2-agent-20hz-stress.json'
        ];
        const connects = createHetznerDistributedManifestCatalog()
            .filter((entry) => paths.includes(entry.filePath))
            .flatMap((entry) =>
                toHetznerManifestCommands(entry.manifest)
                    .filter((command) => command.kind === 'rtc.connect')
                    .map((connect) => ({ filePath: entry.filePath, connect }))
            );

        expect(new Set(connects.map(({ filePath }) => filePath))).toEqual(new Set(paths));
        for (const { filePath, connect } of connects) {
            // 65 s for the SDK connect, 65 s for the join and the 5 s margin; readiness stays 10 s after it.
            expect(connect, filePath).toMatchObject({
                timeoutMs: 135_000,
                rallar: { timeoutMs: 65_000 },
                readiness: { timeoutMs: 10_000 }
            });
        }
    });

    it('requires explicit RTC readiness before non-diagnostic live manifests send RTC traffic', () => {
        const expectedReadyPeers = new Map([
            ['apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json', { peers: 1, timeoutMs: 10_000 }],
            ['apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json', {
                peers: 1,
                timeoutMs: 10_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json', {
                peers: 1,
                timeoutMs: 10_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json', {
                peers: 1,
                timeoutMs: 10_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/05b-rtc-realtime-stability-2-agent-30s.json', {
                peers: 1,
                timeoutMs: 10_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/05c-rtc-realtime-stability-2-agent-30s-10hz.json', {
                peers: 1,
                timeoutMs: 10_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/05d-rtc-realtime-stability-2-agent-30s-15hz.json', {
                peers: 1,
                timeoutMs: 10_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/05e-rtc-realtime-stability-2-agent-30s-20hz.json', {
                peers: 1,
                timeoutMs: 10_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json', {
                peers: 2,
                timeoutMs: 10_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/07-rtc-messages-principal-50-agent-30s-20hz-tree.json', {
                peers: 1,
                timeoutMs: 45_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/08-rtc-messages-principal-50-agent-30s-20hz-mesh.json', {
                peers: 1,
                timeoutMs: 45_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/09-rtc-messages-all-peer-50-agent-30s-5hz-tree.json', {
                peers: 1,
                timeoutMs: 45_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/10-rtc-messages-principal-15-agent-30s-20hz-tree.json', {
                peers: 1,
                timeoutMs: 45_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/11-rtc-messages-principal-15-agent-30s-20hz-mesh.json', {
                peers: 1,
                timeoutMs: 45_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/12-rtc-messages-all-peer-15-agent-30s-5hz-tree.json', {
                peers: 1,
                timeoutMs: 45_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/13-rtc-messages-principal-30-agent-30s-20hz-tree.json', {
                peers: 1,
                timeoutMs: 45_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/14-rtc-messages-principal-30-agent-30s-20hz-mesh.json', {
                peers: 1,
                timeoutMs: 45_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/15-rtc-messages-all-peer-30-agent-30s-5hz-tree.json', {
                peers: 1,
                timeoutMs: 45_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/16-rtc-absence-wait-2-agent.json', {
                peers: 1,
                timeoutMs: 10_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/17-group-assertions-2-agent.json', {
                peers: 1,
                timeoutMs: 10_000
            }],
            ['apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json', {
                peers: 1,
                timeoutMs: 54_750
            }],
            ['apps/rallar-black-box/manifests/hetzner/20-alm-conformance-30-agent-30s.json', {
                peers: 1,
                timeoutMs: 64_500
            }],
            ['apps/rallar-black-box/manifests/hetzner/21-alm-conformance-50-agent-30s.json', {
                peers: 1,
                timeoutMs: 77_500
            }],
            ['apps/rallar-black-box/manifests/hetzner/23-rtc-messages-principal-15-agent-78m-2hz-tree.json', {
                peers: 1,
                timeoutMs: 45_000
            }]
        ]);

        for (const entry of createHetznerDistributedManifestCatalog().filter((candidate) => !candidate.diagnostic)) {
            const sendsRtc = (command: RallarBlackBoxTestCommand) =>
                command.kind === 'rtc.send' || command.kind === 'rtc.stream' ||
                (entry.manifest.metadata.family === 'alm-scale' && command.kind === 'messages.send');
            if (!toHetznerManifestCommands(entry.manifest).some(sendsRtc)) {
                expect(expectedReadyPeers.has(entry.filePath)).toBe(false);
                continue;
            }

            const declared = toHetznerManifestCommands(entry.manifest)
                .filter((command) => command.kind === 'rtc.connect')
                .find((command) => command.readiness !== undefined);
            const expected = expectedReadyPeers.get(entry.filePath);
            expect(declared?.readiness, entry.filePath).toEqual({
                minReadyPeers: expected?.peers,
                timeoutMs: expected?.timeoutMs,
                intervalMs: 100
            });
            // A connect that declares no readiness, like a director connecting before any peer exists,
            // must still wait for a ready formation before its recipe's first RTC send.
            for (const selection of entry.manifest.recipes) {
                const commands = toHetznerRecipeCommands(selection.recipe?.commands ?? []);
                const connect = commands.filter((command) => command.kind === 'rtc.connect').at(0);
                if (connect === undefined || connect.readiness !== undefined) {
                    continue;
                }
                const firstSend = commands.findIndex(sendsRtc);
                const gated = commands.slice(commands.indexOf(connect), firstSend < 0 ? commands.length : firstSend)
                    .some((command) => command.kind === 'formation.readiness');
                expect(gated, `${entry.filePath} ${selection.recipeId}`).toBe(true);
            }
        }
    });

    it('synchronizes every multi-agent Hetzner recipe before execution', () => {
        const checkedPaths: string[] = [];

        for (const entry of createHetznerDistributedManifestCatalog()) {
            if (entry.agentCount < 2 || BARRIER_EXEMPT_MANIFEST_PATHS.has(entry.filePath)) {
                continue;
            }
            checkedPaths.push(entry.filePath);

            expect(entry.manifest.barrier, entry.filePath).toEqual({
                enabled: true,
                timeoutMs: 15_000
            });
        }

        expect(checkedPaths.length).toBeGreaterThan(0);
        expect(
            [...BARRIER_EXEMPT_MANIFEST_PATHS].filter(
                (exemptPath) =>
                    !createHetznerDistributedManifestCatalog().some(
                        (entry) => entry.filePath === exemptPath
                    )
            )
        ).toEqual([]);
    });

    it('keeps readiness-enabled recipes resolvable to exact rooms', () => {
        const checkedPaths: string[] = [];

        for (const entry of createHetznerDistributedManifestCatalog()) {
            for (const selection of entry.manifest.recipes) {
                const recipe = selection.recipe;
                if (
                    !recipe ||
                    !toHetznerManifestCommands(entry.manifest).some((command) => command.kind === 'rtc.connect' && command.readiness)
                ) {
                    continue;
                }

                checkedPaths.push(entry.filePath);
                expect(
                    distributedRecipePreflight(recipe).warnings.filter((warning) =>
                        warning.includes('cannot point-refresh room state without an exact room reference')
                    ),
                    entry.filePath
                ).toEqual([]);
            }
        }

        expect(checkedPaths).toContain(
            'apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json'
        );
    });

    it('uses lower-rate rtc.stream baselines for non-diagnostic realtime Hetzner manifests', () => {
        const expectedStreams = new Map<string, ExpectedStream>([
            ['apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json', {
                rateHz: 5,
                intervalMs: 200,
                durationSeconds: 5,
                frameCount: 25,
                maxDroppedFrames: 2,
                minSendSuccessRatio: 0.95,
                maxInFlight: 8
            }],
            ['apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json', {
                rateHz: 10,
                intervalMs: 100,
                durationSeconds: 5,
                frameCount: 50,
                maxDroppedFrames: 5,
                minSendSuccessRatio: 0.99,
                maxInFlight: 64
            }],
            ['apps/rallar-black-box/manifests/hetzner/05b-rtc-realtime-stability-2-agent-30s.json', {
                rateHz: 5,
                intervalMs: 200,
                durationSeconds: 30,
                frameCount: 150,
                maxDroppedFrames: 2,
                minSendSuccessRatio: 0.95,
                maxInFlight: 8
            }],
            ['apps/rallar-black-box/manifests/hetzner/05c-rtc-realtime-stability-2-agent-30s-10hz.json', {
                rateHz: 10,
                intervalMs: 100,
                durationSeconds: 30,
                frameCount: 300,
                maxDroppedFrames: 15,
                maxP95SendDurationMs: 200,
                maxP99SendDurationMs: 1000,
                minSendSuccessRatio: 0.95,
                maxInFlight: 64
            }],
            ['apps/rallar-black-box/manifests/hetzner/05d-rtc-realtime-stability-2-agent-30s-15hz.json', {
                rateHz: 15,
                intervalMs: 67,
                durationSeconds: 30,
                frameCount: 450,
                maxDroppedFrames: 22,
                maxP95SendDurationMs: 200,
                maxP99SendDurationMs: 1000,
                minSendSuccessRatio: 0.95,
                maxInFlight: 64
            }],
            ['apps/rallar-black-box/manifests/hetzner/05e-rtc-realtime-stability-2-agent-30s-20hz.json', {
                rateHz: 20,
                intervalMs: 50,
                durationSeconds: 30,
                frameCount: 600,
                maxDroppedFrames: 30,
                maxP95SendDurationMs: 2500,
                maxP99SendDurationMs: 4000,
                minSendSuccessRatio: 0.95,
                maxInFlight: 64
            }],
            ['apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json', {
                rateHz: 10,
                intervalMs: 100,
                durationSeconds: 15,
                frameCount: 150,
                maxDroppedFrames: 15,
                minSendSuccessRatio: 0.99,
                maxInFlight: 64
            }]
        ]);

        for (
            const entry of createHetznerDistributedManifestCatalog()
                .filter((candidate) =>
                    !candidate.diagnostic &&
                    !candidate.filePath.includes('rtc-messages-') &&
                    !candidate.filePath.includes('alm-conformance')
                )
        ) {
            const commands = toHetznerManifestCommands(entry.manifest);
            const stream = commands.find((command) => command.kind === 'rtc.stream');
            const highRateLoop = commands.find((command) =>
                command.kind === 'loop' &&
                typeof command.count === 'number' &&
                command.count >= 20 &&
                typeof command.intervalMs === 'number' &&
                command.intervalMs <= 100 &&
                (command.commands ?? []).some((child) => child.kind === 'rtc.send')
            );

            if (!expectedStreams.has(entry.filePath)) {
                expect(stream, entry.filePath).toBeUndefined();
                continue;
            }

            const expectedStream = expectedStreams.get(entry.filePath)!;
            const expectedThresholds: Record<string, number> = {
                minSendSuccessRatio: expectedStream.minSendSuccessRatio,
                maxDroppedFrames: expectedStream.maxDroppedFrames
            };
            if (expectedStream.maxP95SendDurationMs !== undefined) {
                expectedThresholds.maxP95SendDurationMs = expectedStream.maxP95SendDurationMs;
            }
            if (expectedStream.maxP99SendDurationMs !== undefined) {
                expectedThresholds.maxP99SendDurationMs = expectedStream.maxP99SendDurationMs;
            }

            expect(stream, entry.filePath).toMatchObject({
                kind: 'rtc.stream',
                commandId: 'rtc-realtime-position-stream',
                continueOnSendFailure: true,
                count: expectedStream.frameCount,
                intervalMs: expectedStream.intervalMs,
                maxInFlight: expectedStream.maxInFlight,
                thresholds: expectedThresholds,
                metadata: {
                    realtime: {
                        rateHz: expectedStream.rateHz,
                        durationSeconds: expectedStream.durationSeconds,
                        frameCount: expectedStream.frameCount
                    }
                }
            });
            expect(highRateLoop, entry.filePath).toBeUndefined();
        }
    });

    it('keeps strict 20 Hz realtime stress coverage as a diagnostic manifest', () => {
        const entry = createHetznerDistributedManifestCatalog()
            .find((candidate) => candidate.filePath.endsWith('/diagnostic/rtc-realtime-2-agent-20hz-stress.json'));
        expect(entry).toBeDefined();
        if (entry === undefined) {
            throw new Error('Expected catalog entry.');
        }
        expect(entry?.diagnostic).toBe(true);
        expect(HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER).not.toContain(entry?.filePath);
        expect(entry?.manifest.metadata).toMatchObject({
            diagnostic: true,
            stress: true,
            expectedFailure: false
        });

        const stream = toHetznerManifestCommands(entry.manifest)
            .find((command) => command.kind === 'rtc.stream');
        expect(stream).toMatchObject({
            count: 100,
            intervalMs: 50,
            continueOnSendFailure: true,
            thresholds: {
                minSendSuccessRatio: 0.99,
                maxDroppedFrames: 20
            },
            metadata: {
                realtime: {
                    rateHz: 20,
                    frameCount: 100
                }
            }
        });
    });

    it('keeps the lower-risk realtime stability manifest in mainline before heavier extended baselines', () => {
        const catalog = createHetznerDistributedManifestCatalog();
        const stabilityPath = 'apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json';
        const baselinePath = 'apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json';
        const stability = catalog.find((entry) => entry.filePath === stabilityPath);

        expect(stability).toBeDefined();
        expect(stability?.mainline).toBe(true);
        expect(stability?.diagnostic).toBe(false);
        expect(stability?.agentCount).toBe(2);
        expect(HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER.at(-1)).toBe(stabilityPath);
        expect(HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[0]).toBe(baselinePath);
        expect(stability?.manifest.metadata).toMatchObject({
            manifestSuite: 'hetzner-distributed',
            diagnostic: false,
            expectedFailure: false
        });
        expect(stability?.manifest.recipes[0]).toMatchObject({
            recipeId: 'rtc-realtime-stability',
            profile: 'rtc'
        });
    });

    it('keeps provider parity manifests from replacing headless auth with restore-only demo auth', () => {
        const catalog = createHetznerDistributedManifestCatalog();
        const parity = catalog.find((entry) => entry.filePath === 'apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json');
        const configure = parity?.manifest.recipes[0]?.recipe?.commands[0];

        expect(parity).toBeDefined();
        expect(configure).toMatchObject({ kind: 'configure' });
        if (!configure || configure.kind !== 'configure') {
            throw new Error('Expected provider parity manifest to start with configure.');
        }

        const rallar = configure.config.rallar;
        expect(rallar).not.toMatchObject({ username: expect.any(String) });
        expect(rallar).not.toMatchObject({ password: expect.any(String) });
        expect(rallar).not.toMatchObject({ token: expect.any(String) });
        expect(rallar).not.toMatchObject({ restoreSession: true });
        expect(JSON.stringify(parity?.manifest)).toContain('{rtc.readyPeerIds[0]}');
        expect(JSON.stringify(parity?.manifest)).toContain('{rtc.readyPeerIds}');
        expect(JSON.stringify(parity?.manifest)).not.toContain('bob-session');
        expect(JSON.stringify(parity?.manifest)).not.toContain('charlie-session');
        expect(parity?.manifest.recipes[0]?.recipe?.commands.find((command) => command.kind === 'rtc.connect'))
            .toMatchObject({
                timeoutMs: 135_000,
                rallar: { sessionId: 'alice-session', timeoutMs: 65_000 },
                readiness: { timeoutMs: 10_000 }
            });
    });

    it('keeps provider parity peers alive through the readiness window before teardown', () => {
        const parity = createHetznerDistributedManifestCatalog().find((entry) =>
            entry.filePath === 'apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json'
        );
        const commands = parity?.manifest.recipes[0]?.recipe?.commands;
        const connectIndex = commands?.findIndex((command) => command.kind === 'rtc.connect') ?? -1;
        const holdIndex = commands?.findIndex((command) => command.commandId === 'parity-peer-overlap-hold') ?? -1;
        const closeIndex = commands?.findIndex((command) => command.kind === 'close') ?? -1;
        const resetIndex = commands?.findIndex((command) => command.kind === 'reset') ?? -1;
        const connect = commands?.at(connectIndex);
        const hold = commands?.at(holdIndex);

        expect(parity?.manifest.targetPolicy.mode).toBe('all-online-group-members');
        expect(parity?.manifest.recipes).toHaveLength(1);
        expect(parity?.manifest.recipes[0]?.role).toBeUndefined();
        expect(connectIndex).toBeGreaterThanOrEqual(0);
        expect(holdIndex).toBeGreaterThanOrEqual(0);
        expect(closeIndex).toBeGreaterThanOrEqual(0);
        expect(resetIndex).toBeGreaterThanOrEqual(0);
        expect(connectIndex).toBeLessThan(holdIndex);
        expect(holdIndex).toBeLessThan(closeIndex);
        expect(closeIndex).toBeLessThan(resetIndex);
        expect(hold).toMatchObject({
            kind: 'loop',
            durationMs: 12_000,
            intervalMs: 1_000,
            maxCommands: 12,
            commands: [
                {
                    kind: 'health',
                    commandId: 'parity-peer-overlap-health'
                }
            ]
        });
        expect(hold?.kind === 'loop' ? hold.durationMs : undefined).toBeGreaterThanOrEqual(
            (connect?.kind === 'rtc.connect' ? connect.readiness?.timeoutMs ?? 0 : 0) + 2_000
        );
    });
});
