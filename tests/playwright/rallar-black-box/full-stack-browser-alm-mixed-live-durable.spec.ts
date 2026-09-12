import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
    MixedClientCleanupFailure,
    MixedDurablePayload,
    MixedLivePayload,
    MixedReceiverProgress
} from './browser-alm-mixed-live-durable-client.ts';
import {
    classifyMixedLiveDurableSends,
    evaluateMixedLiveDurableCoverage,
    evaluateMixedLiveDurableExecutionBoundary,
    readAdmittedMixedLiveDurableIds,
    type MixedLiveDurableCoverage,
    type MixedLiveDurableExecutionBoundary
} from './browser-alm-mixed-live-durable-coverage.ts';
import type {
    MixedLiveDurableObservationSnapshot,
    MixedLiveDurableTerminalIdentity
} from './browser-alm-mixed-live-durable-observer.ts';
import {
    expectFullStackApiReady,
    FULL_STACK_SPA_ORIGIN,
    readFullStackConfig,
    uniqueSuffix,
    type FullStackUser
} from './full-stack-helpers.ts';

const config = readFullStackConfig();
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const rallarModuleUrl = `/@fs${path.join(repoRoot, 'packages/shared-web/browser/rallar.ts')}`;
const observerModuleUrl = `/@fs${
    path.join(
        repoRoot,
        'tests/playwright/rallar-black-box/browser-alm-mixed-live-durable-observer.ts'
    )
}`;
const clientModuleUrl = `/@fs${
    path.join(
        repoRoot,
        'tests/playwright/rallar-black-box/browser-alm-mixed-live-durable-client.ts'
    )
}`;

const CORRECTNESS_DEADLINE_MS = 30_000;
const DURABLE_BURST_COUNT = 64;
const LIVE_SEQUENCE_COUNT = 24;
const OVERLAP_PROBE_SEQUENCES = new Set([0, 7, 15, 23]);
const DURABLE_TOPIC_ID = 'room.mixed-durable';
const DURABLE_TYPE_ID = 'room.mixed-durable.v1';
const LIVE_LANE_ID = 'realtime';
const EXPECTED_DATABASE_NAME = 'ar-eye-hunter-al-runtime';
const CLEANUP_FAILURE_CAPACITY = 20;

interface MixedClient {
    readonly role: 'a' | 'b' | 'c';
    readonly context: BrowserContext;
    readonly page: Page;
    sessionId: string | null;
}

interface MixedReadiness {
    readonly role: MixedClient['role'];
    readonly status: string;
    readonly readyPeerCount: number;
}

interface MixedDurableSend {
    readonly logicalIdentity: string;
    readonly msgId: string;
    readonly status: string;
    readonly entryCount: number;
}

interface MixedDurableDisposition {
    readonly offeredCount: number;
    readonly admittedCount: number;
    readonly refusedCount: number;
    readonly unexpectedCount: number;
}

interface MixedLiveSendSummary {
    readonly acceptedCount: number;
    readonly finalSequence: number;
}

interface MixedReconnectSummary {
    readonly sessionIdBefore: string;
    readonly sessionIdAfter: string;
    readonly refreshContainedRoom: boolean;
    readonly laneStatus: string;
    readonly readyPeerCount: number;
    readonly sendStatus: string;
}

interface MixedScenarioEvidence {
    readonly roomId: string | null;
    readonly clients: readonly Pick<MixedClient, 'role' | 'sessionId'>[];
    readonly readiness: readonly MixedReadiness[];
    readonly durableSends: readonly MixedDurableSend[];
    readonly durableDisposition: MixedDurableDisposition | null;
    readonly liveSend: MixedLiveSendSummary | null;
    readonly reconnect: MixedReconnectSummary | null;
    readonly receiverProgress: MixedReceiverProgress | null;
    readonly terminalIdentities: readonly MixedLiveDurableTerminalIdentity[];
}

interface MixedScenarioFailure {
    readonly stage: string;
    readonly name: string;
}

interface MixedScenarioCleanupFailure {
    readonly role: MixedClient['role'];
    readonly stage: MixedClientCleanupFailure['stage'] | 'client-cleanup-call' | 'context-close';
    readonly name: string;
}

interface MixedScenarioArtifact {
    readonly schema: 'rallar.browser-alm-mixed-live-durable-proof.v2';
    readonly executionBoundary: MixedLiveDurableExecutionBoundary;
    readonly sources: {
        readonly runtime: { readonly identity: string; readonly verification: 'operator-supplied-unverified'; };
        readonly instrumentation: { readonly identity: string; readonly verification: 'operator-supplied-unverified'; };
    };
    readonly environment: {
        readonly nodeVersion: string;
        readonly platform: string;
        readonly architecture: string;
        readonly apiMode: string;
        readonly workerCount: number;
        readonly workerIndex: number;
    };
    readonly workload: {
        readonly durableBurstCount: number;
        readonly liveSequenceCount: number;
        readonly overlapProbeSequences: readonly number[];
        readonly correctnessDeadlineMs: number;
        readonly durableTypeId: string;
        readonly liveLaneId: string;
        readonly liveCadence: 'one browser animation frame before each send';
        readonly durableProofReceiverRole: 'b';
        readonly reconnectingNonProofReceiverRole: 'c';
    };
    readonly failure: MixedScenarioFailure | null;
    readonly cleanupFailures: readonly MixedScenarioCleanupFailure[];
    readonly droppedCleanupFailureCount: number;
    readonly evidence: MixedScenarioEvidence;
    readonly observations: Readonly<Record<MixedClient['role'], MixedLiveDurableObservationSnapshot | null>>;
    readonly coverage: MixedLiveDurableCoverage;
}

test.describe('browser ALM mixed live and durable progress', () => {
    test.skip(!config.enabled, config.skipReason);

    test('keeps latest-value room traffic moving while durable RTC completes across reconnect', async ({
        browser,
        request
    }, testInfo) => {
        test.setTimeout(180_000);
        const executionBoundary = evaluateMixedLiveDurableExecutionBoundary({
            apiMode: process.env.RALLAR_BLACK_BOX_API_MODE,
            nodeVersion: process.version,
            apiBaseUrl: config.apiBaseUrl,
            spaBaseUrl: FULL_STACK_SPA_ORIGIN,
            workerCount: testInfo.config.workers,
            runtimeSource: process.env.RALLAR_ALM_MIXED_RUNTIME_SOURCE,
            instrumentationSource: process.env.RALLAR_ALM_MIXED_INSTRUMENTATION_SOURCE
        });
        test.skip(
            executionBoundary.verdict === 'failed',
            `Mixed proof requires explicit local memory source boundary: ${executionBoundary.reasons.join(', ')}`
        );
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const durableLogicalIdentities = Array.from(
            { length: DURABLE_BURST_COUNT },
            (_, index) => `durable-${String(index).padStart(3, '0')}`
        );
        const clients: MixedClient[] = [];
        let scenario = emptyScenarioEvidence(clients);
        const observations: Record<MixedClient['role'], MixedLiveDurableObservationSnapshot | null> = {
            a: null,
            b: null,
            c: null
        };
        const cleanupFailures: MixedScenarioCleanupFailure[] = [];
        let droppedCleanupFailureCount = 0;
        let stage = 'connect-clients';
        let failure: MixedScenarioFailure | null = null;

        try {
            await createMixedClients(browser, clients);
            await connectMixedClients(clients, suffix);
            scenario = emptyScenarioEvidence(clients);
            stage = 'create-room';
            const roomId = await createRoom(clients[0].page, suffix);
            scenario.roomId = roomId;
            stage = 'join-and-subscribe';
            await Promise.all([
                joinReceiver(clients[1].page, roomId),
                joinRoom(clients[2].page, roomId)
            ]);
            stage = 'wait-for-lane-readiness';
            scenario.readiness.push(...await Promise.all(clients.map((client) => waitForLane(client, roomId))));
            stage = 'start-concurrent-workload';
            const durableSendsPromise = sendDurableBurst(
                clients[0].page,
                roomId,
                durableLogicalIdentities
            );
            const liveSendPromise = sendLiveSequence(clients[0].page, roomId);
            const reconnectPromise = reconnectAndSend(clients[2].page, roomId);
            scenario.durableSends.push(...await durableSendsPromise);
            scenario.durableDisposition = classifyMixedLiveDurableSends(scenario.durableSends);
            await markReceiverDurableIdentities(
                clients[1].page,
                scenario.durableSends.map((send) => send.msgId)
            );
            [scenario.liveSend, scenario.reconnect] = await Promise.all([
                liveSendPromise,
                reconnectPromise
            ]);
            stage = 'wait-for-public-progress';
            scenario.receiverProgress = await waitForReceiverProgress(
                clients[1].page,
                readAdmittedMixedLiveDurableIds(scenario.durableSends)
            );
            stage = 'stop-native-measurement';
            await Promise.all(clients.map((client) => stopNativeMeasurement(client.page)));
            stage = 'terminal-readback';
            scenario.terminalIdentities.push(
                ...await waitForTerminalReadback(
                    clients[1].page,
                    scenario.durableDisposition.admittedCount
                )
            );
        }
        catch (error) {
            failure = { stage, name: error instanceof Error ? error.name : 'UnknownFailure' };
        }
        finally {
            const cleanup = await disposeMixedClients(clients);
            Object.assign(observations, cleanup.observations);
            for (const cleanupFailure of cleanup.failures) {
                if (cleanupFailures.length < CLEANUP_FAILURE_CAPACITY) {
                    cleanupFailures.push(cleanupFailure);
                }
                else {
                    droppedCleanupFailureCount += 1;
                }
            }
        }

        const coverage = evaluateMixedLiveDurableCoverage({
            expectedDurableSendCount: DURABLE_BURST_COUNT,
            expectedLatestLiveSequence: LIVE_SEQUENCE_COUNT - 1,
            expectedDatabaseName: EXPECTED_DATABASE_NAME,
            scenarioFailure: failure,
            cleanupFailureCount: cleanupFailures.length + droppedCleanupFailureCount,
            readiness: scenario.readiness,
            durableSends: scenario.durableSends,
            durableDisposition: scenario.durableDisposition,
            liveAcceptedCount: scenario.liveSend?.acceptedCount ?? null,
            reconnect: scenario.reconnect,
            receiverProgress: scenario.receiverProgress,
            terminalIdentities: scenario.terminalIdentities,
            receiverObservation: observations.b,
            observations
        });
        const artifact: MixedScenarioArtifact = {
            schema: 'rallar.browser-alm-mixed-live-durable-proof.v2',
            executionBoundary,
            sources: {
                runtime: {
                    identity: executionBoundary.runtimeSource,
                    verification: executionBoundary.sourceVerification
                },
                instrumentation: {
                    identity: executionBoundary.instrumentationSource,
                    verification: executionBoundary.sourceVerification
                }
            },
            environment: {
                nodeVersion: process.version,
                platform: process.platform,
                architecture: process.arch,
                apiMode: executionBoundary.apiMode,
                workerCount: executionBoundary.workerCount,
                workerIndex: testInfo.workerIndex
            },
            workload: {
                durableBurstCount: DURABLE_BURST_COUNT,
                liveSequenceCount: LIVE_SEQUENCE_COUNT,
                overlapProbeSequences: [...OVERLAP_PROBE_SEQUENCES],
                correctnessDeadlineMs: CORRECTNESS_DEADLINE_MS,
                durableTypeId: DURABLE_TYPE_ID,
                liveLaneId: LIVE_LANE_ID,
                liveCadence: 'one browser animation frame before each send',
                durableProofReceiverRole: 'b',
                reconnectingNonProofReceiverRole: 'c'
            },
            failure,
            cleanupFailures,
            droppedCleanupFailureCount,
            evidence: scenario,
            observations,
            coverage
        };
        const artifactPath = await writeUniqueArtifact(artifact, testInfo);
        await testInfo.attach('browser-alm-mixed-live-durable-proof.json', {
            body: JSON.stringify(artifact, null, 2),
            contentType: 'application/json'
        });

        expect(coverage, `payload-free bounded coverage evidence: ${artifactPath}`).toEqual({
            verdict: 'passed',
            reasons: []
        });
    });
});

async function createMixedClients(
    browser: Browser,
    clients: MixedClient[]
): Promise<void> {
    const roles = ['a', 'b', 'c'] as const;
    for (const role of roles) {
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            clients.push({ role, context, page, sessionId: null });
        }
        catch {
            await context.close();
            throw new Error(`Failed to create mixed client page for role ${role}`);
        }
    }
}

async function connectMixedClients(clients: readonly MixedClient[], suffix: string): Promise<void> {
    const users = [config.userA, config.userB, config.userC];
    for (const [index, client] of clients.entries()) {
        client.sessionId = await connectClient(
            client.page,
            uniqueRegisteredUser(users[index], `mixed-${client.role}`, suffix)
        );
    }
}

async function connectClient(
    page: Page,
    user: FullStackUser
): Promise<string> {
    await page.goto('/');
    return await page.evaluate(async (input) => {
        const fixture: typeof import('./browser-alm-mixed-live-durable-observer.ts') = await import(input.observerUrl);
        const observation = fixture.installBrowserMixedLiveDurableObservation(
            input.durableTypeId,
            []
        );
        const rallarModule: typeof import('../../../packages/shared-web/browser/rallar.ts') = await import(
            input.rallarUrl
        );
        const { rallar } = rallarModule;
        rallar.configure({ apiBaseUrl: input.apiBaseUrl });
        rallar.setDefaults({
            applicationId: input.applicationId,
            workspaceId: input.workspaceId,
            diagnosticsPorts: observation.diagnosticsPorts()
        });
        const authenticated = await rallar.auth.registerAndLogin({
            username: input.username,
            password: input.password,
            displayName: input.displayName
        }, { timeoutMs: input.timeoutMs, maxAttempts: 3 });
        observation.setBrowserSessionId(authenticated.sessionId);
        await rallar.connect({ timeoutMs: input.timeoutMs, maxAttempts: 3 });
        const ws = await rallar.ws.waitForOpen({ timeoutMs: input.timeoutMs });
        if (ws.status !== 'open') {
            throw new Error(`Expected WebSocket open, received ${ws.status}`);
        }
        return authenticated.sessionId;
    }, {
        observerUrl: observerModuleUrl,
        rallarUrl: rallarModuleUrl,
        apiBaseUrl: config.apiBaseUrl,
        applicationId: config.applicationId,
        workspaceId: config.workspaceId,
        durableTypeId: DURABLE_TYPE_ID,
        username: user.username,
        password: user.password,
        displayName: user.actor,
        timeoutMs: CORRECTNESS_DEADLINE_MS
    });
}

async function createRoom(page: Page, suffix: string): Promise<string> {
    return await page.evaluate(async (input) => {
        const rallarModule: typeof import('../../../packages/shared-web/browser/rallar.ts') = await import(
            input.rallarUrl
        );
        const { rallar } = rallarModule;
        const snapshot = await rallar.rooms.create({
            displayName: `Mixed live durable ${input.suffix}`,
            joinMode: 'open',
            timeoutMs: input.timeoutMs,
            maxAttempts: 3
        });
        return snapshot.group.groupId;
    }, { rallarUrl: rallarModuleUrl, suffix, timeoutMs: CORRECTNESS_DEADLINE_MS });
}

async function joinReceiver(page: Page, roomId: string): Promise<void> {
    await page.evaluate(async (input) => {
        const client: typeof import('./browser-alm-mixed-live-durable-client.ts') = await import(input.clientUrl);
        await client.installMixedLiveDurableReceiver(input);
    }, {
        clientUrl: clientModuleUrl,
        roomId,
        durableTopicId: DURABLE_TOPIC_ID,
        durableTypeId: DURABLE_TYPE_ID,
        liveLaneId: LIVE_LANE_ID,
        timeoutMs: CORRECTNESS_DEADLINE_MS
    });
}

async function joinRoom(page: Page, roomId: string): Promise<void> {
    await page.evaluate(async (input) => {
        const rallarModule: typeof import('../../../packages/shared-web/browser/rallar.ts') = await import(
            input.rallarUrl
        );
        const { rallar } = rallarModule;
        await rallar.rooms.join(input.roomId, { timeoutMs: input.timeoutMs, maxAttempts: 3 });
    }, { rallarUrl: rallarModuleUrl, roomId, timeoutMs: CORRECTNESS_DEADLINE_MS });
}

async function waitForLane(client: MixedClient, roomId: string): Promise<MixedReadiness> {
    const readiness = await client.page.evaluate(async (input) => {
        const rallarModule: typeof import('../../../packages/shared-web/browser/rallar.ts') = await import(
            input.rallarUrl
        );
        const { rallar } = rallarModule;
        await rallar.rooms.refresh({ timeoutMs: input.timeoutMs });
        const result = await rallar.rooms.session(input.roomId).realtime(input.laneId).wait({
            timeoutMs: input.timeoutMs,
            minReadyPeers: 2
        });
        return { status: result.rtc.state, readyPeerCount: result.rtc.activePeerIds.length };
    }, {
        rallarUrl: rallarModuleUrl,
        roomId,
        laneId: LIVE_LANE_ID,
        timeoutMs: CORRECTNESS_DEADLINE_MS
    });
    return { role: client.role, ...readiness };
}

async function sendDurableBurst(
    page: Page,
    roomId: string,
    logicalIdentities: readonly string[]
): Promise<readonly MixedDurableSend[]> {
    return await page.evaluate(async (input) => {
        const rallarModule: typeof import('../../../packages/shared-web/browser/rallar.ts') = await import(
            input.rallarUrl
        );
        const { rallar } = rallarModule;
        const channel = rallar.rooms.session(input.roomId).message<MixedDurablePayload>({
            topicId: input.topicId,
            typeId: input.typeId
        });
        return await Promise.all(input.logicalIdentities.map(async (logicalIdentity) => {
            const result = await channel.sendRtc({ identity: logicalIdentity, sentAtEpochMs: Date.now() }, {
                ttlMs: input.timeoutMs
            });
            return {
                logicalIdentity,
                msgId: result.message.id.msgId,
                status: result.status,
                entryCount: result.entries.length
            };
        }));
    }, {
        rallarUrl: rallarModuleUrl,
        roomId,
        topicId: DURABLE_TOPIC_ID,
        typeId: DURABLE_TYPE_ID,
        logicalIdentities,
        timeoutMs: CORRECTNESS_DEADLINE_MS
    });
}

async function markReceiverDurableIdentities(page: Page, identities: readonly string[]): Promise<void> {
    await page.evaluate(async (input) => {
        const fixture: typeof import('./browser-alm-mixed-live-durable-observer.ts') = await import(input.observerUrl);
        fixture.readMixedLiveDurableObservation().addMarkedDurableIdentities(input.identities);
    }, { observerUrl: observerModuleUrl, identities });
}

async function sendLiveSequence(page: Page, roomId: string): Promise<MixedLiveSendSummary> {
    return await page.evaluate(async (input) => {
        const rallarModule: typeof import('../../../packages/shared-web/browser/rallar.ts') = await import(
            input.rallarUrl
        );
        const { rallar } = rallarModule;
        const room = rallar.rooms.session(input.roomId);
        const channel = room.realtime<MixedLivePayload>(input.laneId);
        let acceptedCount = 0;
        for (let sequence = 0; sequence < input.sequenceCount; sequence += 1) {
            await new Promise<number>((resolve) => requestAnimationFrame(resolve));
            const sent = await channel.send({
                identity: `live-${sequence}`,
                sequence,
                sentAtEpochMs: Date.now(),
                probeOverlap: input.overlapSequences.includes(sequence),
                roomRef: room.roomRef
            }, { openTimeoutMs: input.timeoutMs });
            if (sent.status === 'sent' || sent.status === 'partial') {
                acceptedCount += 1;
            }
        }
        return { acceptedCount, finalSequence: input.sequenceCount - 1 };
    }, {
        rallarUrl: rallarModuleUrl,
        roomId,
        laneId: LIVE_LANE_ID,
        sequenceCount: LIVE_SEQUENCE_COUNT,
        overlapSequences: [...OVERLAP_PROBE_SEQUENCES],
        timeoutMs: CORRECTNESS_DEADLINE_MS
    });
}

async function reconnectAndSend(page: Page, roomId: string): Promise<MixedReconnectSummary> {
    return await page.evaluate(async (input) => {
        const rallarModule: typeof import('../../../packages/shared-web/browser/rallar.ts') = await import(
            input.rallarUrl
        );
        const { rallar } = rallarModule;
        const sessionIdBefore = rallar.session()?.sessionId ?? '';
        await rallar.disconnect();
        await rallar.connect({ timeoutMs: input.timeoutMs, maxAttempts: 3 });
        await rallar.ws.waitForOpen({ timeoutMs: input.timeoutMs });
        const refreshed = await rallar.rooms.refresh({ timeoutMs: input.timeoutMs });
        const room = await rallar.rooms.enter(input.roomId, { timeoutMs: input.timeoutMs, maxAttempts: 3 });
        const ready = await room.realtime<MixedLivePayload>(input.laneId).wait({
            timeoutMs: input.timeoutMs,
            minReadyPeers: 1
        });
        const sent = await room.realtime<MixedLivePayload>(input.laneId).send({
            identity: 'post-reconnect',
            sequence: input.postReconnectSequence,
            sentAtEpochMs: Date.now(),
            probeOverlap: false,
            roomRef: room.roomRef
        }, { openTimeoutMs: input.timeoutMs });
        return {
            sessionIdBefore,
            sessionIdAfter: rallar.session()?.sessionId ?? '',
            refreshContainedRoom: refreshed.rooms.some((candidate) => candidate.roomId === input.roomId),
            laneStatus: ready.rtc.state,
            readyPeerCount: ready.rtc.activePeerIds.length,
            sendStatus: sent.status
        };
    }, {
        rallarUrl: rallarModuleUrl,
        roomId,
        laneId: LIVE_LANE_ID,
        postReconnectSequence: LIVE_SEQUENCE_COUNT,
        timeoutMs: CORRECTNESS_DEADLINE_MS
    });
}

async function waitForReceiverProgress(
    page: Page,
    durableMessageIds: readonly string[]
): Promise<MixedReceiverProgress> {
    await expect.poll(async () => {
        const progress = await readReceiverProgress(page);
        return {
            allDurable: durableMessageIds.every((identity) => progress.durableMessageIds.includes(identity)),
            latestLive: progress.liveSequences.includes(LIVE_SEQUENCE_COUNT - 1),
            postReconnect: progress.postReconnectReceived
        };
    }, { timeout: CORRECTNESS_DEADLINE_MS }).toEqual({
        allDurable: true,
        latestLive: true,
        postReconnect: true
    });
    return await readReceiverProgress(page);
}

async function readReceiverProgress(page: Page): Promise<MixedReceiverProgress> {
    return await page.evaluate(async (clientUrl) => {
        const client: typeof import('./browser-alm-mixed-live-durable-client.ts') = await import(clientUrl);
        return client.readMixedLiveDurableReceiverProgress();
    }, clientModuleUrl);
}

async function stopNativeMeasurement(page: Page): Promise<void> {
    await page.evaluate(async (observerUrl) => {
        const fixture: typeof import('./browser-alm-mixed-live-durable-observer.ts') = await import(observerUrl);
        fixture.readMixedLiveDurableObservation().stopNativeMeasurement();
    }, observerModuleUrl);
}

async function waitForTerminalReadback(
    page: Page,
    completedIdentityCount: number
): Promise<readonly MixedLiveDurableTerminalIdentity[]> {
    await expect.poll(async () => {
        const terminal = await readTerminalIdentities(page);
        return terminal.filter((identity) => identity.completed).length;
    }, { timeout: CORRECTNESS_DEADLINE_MS }).toBe(completedIdentityCount);
    return await readTerminalIdentities(page);
}

async function readTerminalIdentities(page: Page): Promise<readonly MixedLiveDurableTerminalIdentity[]> {
    return await page.evaluate(async (observerUrl) => {
        const fixture: typeof import('./browser-alm-mixed-live-durable-observer.ts') = await import(observerUrl);
        return await fixture.readMixedLiveDurableObservation().readTerminalIdentities();
    }, observerModuleUrl);
}

async function disposeMixedClients(clients: readonly MixedClient[]): Promise<
    Readonly<{
        observations: Record<MixedClient['role'], MixedLiveDurableObservationSnapshot | null>;
        failures: readonly MixedScenarioCleanupFailure[];
    }>
> {
    const observations: Record<MixedClient['role'], MixedLiveDurableObservationSnapshot | null> = {
        a: null,
        b: null,
        c: null
    };
    const failures: MixedScenarioCleanupFailure[] = [];
    await Promise.all(clients.map(async (client) => {
        const cleanup = await disposeMixedClient(client);
        observations[client.role] = cleanup.observation;
        failures.push(...cleanup.failures);
    }));
    return { observations, failures };
}

async function disposeMixedClient(client: MixedClient): Promise<
    Readonly<{
        observation: MixedLiveDurableObservationSnapshot | null;
        failures: readonly MixedScenarioCleanupFailure[];
    }>
> {
    let observation: MixedLiveDurableObservationSnapshot | null = null;
    const failures: MixedScenarioCleanupFailure[] = [];
    try {
        const cleanup = await client.page.evaluate(async (clientUrl) => {
            const module: typeof import('./browser-alm-mixed-live-durable-client.ts') = await import(clientUrl);
            return await module.disposeMixedLiveDurableClient();
        }, clientModuleUrl);
        observation = cleanup.observation;
        failures.push(...cleanup.failures.map((failure) => ({ role: client.role, ...failure })));
    }
    catch (error) {
        failures.push({
            role: client.role,
            stage: 'client-cleanup-call',
            name: error instanceof Error ? error.name : 'UnknownFailure'
        });
    }
    try {
        await client.context.close();
    }
    catch (error) {
        failures.push({
            role: client.role,
            stage: 'context-close',
            name: error instanceof Error ? error.name : 'UnknownFailure'
        });
    }
    return { observation, failures };
}

function emptyScenarioEvidence(clients: readonly MixedClient[]): MutableMixedScenarioEvidence {
    return {
        roomId: null,
        clients: clients.map(({ role, sessionId }) => ({ role, sessionId })),
        readiness: [],
        durableSends: [],
        durableDisposition: null,
        liveSend: null,
        reconnect: null,
        receiverProgress: null,
        terminalIdentities: []
    };
}

interface MutableMixedScenarioEvidence {
    roomId: string | null;
    readonly clients: Pick<MixedClient, 'role' | 'sessionId'>[];
    readonly readiness: MixedReadiness[];
    readonly durableSends: MixedDurableSend[];
    durableDisposition: MixedDurableDisposition | null;
    liveSend: MixedLiveSendSummary | null;
    reconnect: MixedReconnectSummary | null;
    receiverProgress: MixedReceiverProgress | null;
    readonly terminalIdentities: MixedLiveDurableTerminalIdentity[];
}

async function writeUniqueArtifact(artifact: MixedScenarioArtifact, testInfo: TestInfo): Promise<string> {
    const directory = path.resolve('tmp/perf/alm-mixed-live-durable');
    const fileName = `${
        new Date().toISOString().replace(/[:.]/g, '')
    }-${testInfo.workerIndex}-${crypto.randomUUID()}.json`;
    const artifactPath = path.join(directory, fileName);
    await mkdir(directory, { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return artifactPath;
}

function uniqueRegisteredUser(base: FullStackUser, label: string, suffix: string): FullStackUser {
    const id = `${label}-${suffix}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
    return { username: id, password: base.password, clientId: id, actor: id };
}
