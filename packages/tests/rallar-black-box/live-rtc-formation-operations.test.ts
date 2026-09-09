import { describe, expect, it } from 'vitest';
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
});
