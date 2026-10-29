import 'fake-indexeddb/auto';
import {
    beforeEach,
    expect,
    it,
    onTestFinished
} from 'vitest';

import { decodeBlackBoxRallarMessageSendInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts';

import { facade, loadRuntime, resetFacade } from './browser-rallar-runtime-test-harness.ts';

const POLICY = { cadenceMs: 500, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } };
const SEND = {
    kind: 'messages.send',
    timeoutMs: 1_000,
    connection: 'aliceAlm',
    carrier: 'ws',
    typeId: 'alm.conformance',
    handleId: 'handle-1',
    payload: { n: 1 }
};
const CONNECTION = {
    connection: 'aliceAlm',
    actor: 'alice',
    roomId: 'room-1',
    rallar: {
        apiBaseUrl: 'https://api.example.test',
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        username: 'alice',
        password: 'secret'
    }
};

beforeEach(() => {
    resetFacade();
    const registry = facade.deliveries;
    onTestFinished(() => registry.releaseAll());
});

it('decodes a live send with its publication policy, and neither field on a send that names no purpose', () => {
    expect(decodeBlackBoxRallarMessageSendInput({ ...SEND, purpose: 'live', publication: POLICY }).right)
        .toMatchObject({ purpose: 'live', publication: POLICY });
    expect(decodeBlackBoxRallarMessageSendInput({ ...SEND, purpose: 'command' }).right)
        .toMatchObject({ purpose: 'command', publication: undefined });
    expect(decodeBlackBoxRallarMessageSendInput(SEND).right)
        .toMatchObject({ purpose: undefined, publication: undefined });
});

it.each([
    {
        name: 'a publication on a command',
        fields: { purpose: 'command', publication: POLICY },
        message: 'messages.send.publication is allowed only with purpose live.'
    },
    {
        name: 'a publication without a purpose',
        fields: { publication: POLICY },
        message: 'messages.send.publication is allowed only with purpose live.'
    },
    {
        name: 'a live send without a publication',
        fields: { purpose: 'live' },
        message: 'messages.send.purpose live requires a publication.'
    },
    {
        name: 'an unknown purpose',
        fields: { purpose: 'stream' },
        message: 'messages.send.purpose must be command, notification or live.'
    },
    {
        name: 'a publication outside its limits',
        fields: { purpose: 'live', publication: { ...POLICY, cadenceMs: 0 } },
        message: 'messages.send.publication.cadenceMs: Expected a positive safe integer of at most 60000.'
    }
])('refuses $name', ({ fields, message }) => {
    expect(decodeBlackBoxRallarMessageSendInput({ ...SEND, ...fields }).left).toEqual({ message });
});

it('refuses a purpose or a publication beside replayOnCarrier', () => {
    const replay = { connection: 'aliceAlm', timeoutMs: 100, replayOnCarrier: { handleId: 'handle-1', carrier: 'ws' } };

    expect(decodeBlackBoxRallarMessageSendInput({ ...replay, purpose: 'live', publication: POLICY }).left).toEqual({
        message: 'messages.send names purpose, publication beside replayOnCarrier; a replay names only the handle ' +
            'and its carrier.'
    });
});

it('opens a live send\'s channel with its purpose and publication, and a send without one by the toPeer rule', async () => {
    const runtime = await loadRuntime();
    onTestFinished(async () => {
        await runtime.close();
    });
    await runtime.connect(CONNECTION);
    const opensBefore = facade.records.typedChannelOpens.length;

    await runtime.sendMessage({ ...SEND, handleId: 'h-live', purpose: 'live', publication: POLICY, resourceId: 'pose-1' });
    await runtime.sendMessage({ ...SEND, handleId: 'h-room' });

    expect(facade.records.typedChannelOpens.slice(opensBefore).map(({ purpose, publication }) => ({ purpose, publication })))
        .toEqual([
            { purpose: 'live', publication: POLICY },
            { purpose: 'notification', publication: undefined }
        ]);
    expect(facade.records.typedSends.map(([, options]) => options?.resourceId)).toEqual(['pose-1', undefined]);
});
