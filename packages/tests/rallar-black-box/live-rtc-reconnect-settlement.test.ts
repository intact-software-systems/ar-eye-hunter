import { expect, it } from 'vitest';

import { computeResultCaptureReceipt } from '@shared-test/rallar-bb-test/result-release/result-release-protocol.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

import {
    createGroupFormationLifecycleDriver,
    type LiveRtcControlPort
} from '../../../tests/playwright/rallar-black-box/create-group-formation-lifecycle-driver.ts';
import type { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { jsonRecord, normalizeJson } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';
import { createLiveRtcFormationOperations } from '../../../tests/playwright/rallar-black-box/live-rtc-formation-operations.ts';

it('waits past survivor-only captures until every reconnect participant observes its exact peers', async () => {
    const observations = new Map<string, number>();
    const waitingC = Promise.withResolvers<LiveRtcControlClient.Result>();
    const control = createControl(async (command) => {
        if (command.command.kind === 'rtc.connect') {
            return { commandId: command.commandId, agentId: 'C', ok: true, result: { value: { sessionId: 'C', almDiagnostics: false } } };
        }
        const attempt = (observations.get(command.agentId) ?? 0) + 1;
        observations.set(command.agentId, attempt);
        if (command.agentId === 'C') {
            return waitingC.promise;
        }
        const survivor = command.agentId === 'A' ? 'B' : 'A';
        return readinessResult(command, attempt === 1 ? [survivor] : [survivor, 'C']);
    });
    const agents = ['A', 'B', 'C'].map((prefix) => createAgent(prefix));
    const driver = createGroupFormationLifecycleDriver({
        apiBaseUrl: 'http://localhost:18080',
        applicationId: 'app',
        workspaceId: 'workspace',
        messagesRtcTypeId: 'type',
        messagesRtcTopicId: 'topic',
        almDiagnostics: false,
        formation: createLiveRtcFormationOperations()
    });
    let settled = false;
    const outcome = driver.reconnectAndWaitForPeerReadiness({
        control,
        runId: 'run',
        reconnectingAgent: agents[2],
        survivingAgents: [agents[0], agents[1]],
        survivingSessionIds: ['A', 'B'],
        transport: 'realtime',
        groupId: 'room',
        suffix: 'cycle-4'
    }).then((value) => {
        settled = true;
        return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect([...observations]).toEqual([['A', 1], ['B', 1], ['C', 1]]);
    waitingC.resolve(readinessResult({ commandId: 'C', agentId: 'C' }, ['A', 'B']));
    await expect(outcome).resolves.toMatchObject({ sessionId: 'C' });
    expect([...observations]).toEqual([['A', 2], ['B', 2], ['C', 1]]);
});

it('drains a pending C command before reconnect failure allows finalization', async () => {
    let finishC: (value: LiveRtcControlClient.Result) => void = () => {};
    const originalC = new Promise<LiveRtcControlClient.Result>((resolve) => {
        finishC = resolve;
    });
    const identity = { runId: 'run', agentId: 'C' };
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        commandExecutor: async (command) =>
            command.kind === 'formation.readiness'
                ? { status: 'ok', value: (await originalC).result?.value }
                : undefined
    });
    const capturedHealth = await runtime.execute({ kind: 'health', commandId: 'original-health' }, identity);
    const receipt = await computeResultCaptureReceipt(capturedHealth, identity);
    if (receipt === undefined) {
        throw new Error('Health result must have durable capture evidence');
    }
    const firstFailure = new Error('B canonical readiness failed first');
    const calls: string[] = [];
    const control = createControl(async (command) => {
        calls.push(command.agentId);
        if (command.command.kind === 'rtc.connect') {
            return { commandId: command.commandId, agentId: 'C', ok: true, result: { value: { sessionId: 'C', almDiagnostics: false } } };
        }
        if (command.agentId === 'B') {
            throw firstFailure;
        }
        if (command.agentId === 'C') {
            const result = await runtime.execute(command.command, identity);
            return { commandId: command.commandId, agentId: command.agentId, ok: result.ok, result: { value: normalizeJson(result.value) } };
        }
        return readinessResult(command, ['B', 'C']);
    });
    const agents = ['A', 'B', 'C'].map((prefix) => createAgent(prefix));
    const driver = createGroupFormationLifecycleDriver({
        apiBaseUrl: 'http://localhost:18080',
        applicationId: 'app',
        workspaceId: 'workspace',
        messagesRtcTypeId: 'type',
        messagesRtcTopicId: 'topic',
        almDiagnostics: false,
        formation: createLiveRtcFormationOperations()
    });
    let finalizationStarted = false;
    const outcome = driver.reconnectAndWaitForPeerReadiness({
        control,
        runId: 'run',
        reconnectingAgent: agents[2],
        survivingAgents: [agents[0], agents[1]],
        survivingSessionIds: ['A', 'B'],
        transport: 'realtime',
        groupId: 'room',
        suffix: 'cycle-4'
    }).catch((failure: Error) => failure).then((value) => {
        finalizationStarted = true;
        return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const finalizedWithPendingC = finalizationStarted;
    const release = { ...identity, requestId: 'release-original-health', receipts: [receipt] };
    expect((await runtime.releaseResults(release)).status).toBe('deferred');
    expect(runtime.state().resultCache['original-health']).toBe(capturedHealth);
    finishC(readinessResult({ commandId: 'original-C', agentId: 'C' }, ['A', 'B']));
    const failure = await outcome;

    expect(calls).toEqual(['C', 'A', 'B', 'C']);
    expect(finalizedWithPendingC).toBe(false);
    expect(failure).toBe(firstFailure);
    expect(runtime.state().commandHistory.filter((result) => result.kind === 'formation.readiness')).toHaveLength(1);
    expect((await runtime.releaseResults(release)).status).toBe('released');
});

function createAgent(prefix: string): LiveRtcControlClient.FormationAgent {
    if (prefix !== 'A' && prefix !== 'B' && prefix !== 'C') {
        throw new Error('Invalid fixture agent');
    }
    return { prefix, agentId: prefix, actor: prefix, connection: prefix, refreshRoom: async () => {} };
}

function createControl(executeOk: LiveRtcControlPort['executeOk']): LiveRtcControlPort {
    return {
        executeOk,
        executeResult: executeOk,
        resultValue: (result) => jsonRecord(result.result?.value) ?? {},
        requireSessionId: () => 'C',
        waitForPeerReadiness: async () => 1,
        waitForPeerAbsence: async () => {},
        waitForMessage: async () => 1,
        readyPeerIds: () => []
    };
}

function readinessResult(command: { commandId: string; agentId: string; }, peers: readonly string[]): LiveRtcControlClient.Result {
    return {
        commandId: command.commandId,
        agentId: command.agentId,
        ok: true,
        result: {
            value: {
                readyAtEpochMs: 1,
                formation: {
                    roomRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
                    stage: 'active',
                    formationEpoch: 6,
                    formationAttemptCount: 1,
                    causalRevision: { groupRevision: 20, presenceRevision: 10 },
                    transportState: 'flowing',
                    dialing: 'accepted',
                    memberPolicy: { maxConcurrentEdgeSetups: 4, transports: 'rtc-and-ws' },
                    room: {
                        state: 'open',
                        desiredPeerIds: [...peers],
                        readyPeerIds: [...peers],
                        activePeerIds: [...peers],
                        failedPeerIds: [],
                        acceptedLayoutIdentity: { groupRevision: 18, presenceRevision: 10, version: 9, state: 'active' }
                    }
                }
            }
        }
    };
}
