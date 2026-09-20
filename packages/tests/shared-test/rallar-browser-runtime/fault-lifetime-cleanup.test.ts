import {
    afterEach,
    beforeEach,
    expect,
    it,
    vi
} from 'vitest';

import { createSpaBrowserRallarRuntime } from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import type { RallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';

import {
    facade,
    loadRuntime,
    resetFacade
} from './browser-rallar-runtime-test-harness.ts';

const CONNECTION = {
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
} as const;

beforeEach(resetFacade);
afterEach(() => vi.unstubAllGlobals());

it.each(['close', 'reset', 'failed-recipe', 'recipe.cancel'] as const)(
    'releases indefinite holds on %s while successful commands preserve them',
    async (cleanup) => {
        const { runtime, frame } = await createHeldFaultRuntime();
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

it('targeted active recipe cleanup releases its real fault even when disconnect fails', async () => {
    const { runtime, frame } = await createHeldFaultRuntime();
    facade.behavior.disconnect.mockRejectedValueOnce(new Error('Disconnected resource failed.'));
    const started = Promise.withResolvers<void>();
    const unsubscribe = runtime.subscribe((state) => {
        if (state.activeCommand?.commandId === 'held-wait') {
            started.resolve();
        }
    });
    const running = runtime.execute({
        kind: 'recipe.run',
        commandId: 'held-root',
        recipe: {
            schemaVersion: 1,
            recipeId: 'held-recipe',
            continueOnFailure: false,
            commands: [{ kind: 'wait', commandId: 'held-wait', match: { topic: 'never' }, timeoutMs: 1_000 }]
        }
    });
    await started.promise;
    try {
        expect(facade.rallar.diagnostics.faults.decideSubmissionReadiness(frame)).toBe('not-ready');
        const cancellation = await runtime.execute({ kind: 'recipe.cancel', targetCommandId: 'held-root' });
        expect(cancellation.value).toMatchObject({ cancelRequested: true, targetCommandId: 'held-root' });
        expect((await running).status).toBe('cancelled');
        expect(facade.rallar.diagnostics.faults.decideSubmissionReadiness(frame)).toBe('ready');
        expect(runtime.state().events.some((event) => event.topic === 'rallar.bb.cleanup.resources_closed')).toBe(true);
    }
    finally {
        await running;
        unsubscribe();
    }
});

it('closes the exact idle successful prefix through its existing close operation', async () => {
    const { runtime, frame } = await createHeldFaultRuntime();
    const close = { kind: 'close' as const, targetCommandId: 'hold-prefix' };
    expect((await runtime.execute(close)).value).toMatchObject({ closed: true });
    expect(facade.rallar.diagnostics.faults.decideSubmissionReadiness(frame)).toBe('ready');
});

it.each(['idle-close', 'active-cancel', 'standalone-cancel'] as const)(
    'refuses new resource work while actual %s disconnect cleanup is pending',
    async (mode) => {
        const { runtime } = await createHeldFaultRuntime();
        const disconnectEntered = Promise.withResolvers<void>();
        const disconnectFinished = Promise.withResolvers<void>();
        facade.behavior.disconnect.mockImplementationOnce(async () => {
            disconnectEntered.resolve();
            await disconnectFinished.promise;
        });
        const waitEntered = Promise.withResolvers<void>();
        const unsubscribe = runtime.subscribe((state) => {
            if (state.activeCommand?.commandId === 'pending-wait' || (mode === 'standalone-cancel' && state.activeCommand?.commandId === 'active-owner')) {
                waitEntered.resolve();
            }
        });
        const active = mode === 'standalone-cancel'
            ? runtime.execute({ kind: 'wait', commandId: 'active-owner', match: { topic: 'never' }, timeoutMs: 1_000 })
            : mode === 'active-cancel'
            ? runtime.execute({
                kind: 'recipe.run',
                commandId: 'active-owner',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'active-owner',
                    continueOnFailure: false,
                    commands: [{ kind: 'wait', commandId: 'pending-wait', match: { topic: 'never' }, timeoutMs: 1_000 }]
                }
            })
            : undefined;
        if (active) {
            await waitEntered.promise;
        }
        const cleanup = mode === 'idle-close'
            ? runtime.execute({ kind: 'close', targetCommandId: 'hold-prefix' } as const)
            : runtime.execute({ kind: 'recipe.cancel', targetCommandId: 'active-owner' });
        await disconnectEntered.promise;
        try {
            const incoming = await runtime.execute({
                kind: 'fault.inject',
                commandId: 'new-resource',
                faultId: 'new-hold',
                carrier: 'ws',
                match: { typeId: 'new-held' },
                action: 'not-ready',
                remaining: 'until-cleared'
            });
            expect(facade.rallar.diagnostics.faults.decideSubmissionReadiness(toTestFrame('new-held'))).toBe('ready');
            expect(incoming.ok).toBe(false);
            expect(incoming.error?.code).toBe('RALLAR_BLACK_BOX_CLEANUP_IN_PROGRESS');
            const connectionCount = facade.records.connectionAttempts.length;
            const connection = await runtime.execute({ kind: 'rtc.connect', commandId: 'fenced-connect', ...CONNECTION });
            expect(connection.error?.code).toBe('RALLAR_BLACK_BOX_CLEANUP_IN_PROGRESS');
            expect(facade.records.connectionAttempts.length).toBe(connectionCount);
            expect((await runtime.execute({ kind: 'recipe.run', commandId: 'hold-prefix' })).replayed).toBe(true);
        }
        finally {
            disconnectFinished.resolve();
            await cleanup;
            await active;
            unsubscribe();
            try {
                expect((await runtime.execute({ kind: 'rtc.connect', commandId: 'fresh-connect', ...CONNECTION })).ok).toBe(true);
                expect(
                    (await runtime.execute({
                        kind: 'fault.inject',
                        commandId: 'fresh-fault',
                        faultId: 'fresh-hold',
                        carrier: 'ws',
                        match: { typeId: 'new-held' },
                        action: 'not-ready',
                        remaining: 'until-cleared'
                    })).ok
                ).toBe(true);
                expect(facade.rallar.diagnostics.faults.decideSubmissionReadiness(toTestFrame('new-held'))).toBe('not-ready');
            }
            finally {
                await runtime.execute({ kind: 'close' });
            }
        }
    }
);

interface HeldFaultRuntime {
    readonly runtime: RallarBlackBoxBrowserTestRuntime;
    readonly frame: string;
}

async function createHeldFaultRuntime(): Promise<HeldFaultRuntime> {
    const pageRuntime = await loadRuntime();
    await pageRuntime.connect(CONNECTION);
    vi.stubGlobal('window', { __blackBoxRallar: pageRuntime });
    const runtime = createRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime() });
    const injected = await runtime.execute({
        kind: 'recipe.run',
        commandId: 'hold-prefix',
        recipe: {
            schemaVersion: 1,
            recipeId: 'hold-prefix',
            continueOnFailure: false,
            commands: [{
                kind: 'fault.inject',
                faultId: 'owned-hold',
                carrier: 'ws',
                match: { typeId: 'held' },
                action: 'not-ready',
                remaining: 'until-cleared'
            }]
        }
    });
    expect(injected.ok, injected.error?.message).toBe(true);
    const frame = toTestFrame('held');
    return { runtime, frame };
}

function toTestFrame(typeId: string): string {
    return JSON.stringify(newALUnicastMessage(
        'sender',
        {
            topicId: 'topic',
            contextId: 'room',
            resourceId: 'resource'
        },
        'receiver',
        typeId,
        {}
    ));
}

it.each(['close', 'recipe.cancel'] as const)('refuses nested targeted %s without transferring cleanup ownership', async (kind) => {
    const { runtime, frame } = await createHeldFaultRuntime();
    try {
        const result = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'nested-owner',
            recipe: {
                schemaVersion: 1,
                recipeId: 'nested-owner',
                continueOnFailure: false,
                commands: [{ kind, targetCommandId: kind === 'close' ? 'hold-prefix' : 'nested-owner' }]
            }
        });
        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ results: [{ value: kind === 'close' ? { closed: false } : { cancelRequested: false } }] });
        expect(facade.rallar.diagnostics.faults.decideSubmissionReadiness(frame)).toBe('not-ready');
    }
    finally {
        await runtime.execute({ kind: 'close' });
    }
});

it('keeps idle ownership across refused cleanup and closes after an actual active-cancel refusal', async () => {
    const { runtime, frame } = await createHeldFaultRuntime();
    try {
        const refused = await runtime.execute({ kind: 'recipe.cancel', commandId: 'late-cancel', targetCommandId: 'hold-prefix' });
        expect(refused.value).toMatchObject({ cancelRequested: false });
        expect((await runtime.execute({ kind: 'close', commandId: 'wrong-close', targetCommandId: 'wrong-owner' })).value).toMatchObject({ closed: false });
        expect((await runtime.execute({ kind: 'close', targetCommandId: 'wrong-close' })).value).toMatchObject({ closed: false });
        expect((await runtime.execute({ kind: 'close', targetCommandId: 'late-cancel' })).value).toMatchObject({ closed: false });
        expect(facade.rallar.diagnostics.faults.decideSubmissionReadiness(frame)).toBe('not-ready');
        expect((await runtime.execute({ kind: 'close', targetCommandId: 'hold-prefix' })).value).toMatchObject({ closed: true });
        expect(facade.rallar.diagnostics.faults.decideSubmissionReadiness(frame)).toBe('ready');
    }
    finally {
        await runtime.execute({ kind: 'close' });
    }
});

it('consumes failed idle cleanup ownership and releases its admission fence', async () => {
    const { runtime } = await createHeldFaultRuntime();
    facade.behavior.disconnect.mockRejectedValueOnce(new Error('Close rejected.'));
    const failure = await runtime.execute({ kind: 'close', targetCommandId: 'hold-prefix' });
    expect(failure.ok).toBe(false);
    expect((await runtime.execute({ kind: 'close', targetCommandId: 'hold-prefix' })).value).toMatchObject({ closed: false });
    expect((await runtime.execute({ kind: 'stats', commandId: 'later-work' })).ok).toBe(true);
});

it('refuses a stale idle prefix after later successful work takes ownership', async () => {
    const { runtime, frame } = await createHeldFaultRuntime();
    try {
        await runtime.execute({ kind: 'health', commandId: 'later-owner' });
        const stale = await runtime.execute({ kind: 'close', targetCommandId: 'hold-prefix' });
        expect(stale.value).toMatchObject({ closed: false });
        expect(facade.rallar.diagnostics.faults.decideSubmissionReadiness(frame)).toBe('not-ready');
        expect((await runtime.execute({ kind: 'close', targetCommandId: 'later-owner' })).value).toMatchObject({ closed: true });
    }
    finally {
        await runtime.execute({ kind: 'close' });
    }
});
