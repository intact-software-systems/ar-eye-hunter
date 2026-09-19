import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createSpaBrowserRallarRuntime } from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';

import { facade, loadRuntime, resetFacade } from './browser-rallar-runtime-test-harness.ts';

beforeEach(resetFacade);
afterEach(() => vi.unstubAllGlobals());

it.each(['close', 'reset', 'failed-recipe', 'recipe.cancel'] as const)(
    'releases indefinite holds on %s while successful commands preserve them',
    async (cleanup) => {
        const pageRuntime = await loadRuntime();
        await pageRuntime.connect({
            connection: 'fault-owner',
            actor: 'alice',
            roomId: 'room',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret',
                applicationId: 'app',
                workspaceId: 'workspace',
                transport: 'messages.ws',
                typeId: 'held',
                topicId: 'topic',
                logoutOnClose: false,
                leaveRoomOnClose: false
            }
        });
        vi.stubGlobal('window', { __blackBoxRallar: pageRuntime });
        const runtime = createRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime() });
        const injected = await runtime.execute({
            kind: 'fault.inject',
            faultId: 'owned-hold',
            carrier: 'ws',
            match: { typeId: 'held' },
            action: 'not-ready',
            remaining: 'until-cleared'
        });
        expect(injected.ok, injected.error?.message).toBe(true);
        const frame = JSON.stringify(newALUnicastMessage(
            'sender',
            {
                topicId: 'topic',
                contextId: 'room',
                resourceId: 'resource'
            },
            'receiver',
            'held',
            {}
        ));
        await runtime.execute({ kind: 'health' });
        expect(facade.rallar.diagnostics.faults.decideSubmissionReadiness(frame)).toBe('not-ready');
        if (cleanup === 'failed-recipe') {
            const failed = await runtime.execute({
                kind: 'recipe.run',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'failure',
                    name: 'failure cleanup',
                    commands: [
                        { kind: 'assert', source: 'lastResult.ok', operator: 'equals', expected: false }
                    ]
                }
            });
            expect(failed.ok).toBe(false);
        }
        else {
            expect((await runtime.execute({ kind: cleanup })).ok).toBe(true);
        }
        expect(facade.rallar.diagnostics.faults.decideSubmissionReadiness(frame)).toBe('ready');
    }
);
