import type { BlackBoxRallarEvent } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import {
    createBlackBoxRallarRuntime,
    installBlackBoxRallarRuntime,
    type BlackBoxRallarRuntimeInstallationTarget
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import {
    afterEach,
    beforeEach,
    expect,
    it,
    vi
} from 'vitest';
import { facade, resetFacade } from './browser-rallar-runtime-test-harness.ts';

beforeEach(() => {
    resetFacade();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('installs the composed runtime on the target browser window', () => {
    const targetWindow: BlackBoxRallarRuntimeInstallationTarget = {};

    const runtime = installBlackBoxRallarRuntime(targetWindow);

    expect(targetWindow.__blackBoxRallar).toBe(runtime);
});

it('creates an injectable runtime without installing a browser global', async () => {
    const factoryEvents: BlackBoxRallarEvent[] = [];
    const targetWindow: BlackBoxRallarRuntimeInstallationTarget = {
        __blackBoxRallarEmit: (event: BlackBoxRallarEvent) => {
            factoryEvents.push(event);
        }
    };
    const runtime = createBlackBoxRallarRuntime({
        facade: facade.rallar,
        targetWindow,
        clock: {
            now: () => 12_345
        },
        delay: async () => undefined
    });
    if (runtime.authenticate === undefined) {
        throw new Error('The injectable runtime did not expose authenticate.');
    }

    await runtime.authenticate({
        connection: 'factoryAuth',
        actor: 'alice',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret'
        }
    });

    expect(targetWindow.__blackBoxRallar).toBeUndefined();
    expect(factoryEvents.length).toBeGreaterThan(0);
    expect(factoryEvents.every((event) => event.atEpochMs === 12_345)).toBe(true);
});
