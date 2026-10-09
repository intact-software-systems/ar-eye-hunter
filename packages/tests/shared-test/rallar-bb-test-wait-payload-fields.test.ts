import {
    describe,
    expect,
    it
} from 'vitest';

import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestWaitCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { snapshotExecutableCommand } from '@shared-test/rallar-bb-test/recipe/snapshot-executable-recipe.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
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
        const runtime = createRallarBlackBoxTestRuntime();
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
        const runtime = createRallarBlackBoxTestRuntime();
        runtime.recordEvent({ kind: 'diagnostic', topic: TOPIC, payload: { data } });

        const result = await runtime.execute(toWaitCommand());

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_TIMEOUT');
    });

    it('requires the constraints on one event rather than assembling them across different events', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
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

    it('owns field operands before caller mutation can redirect execution', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
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
