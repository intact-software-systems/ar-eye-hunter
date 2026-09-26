import { expect, test } from '@playwright/test';
import path from 'node:path';

const CLIENT_PATH = path.resolve(
    'tests/playwright/rallar-black-box/browser-alm-mixed-live-durable-client.ts'
);
const OBSERVER_PATH = path.resolve(
    'tests/playwright/rallar-black-box/browser-alm-mixed-live-durable-observer.ts'
);
const RALLAR_PATH = path.resolve('packages/shared-web/browser/rallar.ts');

test('rolls back an acquired durable subscription when live registration rejects', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async (input) => {
        const client: typeof import('./browser-alm-mixed-live-durable-client.ts') = await import(input.clientUrl);
        const observer: typeof import('./browser-alm-mixed-live-durable-observer.ts') = await import(input.observerUrl);
        const { rallar }: typeof import('../../../packages/shared-web/browser/rallar.ts') = await import(
            input.rallarUrl
        );
        const originalJoin = rallar.rooms.join;
        const originalSession = rallar.rooms.session;
        let durableUnsubscribeCount = 0;
        let rejectionName = '';
        let receiverPublished = false;
        const observation = observer.installMixedLiveDurableObservation({
            databaseName: `playwright-mixed-client-rollback-${crypto.randomUUID()}`,
            storeName: 'entries',
            durableTypeId: 'room.mixed-durable.v1',
            markedDurableIdentities: [],
            inboundNamespace: 'rollback:inbound:admission'
        });
        Reflect.set(rallar.rooms, 'join', async () => undefined);
        Reflect.set(rallar.rooms, 'session', () => ({
            roomRef: { applicationId: 'rollback-app', workspaceId: 'rollback-workspace', groupId: 'rollback-room' },
            message: () => ({
                onRtc: () => () => {
                    durableUnsubscribeCount += 1;
                }
            }),
            realtime: () => ({
                on: () => {
                    throw new DOMException('injected live registration failure', 'OperationError');
                }
            })
        }));
        try {
            await client.installMixedLiveDurableReceiver({
                roomId: 'rollback-room',
                durableTopicId: 'room.mixed-durable',
                durableTypeId: 'room.mixed-durable.v1',
                liveLaneId: 'mixed-live',
                timeoutMs: 1_000
            });
        }
        catch (error) {
            rejectionName = error instanceof Error ? error.name : 'UnknownFailure';
        }
        finally {
            receiverPublished = window.__rallarMixedReceiver !== undefined;
            Reflect.set(rallar.rooms, 'join', originalJoin);
            Reflect.set(rallar.rooms, 'session', originalSession);
            if (receiverPublished) {
                await client.disposeMixedLiveDurableClient();
            }
            else {
                observation.dispose();
            }
        }
        return {
            durableUnsubscribeCount,
            receiverPublished,
            rejectionName
        };
    }, {
        clientUrl: `/@fs${CLIENT_PATH}`,
        observerUrl: `/@fs${OBSERVER_PATH}`,
        rallarUrl: `/@fs${RALLAR_PATH}`
    });

    expect(result).toEqual({
        durableUnsubscribeCount: 1,
        receiverPublished: false,
        rejectionName: 'OperationError'
    });
});
