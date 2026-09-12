import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

import {
    runAlmNativeObservationLifecycle,
    type AlmNativeObservationArtifact,
    type AlmNativeObservationLifecycleInput
} from './browser-alm-native-observation.ts';

const NATIVE_RECORDER_MODULE_URL = `/@fs${
    path.resolve('tests/playwright/rallar-black-box/browser-native-indexeddb-timing-recorder.ts')
}`;
const TARGET_DATABASE_NAME = 'ar-eye-hunter-al-runtime';

interface LifecycleTestState {
    artifact: AlmNativeObservationArtifact | null;
    scenarioRan: boolean;
    controlObservationScenarioFailed: boolean | null;
    closeRan: boolean;
}

test('restores the first participant when the second native recorder cannot start', async ({ context, page }) => {
    await page.goto('/');
    const closedPage = await context.newPage();
    await closedPage.goto('/');
    await closedPage.close();
    const state = createLifecycleTestState();

    await runAlmNativeObservationLifecycle({
        ...toLifecycleTestInput(page, closedPage, state),
        runScenario: async () => {
            state.scenarioRan = true;
            expect(await canReinstallNativeRecorder(page)).toBe(true);
        }
    });

    expect(state.scenarioRan).toBe(true);
    expect(state.closeRan).toBe(true);
    expect(state.controlObservationScenarioFailed).toBe(false);
    expect(state.artifact?.participants).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'sender', methodsRestored: true }),
        expect.objectContaining({ role: 'receiver', nativeTiming: null })
    ]));
    expect(state.artifact?.failures).toContainEqual(expect.objectContaining({
        role: 'receiver',
        stage: 'start',
        name: expect.any(String)
    }));
});

test('retains native evidence and the recipe error when participant teardown and observation writes fail', async ({ context, page }) => {
    await page.goto('/');
    const receiverPage = await context.newPage();
    await receiverPage.goto('/');
    const state = createLifecycleTestState();
    const recipeError = new Error('recipe failed');
    let observedError: Error | undefined;

    try {
        await runAlmNativeObservationLifecycle({
            ...toLifecycleTestInput(page, receiverPage, state),
            runScenario: async () => {
                state.scenarioRan = true;
                await writeTargetDatabaseValue(page);
                await receiverPage.close();
                throw recipeError;
            },
            writeNativeObservation: async (artifact) => {
                state.artifact = artifact;
                throw new Error('artifact write failed');
            },
            recordControlObservation: async (scenarioFailed) => {
                state.controlObservationScenarioFailed = scenarioFailed;
                throw new Error('control observation failed');
            }
        });
    }
    catch (error) {
        observedError = error instanceof Error ? error : new Error(String(error));
    }

    expect(observedError).toBe(recipeError);
    expect(state.scenarioRan).toBe(true);
    expect(state.controlObservationScenarioFailed).toBe(true);
    expect(state.closeRan).toBe(true);
    expect(state.artifact?.participants).toEqual(expect.arrayContaining([
        expect.objectContaining({
            role: 'sender',
            methodsRestored: true,
            nativeTiming: expect.objectContaining({
                capturedDatabaseNames: [TARGET_DATABASE_NAME]
            })
        }),
        expect.objectContaining({ role: 'receiver', nativeTiming: null })
    ]));
    expect(state.artifact?.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'receiver', stage: 'measurement-end', name: expect.any(String) }),
        expect.objectContaining({ role: 'receiver', stage: 'stop', name: expect.any(String) }),
        expect.objectContaining({ role: 'receiver', stage: 'snapshot', name: expect.any(String) })
    ]));
    expect(await canReinstallNativeRecorder(page)).toBe(true);
});

function createLifecycleTestState(): LifecycleTestState {
    return {
        artifact: null,
        scenarioRan: false,
        controlObservationScenarioFailed: null,
        closeRan: false
    };
}

function toLifecycleTestInput(
    senderPage: Page,
    receiverPage: Page,
    state: LifecycleTestState
): AlmNativeObservationLifecycleInput {
    return {
        runId: 'native-observation-lifecycle-test',
        carrier: 'rtc',
        scope: 'smoke',
        retry: 0,
        databaseName: TARGET_DATABASE_NAME,
        sampleCapacity: 50_000,
        recorderModuleUrl: NATIVE_RECORDER_MODULE_URL,
        sourceLabels: {
            runtime: 'test-runtime-label',
            instrumentation: 'test-instrumentation-label',
            servedSourceIdentity: 'unverified'
        },
        environment: {
            nodeVersion: process.version,
            platform: process.platform,
            architecture: process.arch,
            apiMode: 'test-label',
            apiBaseUrl: 'http://127.0.0.1:18080',
            spaBaseUrl: 'http://127.0.0.1:5176',
            workerCount: 1
        },
        participants: [
            { role: 'sender', agentId: 'sender-agent', page: senderPage },
            { role: 'receiver', agentId: 'receiver-agent', page: receiverPage }
        ],
        runScenario: async () => {
            state.scenarioRan = true;
        },
        writeNativeObservation: async (artifact) => {
            state.artifact = artifact;
        },
        recordControlObservation: async (scenarioFailed) => {
            state.controlObservationScenarioFailed = scenarioFailed;
        },
        closeRun: async () => {
            state.closeRan = true;
        }
    };
}

async function canReinstallNativeRecorder(page: Page): Promise<boolean> {
    return await page.evaluate(async (input) => {
        const timing: typeof import('./browser-native-indexeddb-timing-recorder.ts') = await import(input.moduleUrl);
        const recorder = new timing.NativeIndexedDbTimingRecorder(1, input.databaseName);
        recorder.start();
        recorder.stop();
        return recorder.methodsRestored;
    }, { moduleUrl: NATIVE_RECORDER_MODULE_URL, databaseName: TARGET_DATABASE_NAME });
}

async function writeTargetDatabaseValue(page: Page): Promise<void> {
    await page.evaluate(async (databaseName) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(databaseName, 1);
            request.addEventListener('upgradeneeded', () => {
                request.result.createObjectStore('entries', { keyPath: 'key' });
            });
            request.addEventListener('success', () => resolve(request.result), { once: true });
            request.addEventListener('error', () => reject(request.error), { once: true });
        });
        try {
            const transaction = database.transaction('entries', 'readwrite');
            transaction.objectStore('entries').put({ key: 'native-observation-test', value: 'bounded' });
            await new Promise<void>((resolve, reject) => {
                transaction.addEventListener('complete', () => resolve(), { once: true });
                transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
                transaction.addEventListener('error', () => reject(transaction.error), { once: true });
            });
        }
        finally {
            database.close();
        }
    }, TARGET_DATABASE_NAME);
}
