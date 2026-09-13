import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { BrowserRtcAnswerCorrelationResult } from './browser-rtc-answer-correlation-fixture.ts';

for (const delayedOldAnswer of [false, true]) {
    test(
        delayedOldAnswer
            ? 'opens the replacement channel and delivers a payload after a captured retired answer'
            : 'opens the native control channel and delivers a payload with its current answer',
        async ({ page }, testInfo) => {
            await page.goto('/');
            const fixturePath = path.resolve(
                'tests/playwright/rallar-black-box/browser-rtc-answer-correlation-fixture.ts'
            );
            const result = await page.evaluate<
                BrowserRtcAnswerCorrelationResult,
                { moduleUrl: string; delayedOldAnswer: boolean; }
            >(
                async ({ moduleUrl, delayedOldAnswer }) => {
                    const fixture: typeof import('./browser-rtc-answer-correlation-fixture.ts') = await import(
                        moduleUrl
                    );
                    return await fixture.runBrowserRtcAnswerCorrelation(delayedOldAnswer);
                },
                { moduleUrl: `/@fs${fixturePath}`, delayedOldAnswer }
            );
            const observationPath = testInfo.outputPath('native-answer-observation.json');
            await writeFile(observationPath, JSON.stringify(result, null, 2));
            await testInfo.attach('native-answer-observation', {
                path: observationPath,
                contentType: 'application/json'
            });

            expect(result.channelState).toBe('open');
            expect(result.receivedPayload).toBe('current-answer-native-payload');
            expect(result).toMatchObject({
                delayedOldAnswer,
                distinctOfferIds: delayedOldAnswer,
                oldAnswerDelivered: delayedOldAnswer,
                signalingAfterOldAnswer: 'have-local-offer',
                oldDescriptionSelected: false,
                currentAnswerMatchesOffer: true,
                signalingAfterCurrentAnswer: 'stable',
                observationLimitMs: 5000,
                timedOut: false,
                cleanupErrors: []
            });
        }
    );
}
