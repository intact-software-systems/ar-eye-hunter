import {
    describe,
    expect,
    it
} from 'vitest';

import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestWaitCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { snapshotExecutableCommand } from '@shared-test/rallar-bb-test/recipe/snapshot-executable-recipe.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

const TOPIC = 'rallar.browser.alm.inbound_diagnostics';

function toWaitCommand(): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: 'admission',
        timeoutMs: 20,
        match: {
            kind: 'diagnostic',
            topic: TOPIC,
            payloadFields: { 'data.kind': 'admission-outcome', 'data.typeId': 'scenario-one' }
        }
    };
}

describe('wait payload field constraints', () => {
    it('selects the newest event satisfying every constraint, ignoring newer wrong-kind and wrong-scenario events', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        for (
            const data of [
                { kind: 'admission-outcome', typeId: 'scenario-one', carrier: 'rtc', outcome: 'committed', reason: 'admitted' },
                { reason: 'duplicate', outcome: 'not-handled', carrier: 'ws', typeId: 'scenario-one', kind: 'admission-outcome' },
                { kind: 'dispatch-decision', typeId: 'scenario-one', carrier: 'ws', disposition: 'port-returned' },
                { kind: 'admission-outcome', typeId: 'scenario-two', carrier: 'ws', outcome: 'committed', reason: 'admitted' }
            ]
        ) {
            runtime.recordEvent({ kind: 'diagnostic', topic: TOPIC, payload: { data } });
        }

        const result = await runtime.execute(toWaitCommand());

        expect(result.status).toBe('ok');
        expect(result.value).toMatchObject({
            event: {
                payload: {
                    data: {
                        kind: 'admission-outcome',
                        typeId: 'scenario-one',
                        carrier: 'ws',
                        outcome: 'not-handled',
                        reason: 'duplicate'
                    }
                }
            }
        });
    });

    it.each([
        { kind: 'dispatch-decision', typeId: 'scenario-one' },
        { kind: 'admission-outcome', typeId: 'scenario-two' },
        { kind: 'admission-outcome' }
    ])('times out when one event cannot satisfy all constraints: %j', async (data) => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        runtime.recordEvent({ kind: 'diagnostic', topic: TOPIC, payload: { data } });

        const result = await runtime.execute(toWaitCommand());

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_TIMEOUT');
    });

    it('requires the constraints on one event rather than assembling them across different events', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        for (
            const data of [
                { kind: 'dispatch-decision', typeId: 'scenario-one' },
                { kind: 'admission-outcome', typeId: 'scenario-two' }
            ]
        ) {
            runtime.recordEvent({ kind: 'diagnostic', topic: TOPIC, payload: { data } });
        }

        const result = await runtime.execute(toWaitCommand());

        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_TIMEOUT');
    });

    it('admits the field contract at both command boundaries, including JSON null and structured values', () => {
        const command = {
            ...toWaitCommand(),
            match: {
                payloadFields: {
                    'data.identity': { scenario: 'one', sequence: [1, 2] },
                    'data.reason': null
                }
            }
        };

        expect(validateRallarBlackBoxTestCommand(command)).toEqual({ ok: true });
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(true);
    });

    it.each([null, [], 'data.kind', { 'data.kind': undefined }])('rejects malformed field contracts at control admission: %j', (payloadFields) => {
        const command = { ...toWaitCommand(), match: { payloadFields } };

        expect(validateRallarBlackBoxTestCommand(command).ok).toBe(false);
    });

    it.each([null, [], 'data.kind'])('rejects malformed field contracts in the published schema: %j', (payloadFields) => {
        expect(
            validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, {
                ...toWaitCommand(),
                match: { payloadFields }
            }).ok
        ).toBe(false);
    });

    describe('numeric floors', () => {
        const APPLIED_TOPIC = 'rallar.browser.group_state.applied';
        const FLOORS = {
            'data.groupRevision': '{resultCache.formation.value.groupRevision}',
            'data.presenceRevision': 3
        };

        function createRuntimeAfterFormation(formation: Readonly<Record<string, number | string>>) {
            return createDefaultRallarBlackBoxTestRuntime({
                commandExecutor: (command) => command.kind === 'formation.readiness' ? { status: 'ok', value: formation } : undefined
            });
        }

        async function readFormation(runtime: ReturnType<typeof createRuntimeAfterFormation>) {
            await runtime.execute({ kind: 'formation.readiness', commandId: 'formation', timeoutMs: 1_000 });
        }

        function toFloorWait(payloadMinimums: Record<string, number | string>): RallarBlackBoxTestWaitCommand {
            return { kind: 'wait', commandId: 'settled', timeoutMs: 20, match: { kind: 'diagnostic', topic: APPLIED_TOPIC, payloadMinimums } };
        }

        function recordApplied(runtime: ReturnType<typeof createRuntimeAfterFormation>, data: Readonly<Record<string, number | string>>) {
            runtime.recordEvent({ kind: 'diagnostic', topic: APPLIED_TOPIC, payload: { data } });
        }

        it('matches an event whose numbers reach floors read from an earlier result', async () => {
            const runtime = createRuntimeAfterFormation({ groupRevision: 7 });
            await readFormation(runtime);
            recordApplied(runtime, { page: 'below', groupRevision: 6, presenceRevision: 9 });
            recordApplied(runtime, { page: 'reached', groupRevision: 7, presenceRevision: 3 });
            recordApplied(runtime, { page: 'text', groupRevision: '8', presenceRevision: 9 });

            const result = await runtime.execute(toFloorWait(FLOORS));

            expect(result.status).toBe('ok');
            expect(result.value).toHaveProperty('event.payload.data.page', 'reached');
        });

        it('a floor reached by one path but not another in the same event does not match', async () => {
            const runtime = createRuntimeAfterFormation({ groupRevision: 7 });
            await readFormation(runtime);
            recordApplied(runtime, { groupRevision: 9, presenceRevision: 2 });
            recordApplied(runtime, { groupRevision: 6, presenceRevision: 9 });

            const result = await runtime.execute(toFloorWait(FLOORS));

            expect(result.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_TIMEOUT');
        });

        it('a floor that names no numeric result is invalid', async () => {
            const runtime = createRuntimeAfterFormation({ groupRevision: 'seven' });
            await readFormation(runtime);
            recordApplied(runtime, { groupRevision: 9, presenceRevision: 9 });

            const textual = await runtime.execute(toFloorWait(FLOORS));
            const missing = await runtime.execute({
                ...toFloorWait({ 'data.groupRevision': '{resultCache.formation.value.planned}' }),
                commandId: 'settled-missing'
            });

            expect(textual.error).toMatchObject({
                code: 'RALLAR_BLACK_BOX_WAIT_INVALID',
                details: { path: 'data.groupRevision', reference: 'resultCache.formation.value.groupRevision' }
            });
            expect(missing.error).toMatchObject({
                code: 'RALLAR_BLACK_BOX_WAIT_INVALID',
                details: { path: 'data.groupRevision', reference: 'resultCache.formation.value.planned' }
            });
        });

        it('admits finite numbers and one result reference at both command boundaries', () => {
            const command = toFloorWait({ ...FLOORS, 'data.loopKeyed': '{resultCache.stable:i{loop.iteration}:c1:formation.value.groupRevision}' });

            expect(validateRallarBlackBoxTestCommand(command)).toEqual({ ok: true });
            expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(true);
        });

        it.each([null, [], 'data.groupRevision', { 'data.groupRevision': true }, { 'data.groupRevision': 'at {resultCache.formation.value.groupRevision}' }])(
            'rejects malformed floors at control admission and in the published schema: %j',
            (payloadMinimums) => {
                const command = { ...toFloorWait({}), match: { payloadMinimums } };

                expect(validateRallarBlackBoxTestCommand(command).ok).toBe(false);
                expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(false);
            }
        );
    });

    it('owns field operands before caller mutation can redirect execution', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const payloadFields = { 'data.identity': { scenario: 'one', sequence: [1, 2] }, 'data.reason': null };
        const command = snapshotExecutableCommand({ ...toWaitCommand(), match: { payloadFields } });
        payloadFields['data.identity'].scenario = 'two';
        payloadFields['data.identity'].sequence.push(3);
        runtime.recordEvent({
            kind: 'diagnostic',
            topic: TOPIC,
            payload: {
                data: {
                    identity: { scenario: 'one', sequence: [1, 2] },
                    reason: null
                }
            }
        });

        const result = await runtime.execute(command);

        expect(result.status).toBe('ok');
        expect(result.value).toMatchObject({ event: { payload: { data: { identity: { scenario: 'one', sequence: [1, 2] } } } } });
    });
});
