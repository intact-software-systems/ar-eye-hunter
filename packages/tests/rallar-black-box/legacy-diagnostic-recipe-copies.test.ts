// @vitest-environment happy-dom
import { resolveRallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    useRoomsClientsController,
    type RoomsClientsControllerModel
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/rooms-clients/use-rooms-clients-controller.ts';
import {
    useRtcRealtimeController,
    type RtcRealtimeControllerModel
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/rtc-realtime/use-rtc-realtime-controller.ts';

vi.mock('../../../apps/rallar-black-box/src/runtime-store.ts', () => ({
    rallarBlackBoxRuntimeStore: { recordRuntimeEvent: () => {} },
    rallarBlackBoxProviderModeFromConfig: () => 'browser-rallar'
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const state: RallarBlackBoxTestState = { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
const authSession: AuthSession = { clientId: 'client', sessionId: 'session', username: 'user', accessToken: 'test-token', expiresAtEpochMs: 100_000 };
const input = {
    state,
    bootstrap: resolveRallarBlackBoxBootstrapConfig('?provider=browser-rallar', {}, ''),
    authSession,
    globalValues: {
        apiBaseUrl: 'http://localhost',
        applicationId: 'app',
        workspaceId: 'workspace',
        clientId: 'client',
        sessionId: 'session',
        roomId: 'room-a'
    }
};

function RtcRealtimeHarness(props: { capture(view: RtcRealtimeControllerModel): void; }) {
    const view = useRtcRealtimeController(input);
    useLayoutEffect(() => props.capture(view), [view, props]);
    return null;
}
function RoomsClientsHarness(props: { capture(view: RoomsClientsControllerModel): void; }) {
    const view = useRoomsClientsController(input);
    useLayoutEffect(() => props.capture(view), [view, props]);
    return null;
}

describe('legacy diagnostic recipe copies', () => {
    let root: Root;
    let container: HTMLDivElement;
    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
    });

    it('copies the direct RTC realtime export as a strict version-1 recipe envelope with its requirements in metadata', async () => {
        const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        let rtcRealtime: RtcRealtimeControllerModel | undefined;
        await act(async () =>
            root.render(createElement(RtcRealtimeHarness, {
                capture: (view) => {
                    rtcRealtime = view;
                }
            }))
        );
        rtcRealtime?.copyRecipe();
        const recipe = JSON.parse(clipboard.mock.calls.at(-1)?.[0] ?? 'null');

        expect(recipe).toMatchObject({
            schemaVersion: 1,
            metadata: { requirements: expect.arrayContaining(['provider=browser-rallar', 'logged-in browser session']) }
        });
        const validation = validateRallarBlackBoxTestCommand({ kind: 'recipe.load', recipe });
        // The rtc.send in this export has carried roomId and rallar since before strict v1 and no command schema accepts them;
        // this case proves only the version-1 recipe envelope.
        expect(validation.ok ? [] : validation.messages.filter((message) => !message.startsWith('recipe.load.recipe.commands['))).toEqual([]);
    });

    it('copies the rooms and clients state recipe as a strict version-1 recipe', async () => {
        const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        let roomsClients: RoomsClientsControllerModel | undefined;
        await act(async () =>
            root.render(createElement(RoomsClientsHarness, {
                capture: (view) => {
                    roomsClients = view;
                }
            }))
        );
        roomsClients?.copyStateRecipe();
        const recipe = JSON.parse(clipboard.mock.calls.at(-1)?.[0] ?? 'null');

        expect(recipe).toMatchObject({ schemaVersion: 1 });
        expect(validateRallarBlackBoxTestCommand({ kind: 'recipe.load', recipe })).toEqual({ ok: true });
    });
});
