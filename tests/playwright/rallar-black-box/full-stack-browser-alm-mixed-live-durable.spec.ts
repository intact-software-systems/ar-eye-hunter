import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
    MixedLiveDurableObservationSnapshot,
    MixedLiveDurableTerminalIdentity
} from './browser-alm-mixed-live-durable-observer.ts';
import {
    expectFullStackApiReady,
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

const CORRECTNESS_DEADLINE_MS = 30_000;
const DURABLE_BURST_COUNT = 64;
const LIVE_SEQUENCE_COUNT = 24;
const OVERLAP_PROBE_SEQUENCES = new Set([0, 7, 15, 23]);
const DURABLE_TOPIC_ID = 'room.mixed-durable';
const DURABLE_TYPE_ID = 'room.mixed-durable.v1';
const LIVE_LANE_ID = 'realtime';
const RUNTIME_SOURCE_COMMIT = '4c5435b3f95cf48287f39076eeff56b02fabe239';

interface MixedClient {
    readonly role: 'a' | 'b' | 'c';
    readonly context: BrowserContext;
    readonly page: Page;
    readonly sessionId: string;
}

interface MixedLivePayload {
    readonly identity: string;
    readonly sequence: number;
    readonly sentAtEpochMs: number;
    readonly probeOverlap: boolean;
    readonly roomRef: {
        readonly applicationId: string;
        readonly workspaceId: string;
        readonly groupId: string;
    };
}

interface MixedDurablePayload {
    readonly identity: string;
    readonly sentAtEpochMs: number;
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

interface MixedReceiverProgress {
    readonly durableMessageIds: readonly string[];
    readonly liveSequences: readonly number[];
    readonly postReconnectReceived: boolean;
}

interface MixedReceiverState {
    readonly durableMessageIds: string[];
    readonly liveSequences: number[];
    readPostReconnectReceived(): boolean;
    unsubscribe(): void;
}

declare global {
    interface Window {
        __rallarMixedReceiver?: MixedReceiverState;
    }
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

interface MixedScenarioArtifact {
    readonly schema: 'rallar.browser-alm-mixed-live-durable-proof.v1';
    readonly runtimeSourceCommit: string;
    readonly instrumentationSource: string;
    readonly environment: {
        readonly nodeVersion: string;
        readonly platform: string;
        readonly architecture: string;
        readonly apiMode: 'memory';
        readonly workerCount: 1;
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
    readonly evidence: MixedScenarioEvidence;
    readonly observations: Readonly<Record<MixedClient['role'], MixedLiveDurableObservationSnapshot | null>>;
}

test.describe('browser ALM mixed live and durable progress', () => {
    test.skip(!config.enabled, config.skipReason);

    test('keeps latest-value room traffic moving while durable RTC completes across reconnect', async ({
        browser,
        request
    }, testInfo) => {
        test.setTimeout(180_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const durableLogicalIdentities = Array.from(
            { length: DURABLE_BURST_COUNT },
            (_, index) => `durable-${String(index).padStart(3, '0')}`
        );
        let clients: readonly MixedClient[] = [];
        let scenario = emptyScenarioEvidence(clients);
        const observations: Record<MixedClient['role'], MixedLiveDurableObservationSnapshot | null> = {
            a: null,
            b: null,
            c: null
        };
        let stage = 'connect-clients';
        let failure: MixedScenarioFailure | null = null;

        try {
            clients = await createMixedClients(browser, suffix, observations);
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
            scenario.durableDisposition = classifyDurableSends(scenario.durableSends);
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
                admittedDurableIds(scenario.durableSends)
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
            await Promise.all(clients.map(async (client) => {
                observations[client.role] = await disposeClient(client.page);
                await client.context.close();
            }));
        }

        const artifact: MixedScenarioArtifact = {
            schema: 'rallar.browser-alm-mixed-live-durable-proof.v1',
            runtimeSourceCommit: RUNTIME_SOURCE_COMMIT,
            instrumentationSource: process.env.RALLAR_ALM_MIXED_INSTRUMENTATION_SOURCE ?? 'working-tree',
            environment: {
                nodeVersion: process.version,
                platform: process.platform,
                architecture: process.arch,
                apiMode: 'memory',
                workerCount: 1
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
            evidence: scenario,
            observations
        };
        const artifactPath = await writeUniqueArtifact(artifact, testInfo);
        await testInfo.attach('browser-alm-mixed-live-durable-proof.json', {
            body: JSON.stringify(artifact, null, 2),
            contentType: 'application/json'
        });

        expect(failure, `payload-free failure evidence: ${artifactPath}`).toBeNull();
        assertMixedScenarioCoverage(artifact, artifactPath);
    });
});

async function createMixedClients(
    browser: Browser,
    suffix: string,
    observations: Record<MixedClient['role'], MixedLiveDurableObservationSnapshot | null>
): Promise<readonly MixedClient[]> {
    const roles = ['a', 'b', 'c'] as const;
    const users = [config.userA, config.userB, config.userC];
    const clients: MixedClient[] = [];
    for (const [index, role] of roles.entries()) {
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
            const sessionId = await connectClient(
                page,
                uniqueRegisteredUser(users[index], `mixed-${role}`, suffix)
            );
            clients.push({ role, context, page, sessionId });
        }
        catch (error) {
            observations[role] = await disposeClient(page);
            await context.close();
            await Promise.all(clients.map(async (client) => {
                observations[client.role] = await disposeClient(client.page);
                await client.context.close();
            }));
            throw error;
        }
    }
    return clients;
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
        const fixture: typeof import('./browser-alm-mixed-live-durable-observer.ts') = await import(input.observerUrl);
        const observation = fixture.readMixedLiveDurableObservation();
        const rallarModule: typeof import('../../../packages/shared-web/browser/rallar.ts') = await import(
            input.rallarUrl
        );
        const { rallar } = rallarModule;
        await rallar.rooms.join(input.roomId, { timeoutMs: input.timeoutMs, maxAttempts: 3 });
        const room = rallar.rooms.session(input.roomId);
        const durableMessageIds: string[] = [];
        const liveSequences: number[] = [];
        let postReconnectReceived = false;
        const durable = room.message<MixedDurablePayload>({
            topicId: input.durableTopicId,
            typeId: input.durableTypeId
        });
        const realtime = room.realtime<MixedLivePayload>(input.liveLaneId);
        const unsubscribeDurable = durable.onRtc((payload, message) => {
            const target = message.raw.targets;
            if (
                target === undefined ||
                target.mode !== 'multicast' ||
                target.groupRef.applicationId !== room.roomRef.applicationId ||
                target.groupRef.workspaceId !== room.roomRef.workspaceId ||
                target.groupRef.groupId !== room.roomRef.groupId
            ) {
                return;
            }
            durableMessageIds.push(message.raw.id.msgId);
            observation.observeDurableCallback({
                identity: message.raw.id.msgId,
                sentAtEpochMs: payload.sentAtEpochMs,
                receivedAtEpochMs: message.receivedAtEpochMs
            });
        });
        const unsubscribeLive = realtime.on(async (message) => {
            const sourceRoom = message.data.roomRef;
            if (
                sourceRoom.applicationId !== room.roomRef.applicationId ||
                sourceRoom.workspaceId !== room.roomRef.workspaceId ||
                sourceRoom.groupId !== room.roomRef.groupId
            ) {
                return;
            }
            liveSequences.push(message.data.sequence);
            postReconnectReceived ||= message.data.identity === 'post-reconnect';
            await observation.observeLiveMessage({
                identity: message.data.identity,
                sequence: message.data.sequence,
                sentAtEpochMs: message.data.sentAtEpochMs,
                receivedAtEpochMs: message.receivedAtEpochMs,
                markedForOverlap: message.data.probeOverlap
            });
        });
        window.__rallarMixedReceiver = {
            durableMessageIds,
            liveSequences,
            readPostReconnectReceived: () => postReconnectReceived,
            unsubscribe: () => {
                unsubscribeDurable();
                unsubscribeLive();
            }
        };
    }, {
        observerUrl: observerModuleUrl,
        rallarUrl: rallarModuleUrl,
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
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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
    return await page.evaluate(() => {
        const receiver = window.__rallarMixedReceiver;
        if (receiver === undefined) {
            throw new Error('Mixed live/durable receiver subscription is missing');
        }
        return {
            durableMessageIds: [...receiver.durableMessageIds],
            liveSequences: [...receiver.liveSequences],
            postReconnectReceived: receiver.readPostReconnectReceived()
        };
    });
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

async function disposeClient(page: Page): Promise<MixedLiveDurableObservationSnapshot | null> {
    return await page.evaluate(async (input) => {
        const receiver = window.__rallarMixedReceiver;
        receiver?.unsubscribe();
        const rallarModule: typeof import('../../../packages/shared-web/browser/rallar.ts') = await import(
            input.rallarUrl
        );
        const { rallar } = rallarModule;
        await rallar.disconnect().catch(() => undefined);
        const fixture: typeof import('./browser-alm-mixed-live-durable-observer.ts') = await import(input.observerUrl);
        return fixture.readMixedLiveDurableObservation().dispose();
    }, { rallarUrl: rallarModuleUrl, observerUrl: observerModuleUrl }).catch(() => null);
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

function assertMixedScenarioCoverage(artifact: MixedScenarioArtifact, artifactPath: string): void {
    const receiver = artifact.observations.b;
    expect(receiver, `receiver observation missing: ${artifactPath}`).not.toBeNull();
    expect(artifact.evidence.readiness.every((ready) => ready.status === 'open' && ready.readyPeerCount > 0)).toBe(
        true
    );
    expect(artifact.evidence.durableSends).toHaveLength(DURABLE_BURST_COUNT);
    expect(artifact.evidence.durableDisposition?.offeredCount).toBe(DURABLE_BURST_COUNT);
    expect(artifact.evidence.durableDisposition?.unexpectedCount).toBe(0);
    expect(artifact.evidence.durableDisposition?.admittedCount).toBeGreaterThan(0);
    expect(artifact.evidence.liveSend?.acceptedCount).toBeGreaterThan(0);
    expect(artifact.evidence.receiverProgress?.liveSequences).toContain(LIVE_SEQUENCE_COUNT - 1);
    expect(artifact.evidence.reconnect).toMatchObject({
        refreshContainedRoom: true,
        laneStatus: 'open',
        sendStatus: 'sent'
    });
    expect(artifact.evidence.receiverProgress?.postReconnectReceived).toBe(true);
    expect(artifact.evidence.terminalIdentities).toHaveLength(DURABLE_BURST_COUNT);
    assertDurableDispositionCoverage(artifact, receiver, artifactPath);
    expect(receiver?.queuePhases.map((phase) => phase.phase)).toEqual(expect.arrayContaining([
        'queue-read',
        'claim-reserved',
        'release-completed'
    ]));
    expect(receiver?.nativeTiming.capturedDatabaseNames).toEqual(['ar-eye-hunter-al-runtime']);
    expect(receiver?.queueHookModuleIdentityObserved).toBe(true);
    expect(receiver?.terminalReadbackCensoredByRowCapacity).toBe(false);
    expect(receiver?.droppedQueuePhaseCount).toBe(0);
    expect(receiver?.droppedLiveObservationCount).toBe(0);
    expect(receiver?.droppedDurableCallbackCount).toBe(0);
    expect(receiver?.droppedMarkedIdentityCount).toBe(0);
    expect(receiver?.droppedReturnedClaimCount).toBe(0);
    expect(receiver?.droppedCompletedIdentityCount).toBe(0);
    for (const role of ['a', 'b', 'c'] as const) {
        const observation = artifact.observations[role];
        expect(observation, `${role} observation missing: ${artifactPath}`).not.toBeNull();
        expect(observation?.methodsRestored).toBe(true);
        expect(observation?.nativeTiming.uncapturedInFlightObservationCount).toBe(0);
    }
}

function classifyDurableSends(sends: readonly MixedDurableSend[]): MixedDurableDisposition {
    const admittedCount = admittedDurableIds(sends).length;
    const refusedCount = sends.filter((send) => send.status === 'rate-limited' && send.entryCount === 0).length;
    return {
        offeredCount: sends.length,
        admittedCount,
        refusedCount,
        unexpectedCount: sends.length - admittedCount - refusedCount
    };
}

function admittedDurableIds(sends: readonly MixedDurableSend[]): readonly string[] {
    return sends
        .filter((send) => ['accepted', 'enqueued'].includes(send.status) && send.entryCount > 0)
        .map((send) => send.msgId);
}

function assertDurableDispositionCoverage(
    artifact: MixedScenarioArtifact,
    receiver: MixedLiveDurableObservationSnapshot | null,
    artifactPath: string
): void {
    const admitted = new Set(admittedDurableIds(artifact.evidence.durableSends));
    const refused = new Set(
        artifact.evidence.durableSends
            .filter((send) => send.status === 'rate-limited' && send.entryCount === 0)
            .map((send) => send.msgId)
    );
    const callbackIds = new Set(receiver?.durableCallbacks.map((callback) => callback.identity));
    const completedReleaseIds = new Set(receiver?.completedDurableIdentities);
    const terminalByIdentity = new Map(
        artifact.evidence.terminalIdentities.map((identity) => [identity.identity, identity])
    );
    expect([...admitted].every((identity) => callbackIds.has(identity)), artifactPath).toBe(true);
    expect([...admitted].every((identity) => completedReleaseIds.has(identity)), artifactPath).toBe(true);
    expect([...admitted].every((identity) => terminalByIdentity.get(identity)?.completed === true), artifactPath)
        .toBe(true);
    expect([...refused].every((identity) => !callbackIds.has(identity)), artifactPath).toBe(true);
    expect([...refused].every((identity) => !completedReleaseIds.has(identity)), artifactPath).toBe(true);
    expect([...refused].every((identity) => terminalByIdentity.get(identity)?.rowCount === 0), artifactPath).toBe(true);
    expect(receiver?.queuePhases.every((phase) => !refused.has(phase.identity)), artifactPath).toBe(true);
    expect(
        receiver?.liveObservations.some((observation) =>
            observation.overlappingReturnedClaimIdentities.some((identity) => admitted.has(identity))
        ),
        artifactPath
    ).toBe(true);
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
