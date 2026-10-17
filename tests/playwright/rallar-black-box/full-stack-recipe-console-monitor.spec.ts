import {
    expect,
    test,
    type APIRequestContext,
    type APIResponse,
    type Page
} from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

import type {
    RecorderJsonlFailure,
    RecorderJsonlRead
} from '@shared-test/black-box-runner/artifacts/read-recorder-jsonl-rows.ts';
import {
    readRtcNativeAcquisition,
    type RtcNativeAcquisitionProof,
    type RtcNativeCapturedConnection
} from '@shared-test/black-box-runner/artifacts/rtc-native-acquisition.ts';
import { toRtcNativeObservationProjection } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/rtc-native-observation-projection.ts';
import { decodeRallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/composite-results.ts';
import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import { decodeDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    decodeJsonValue,
    decodeNonBlankText,
    decodeRecord
} from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { decodeControlDistributedRunArtifactBundle } from '@shared-test/rallar-bb-test/schema/control-artifact-envelope.ts';
import { toRtcCaptureReadout } from '@shared-web/browser/connection/to-rtc-capture-readout.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import {
    evaluateFullStackConfiguredServiceEvidence,
    type FullStackConfiguredServiceProbe
} from '../../../apps/rallar-black-box/playwright-full-stack-api-server.ts';
import {
    cleanupRallarPage,
    decodeFullStackAuthSession,
    expectFullStackApiReady,
    FULL_STACK_SPA_ORIGIN,
    loginUser,
    readControlRun,
    readExhaustivePostgresConfig,
    uniqueGroupId,
    uniqueRunId,
    waitForControlRunAgent
} from './full-stack-helpers.ts';
import { readLiveRtcRecorderRows } from './live-rtc-recorder-reader.ts';

interface OperatorUrlInput {
    readonly actor: string;
    readonly groupId: string;
    readonly controlRunId: string;
    readonly sessionId: string;
}

interface LaunchBrowserAgentsInput {
    readonly controlRunId: string;
    readonly groupId: string;
    readonly prefix: string;
    readonly count: number;
}

interface LaunchedBrowserAgents {
    readonly pages: readonly Page[];
    readonly agentIds: readonly string[];
}

interface ArtifactExpectation {
    readonly distributedRunId: string;
    readonly controlRunId: string;
    readonly groupId: string;
    readonly agentIds: readonly string[];
    readonly recipeId: string;
}

interface ExecuteRecipeExpectation {
    readonly recipeId: string;
    readonly providerMode: string;
    readonly prerequisite: string;
}

interface ConsoleNativeAttachment {
    readonly proof: RtcNativeAcquisitionProof;
    readonly event: ApiJsonObject;
}

const COMPOSITE_RECIPE: ExecuteRecipeExpectation = {
    recipeId: 'composite-evidence-recipe',
    providerMode: 'simulated',
    prerequisite: 'Self-contained'
};

const CONFIGURED_LIVE_SKIP_REASON =
    'Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box available.';
const CONFIGURED_POSTGRES = readExhaustivePostgresConfig();
const CONFIGURED_POSTGRES_MODE = (process.env.RALLAR_BLACK_BOX_API_MODE?.trim() ?? 'postgres') ===
    'postgres';
const CONFIGURED_FRESH_POSTGRES_API = [
    '1',
    'true'
].includes(
    process.env.RALLAR_BLACK_BOX_REQUIRE_FRESH_POSTGRES_API?.trim().toLowerCase() ?? ''
);

test('completes the configured live distributed run lifecycle and exports its artifact', async ({
    page,
    request
}, testInfo) => {
    test.skip(
        !CONFIGURED_POSTGRES.enabled ||
            !CONFIGURED_POSTGRES_MODE ||
            !CONFIGURED_FRESH_POSTGRES_API,
        CONFIGURED_LIVE_SKIP_REASON
    );
    test.skip(
        (await configuredPostgresStackAvailability(request)) === 'unavailable',
        CONFIGURED_LIVE_SKIP_REASON
    );
    test.setTimeout(240_000);
    await expectFullStackApiReady(request, CONFIGURED_POSTGRES);

    const groupId = uniqueGroupId(testInfo);
    const controlRunId = uniqueRunId(testInfo);
    const operatorSessionId = `${controlRunId}-operator-session`;
    const agentPages: Page[] = [];
    let agentIds: readonly string[] = [];
    let failure: Error | undefined;

    try {
        await loginUser({
            page,
            config: CONFIGURED_POSTGRES,
            user: CONFIGURED_POSTGRES.userC,
            groupId,
            sessionId: operatorSessionId,
            tab: 'rallar-server'
        });
        await page.goto(operatorUrl({
            groupId,
            controlRunId,
            sessionId: operatorSessionId,
            actor: CONFIGURED_POSTGRES.userC.actor
        }));
        await expect(page).toHaveURL(/(?:\?|&)provider=browser-rallar(?:&|$)/);

        const launched = await launchBrowserAgentsThroughVisibleControls(page, {
            controlRunId,
            groupId,
            prefix: 'recipe-console-live-agent',
            count: 3
        });
        agentPages.push(...launched.pages);
        agentIds = launched.agentIds;
        await Promise.all(agentIds.map((agentId) => waitForControlRunAgent(request, controlRunId, agentId)));

        await assertLiveExecuteTargets(page, agentIds, COMPOSITE_RECIPE);
        const passedRunId = await createDraftThroughVisibleExecuteControls(page);
        await stageThroughVisibleExecuteControls(page);
        await startThroughVisibleExecuteControls(page);
        await navigateToMonitor(page, passedRunId, 'passed');
        assertSchemaV2Artifact(
            await exportMonitorArtifact(page, passedRunId, testInfo.outputPath('lifecycle-artifact.json')),
            { distributedRunId: passedRunId, controlRunId, groupId, agentIds, recipeId: COMPOSITE_RECIPE.recipeId }
        );

        await page.getByRole('button', { name: 'Execute', exact: true }).click();
        await expect(page.locator('[data-execute-workspace]')).toBeVisible();
        await page.goto(operatorUrl({
            groupId,
            controlRunId,
            sessionId: operatorSessionId,
            actor: CONFIGURED_POSTGRES.userC.actor
        }));
        await expect(page).not.toHaveURL(/(?:\?|&)distributedRunId=/);
        await assertLiveExecuteTargets(page, agentIds, COMPOSITE_RECIPE);
        const cancelledRunId = await createDraftThroughVisibleExecuteControls(page);
        expect(cancelledRunId).not.toBe(passedRunId);
        await stageThroughVisibleExecuteControls(page);
        expect((await readDistributedRun(request, cancelledRunId)).state).toBe(
            'ready'
        );

        await navigateToMonitor(page, cancelledRunId, 'ready');
        const monitorActions = page.getByRole('region', {
            name: 'Monitor actions'
        });
        await monitorActions
            .getByRole('button', { name: 'Arm Cancel', exact: true })
            .click();
        await monitorActions
            .getByRole('button', { name: 'Cancel run', exact: true })
            .click();
        const cancelDialog = page.getByRole('alertdialog', {
            name: 'Cancel distributed run?'
        });
        await expect(cancelDialog).toBeVisible();
        await expect(cancelDialog).toContainText(cancelledRunId);
        await expect(cancelDialog).toContainText('ready');
        await cancelDialog
            .getByRole('button', { name: 'Cancel run', exact: true })
            .click();
        await expect(cancelDialog).toHaveCount(0);
        await expect(
            page.locator('[data-monitor-section="verdict"]')
        ).toHaveAttribute('data-run-state', 'cancelled', { timeout: 30_000 });
        await expectCompletedCancelProof(
            request,
            controlRunId,
            cancelledRunId
        );
    }
    catch (error) {
        failure = toError(error);
        throw failure;
    }
    finally {
        await cleanupConsolePages(page, agentPages, failure);
    }
});

test('applies Console Full native run intent through real browser agents', async ({ page, request }, testInfo) => {
    test.skip(
        !CONFIGURED_POSTGRES.enabled || !CONFIGURED_POSTGRES_MODE || !CONFIGURED_FRESH_POSTGRES_API,
        CONFIGURED_LIVE_SKIP_REASON
    );
    test.skip(
        (await configuredPostgresStackAvailability(request)) === 'unavailable',
        CONFIGURED_LIVE_SKIP_REASON
    );
    test.setTimeout(240_000);
    await expectFullStackApiReady(request, CONFIGURED_POSTGRES);
    const groupId = uniqueGroupId(testInfo);
    const controlRunId = uniqueRunId(testInfo);
    const operatorSessionId = `${controlRunId}-operator-session`;
    const agentPages: Page[] = [];
    let failure: Error | undefined;
    try {
        await loginUser({
            page,
            config: CONFIGURED_POSTGRES,
            user: CONFIGURED_POSTGRES.userB,
            groupId,
            sessionId: operatorSessionId,
            tab: 'rallar-server'
        });
        await page.goto(
            operatorUrl({ groupId, controlRunId, sessionId: operatorSessionId, actor: CONFIGURED_POSTGRES.userB.actor })
        );
        await page.locator('[data-execute-recipe][data-recipe-id="rtc-realtime-stability"]').click();
        const launched = await launchBrowserAgentsThroughVisibleControls(page, {
            controlRunId,
            groupId,
            prefix: 'console-native-agent',
            count: 2
        });
        agentPages.push(...launched.pages);
        const agentIds = launched.agentIds;
        await Promise.all(agentIds.map((agentId) => waitForControlRunAgent(request, controlRunId, agentId)));
        await assertLiveExecuteTargets(page, agentIds, {
            recipeId: 'rtc-realtime-stability',
            providerMode: 'browser-rallar',
            prerequisite: 'Live services'
        });
        const issued = await Promise.all(agentPages.map(async (agentPage, index) => {
            await expect(agentPage).toHaveURL(/(?:\?|&)rallarAuthStorage=session(?:&|$)/);
            const session = decodeFullStackAuthSession(
                await agentPage.evaluate(() => JSON.parse(sessionStorage.getItem('auth.session') ?? 'null'))
            );
            return { agentId: agentIds[index], sessionId: session.sessionId, clientId: session.clientId };
        }));
        expect(new Set(issued.map((agent) => agent.sessionId)).size).toBe(2);
        const before = await readControlRun(request, controlRunId);
        expect(before.results.filter((result) => result.result?.kind === 'recipe.run')).toEqual([]);
        const original = await readVisibleExecuteManifest(page);
        expect(original.rtcCaptureMode).toBeUndefined();
        const authored = original.recipes[0]?.recipe;
        if (!authored) {
            throw new Error('Visible Stability selection omitted its authored recipe.');
        }
        assertAuthoredStabilityRecipe(authored, original);
        await writeFile(
            testInfo.outputPath('console-native-original-manifest.json'),
            JSON.stringify(original, null, 2)
        );
        const capture = page.getByRole('combobox', { name: 'Run RTC capture', exact: true });
        await expect(capture).toHaveValue('');
        await capture.selectOption({ label: 'Full native' });
        expect((await readVisibleExecuteManifest(page)).recipes).toEqual(original.recipes);
        const [resolution, distributedRunId] = await Promise.all([
            page.waitForResponse((response) =>
                new URL(response.url()).pathname === '/distributed-runs/resolve-targets' &&
                response.request().method() === 'POST'
            ),
            createDraftThroughVisibleExecuteControls(page)
        ]);
        expect(resolution.ok()).toBe(true);
        expect(resolution.request().postDataJSON()).toEqual({
            manifest: { ...original, rtcCaptureMode: 'native' }
        });
        await expect(capture).toBeDisabled();
        await expect(capture).toHaveValue('native');
        const draft = await readDistributedRun(request, distributedRunId);
        expect(draft.manifest).toEqual({ ...original, rtcCaptureMode: 'native' });
        await stageThroughVisibleExecuteControls(page);
        const staged = await readDistributedRun(request, distributedRunId);
        expect(staged.manifest).toEqual(draft.manifest);
        assertConsolePhaseOwnership(staged, await readControlRun(request, controlRunId), 'stage');
        await startThroughVisibleExecuteControls(page);
        expect((await readVisibleExecuteManifest(page)).recipes).toEqual(original.recipes);
        await expect(capture).toBeDisabled();
        const completed = await readDistributedRun(request, distributedRunId);
        const current = await readControlRun(request, controlRunId);
        expect(completed.manifest).toEqual(draft.manifest);
        expect(completed.targetAgentIds).toEqual([...agentIds].sort());
        assertConsolePhaseOwnership(completed, current, 'start');
        const captures = completed.commandLinks.filter((link) => link.phase === 'start').map((link) => {
            const roots = current.results.filter((result) => result.commandId === link.commandId);
            expect(roots).toHaveLength(1);
            const session = issued.find((agent) => agent.agentId === link.agentId);
            expect(current.agents.find((agent) => agent.agentId === link.agentId)?.identity).toMatchObject({
                applicationId: original.group.applicationId,
                workspaceId: original.group.workspaceId,
                groupId,
                providerMode: 'browser-rallar',
                clientId: session?.clientId,
                sessionId: session?.sessionId
            });
            if (!session) {
                throw new Error('Start root did not belong to a visibly launched issued session.');
            }
            return toConsoleNativeConnection(roots[0], authored, session.sessionId);
        });
        await writeFile(
            testInfo.outputPath('console-native-captures.json'),
            JSON.stringify({ issued, captures }, null, 2)
        );
        const native = [];
        for (const connection of captures) {
            const peer = captures.find((candidate) => candidate.agentId !== connection.agentId);
            if (!peer) {
                throw new Error('Console Native attachment requires the other issued peer.');
            }
            native.push(await readConsoleNativeAttachment(connection, peer.sessionId));
        }
        await navigateToMonitor(page, distributedRunId, 'passed');
        const artifact = await exportMonitorArtifact(
            page,
            distributedRunId,
            testInfo.outputPath('console-native-artifact.json')
        );
        assertSchemaV2Artifact(artifact, {
            distributedRunId,
            controlRunId,
            groupId,
            agentIds,
            recipeId: authored.recipeId
        });
        expect(JSON.parse(artifact.files['manifest.json'])).toEqual(draft.manifest);
        await writeFile(
            testInfo.outputPath('console-native-observations.json'),
            JSON.stringify(
                {
                    issued,
                    original,
                    draft,
                    staged,
                    completed,
                    captures,
                    native,
                    limits: { receiverDelivery: 'not-measured', performanceAcceptance: false, durableOrigin: 'unknown' }
                },
                null,
                2
            )
        );
    }
    catch (error) {
        failure = toError(error);
        throw failure;
    }
    finally {
        await cleanupConsolePages(page, agentPages, failure);
    }
});

function configuredServiceProbe(
    probe: PromiseSettledResult<APIResponse>,
    label: string
): FullStackConfiguredServiceProbe {
    if (probe.status === 'rejected') {
        return { kind: 'unavailable' };
    }
    return {
        kind: 'reachable',
        ok: probe.value.ok(),
        status: probe.value.status(),
        statusText: probe.value.statusText(),
        readJson: () => configuredReadinessJson(probe.value, label)
    };
}

async function readVisibleExecuteManifest(page: Page): Promise<RallarBlackBoxDistributedRunManifest> {
    const manifest = page.getByLabel('Generated distributed run manifest');
    if (await manifest.count() === 0) {
        await page.locator('[data-execute-manifest] summary').click();
    }
    const raw = await manifest.textContent();
    return decodeDistributedRunManifest(JSON.parse(raw ?? 'null')).fold(
        (issues) => {
            throw new Error(`Invalid visible Execute manifest: ${JSON.stringify(issues)}`);
        },
        (decoded) => decoded
    );
}

function assertAuthoredStabilityRecipe(
    authored: RallarBlackBoxTestRecipe,
    manifest: RallarBlackBoxDistributedRunManifest
): void {
    expect(authored.recipeId).toBe('rtc-realtime-stability');
    expect(authored.rtcCaptureMode).toBeUndefined();
    expect(authored.metadata).toMatchObject({ durationSeconds: 5, rateHz: 5, frameCount: 25, executionMode: 'stream' });
    const connect = authored.commands.filter((command) => command.kind === 'rtc.connect');
    expect(connect).toHaveLength(1);
    expect(connect[0]).toMatchObject({
        commandId: 'rtc-realtime-connect',
        transport: 'realtime',
        roomRef: manifest.group,
        readiness: { minReadyPeers: 1, timeoutMs: 10_000 }
    });
    expect(connect[0].rallar?.rtcCaptureMode).toBeUndefined();
    expect(authored.commands.find((command) => command.kind === 'rtc.stream')).toMatchObject({
        commandId: 'rtc-realtime-position-stream',
        count: 25,
        intervalMs: 200,
        maxInFlight: 8,
        thresholds: { maxDroppedFrames: 2, minSendSuccessRatio: 0.95 }
    });
}

function assertConsolePhaseOwnership(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot,
    phase: 'stage' | 'start'
): void {
    const links = distributedRun.commandLinks.filter((link) => link.phase === phase);
    expect(links.map((link) => link.agentId).sort()).toEqual([...distributedRun.targetAgentIds].sort());
    expect(new Set(links.map((link) => link.commandId)).size).toBe(2);
    for (const link of links) {
        expect(link.recipeId).toBe('rtc-realtime-stability');
        const commands = controlRun.commands.filter((command) => command.envelope.commandId === link.commandId);
        expect(commands).toHaveLength(1);
        const queued = commands[0];
        const command = queued.envelope.command;
        if (command.kind !== 'recipe.load' && command.kind !== 'recipe.run') {
            throw new Error('Console stage/start link did not queue its recipe.');
        }
        expect(command.recipe).toEqual(distributedRun.manifest.recipes[0].recipe);
        expect(queued).toMatchObject({
            dispatchedAtEpochMs: expect.any(Number),
            completedAtEpochMs: expect.any(Number),
            envelope: {
                runId: distributedRun.controlRunId,
                agentId: link.agentId,
                commandId: link.commandId,
                command: { kind: phase === 'stage' ? 'recipe.load' : 'recipe.run' }
            }
        });
        const results = controlRun.results.filter((result) => result.commandId === link.commandId);
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ runId: distributedRun.controlRunId, agentId: link.agentId, ok: true });
        expect(results[0].replayed).not.toBe(true);
        if (phase === 'start') {
            expect(queued.envelope.command).toMatchObject({ rtcCaptureMode: 'native' });
        }
        else {
            const acknowledged = decodeRallarBlackBoxTestResult(results[0].result).fold(
                (issues) => {
                    throw new Error(`Console stage acknowledgment refused: ${issues.join(', ')}`);
                },
                (result) => result
            );
            expect(acknowledged).toMatchObject({
                commandId: link.commandId,
                kind: 'recipe.load',
                ok: true,
                status: 'ok',
                value: {
                    recipeId: 'rtc-realtime-stability',
                    recipeBodyId: expect.stringMatching(/\S/),
                    commandCount: distributedRun.manifest.recipes[0].recipe?.commands.length
                }
            });
            expect(acknowledged.replayed).not.toBe(true);
        }
    }
}

function toConsoleNativeConnection(
    root: ControlResultEnvelope,
    authored: RallarBlackBoxTestRecipe,
    sessionId: string
): RtcNativeCapturedConnection {
    const decoded = decodeRallarBlackBoxTestResult(root.result).fold(
        (issues) => {
            throw new Error(`Invalid Console root result: ${issues.join(', ')}`);
        },
        (result) => result
    );
    expect(decoded).toMatchObject({ commandId: root.commandId, kind: 'recipe.run', ok: true, status: 'ok' });
    expect(decoded.replayed).not.toBe(true);
    const recipe = decodeRecord(decoded.value);
    const invocation = decodeRecord(recipe.invocation);
    expect(recipe.recipeId).toBe(authored.recipeId);
    expect(invocation).toMatchObject({
        invocationId: expect.stringMatching(/\S/),
        recipeBodyId: expect.stringMatching(/\S/),
        run: 'native'
    });
    expect(invocation.recipe).toBeUndefined();
    const childIndex = authored.commands.findIndex((command) => command.commandId === 'rtc-realtime-connect');
    expect(Array.isArray(recipe.results)).toBe(true);
    const children = Array.isArray(recipe.results) ? recipe.results : [];
    expect(children).toHaveLength(authored.commands.length);
    expect(children.filter((child) => decodeRecord(child).commandId === 'rtc-realtime-connect')).toHaveLength(1);
    const connected = decodeRallarBlackBoxTestResult(children[childIndex]).fold(
        (issues) => {
            throw new Error(`Invalid immediate Console Connect result: ${issues.join(', ')}`);
        },
        (result) => result
    );
    expect(connected).toMatchObject({ commandId: 'rtc-realtime-connect', kind: 'rtc.connect', ok: true, status: 'ok' });
    expect(connected.replayed).not.toBe(true);
    const receipt = toConsoleCaptureReceipt(connected, sessionId);
    const invocationId = decodeNonBlankText(invocation.invocationId);
    const recipeBodyId = decodeNonBlankText(invocation.recipeBodyId);
    if (invocationId === undefined || recipeBodyId === undefined) {
        throw new Error('Console recipe omitted fresh invocation/body identity.');
    }
    return {
        runId: root.runId,
        agentId: root.agentId,
        commandId: connected.commandId,
        connection: 'rtcRealtime',
        transport: 'realtime',
        sessionId,
        requestedConfiguration: { mode: 'native', origin: 'run' },
        receipt,
        recipeAttribution: {
            rootCommandId: root.commandId,
            recipeId: authored.recipeId,
            invocationId,
            recipeBodyId,
            childIndex
        }
    };
}

function toConsoleCaptureReceipt(
    connected: RallarBlackBoxTestResult,
    sessionId: string
): RtcSignalingDiagnostics.CaptureReceipt {
    const value = decodeRecord(connected.value);
    expect(value).toMatchObject({ sessionId, connection: 'rtcRealtime', transport: 'realtime' });
    const readout = toRtcCaptureReadout(decodeJsonValue(value.rtcCapture)).fold(
        (reason) => {
            throw new Error(`Console capture receipt refused: ${reason}`);
        },
        (observed) => observed
    );
    if (readout.status !== 'observed') {
        throw new Error(`Console capture receipt unavailable: ${readout.reason}`);
    }
    expect(readout.value).toMatchObject({
        configuration: { mode: 'native', origin: 'run' },
        application: { status: 'applied', mode: 'native' },
        connectionId: { status: 'observed', value: expect.stringMatching(/\S/) },
        nativeScopeId: { status: 'observed', value: expect.stringMatching(/\S/) },
        nativeAvailability: { status: 'observed', value: 'enabled' },
        nativeCoverage: expect.stringMatching(/^(attached|partial)$/)
    });
    return readout.value;
}

async function readConsoleNativeAttachment(
    connection: RtcNativeCapturedConnection,
    peerSessionId: string
): Promise<ConsoleNativeAttachment> {
    const endpoint = `${CONFIGURED_POSTGRES.controlBaseUrl}/runs/${encodeURIComponent(connection.runId)}/events.jsonl`;
    let latest: ApiJsonObject | undefined;
    async function* observedRows(): AsyncGenerator<Either<RecorderJsonlFailure, RecorderJsonlRead>> {
        for await (const read of readLiveRtcRecorderRows(endpoint)) {
            const record = read.right;
            if (record?.kind === 'row') {
                const runtime = decodeRecord(record.row.value);
                if (
                    record.row.kind === 'rtc-diagnostic' && record.row.agentId === connection.agentId &&
                    runtime.topic === 'rallar.browser.rtc.signaling_diagnostics'
                ) {
                    const event = toRtcNativeObservationProjection(decodeRecord(runtime.payload).data).event;
                    const native = decodeRecord(event?.native ?? decodeRecord(event?.service).native);
                    if (
                        event?.localSessionId === connection.sessionId && event.peerSessionId === peerSessionId &&
                        jsonEquals(decodeRecord(native.capture).scopeId, connection.receipt.nativeScopeId)
                    ) {
                        latest = event;
                    }
                }
            }
            yield read;
        }
    }
    const proof = (await readRtcNativeAcquisition(connection, endpoint, observedRows())).fold(
        (refused) => {
            throw new Error(`Console Native acquisition refused: ${refused.reason}`);
        },
        (accepted) => accepted
    );
    expect(proof.source).toMatchObject({ completeness: 'complete', durableOrigin: 'unknown' });
    assertConsoleNativeChannel(latest, connection);
    return { proof, event: latest };
}

function assertConsoleNativeChannel(
    event: ApiJsonObject | undefined,
    connection: RtcNativeCapturedConnection
): asserts event is ApiJsonObject {
    if (!event) {
        throw new Error('Console Native recorder omitted a matching current channel.');
    }
    expect(decodeRecord(event.native ?? decodeRecord(event.service).native)).toMatchObject({
        capture: { scope: 'active', scopeId: connection.receipt.nativeScopeId },
        identity: {
            peerConnectionId: { status: 'observed', value: expect.stringMatching(/\S/) },
            channelId: { status: 'observed', value: expect.stringMatching(/\S/) }
        },
        state: {
            channelState: { status: 'observed', value: 'open' },
            listenerCoverage: expect.stringMatching(/^(attached|partial)$/)
        }
    });
    expect(event.action).not.toBe('retiring');
    expect(decodeRecord(event.service).stage).not.toBe('terminating');
}

async function cleanupConsolePages(page: Page, agentPages: readonly Page[], failure: Error | undefined): Promise<void> {
    const cleaned = await Promise.allSettled([cleanupRallarPage(page), ...agentPages.map(cleanupRallarPage)]);
    const closed = await Promise.allSettled(agentPages.map((agentPage) => agentPage.close()));
    const failures = [...cleaned, ...closed].filter((result) => result.status === 'rejected').map((result) =>
        toError(result.reason)
    );
    if (failures.length > 0) {
        throw new AggregateError(
            failure === undefined ? failures : [failure, ...failures],
            'Console acquisition or cleanup failed.'
        );
    }
}

function operatorUrl(
    input: OperatorUrlInput
): string {
    return `${FULL_STACK_SPA_ORIGIN}/?${
        new URLSearchParams({
            provider: 'browser-rallar',
            v: '1',
            experience: 'recipe-console',
            view: 'execute',
            recipeId: 'composite-evidence-recipe',
            controlUrl: CONFIGURED_POSTGRES.controlWsUrl,
            applicationId: CONFIGURED_POSTGRES.applicationId,
            workspaceId: CONFIGURED_POSTGRES.workspaceId,
            roomId: input.groupId,
            controlRunId: input.controlRunId,
            actor: input.actor,
            sessionId: input.sessionId
        }).toString()
    }`;
}

function hasCompletedCancelProof(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot
): boolean {
    const cancelLinks = distributedRun.commandLinks.filter(
        (link) => link.phase === 'cancel'
    );
    return distributedRun.state === 'cancelled' &&
        cancelLinks.length === distributedRun.targetAgentIds.length &&
        distributedRun.targetAgentIds.every((agentId) =>
            cancelLinks.filter((link) => link.agentId === agentId).length === 1
        ) &&
        cancelLinks.every((link) => {
            const command = controlRun.commands.find((candidate) => candidate.envelope.commandId === link.commandId);
            const result = controlRun.results.find((candidate) =>
                candidate.commandId === link.commandId &&
                candidate.agentId === link.agentId
            );
            return command?.envelope.command.kind === 'recipe.cancel' &&
                command.dispatchedAtEpochMs !== undefined &&
                command.completedAtEpochMs !== undefined &&
                result?.ok === true;
        });
}

async function configuredPostgresStackAvailability(
    request: APIRequestContext
): Promise<'ready' | 'unavailable'> {
    if (
        !CONFIGURED_POSTGRES.enabled ||
        !CONFIGURED_POSTGRES_MODE ||
        !CONFIGURED_FRESH_POSTGRES_API
    ) {
        return 'unavailable';
    }
    const [apiProbe, controlProbe] = await Promise.allSettled([
        request.get(`${CONFIGURED_POSTGRES.apiBaseUrl}/api/config`, {
            failOnStatusCode: false,
            headers: { origin: FULL_STACK_SPA_ORIGIN },
            timeout: 5_000
        }),
        request.get(`${CONFIGURED_POSTGRES.controlBaseUrl}/health`, {
            failOnStatusCode: false,
            timeout: 5_000
        })
    ]);
    return await evaluateFullStackConfiguredServiceEvidence({
        api: configuredServiceProbe(apiProbe, 'API configuration'),
        control: configuredServiceProbe(controlProbe, 'control health'),
        expectedApiBaseUrl: CONFIGURED_POSTGRES.apiBaseUrl
    });
}

async function configuredReadinessJson(
    response: APIResponse,
    label: string
): Promise<unknown> {
    try {
        return await response.json();
    }
    catch (cause) {
        throw new Error(`Configured ${label} returned malformed JSON.`, {
            cause
        });
    }
}

async function assertLiveExecuteTargets(
    page: Page,
    agentIds: readonly string[],
    expected: ExecuteRecipeExpectation
): Promise<void> {
    const recipe = page.locator(
        `[data-execute-recipe][data-recipe-id="${expected.recipeId}"]`
    );
    await expect(recipe).toHaveAttribute('aria-selected', 'true');
    await expect(recipe).toContainText(expected.providerMode);
    await expect(recipe).toContainText(expected.prerequisite);

    const targets = page.locator('[data-execute-targets]');
    await expect(targets.locator('[data-execute-target]')).toHaveCount(
        agentIds.length,
        { timeout: 30_000 }
    );
    for (const agentId of agentIds) {
        await expect(targets).toContainText(agentId);
    }
    await expect(targets.locator('[data-target-status="matched"]')).toHaveCount(
        agentIds.length
    );
}

async function launchBrowserAgentsThroughVisibleControls(
    page: Page,
    input: LaunchBrowserAgentsInput
): Promise<LaunchedBrowserAgents> {
    const setup = page.locator('[data-execute-agent-setup]');
    await expect(setup).toBeVisible();
    await expect(setup.getByLabel('Control run ID for new agents')).toHaveValue(
        input.controlRunId
    );
    await setup.getByLabel('Agent ID prefix').fill(input.prefix);
    await setup.getByLabel('Agent count').fill(String(input.count));

    const context = page.context();
    const existingPages = new Set(context.pages());
    try {
        await setup.getByRole('button', {
            name: `Open ${input.count} browser agents`
        }).click();
        await expect.poll(
            () => context.pages().filter((candidate) => !existingPages.has(candidate)).length,
            { timeout: 30_000 }
        ).toBe(input.count);
        const agentPages = context.pages().filter((candidate) => !existingPages.has(candidate));
        await Promise.all(
            agentPages.map((agentPage) =>
                agentPage.waitForURL((url) =>
                    url.searchParams.get('mode') === 'control' &&
                    url.searchParams.get('agentId')?.startsWith(`${input.prefix}-`) === true
                )
            )
        );

        const agentIds = readLaunchedAgentIds(agentPages, input);
        await expect(setup.getByRole('status')).toContainText(
            `${input.count} launched browser agents are ready and selected as targets.`,
            { timeout: 60_000 }
        );
        return { pages: agentPages, agentIds };
    }
    catch (error) {
        const acquired = context.pages().filter((candidate) => !existingPages.has(candidate));
        const cleanup = await Promise.allSettled(acquired.map((page) => page.close()));
        const failures = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason);
        if (failures.length > 0) {
            throw new AggregateError([error, ...failures], 'Visible agent acquisition and cleanup failed.', {
                cause: error
            });
        }
        throw error;
    }
}

async function createDraftThroughVisibleExecuteControls(
    page: Page
): Promise<string> {
    const actions = page.locator('[data-execute-action-runway]');
    await actions.getByRole('button', { name: /Resolve \d+ targets/ }).click();
    await actions
        .getByRole('button', { name: 'Create draft', exact: true })
        .click();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'draft'
    );
    const distributedRunId = new URL(page.url()).searchParams.get(
        'distributedRunId'
    );
    expect(distributedRunId).toMatch(/^dist-/);
    if (!distributedRunId) {
        throw new Error('Created run URL omitted distributedRunId.');
    }
    return distributedRunId;
}

async function stageThroughVisibleExecuteControls(page: Page): Promise<void> {
    const actions = page.locator('[data-execute-action-runway]');
    await actions
        .getByRole('button', { name: /Stage \d+ agents/ })
        .click();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'ready',
        { timeout: 60_000 }
    );
}

async function startThroughVisibleExecuteControls(page: Page): Promise<void> {
    const actions = page.locator('[data-execute-action-runway]');
    await actions.getByRole('button', { name: 'Review and start' }).click();
    await page.getByRole('dialog', { name: 'Start distributed run?' })
        .getByRole('button', { name: 'Start distributed run' }).click();
    await expect(page.locator('[data-execute-run-status]')).toHaveAttribute(
        'data-run-state',
        'passed',
        { timeout: 90_000 }
    );
}

async function navigateToMonitor(
    page: Page,
    distributedRunId: string,
    state: ControlDistributedRunSnapshot['state']
): Promise<void> {
    if (state === 'ready') {
        await page.getByRole('button', { name: 'Monitor', exact: true }).click();
    }
    else {
        await page.locator('[data-execute-action-runway]')
            .getByRole('button', { name: 'Monitor run' }).click();
    }
    await expect(page).toHaveURL(/(?:\?|&)view=monitor(?:&|$)/);
    await expect(page).toHaveURL(
        new RegExp(`(?:\\?|&)distributedRunId=${distributedRunId}(?:&|$)`)
    );
    await expect(
        page.locator('[data-monitor-section="verdict"]')
    ).toHaveAttribute('data-run-state', state, { timeout: 30_000 });
}

async function exportMonitorArtifact(
    page: Page,
    distributedRunId: string,
    outputPath: string
): Promise<ControlDistributedRunArtifactBundle> {
    const actions = page.getByRole('region', { name: 'Monitor actions' });
    const downloadPromise = page.waitForEvent('download');
    await actions.getByRole('button', { name: 'Export artifact' }).click();
    const download = await downloadPromise;
    expect(distributedRunId).toMatch(/^[a-z0-9-]+$/u);
    const expectedStem = distributedRunId.slice(0, 120).replace(/-+$/u, '');
    expect(download.suggestedFilename()).toBe(`${expectedStem}-artifact.json`);
    const downloadPath = await download.path();
    if (!downloadPath) {
        throw new Error('Artifact download path is unavailable.');
    }
    await download.saveAs(outputPath);
    return decodeControlDistributedRunArtifactBundle(JSON.parse(await readFile(downloadPath, 'utf8'))).fold(
        (issue) => {
            throw new Error(`Invalid distributed artifact: ${issue}`);
        },
        (artifact) => artifact
    );
}

function assertSchemaV2Artifact(
    artifact: ControlDistributedRunArtifactBundle,
    input: ArtifactExpectation
): void {
    expect(JSON.stringify(artifact)).not.toMatch(
        /agentSessionTicket|controlToken|authorization:\s*bearer/iu
    );
    expect(artifact).toMatchObject({
        artifactSchemaVersion: 2,
        distributedRunId: input.distributedRunId,
        files: {
            'distributed-run.json': expect.any(String),
            'manifest.json': expect.any(String),
            'target-resolution.json': expect.any(String),
            'control-run.json': expect.any(String),
            'report.json': expect.any(String),
            'metadata.json': expect.any(String)
        }
    });
    const files = artifact.files;
    expect(JSON.parse(files['manifest.json'])).toMatchObject({
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        group: { groupId: input.groupId },
        recipes: [{ recipeId: input.recipeId }],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: [...input.agentIds].sort(),
            expectedParticipantCount: input.agentIds.length
        }
    });
    expect(JSON.parse(files['distributed-run.json'])).toMatchObject({
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        state: 'passed',
        targetAgentIds: [...input.agentIds].sort(),
        rollup: { state: 'passed', ok: true }
    });
    expect(JSON.parse(files['report.json'] ?? '{}')).toMatchObject({
        artifactSchemaVersion: 2,
        execution: 'distributed-run',
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        state: 'passed',
        ok: true
    });
    assertArtifactControlSessions(
        decodeControlRunSnapshot(JSON.parse(files['control-run.json'])).fold(
            (issue) => {
                throw new Error(`Invalid embedded control run: ${issue}`);
            },
            (snapshot) => snapshot
        ),
        input
    );
}

function assertArtifactControlSessions(controlRun: ControlRunSnapshot, input: ArtifactExpectation): void {
    expect(controlRun).toMatchObject({
        runId: input.controlRunId,
        agents: expect.arrayContaining(input.agentIds.map((agentId) =>
            expect.objectContaining({
                agentId,
                identity: expect.objectContaining({
                    groupId: input.groupId,
                    providerMode: 'browser-rallar'
                })
            })
        )),
        results: expect.arrayContaining([
            expect.objectContaining({ ok: true })
        ])
    });
    const launchedSessions = controlRun.agents
        .filter((agent) => input.agentIds.includes(agent.agentId))
        .map((agent) => agent.identity?.sessionId);
    expect(launchedSessions).toHaveLength(input.agentIds.length);
    expect(launchedSessions.every((sessionId) => Boolean(sessionId))).toBe(true);
    expect(new Set(launchedSessions).size).toBe(input.agentIds.length);
}

async function readDistributedRun(
    request: APIRequestContext,
    distributedRunId: string
): Promise<ControlDistributedRunSnapshot> {
    const response = await request.get(
        `${CONFIGURED_POSTGRES.controlBaseUrl}/distributed-runs/${encodeURIComponent(distributedRunId)}`
    );
    expect(response.ok()).toBe(true);
    return decodeControlDistributedRunSnapshot(await response.json()).fold(
        (issue) => {
            throw new Error(`Invalid distributed run: ${issue}`);
        },
        (snapshot) => snapshot
    );
}

async function expectCompletedCancelProof(
    request: APIRequestContext,
    controlRunId: string,
    distributedRunId: string
): Promise<void> {
    await expect.poll(async () => {
        const [distributedRun, controlRun] = await Promise.all([
            readDistributedRun(request, distributedRunId),
            readControlRun(request, controlRunId)
        ]);
        return hasCompletedCancelProof(distributedRun, controlRun);
    }, { timeout: 30_000 }).toBe(true);

    const [distributedRun, controlRun] = await Promise.all([
        readDistributedRun(request, distributedRunId),
        readControlRun(request, controlRunId)
    ]);
    const cancelLinks = distributedRun.commandLinks.filter(
        (link) => link.phase === 'cancel'
    );
    expect(cancelLinks.map((link) => link.agentId).sort()).toEqual(
        [...distributedRun.targetAgentIds].sort()
    );
    for (const link of cancelLinks) {
        expect(controlRun.commands.find((candidate) => candidate.envelope.commandId === link.commandId)).toMatchObject({
            envelope: {
                agentId: link.agentId,
                commandId: link.commandId,
                command: { kind: 'recipe.cancel' }
            },
            dispatchedAtEpochMs: expect.any(Number),
            completedAtEpochMs: expect.any(Number)
        });
        expect(controlRun.results.find((candidate) =>
            candidate.commandId === link.commandId &&
            candidate.agentId === link.agentId
        )).toMatchObject({
            agentId: link.agentId,
            commandId: link.commandId,
            ok: true
        });
    }
}

function readLaunchedAgentIds(agentPages: readonly Page[], input: LaunchBrowserAgentsInput): readonly string[] {
    const agentIds = agentPages.map((agentPage) => {
        const url = new URL(agentPage.url());
        expect(url.hash).toBe('');
        expect(url.searchParams.get('provider')).toBe('browser-rallar');
        expect(url.searchParams.get('runId')).toBe(input.controlRunId);
        expect(url.searchParams.get('roomId')).toBe(input.groupId);
        expect(url.searchParams.get('apiBaseUrl')).toBe(
            CONFIGURED_POSTGRES.apiBaseUrl
        );
        expect(url.searchParams.get('sessionId')).toBeNull();
        return url.searchParams.get('agentId') ?? '';
    });
    expect(new Set(agentIds).size).toBe(input.count);
    return agentIds;
}
