// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    takeAgentResumeRecord,
    writeAgentResumeRecord,
    type AgentResumeRecord
} from '../../shared-test/rallar-bb-test/alm/browser-control-agent-resume.ts';
import { createRallarBlackBoxBrowserControlAgent } from '../../shared-test/rallar-bb-test/browser-control-agent.ts';
import type {
    ControlClientEnvelope,
    ControlCommandEnvelope,
    ControlRegisterEnvelope,
    ControlResultEnvelope
} from '../../shared-test/rallar-bb-test/control-protocol.ts';

const RESUME_KEY = 'rallar-bb-agent-resume';
const SEARCH = '?mode=control&provider=simulated&autoConnect=1&controlUrl=ws%3A%2F%2Fcontrol.example.test%2Fcontrol&runId=run-reload&agentId=agent-reload';

type SocketEvent = Readonly<{ data?: string; }>;
type SocketListener = (event: SocketEvent) => void;

class FakeControlSocket {
    readyState = 0;
    readonly sent: string[] = [];
    private readonly listeners = new Map<string, Set<SocketListener>>();

    addEventListener(type: string, listener: SocketListener): void {
        const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: SocketListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this.readyState = 3;
    }

    open(): void {
        this.readyState = 1;
        this.listeners.get('open')?.forEach((listener) => listener({}));
    }

    message(data: string): void {
        this.listeners.get('message')?.forEach((listener) => listener({ data }));
    }
}

function stubWebSockets(): FakeControlSocket[] {
    const sockets: FakeControlSocket[] = [];
    vi.stubGlobal('WebSocket', function FakeWebSocket (_url: string) {
        const socket = new FakeControlSocket();
        sockets.push(socket);
        return socket;
    });
    return sockets;
}

function toEnvelopes(sent: readonly string[]): ControlClientEnvelope[] {
    return sent.map((serialized) => JSON.parse(serialized) as ControlClientEnvelope);
}

function resultsFor(sent: readonly string[], commandId: string): ControlResultEnvelope[] {
    return toEnvelopes(sent).filter((envelope): envelope is ControlResultEnvelope => envelope.kind === 'result' && envelope.commandId === commandId);
}

function registersFrom(sent: readonly string[]): ControlRegisterEnvelope[] {
    return toEnvelopes(sent).filter((envelope): envelope is ControlRegisterEnvelope => envelope.kind === 'register');
}

function reloadCommandEnvelope(commandId: string): ControlCommandEnvelope {
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

function readStoredResumeRecord(): AgentResumeRecord | undefined {
    const raw = globalThis.sessionStorage.getItem(RESUME_KEY);
    return raw === null ? undefined : JSON.parse(raw) as AgentResumeRecord;
}

describe('browser control-agent reload', () => {
    beforeEach(() => {
        globalThis.sessionStorage.clear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('sends the agent.reload result before reloading and persists the resume record', async () => {
        const sockets = stubWebSockets();
        const sentAtReload: ControlClientEnvelope[][] = [];
        const agent = createRallarBlackBoxBrowserControlAgent({ search: SEARCH, env: {} });
        await agent.start();
        const socket = sockets[0];
        const reload = vi
            .spyOn(globalThis.location, 'reload')
            .mockImplementation(() => {
                sentAtReload.push(toEnvelopes(socket.sent));
            });
        socket.open();

        socket.message(JSON.stringify(reloadCommandEnvelope('reload-1')));
        await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

        // The result must already be on the wire when the page goes away.
        expect(resultsFor(socket.sent, 'reload-1')).toHaveLength(1);
        expect(sentAtReload[0].filter((envelope) => envelope.kind === 'result' && envelope.commandId === 'reload-1')).toHaveLength(1);
        expect(resultsFor(socket.sent, 'reload-1')[0]).toMatchObject({
            ok: true,
            result: {
                status: 'ok',
                value: { reloading: true, readyTimeoutMs: 30_000 }
            }
        });

        const record = readStoredResumeRecord();
        expect(record?.runId).toBe('run-reload');
        expect(record?.agentId).toBe('agent-reload');
        expect(record?.completedCommandIds).toContain('reload-1');

        agent.dispose();
    });

    it('registers a rebooted agent with the resumed command ids and clears the record', async () => {
        writeAgentResumeRecord({
            runId: 'run-reload',
            agentId: 'agent-reload',
            completedCommandIds: ['configure-control-1', 'reload-1']
        });
        const sockets = stubWebSockets();
        const agent = createRallarBlackBoxBrowserControlAgent({ search: SEARCH, env: {} });

        await agent.start();
        sockets[0].open();

        const registers = registersFrom(sockets[0].sent);
        expect(registers).toHaveLength(1);
        expect(registers[0].resume.completedCommandIds).toContain('reload-1');
        expect(registers[0].resume.completedCommandIds).toContain('configure-control-1');
        expect(globalThis.sessionStorage.getItem(RESUME_KEY)).toBeNull();

        agent.dispose();
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
});
