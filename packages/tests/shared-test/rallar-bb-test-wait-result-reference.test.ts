import { describe, expect, it } from 'vitest';
import type { RallarBlackBoxTestWaitResultValue } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

const NACK_TOPIC = 'rallar.browser.alm.outbound_diagnostics';

function createRuntimeWithSentMessage() {
    let now = 1_000;
    const runtime = createRallarBlackBoxTestRuntime({
        now: () => now,
        sleep: async (ms) => {
            now += ms;
        },
        commandExecutor: (command) =>
            command.kind === 'messages.send'
                ? { status: 'ok', value: { handleId: 'send-2', msgId: 'msg-2', carrier: 'ws', status: 'queued' } }
                : undefined
    });
    return runtime;
}

function toNackEvent(targetMsgId: string) {
    return {
        kind: 'diagnostic',
        topic: NACK_TOPIC,
        payload: { data: { kind: 'control-admission', typeId: 'al.control.nack.v1', targetMsgId, outcome: 'rejected' } }
    } as const;
}

function toNackWait(commandId: string, contains: string) {
    return {
        kind: 'wait',
        commandId,
        timeoutMs: 20,
        match: { kind: 'diagnostic', topic: NACK_TOPIC, payloadPath: 'data', contains }
    } as const;
}

async function executeSend(runtime: ReturnType<typeof createRuntimeWithSentMessage>) {
    await runtime.execute({
        kind: 'messages.send',
        commandId: 'send-2',
        connection: 'sender',
        carrier: 'ws',
        typeId: 'alm.conformance',
        payload: {},
        handleId: 'send-2',
        timeoutMs: 1_000
    });
}

describe('rallar-bb-test wait result references', () => {
    it('pins a wait on a value an earlier command returned, and reports the resolved match', async () => {
        const runtime = createRuntimeWithSentMessage();
        await executeSend(runtime);
        const wait = toNackWait('nack-2', '"targetMsgId":"{resultCache.send-2.value.msgId}"');

        runtime.recordEvent(toNackEvent('msg-1'));
        const early = await runtime.execute(wait);
        runtime.recordEvent(toNackEvent('msg-2'));
        const pinned = await runtime.execute({ ...wait, commandId: 'nack-2-again' });

        expect(early.status).toBe('failed');
        expect(early.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_TIMEOUT');
        expect(pinned.status).toBe('ok');
        expect((pinned.value as RallarBlackBoxTestWaitResultValue).match.contains).toBe('"targetMsgId":"msg-2"');
    });

    it('refuses a wait whose reference names no string or number result value', async () => {
        const runtime = createRuntimeWithSentMessage();
        runtime.recordEvent(toNackEvent('msg-2'));

        const result = await runtime.execute(toNackWait('nack-unsent', '"targetMsgId":"{resultCache.send-9.value.msgId}"'));

        expect(result.status).toBe('failed');
        expect(result.error).toMatchObject({
            code: 'RALLAR_BLACK_BOX_WAIT_INVALID',
            details: { reference: 'resultCache.send-9.value.msgId' }
        });
    });

    it('keeps a literal brace that opens no result reference as text to match', async () => {
        const runtime = createRuntimeWithSentMessage();
        await executeSend(runtime);
        runtime.recordEvent(toNackEvent('msg-2'));

        const result = await runtime.execute(
            toNackWait('nack-literal', '{"kind":"control-admission","typeId":"al.control.nack.v1","targetMsgId":"{resultCache.send-2.value.msgId}"')
        );

        expect(result.status).toBe('ok');
        expect((result.value as RallarBlackBoxTestWaitResultValue).match.contains)
            .toBe('{"kind":"control-admission","typeId":"al.control.nack.v1","targetMsgId":"msg-2"');
    });

    it('refuses a wait whose reference resolves to an object', async () => {
        const runtime = createRuntimeWithSentMessage();
        await executeSend(runtime);
        runtime.recordEvent(toNackEvent('msg-2'));

        const result = await runtime.execute(toNackWait('nack-object', '"targetMsgId":"{resultCache.send-2.value}"'));

        expect(result.status).toBe('failed');
        expect(result.error).toMatchObject({
            code: 'RALLAR_BLACK_BOX_WAIT_INVALID',
            details: { reference: 'resultCache.send-2.value' }
        });
    });

    it('resolves the reference of an absence wait before it scans the buffered events', async () => {
        const runtime = createRuntimeWithSentMessage();
        await executeSend(runtime);
        runtime.recordEvent(toNackEvent('msg-2'));
        const absent = { ...toNackWait('nack-absent', '"targetMsgId":"{resultCache.send-2.value.msgId}"'), absent: true } as const;

        const violated = await runtime.execute(absent);
        const unresolved = await runtime.execute({
            ...absent,
            commandId: 'nack-absent-unsent',
            match: { ...absent.match, contains: '"targetMsgId":"{resultCache.send-9.value.msgId}"' }
        });

        expect(violated.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED');
        expect((violated.value as RallarBlackBoxTestWaitResultValue).match.contains).toBe('"targetMsgId":"msg-2"');
        expect(unresolved.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_INVALID');
    });
});
