import { expect, type APIRequestContext } from '@playwright/test';

import type { ControlEventEnvelope } from '../../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxDistributedGroupRef } from '../../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecord } from '../../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../../../../packages/shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';

import { readControlRun } from '../full-stack-helpers.ts';
import type { AgentHandle } from './browser-agents.ts';

export interface RuntimeDiagnosticExpectation {
    readonly agentId: string;
    readonly diagnosticTypeId: string;
    readonly transport: 'ws' | 'realtime';
    readonly pattern: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    /** A control run retains only a tail of its events, so an index into it orders nothing; the agent's stamp does. */
    readonly recordedFromEpochMs: number;
    readonly connection: string;
}

interface WaitForBrowserMessageInput {
    readonly agentId: string;
    readonly transport: 'ws' | 'realtime';
    readonly messageId: string;
}

interface EmitKnownLiveWarningDiagnosticsInput {
    readonly distributedRunId: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
}

function toMessageData(event: ControlEventEnvelope): RallarBlackBoxTestRecord {
    const runtimeEvent = decodeRecord(event.payload);
    const runtimePayload = decodeRecord(runtimeEvent.payload);
    return decodeRecord(runtimePayload.data);
}

function browserMessageMatches(
    event: ControlEventEnvelope,
    input: WaitForBrowserMessageInput
): boolean {
    const runtimeEvent = decodeRecord(event.payload);
    const data = toMessageData(event);
    return event.agentId === input.agentId &&
        runtimeEvent.kind === 'message' &&
        runtimeEvent.transport === input.transport &&
        data.messageId === input.messageId;
}

export async function waitForBrowserMessage(
    request: APIRequestContext,
    runId: string,
    input: WaitForBrowserMessageInput
): Promise<void> {
    await expect.poll(async () => {
        const run = await readControlRun(request, runId);
        return run.events.some((event) => browserMessageMatches(event, input));
    }, { timeout: 75_000 }).toBe(true);
}

export async function waitForRuntimeDiagnostic(
    request: APIRequestContext,
    runId: string,
    expected: RuntimeDiagnosticExpectation
): Promise<void> {
    await expect.poll(async () => {
        const run = await readControlRun(request, runId);
        return hasRuntimeDiagnostic(run.events, expected);
    }, { timeout: 30_000 }).toBe(true);
}

export function hasRuntimeDiagnostic(
    events: readonly ControlEventEnvelope[],
    expected: RuntimeDiagnosticExpectation
): boolean {
    return events.some((event) => {
        const runtime = decodeRecord(event.payload);
        const diagnostic = decodeRecord(runtime.payload);
        const scope = decodeRecord(diagnostic.scope);
        const detail = decodeRecord(diagnostic.data);
        return event.kind === 'diagnostic' && event.atEpochMs >= expected.recordedFromEpochMs &&
            event.agentId === expected.agentId &&
            runtime.topic === expected.diagnosticTypeId &&
            runtime.transport === expected.transport &&
            diagnostic.diagnosticTypeId === expected.diagnosticTypeId &&
            diagnostic.severity === 'warning' &&
            diagnostic.connection === expected.connection &&
            diagnostic.roomId === expected.group.groupId &&
            scope.applicationId === expected.group.applicationId &&
            scope.workspaceId === expected.group.workspaceId &&
            detail.pattern === expected.pattern && detail.source === 'console.warn' &&
            Object.keys(detail).length === 2;
    });
}

export async function emitKnownLiveWarningDiagnostics(
    agents: readonly AgentHandle[],
    input: EmitKnownLiveWarningDiagnosticsInput
): Promise<void> {
    await agents[1].page.evaluate(({ distributedRunId, groupId }) => {
        console.warn('Unhandled WS message', {
            distributedRunId,
            groupId,
            typeId: 'room.rallar-black-box.distributed.warning',
            topicId: 'room.rallar-black-box.distributed.warning'
        });
    }, {
        distributedRunId: input.distributedRunId,
        groupId: input.group.groupId
    });
    await agents[2].page.evaluate(({ distributedRunId, groupId }) => {
        console.warn('Received data channel for different data channel name.', {
            distributedRunId,
            groupId,
            expectedChannelLabel: 'rtcRealtime',
            observedChannelLabel: 'rtc-data-channel'
        });
    }, {
        distributedRunId: input.distributedRunId,
        groupId: input.group.groupId
    });
}

export async function waitForRealtimePositionPayload(
    request: APIRequestContext,
    runId: string,
    distributedRunId: string
): Promise<void> {
    await expect.poll(async () => {
        const run = await readControlRun(request, runId);
        return run.events.some((event) => {
            const runtimeEvent = decodeRecord(event.payload);
            const data = toMessageData(event);
            return runtimeEvent.kind === 'message' &&
                runtimeEvent.transport === 'realtime' &&
                data.distributedRunId === distributedRunId &&
                data.topic === 'room.black-box.rtc-realtime.position';
        });
    }, { timeout: 75_000 }).toBe(true);
}
