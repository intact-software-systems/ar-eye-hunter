// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    toControlRecipeReloadCommands,
    type ControlRecipeReloadRoot
} from '../../../apps/rallar-black-box-control-server/src/recipe-reload/control-recipe-reload-commands.ts';
import {
    takeAgentResumeRecord,
    writeAgentResumeRecord
} from '../../shared-test/rallar-bb-test/alm/browser-control-agent-resume.ts';
import { resolveRallarBlackBoxBootstrapConfig } from '../../shared-test/rallar-bb-test/browser-control-agent-config.ts';
import {
    createRallarBlackBoxBrowserControlAgent,
    type RallarBlackBoxBrowserControlAgent
} from '../../shared-test/rallar-bb-test/browser-control-agent.ts';
import { decodeBrowserCommandRecord } from '../../shared-test/rallar-bb-test/browser/browser-command-values.ts';
import {
    RallarBlackBoxControlClient,
    type RallarBlackBoxControlSocketListener
} from '../../shared-test/rallar-bb-test/control-client.ts';
import {
    parseControlClientMessage,
    parseControlServerMessage,
    type ControlClientEnvelope,
    type ControlCommandEnvelope,
    type ControlRegisterEnvelope,
    type ControlResultEnvelope
} from '../../shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestRecord, RallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { createBrowserTestStorage } from './browser-test-storage.ts';

const RESUME_KEY = 'rallar-bb-agent-resume';
const SEARCH = '?mode=control&provider=simulated&autoConnect=1&controlUrl=ws%3A%2F%2Fcontrol.example.test%2Fcontrol&runId=run-reload&agentId=agent-reload';

class FakeControlSocket {
    readyState = 0;
    readonly sent: string[] = [];
    private readonly listeners = new Map<string, Set<RallarBlackBoxControlSocketListener>>();

    addEventListener(type: string, listener: RallarBlackBoxControlSocketListener): void {
        const listeners = this.listeners.get(type) ?? new Set<RallarBlackBoxControlSocketListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: RallarBlackBoxControlSocketListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    send(message: string): void {
        this.sent.push(message);
    }

    close(): void {
        this.readyState = 3;
    }

    open(): void {
        this.readyState = 1;
        this.listeners.get('open')?.forEach((listener) => listener({}));
    }

    publishMessage(messageText: string): void {
        this.listeners.get('message')?.forEach((listener) => listener({ data: messageText }));
    }
}

function createReloadAgent(
    sockets: FakeControlSocket[],
    runtime: RallarBlackBoxTestRuntime = createDefaultRallarBlackBoxTestRuntime()
): RallarBlackBoxBrowserControlAgent {
    const controlClient = new RallarBlackBoxControlClient({
        now: Date.now,
        runtime,
        webSocketFactory: () => {
            const socket = new FakeControlSocket();
            sockets.push(socket);
            return socket;
        },
        fetch: () => Promise.reject(new Error('The reload agent uploads no final report.')),
        heartbeatIntervalMs: 60_000,
        statsIntervalMs: 0,
        reconnectBaseMs: 600,
        reconnectMaxMs: 5_000
    });
    return createRallarBlackBoxBrowserControlAgent({
        bootstrap: resolveRallarBlackBoxBootstrapConfig(SEARCH, {}, ''),
        agentRuntime: { runtime },
        controlClient
    });
}

function toEnvelopes(sent: readonly string[]): ControlClientEnvelope[] {
    return sent.map((serialized) => {
        const parsed = parseControlClientMessage(serialized);
        if (!parsed.ok) {
            throw new Error(parsed.error);
        }
        return parsed.envelope;
    });
}

function toResultEnvelopes(sent: readonly string[], commandId: string): ControlResultEnvelope[] {
    return toEnvelopes(sent).filter((envelope): envelope is ControlResultEnvelope => envelope.kind === 'result' && envelope.commandId === commandId);
}

function toRegisterEnvelopes(sent: readonly string[]): ControlRegisterEnvelope[] {
    return toEnvelopes(sent).filter((envelope): envelope is ControlRegisterEnvelope => envelope.kind === 'register');
}

function toReloadCommandEnvelope(commandId: string): ControlCommandEnvelope {
    return {
        kind: 'command',
        protocolVersion: 1,
        runId: 'run-reload',
        agentId: 'agent-reload',
        commandId,
        command: {
            kind: 'agent.reload',
            readyTimeoutMs: 30_000
        }
    };
}

function readStoredResumeRecord(): RallarBlackBoxTestRecord | undefined {
    const raw = globalThis.sessionStorage.getItem(RESUME_KEY);
    return raw === null ? undefined : decodeBrowserCommandRecord(JSON.parse(raw));
}

describe('browser control-agent reload', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', createBrowserTestStorage());
        vi.stubGlobal('sessionStorage', createBrowserTestStorage());
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('sends the agent.reload result before reloading and persists the resume record', async () => {
        const sockets: FakeControlSocket[] = [];
        const sentAtReload: ControlClientEnvelope[][] = [];
        const agent = createReloadAgent(sockets);
        try {
            await agent.start();
            const socket = sockets[0];
            const reload = vi
                .spyOn(globalThis.location, 'reload')
                .mockImplementation(() => {
                    sentAtReload.push(toEnvelopes(socket.sent));
                });
            socket.open();

            socket.publishMessage(JSON.stringify(toReloadCommandEnvelope('reload-1')));
            await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

            // The result must already be on the wire when the page goes away.
            expect(toResultEnvelopes(socket.sent, 'reload-1')).toHaveLength(1);
            expect(sentAtReload[0].filter((envelope) => envelope.kind === 'result' && envelope.commandId === 'reload-1')).toHaveLength(1);
            expect(toResultEnvelopes(socket.sent, 'reload-1')[0]).toMatchObject({
                ok: true,
                result: {
                    status: 'ok',
                    value: { reloading: true, readyTimeoutMs: 30_000 }
                }
            });

            const record = readStoredResumeRecord();
            expect(record).toMatchObject({ runId: 'run-reload', agentId: 'agent-reload', completedCommandIds: expect.arrayContaining(['reload-1']) });
        }
        finally {
            agent.dispose();
        }
    });

    it.each(['configured', 'authored', 'run'] as const)(
        'preserves the admitted %s choice across an owned replacement without rewriting defaults',
        async (source) => {
            const root: ControlRecipeReloadRoot = {
                kind: 'command',
                protocolVersion: 1,
                runId: 'run-reload',
                agentId: 'agent-reload',
                commandId: 'history-reload-root',
                command: {
                    kind: 'recipe.run',
                    ...(source === 'run' ? { eventHistory: { mode: 'recent', maxEvents: 2 } as const } : {}),
                    recipe: {
                        schemaVersion: 1,
                        recipeId: 'history-reload',
                        continueOnFailure: false,
                        metadata: { profile: 'alm-conformance' },
                        ...(source === 'authored' ? { eventHistory: { mode: 'recent', maxEvents: 2 } as const } : {}),
                        ...(source === 'run' ? { eventHistory: { mode: 'full' } as const } : {}),
                        commands: [{ kind: 'health', commandId: 'before-health' }, { kind: 'agent.reload', commandId: 'replace', readyTimeoutMs: 30_000 }, {
                            kind: 'health',
                            commandId: 'after-health'
                        }]
                    }
                }
            };
            const segments = toControlRecipeReloadCommands(root);
            const sockets: FakeControlSocket[] = [];
            let agent = createReloadAgent(sockets);
            const reload = vi.spyOn(globalThis.location, 'reload').mockImplementation(() => {});
            try {
                await agent.start();
                sockets[0].open();
                if (source === 'configured') {
                    await executeAgentCommand(sockets[0], {
                        ...root,
                        commandId: 'configured-choice',
                        command: { kind: 'configure', config: { eventHistory: { mode: 'recent', maxEvents: 2 } } }
                    });
                }
                const prefix = await executeAgentCommand(sockets[0], segments[0]);
                const before = agent.getSnapshot().state.eventHistory;
                expect(prefix.result?.value).toMatchObject({ invocation: { eventHistory: { mode: 'recent', maxEvents: 2 } } });
                await executeAgentCommand(sockets[0], segments[1]);
                await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
                expect(readStoredResumeRecord()).toMatchObject({
                    recipeExecutions: {
                        'history-reload-root': {
                            selection: { policy: { mode: 'recent', maxEvents: 2 }, runOverride: source === 'run' }
                        }
                    }
                });
                agent.dispose();
                agent = createReloadAgent(sockets);
                await agent.start();
                sockets[1].open();
                const suffix = await executeAgentCommand(sockets[1], segments[2]);
                const after = agent.getSnapshot().state.eventHistory;
                expect(suffix.result?.value).toMatchObject({ invocation: { eventHistory: { mode: 'recent', maxEvents: 2 } } });
                expect(after.policy).toEqual({ mode: 'recent', maxEvents: 2 });
                expect(after.runtimeId).not.toBe(before.runtimeId);
                expect(before.generation).toBe(1);
                expect(after.generation).toBe(1);
                expect(segments[2].command.kind).toBe('recipe.run');
                if (segments[2].command.kind === 'recipe.run') {
                    expect(segments[2].command.eventHistory).toEqual(source === 'run' ? { mode: 'recent', maxEvents: 2 } : undefined);
                    expect(segments[2].command.recipe?.eventHistory).toEqual(
                        source === 'authored' ? { mode: 'recent', maxEvents: 2 } : source === 'run' ? { mode: 'full' } : undefined
                    );
                }
                const unrelated = await executeAgentCommand(sockets[1], {
                    ...root,
                    commandId: 'unrelated',
                    command: {
                        kind: 'recipe.run',
                        recipe: {
                            schemaVersion: 1,
                            recipeId: 'unrelated',
                            commands: [{ kind: 'health' }]
                        }
                    }
                });
                expect(unrelated.result?.value).toMatchObject({ invocation: { eventHistory: { mode: 'full' } } });
                await executeAgentCommand(sockets[1], toReloadCommandEnvelope('settled-reload'));
                await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
                expect(readStoredResumeRecord()?.recipeExecutions).toEqual({});
            }
            finally {
                agent.dispose();
            }
        }
    );

    it('preflights the accepted outer recipe before prefix effects when a suffix policy conflicts', async () => {
        const root: ControlRecipeReloadRoot = {
            kind: 'command',
            protocolVersion: 1,
            runId: 'run-reload',
            agentId: 'agent-reload',
            commandId: 'conflicting-root',
            command: {
                kind: 'recipe.run',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'conflicting',
                    eventHistory: { mode: 'recent', maxEvents: 2 },
                    continueOnFailure: false,
                    metadata: { profile: 'alm-conformance' },
                    commands: [
                        { kind: 'health', commandId: 'earlier-prefix' },
                        { kind: 'agent.reload', commandId: 'reload', readyTimeoutMs: 30_000 },
                        {
                            kind: 'recipe.run',
                            commandId: 'nested',
                            recipe: { schemaVersion: 1, recipeId: 'nested', eventHistory: { mode: 'full' }, commands: [{ kind: 'health' }] }
                        }
                    ]
                }
            }
        };
        const sockets: FakeControlSocket[] = [];
        const agent = createReloadAgent(sockets);
        try {
            await agent.start();
            sockets[0].open();
            const prefix = await executeAgentCommand(sockets[0], toControlRecipeReloadCommands(root)[0]);
            expect(prefix.ok).toBe(false);
            expect(agent.getSnapshot().state.resultCache['earlier-prefix']).toBeUndefined();
            expect(agent.getSnapshot().state.eventHistory.policy).toEqual({ mode: 'full' });
        }
        finally {
            agent.dispose();
        }
    });

    it('admits configured inheritance before a leading reload replaces the page', async () => {
        const root: ControlRecipeReloadRoot = {
            kind: 'command',
            protocolVersion: 1,
            runId: 'run-reload',
            agentId: 'agent-reload',
            commandId: 'leading-root',
            command: {
                kind: 'recipe.run',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'leading',
                    continueOnFailure: false,
                    metadata: { profile: 'alm-conformance' },
                    commands: [{ kind: 'agent.reload', commandId: 'leading-reload', readyTimeoutMs: 30_000 }, { kind: 'health', commandId: 'suffix-health' }]
                }
            }
        };
        const sockets: FakeControlSocket[] = [];
        let agent = createReloadAgent(sockets);
        const reload = vi.spyOn(globalThis.location, 'reload').mockImplementation(() => {});
        try {
            await agent.start();
            sockets[0].open();
            await executeAgentCommand(sockets[0], {
                ...root,
                commandId: 'configure-first',
                command: {
                    kind: 'configure',
                    config: { eventHistory: { mode: 'recent', maxEvents: 2 } }
                }
            });
            const segments = toControlRecipeReloadCommands(root);
            const admitted = await executeAgentCommand(sockets[0], segments[0]);
            expect(admitted.result?.value).toMatchObject({ invocation: { eventHistory: { mode: 'recent', maxEvents: 2 } } });
            await executeAgentCommand(sockets[0], segments[1]);
            await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
            agent.dispose();
            agent = createReloadAgent(sockets);
            await agent.start();
            sockets[1].open();
            const suffix = await executeAgentCommand(sockets[1], segments[2]);
            expect(suffix.result?.value).toMatchObject({ invocation: { eventHistory: { mode: 'recent', maxEvents: 2 } } });
        }
        finally {
            agent.dispose();
        }
    });

    it('refuses an unowned reload continuation before replacing the page', async () => {
        const sockets: FakeControlSocket[] = [];
        const agent = createReloadAgent(sockets);
        const reload = vi.spyOn(globalThis.location, 'reload').mockImplementation(() => {});
        try {
            await agent.start();
            sockets[0].open();
            const result = await executeAgentCommand(sockets[0], {
                ...toReloadCommandEnvelope('missing-continuation'),
                recipeExecution: { rootCommandId: 'unowned', first: false, last: false }
            });
            expect(result.ok).toBe(false);
            expect(result.result?.error?.code).toBe('RALLAR_BLACK_BOX_RELOAD_HISTORY_UNAVAILABLE');
            expect(reload).not.toHaveBeenCalled();
            expect(readStoredResumeRecord()).toBeUndefined();
        }
        finally {
            agent.dispose();
        }
    });

    it('releases an admitted non-final reload after resume storage fails', async () => {
        const sockets: FakeControlSocket[] = [];
        const agent = createReloadAgent(sockets);
        let replaced = false;
        vi.spyOn(globalThis.location, 'reload').mockImplementation(() => {
            replaced = true;
        });
        const segments = toControlRecipeReloadCommands(toOwnedReloadRoot('storage-root'));
        try {
            await agent.start();
            sockets[0].open();
            const prefix = await executeAgentCommand(sockets[0], segments[0]);
            expect(prefix.ok).toBe(true);
            expect(prefix.result?.value).toMatchObject({
                invocation: { eventHistory: { mode: 'recent', maxEvents: 2 }, segment: { start: 0, end: 1, first: true } }
            });
            const locked = await executeAgentCommand(sockets[0], toFullConfigureEnvelope('locked'));
            expect(locked.result?.error?.code).toBe('RALLAR_BLACK_BOX_HISTORY_POLICY_ACTIVE');
            const storage = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
                throw new Error('Owned storage failure.');
            });
            const reload = await executeAgentCommand(sockets[0], segments[1]);
            storage.mockRestore();
            expect(reload.result?.error?.code).toBe('RALLAR_BLACK_BOX_AGENT_RELOAD_UNAVAILABLE');
            expect(readStoredResumeRecord()).toBeUndefined();
            const configured = await executeAgentCommand(sockets[0], toFullConfigureEnvelope('released'));
            expect(configured.ok).toBe(true);
            const suffix = await executeAgentCommand(sockets[0], segments[2]);
            expect(suffix.result?.error?.code).toBe('RALLAR_BLACK_BOX_RELOAD_HISTORY_UNAVAILABLE');
            expect(agent.getSnapshot().state.resultCache['after-owned-reload']).toBeUndefined();
            const ordinary = await executeAgentCommand(sockets[0], {
                ...toReloadCommandEnvelope('ordinary'),
                command: { kind: 'recipe.run', recipe: { schemaVersion: 1, recipeId: 'ordinary', commands: [{ kind: 'health' }] } }
            });
            expect(ordinary.ok).toBe(true);
            expect(ordinary.result?.value).toMatchObject({ invocation: { eventHistory: { mode: 'full' } } });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(replaced).toBe(false);
        }
        finally {
            agent.dispose();
        }
    });

    it.each(['reset', 'recipe.cancel', 'close'] as const)('settles owned policy state on explicit %s', async (kind) => {
        const sockets: FakeControlSocket[] = [];
        const agent = createReloadAgent(sockets);
        const segments = toControlRecipeReloadCommands(toOwnedReloadRoot('cleanup-root'));
        try {
            await agent.start();
            sockets[0].open();
            const prefix = await executeAgentCommand(sockets[0], segments[0]);
            expect(prefix.ok).toBe(true);
            expect(prefix.result?.value).toMatchObject({
                invocation: { eventHistory: { mode: 'recent', maxEvents: 2 }, segment: { start: 0, end: 1, first: true } }
            });
            const locked = await executeAgentCommand(sockets[0], toFullConfigureEnvelope('locked'));
            expect(locked.result?.error?.code).toBe('RALLAR_BLACK_BOX_HISTORY_POLICY_ACTIVE');
            const cleanup = await executeAgentCommand(sockets[0], { ...toReloadCommandEnvelope('settle'), command: { kind } });
            expect(cleanup.ok).toBe(true);
            expect(cleanup.result?.value).toMatchObject(kind === 'reset' ? { reset: true } : kind === 'close' ? { closed: true } : { cancelRequested: true });
            const configured = await executeAgentCommand(sockets[0], toFullConfigureEnvelope('released'));
            expect(configured.ok).toBe(true);
            const suffix = await executeAgentCommand(sockets[0], segments[2]);
            expect(suffix.result?.error?.code).toBe('RALLAR_BLACK_BOX_RELOAD_HISTORY_UNAVAILABLE');
            expect(agent.getSnapshot().state.resultCache['after-owned-reload']).toBeUndefined();
        }
        finally {
            agent.dispose();
        }
    });

    it.each([{ mode: 'recent', maxEvents: 0 }, { mode: 'full', maxEvents: 2 }])('rejects malformed persisted execution policy %j', (policy) => {
        sessionStorage.setItem(
            RESUME_KEY,
            JSON.stringify({
                runId: 'run-reload',
                agentId: 'agent-reload',
                completedCommandIds: ['prefix'],
                recipeExecutions: { owned: { commandId: 'prefix', selection: { policy, runOverride: false } } }
            })
        );
        expect(takeAgentResumeRecord('run-reload', 'agent-reload')).toBeUndefined();
        expect(sessionStorage.getItem(RESUME_KEY)).toBeNull();
    });

    it.each([{ start: -1, end: 1, first: true }, { start: 0, end: 0, first: false }, { start: 0, end: 1.5, first: true }])(
        'refuses malformed owned segment %j at the wire boundary',
        (segment) => {
            const parsed = parseControlServerMessage(
                JSON.stringify({
                    ...toReloadCommandEnvelope('malformed'),
                    recipeExecution: { rootCommandId: 'owned', first: segment.first, last: false, segment }
                }),
                { runId: 'run-reload', agentId: 'agent-reload' }
            );
            expect(parsed.ok).toBe(false);
        }
    );

    it('releases a late settled range after disposal without retaining an outer policy lease', async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let atEpochMs = 0;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            now: () => atEpochMs,
            sleep: async () => {
                entered.resolve();
                await release.promise;
                atEpochMs = 1;
            }
        });
        const sockets: FakeControlSocket[] = [];
        const agent = createReloadAgent(sockets, runtime);
        try {
            await agent.start();
            sockets[0].open();
            sockets[0].publishMessage(
                JSON.stringify({
                    ...toReloadCommandEnvelope('pending'),
                    recipeExecution: { rootCommandId: 'late-root', first: true, last: false, segment: { start: 0, end: 1, first: true } },
                    command: {
                        kind: 'recipe.run',
                        eventHistory: { mode: 'recent', maxEvents: 2 },
                        recipe: {
                            schemaVersion: 1,
                            recipeId: 'late',
                            commands: [
                                { kind: 'wait', absent: true, timeoutMs: 1, match: { topic: 'forbidden', sinceEpochMs: 1 } },
                                { kind: 'health' }
                            ]
                        }
                    }
                })
            );
            await entered.promise;
            agent.dispose();
            release.resolve();
            await vi.waitFor(() => expect(runtime.state().resultCache.pending).toBeDefined());
            const configured = await runtime.execute({ kind: 'configure', config: { eventHistory: { mode: 'full' } } }, {
                controlIdentity: {
                    runId: 'run-reload',
                    agentId: 'agent-reload'
                }
            });
            expect(configured.status).toBe('ok');
            expect(readStoredResumeRecord()).toBeUndefined();
        }
        finally {
            release.resolve();
            agent.dispose();
        }
    });

    it('owns the accepted control address and resume ids against caller mutation', () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const socket = new FakeControlSocket();
        const client = new RallarBlackBoxControlClient({
            runtime,
            now: Date.now,
            webSocketFactory: () => socket,
            fetch: () => Promise.reject(new Error('No upload configured.')),
            heartbeatIntervalMs: 60_000,
            statsIntervalMs: 0,
            reconnectBaseMs: 600,
            reconnectMaxMs: 5_000
        });
        const connection = { url: 'ws://owned.test/control', runId: 'accepted-run', agentId: 'accepted-agent', completedCommandIds: ['accepted-prefix'] };
        try {
            client.connect(connection);
            Object.assign(connection, { runId: 'foreign-run', agentId: 'foreign-agent' });
            connection.completedCommandIds.push('borrowed-after-connect');
            socket.open();
            expect(toRegisterEnvelopes(socket.sent)[0]).toMatchObject({
                runId: 'accepted-run',
                agentId: 'accepted-agent',
                resume: { completedCommandIds: ['accepted-prefix'] }
            });
        }
        finally {
            client.dispose();
        }
    });

    it('registers a rebooted agent with the resumed command ids and clears the record', async () => {
        writeAgentResumeRecord({
            runId: 'run-reload',
            agentId: 'agent-reload',
            recipeExecutions: {},
            completedCommandIds: ['configure-control-1', 'reload-1']
        });
        const sockets: FakeControlSocket[] = [];
        const agent = createReloadAgent(sockets);
        try {
            await agent.start();
            sockets[0].open();

            const registers = toRegisterEnvelopes(sockets[0].sent);
            expect(registers).toHaveLength(1);
            expect(registers[0].resume.completedCommandIds).toContain('reload-1');
            expect(registers[0].resume.completedCommandIds).toContain('configure-control-1');
            expect(globalThis.sessionStorage.getItem(RESUME_KEY)).toBeNull();
        }
        finally {
            agent.dispose();
        }
    });

    it('does not resume a record written by a different run or agent', () => {
        writeAgentResumeRecord({
            runId: 'other-run',
            agentId: 'agent-reload',
            recipeExecutions: {},
            completedCommandIds: ['reload-1']
        });

        expect(takeAgentResumeRecord('run-reload', 'agent-reload')).toBeUndefined();
        expect(globalThis.sessionStorage.getItem(RESUME_KEY)).toBeNull();
    });

    it('treats a malformed resume record as no record at all', () => {
        globalThis.sessionStorage.setItem(RESUME_KEY, '{ not json');

        expect(takeAgentResumeRecord('run-reload', 'agent-reload')).toBeUndefined();

        globalThis.sessionStorage.setItem(
            RESUME_KEY,
            JSON.stringify({ runId: 'run-reload', agentId: 'agent-reload' })
        );

        expect(takeAgentResumeRecord('run-reload', 'agent-reload')).toBeUndefined();
    });

    it('does not resume a record whose completed command ids are not all text', () => {
        globalThis.sessionStorage.setItem(
            RESUME_KEY,
            JSON.stringify({ runId: 'run-reload', agentId: 'agent-reload', completedCommandIds: ['reload-1', 7] })
        );

        expect(takeAgentResumeRecord('run-reload', 'agent-reload')).toBeUndefined();
        expect(globalThis.sessionStorage.getItem(RESUME_KEY)).toBeNull();
    });
});

async function executeAgentCommand(socket: FakeControlSocket, envelope: ControlCommandEnvelope): Promise<ControlResultEnvelope> {
    socket.publishMessage(JSON.stringify(envelope));
    await vi.waitFor(() => expect(toResultEnvelopes(socket.sent, envelope.commandId)).toHaveLength(1));
    return toResultEnvelopes(socket.sent, envelope.commandId)[0];
}

function toOwnedReloadRoot(commandId: string): ControlRecipeReloadRoot {
    return {
        ...toReloadCommandEnvelope(commandId),
        command: {
            kind: 'recipe.run',
            eventHistory: { mode: 'recent', maxEvents: 2 },
            recipe: {
                schemaVersion: 1,
                recipeId: 'owned-reload',
                continueOnFailure: false,
                metadata: { profile: 'alm-conformance' },
                commands: [
                    { kind: 'health', commandId: 'before-owned-reload' },
                    { kind: 'agent.reload', commandId: 'owned-reload', readyTimeoutMs: 30_000 },
                    { kind: 'health', commandId: 'after-owned-reload' }
                ]
            }
        }
    };
}

function toFullConfigureEnvelope(commandId: string): ControlCommandEnvelope {
    return { ...toReloadCommandEnvelope(commandId), command: { kind: 'configure', config: { eventHistory: { mode: 'full' } } } };
}
