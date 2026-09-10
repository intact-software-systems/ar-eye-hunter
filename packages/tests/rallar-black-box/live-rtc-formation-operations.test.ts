import { describe, expect, it, vi } from 'vitest';
import { createLiveRtcFormationOperations } from '../../../tests/playwright/rallar-black-box/live-rtc-formation-operations.ts';

const agentB = { agent: { prefix: 'B' as const }, suffix: 'lifecycle-1-uuid' };
const agentC = { agent: { prefix: 'C' as const }, suffix: 'lifecycle-1-uuid' };

describe('live RTC formation command ids', () => {
    // The control server answers a repeated commandId from its result map without dispatching
    // anything, so a reissued id reports the earlier execution while the agent is sent nothing.
    // Every scenario that retries, polls, or reopens a page depends on these being distinct.
    it('never repeats an id, however often the same command is issued to the same agent', () => {
        const operations = createLiveRtcFormationOperations();

        const issued = [
            operations.createCommandId(agentB, 'health'),
            operations.createCommandId(agentB, 'health'),
            operations.createCommandId(agentB, 'health')
        ];

        expect(new Set(issued).size).toBe(issued.length);
    });

    it('separates ids across agents, command names and operations instances', () => {
        const operations = createLiveRtcFormationOperations();
        const other = createLiveRtcFormationOperations();

        const sameAgentDifferentCommand = [
            operations.createCommandId(agentB, 'health'),
            operations.createCommandId(agentB, 'readiness')
        ];
        const differentAgents = [
            operations.createCommandId(agentB, 'connect'),
            operations.createCommandId(agentC, 'connect')
        ];

        expect(new Set([...sameAgentDifferentCommand, ...differentAgents]).size).toBe(4);
        // A second operations instance restarts its own count; the scenario suffix is what keeps two
        // parallel workers apart, so an id must still carry it.
        expect(other.createCommandId(agentB, 'health')).toContain('lifecycle-1-uuid');
    });

    it('still names the command and the agent it addresses', () => {
        const operations = createLiveRtcFormationOperations();

        const commandId = operations.createCommandId(agentB, 'presence');

        expect(commandId).toMatch(/^formation-presence-B-lifecycle-1-uuid-\d+$/u);
    });

    it('refreshes the exact room once before delegating formation readiness', async () => {
        const operations = createLiveRtcFormationOperations();
        const calls: string[] = [];
        const refreshRoom = vi.fn(async () => {
            calls.push('refresh');
        });
        const executeOk = vi.fn(async () => {
            calls.push('readiness');
            return {} as never;
        });
        const roomRef = {
            applicationId: 'application',
            workspaceId: 'workspace',
            groupId: 'room'
        };

        await operations.readiness({
            control: {
                executeOk,
                resultValue: () => ({
                    readyAtEpochMs: 1,
                    formation: { stage: 'active' }
                })
            },
            runId: 'run',
            agent: {
                prefix: 'A',
                agentId: 'agent-a',
                actor: 'alice',
                connection: 'connection-a',
                refreshRoom
            },
            roomRef,
            suffix: 'fresh-room',
            timeoutMs: 1_000
        });

        expect(calls).toEqual(['refresh', 'readiness']);
        expect(refreshRoom).toHaveBeenCalledOnce();
        expect(refreshRoom).toHaveBeenCalledWith({
            timeoutMs: expect.any(Number)
        });
        expect(executeOk).toHaveBeenCalledWith(
            expect.objectContaining({
                command: expect.objectContaining({
                    kind: 'formation.readiness',
                    roomId: roomRef.groupId,
                    applicationId: roomRef.applicationId,
                    workspaceId: roomRef.workspaceId,
                    timeoutMs: expect.any(Number)
                })
            })
        );
    });
});
