import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    decodeBarrierArrival,
    decodeControlBarrierEnvelope,
    RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC,
    toBarrierResolvedEvent,
    type ControlBarrierEnvelope
} from '@shared-test/rallar-bb-test/barrier/control-barrier-protocol.ts';
import { RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS } from '@shared-test/rallar-bb-test/barrier/wait-for-barrier.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import { distributedRecipePreflight } from '@shared-test/rallar-bb-test/distributed-recipe-preflight/distributed-recipe-preflight.ts';
import type {
    RallarBlackBoxTestBarrierCommand,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_RECIPE_TIMEOUT } from '@shared-test/rallar-bb-test/recipe/run-recipe-commands.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

const BARRIER: RallarBlackBoxTestBarrierCommand = {
    kind: 'barrier',
    commandId: 'alm-ws-delivery-baseline-sender-armed',
    barrierId: 'alm-ws-delivery-baseline-armed',
    timeoutMs: 60_000
};

function toResolution(resolution: ControlBarrierEnvelope['resolution']): ControlBarrierEnvelope {
    return {
        kind: 'barrier',
        protocolVersion: 1,
        runId: 'run-1',
        agentId: 'agent-1',
        barrierId: BARRIER.barrierId,
        resolution
    };
}

/** Starts the barrier and returns once its arrival is on the event buffer; the result settles later. */
async function arriveAt(
    runtime: RallarBlackBoxTestRuntime,
    command: RallarBlackBoxTestBarrierCommand
): Promise<Readonly<{ result: Promise<RallarBlackBoxTestResult>; }>> {
    const result = runtime.execute(command);
    await vi.waitFor(() => {
        expect(
            runtime.state().events.filter((event) => event.topic === RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC && event.commandId === command.commandId)
        ).toHaveLength(1);
    });
    return { result };
}

describe('recipe barrier command', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('validates a barrier and refuses one without an id, a window or real participants', () => {
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, BARRIER).ok).toBe(true);
        expect(validateRallarBlackBoxTestCommand({ ...BARRIER, participants: ['sender', 'receiver'] }))
            .toEqual({ ok: true });
        expect(validateRallarBlackBoxTestCommand({ ...BARRIER, barrierId: '' })).toMatchObject({
            ok: false,
            error: expect.stringContaining('barrier.barrierId must be a non-empty string.')
        });
        expect(validateRallarBlackBoxTestCommand({ kind: 'barrier', barrierId: 'b' })).toMatchObject({
            ok: false,
            error: expect.stringContaining('barrier.timeoutMs is required.')
        });
        expect(validateRallarBlackBoxTestCommand({ ...BARRIER, timeoutMs: 0 })).toMatchObject({
            ok: false,
            error: expect.stringContaining('barrier.timeoutMs must be >= 1.')
        });
        expect(validateRallarBlackBoxTestCommand({ ...BARRIER, participants: [] })).toMatchObject({
            ok: false,
            error: expect.stringContaining('barrier.participants must be a non-empty list of distinct role names.')
        });
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, { ...BARRIER, participants: [] }).ok)
            .toBe(false);
    });

    it('reads an arrival from its forwarded event, and a resolution only when it addresses this agent', () => {
        expect(
            decodeBarrierArrival({
                kind: 'event',
                topic: RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC,
                payload: { barrierId: 'b', timeoutMs: 5_000 }
            }).right
        ).toEqual({ barrierId: 'b', timeoutMs: 5_000, participants: undefined });
        expect(
            decodeBarrierArrival({ kind: 'event', topic: 'rallar.bb.other', payload: { barrierId: 'b', timeoutMs: 5_000 } })
                .left
        ).toBe('Not a barrier arrival.');
        const released = toResolution({ outcome: 'released', arrivedAgentIds: ['agent-1', 'agent-2'] });
        expect(decodeControlBarrierEnvelope(JSON.stringify(released), { runId: 'run-1', agentId: 'agent-1' }).right)
            .toEqual(released);
        expect(decodeControlBarrierEnvelope(JSON.stringify(released), { runId: 'run-1', agentId: 'agent-2' }).left)
            .toBe('Control barrier envelope does not address this agent.');
        const unknownReason = {
            ...released,
            resolution: { outcome: 'failed', reason: 'gone', arrivedAgentIds: [], missingAgentIds: [] }
        };
        expect(decodeControlBarrierEnvelope(JSON.stringify(unknownReason), { runId: 'run-1', agentId: 'agent-1' }).left)
            .toBe('A barrier resolution is released, or failed with a known reason and the agents still missing.');
    });

    it('reports its arrival and completes on the released resolution', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
        const { result } = await arriveAt(runtime, BARRIER);
        runtime.recordEvent(
            toBarrierResolvedEvent(toResolution({ outcome: 'released', arrivedAgentIds: ['agent-1', 'agent-2'] }))
        );

        expect(await result).toMatchObject({
            ok: true,
            value: { barrierId: BARRIER.barrierId, outcome: 'released', arrivedAgentIds: ['agent-1', 'agent-2'] }
        });
        expect(
            runtime.state().events.find((event) => event.topic === RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC)?.payload
        ).toEqual({ barrierId: BARRIER.barrierId, timeoutMs: 60_000 });
    });

    it('fails typed with the reason and the missing agents the control server names', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
        const { result } = await arriveAt(runtime, BARRIER);
        runtime.recordEvent(toBarrierResolvedEvent(toResolution({
            outcome: 'failed',
            reason: 'participant-failed',
            arrivedAgentIds: ['agent-1'],
            missingAgentIds: ['agent-2']
        })));

        expect(await result).toMatchObject({
            ok: false,
            error: {
                code: 'RALLAR_BLACK_BOX_BARRIER_FAILED',
                details: { reason: 'participant-failed', missingAgentIds: ['agent-2'] }
            }
        });
    });

    it('fails typed on its own once the window and the grace pass without a resolution', async () => {
        vi.useFakeTimers();
        const runtime = createRallarBlackBoxTestRuntime();
        const { result } = await arriveAt(runtime, { ...BARRIER, timeoutMs: 1_000 });
        await vi.advanceTimersByTimeAsync(1_000 + RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS);

        const outcome = await result;
        expect(outcome).toMatchObject({
            ok: false,
            error: {
                code: 'RALLAR_BLACK_BOX_BARRIER_TIMEOUT',
                details: {
                    barrierId: BARRIER.barrierId,
                    timeoutMs: 1_000,
                    graceMs: RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS
                }
            }
        });
        expect(outcome.error?.message).toContain(BARRIER.barrierId);
    });

    it('reports the recipe deadline, not a silent control server, when the deadline ends the wait first', async () => {
        vi.useFakeTimers();
        const runtime = createRallarBlackBoxTestRuntime();
        const deadlineEpochMs = Date.now() + 1_000;
        const { result } = await arriveAt(runtime, { ...BARRIER, deadlineEpochMs });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(await result).toMatchObject({
            ok: false,
            error: {
                code: RALLAR_BLACK_BOX_RECIPE_TIMEOUT,
                details: { barrierId: BARRIER.barrierId, deadlineEpochMs }
            }
        });
    });

    it('ends cancelled, not timed out, when the recipe is cancelled while it waits', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
        const { result } = await arriveAt(runtime, BARRIER);
        await runtime.execute({ kind: 'recipe.cancel', commandId: 'cancel-barrier', reason: 'operator stop' });

        expect(await result).toMatchObject({
            status: 'cancelled',
            value: { barrierId: BARRIER.barrierId, cancelled: true }
        });
    });

    it('lists the barrier in the distributed preflight as a wait of its window plus the resolution grace', () => {
        const preflight = distributedRecipePreflight({ schemaVersion: 1, recipeId: 'barrier-preflight', commands: [BARRIER] });

        expect(preflight.waits).toEqual([{
            path: '$.commands[0]',
            commandId: BARRIER.commandId,
            matchSummary: `barrier ${BARRIER.barrierId}`,
            timeoutMs: 60_000 + RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS
        }]);
    });

    it('refuses a second arrival at the same barrier id on one page', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
        const first = await arriveAt(runtime, BARRIER);
        runtime.recordEvent(toBarrierResolvedEvent(toResolution({ outcome: 'released', arrivedAgentIds: ['agent-1'] })));
        await first.result;

        expect(await runtime.execute({ ...BARRIER, commandId: 'again' })).toMatchObject({
            ok: false,
            error: { code: 'RALLAR_BLACK_BOX_BARRIER_REUSED' }
        });
    });
});
