// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    type ControlClientEnvelope,
    type ControlCommandEnvelope,
    type ControlRegisterEnvelope,
    type ControlResultEnvelope
} from '../../shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestRecord } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
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

function createReloadAgent(sockets: FakeControlSocket[]): RallarBlackBoxBrowserControlAgent {
    const runtime = createRallarBlackBoxTestRuntime();
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

    it('registers a rebooted agent with the resumed command ids and clears the record', async () => {
        writeAgentResumeRecord({
            runId: 'run-reload',
            agentId: 'agent-reload',
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
