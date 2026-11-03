import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import type { BlackBoxRallarRuntimeInstallationTarget } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import { installSpaBrowserRallarEventBridge } from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import { createRoomJoinPartialFailureError } from '@shared-web/browser/rooms/room-group-state-workflows.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';

import { createGroupSnapshotFixture } from '../../shared-web/authoritative-group-fixtures.ts';
import { events, facade, loadRuntime, resetFacade } from './browser-rallar-runtime-test-harness.ts';

beforeEach(resetFacade);
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it('retains the snapshot-adoption cause in JSON diagnostics after room admission fails', async () => {
    const admitted = createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'default',
        groupId: 'room-1',
        sessionIds: ['session-1']
    });
    const cause = new StateSnapshotRevisionConflictError('Group', 30);
    const failure = createRoomJoinPartialFailureError(admitted, cause);
    facade.behavior.roomJoin.mockRejectedValue(failure);
    const runtime = await loadRuntime();
    onTestFinished(async () => {
        await runtime.close();
    });

    await expect(runtime.connect({
        connection: 'entry-recovery',
        roomId: 'room-1',
        rallar: { apiBaseUrl: 'https://api.example.test', username: 'alice', password: 'secret' }
    })).rejects.toBe(failure);

    const recorder = createDefaultRallarBlackBoxBrowserTestRuntime();
    const target: BlackBoxRallarRuntimeInstallationTarget = {};
    vi.stubGlobal('window', target);
    const restoreBridge = installSpaBrowserRallarEventBridge(recorder);
    onTestFinished(restoreBridge);
    for (const event of events) {
        await target.__blackBoxRallarEmit?.(event);
    }
    for (const topic of ['rallar.browser.connect.phase_failed', 'rallar.browser.connect_failed']) {
        const event = events.find((event) => event.topic === topic);
        expect(event).toBeDefined();
        const recorded = recorder.state().events.find((event) => event.topic === topic);
        expect(recorded).toBeDefined();
        expect(JSON.parse(JSON.stringify(recorded?.payload))).toMatchObject({
            error: {
                name: 'RallarRoomJoinPartialFailureError',
                cause: {
                    name: 'StateSnapshotRevisionConflictError',
                    message: 'Group snapshot revision conflict at revision 30',
                    properties: { entity: 'Group', revision: 30 },
                    cause: null
                }
            }
        });
    }
});
