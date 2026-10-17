import * as Playwright from '@playwright/test';
import {
    mkdtemp,
    readFile,
    rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import { runWithRallarReceiverPage } from '../../../tests/playwright/rallar-black-box/full-stack-helpers.ts';
import { writeCopyRepeatFinalState } from '../../../tests/playwright/rallar-black-box/write-copy-repeat-final-state.ts';

const expectedPayload = {
    topic: 'local.copy.repeat',
    marker: 'actual-copy-repeat',
    value: 61,
    roomRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' }
};

it('preserves an early receiver failure while cleaning pages that never reached the application', async () => {
    const browser = await Playwright.chromium.launch({ headless: true });
    const senderContext = await browser.newContext();
    const sender = await senderContext.newPage();
    const directory = await mkdtemp(path.join(tmpdir(), 'copy-repeat-evidence-'));
    const original = new Error('Receiver setup failed before sender login');
    let receiver: Playwright.Page | undefined;
    try {
        const running = runWithRallarReceiverPage({
            browser,
            sender,
            run: async (page) => {
                receiver = page;
                throw original;
            },
            captureEvidence: async () =>
                await writeCopyRepeatFinalState({
                    sender,
                    observer: undefined,
                    groupId: 'room',
                    expectedPayload,
                    testInfo: { outputPath: (...parts) => path.join(directory, ...parts), attach: async () => {} }
                })
        });
        await expect(running).rejects.toBe(original);
        expect(receiver?.isClosed()).toBe(true);
        expect(sender.isClosed()).toBe(false);
        expect(browser.contexts()).toEqual([senderContext]);
        expect(JSON.parse(await readFile(path.join(directory, 'actual-copy-repeat-final-state.json'), 'utf8'))).toEqual({
            groupId: 'room',
            expectedPayload,
            senderState: { status: 'not-reached', reason: 'sender-not-initialized', url: 'about:blank' },
            received: { status: 'not-reached', reason: 'observer-not-registered' }
        });
    }
    finally {
        await senderContext.close();
        await browser.close();
        await rm(directory, { recursive: true, force: true });
    }
});

it.each(['available', 'receiver-closed', 'sender-store-failure', 'receiver-closed-and-attachment-failed'] as const)(
    'retains each available side in the final JSON packet when capture is %s',
    async (capture) => {
        const browser = await Playwright.chromium.launch({ headless: true });
        const context = await browser.newContext();
        const directory = await mkdtemp(path.join(tmpdir(), 'copy-repeat-evidence-'));
        const attachmentFailure = new Error('Artifact attachment failed');
        const receiverClosed = capture === 'receiver-closed' || capture === 'receiver-closed-and-attachment-failed';
        try {
            const sender = await context.newPage();
            await sender.route('http://copy-repeat.test/**', (route) =>
                route.fulfill({
                    status: 200,
                    contentType: route.request().url().endsWith('/src/runtime-store.ts') ? 'text/javascript' : 'text/html',
                    body: capture === 'sender-store-failure'
                        ? 'throw new Error("Sender runtime unavailable");'
                        : route.request().url().endsWith('/src/runtime-store.ts')
                        ? 'export const rallarBlackBoxRuntimeStore = { getSnapshot: () => ({ state: { commandHistory: [], events: [] } }) };'
                        : '<title>Copy repeat sender</title>'
                }));
            await sender.goto('http://copy-repeat.test/');
            const receiver = await context.newPage();
            const observer = await receiver.evaluateHandle(() => ({ records: [], targets: [], unsubscribe() {} }));
            if (receiverClosed) {
                await receiver.close();
            }
            const writing = writeCopyRepeatFinalState({
                sender,
                observer,
                groupId: 'room',
                expectedPayload,
                testInfo: {
                    outputPath: (...parts) => path.join(directory, ...parts),
                    attach: async () => {
                        if (capture === 'receiver-closed-and-attachment-failed') {
                            throw attachmentFailure;
                        }
                    }
                }
            });
            if (capture === 'available') {
                await expect(writing).resolves.toBeUndefined();
            }
            else {
                await expect(writing).rejects.toBeInstanceOf(Error);
            }
            const packet = JSON.parse(await readFile(path.join(directory, 'actual-copy-repeat-final-state.json'), 'utf8'));
            expect(packet.groupId).toBe('room');
            expect(packet.expectedPayload).toEqual(expectedPayload);
            if (capture === 'sender-store-failure') {
                expect(packet.senderState).toEqual({
                    status: 'unavailable',
                    reason: 'capture-failed',
                    error: expect.stringContaining('Sender runtime unavailable')
                });
            }
            else {
                expect(packet.senderState).toEqual({ commandHistory: [], events: [] });
            }
            if (receiverClosed) {
                expect(packet.received).toMatchObject({ status: 'unavailable', reason: 'capture-failed', error: expect.stringContaining('closed') });
            }
            else {
                expect(packet.received).toEqual({ records: [], targetStates: [] });
            }
            if (capture === 'receiver-closed-and-attachment-failed') {
                await expect(writing).rejects.toBeInstanceOf(AggregateError);
                await expect(writing).rejects.toMatchObject({
                    cause: { message: expect.stringContaining('closed') },
                    errors: expect.arrayContaining([attachmentFailure])
                });
            }
        }
        finally {
            await context.close();
            await browser.close();
            await rm(directory, { recursive: true, force: true });
        }
    }
);
