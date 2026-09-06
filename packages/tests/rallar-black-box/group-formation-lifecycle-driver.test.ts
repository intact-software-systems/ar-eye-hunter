import { describe, expect, it } from 'vitest';

import {
    createGroupFormationLifecycleDriver,
    type LiveRtcControlPort
} from '../../../tests/playwright/rallar-black-box/create-group-formation-lifecycle-driver.ts';
import type { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import type { LiveRtcJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';

function createAgent(prefix: LiveRtcControlClient.FormationAgent['prefix']): LiveRtcControlClient.FormationAgent {
    return {
        prefix,
        agentId: `agent-${prefix.toLowerCase()}`,
        actor: `actor-${prefix.toLowerCase()}`,
        connection: `connection-${prefix.toLowerCase()}`,
        refreshRoom: async () => undefined
    };
}

function lifecycleOperation(command: LiveRtcControlClient.ExecuteInput): string | undefined {
    return (command.command.kind === 'http.request' ? command.command.request.path : undefined)?.match(/\/lifecycle\/([^/]+)\//u)?.[1];
}

function successfulResult(
    input: LiveRtcControlClient.ExecuteInput,
    value: LiveRtcJsonRecord
): LiveRtcControlClient.Result {
    return {
        agentId: input.agentId,
        commandId: input.commandId,
        ok: true,
        result: { value }
    };
}

function readResultValue(
    result: LiveRtcControlClient.Result
): LiveRtcJsonRecord {
    const value = result.result?.value;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
}

describe('group formation lifecycle driver', () => {
    it('waits for exact current membership and accepts a newer active publication', async () => {
        const commands: LiveRtcControlClient.ExecuteInput[] = [];
        const topologyStates: Array<'removed' | 'active'> = ['removed', 'active'];
        const activeSessionIds = [
            ['stale-session', 'session-a'],
            ['session-a'],
            ['session-a', 'session-b'],
            ['session-a', 'session-b', 'session-c']
        ];
        const control: LiveRtcControlPort = {
            executeOk: async (input: LiveRtcControlClient.ExecuteInput): Promise<LiveRtcControlClient.Result> => {
                commands.push(input);
                if (input.command.kind === 'rtc.connect') {
                    return successfulResult(input, { sessionId: `session-${input.agentId.slice(-1)}` });
                }
                if (input.command.kind === 'http.request' && input.command.request.path?.endsWith('/groups/group')) {
                    return successfulResult(input, { body: { group: { lifecycleState: 'forming' } } });
                }
                if (lifecycleOperation(input) === 'plan') {
                    return successfulResult(input, {
                        body: {
                            group: { formationEpoch: 1 },
                            causalRevision: { groupRevision: 7 }
                        }
                    });
                }
                return successfulResult(input, {});
            },
            executeResult: async (input: LiveRtcControlClient.ExecuteInput): Promise<LiveRtcControlClient.Result> => {
                commands.push(input);
                if (input.command.kind === 'http.request' && input.command.request.path?.endsWith('/groups/group')) {
                    return successfulResult(input, {
                        body: {
                            causalRevision: { presenceRevision: 40 },
                            activeSessions: (activeSessionIds.shift() ?? []).map((sessionId) => ({ sessionId }))
                        }
                    });
                }
                return successfulResult(input, {
                    body: {
                        snapshot: {
                            sourceGroupStateCausalRevision: {
                                groupRevision: 8,
                                presenceRevision: 3
                            },
                            version: 4,
                            state: topologyStates.shift() ?? 'active',
                            activeSessionIds: ['session-a', 'session-b', 'session-c']
                        }
                    }
                });
            },
            resultValue: readResultValue,
            requireSessionId: (result: LiveRtcControlClient.Result) => {
                const sessionId = readResultValue(result).sessionId;
                if (typeof sessionId !== 'string' || sessionId.length === 0) {
                    throw new Error('Expected the formation agent session identifier.');
                }
                return sessionId;
            },
            readyPeerIds: () => [],
            waitForMessage: async () => 1,
            waitForPeerAbsence: async () => undefined,
            waitForPeerReadiness: async () => 1
        };
        const agents = [createAgent('A'), createAgent('B'), createAgent('C')] as const;
        const driver = createGroupFormationLifecycleDriver({
            apiBaseUrl: 'http://api.test',
            applicationId: 'application',
            workspaceId: 'workspace',
            messagesRtcTypeId: 'type',
            messagesRtcTopicId: 'topic'
        });

        await driver.run({
            control,
            runId: 'run',
            agents,
            transport: 'realtime',
            groupId: 'group',
            suffix: 'removed-layout',
            readinessScope: 'owner'
        });

        const presenceReads = commands.filter((command) => command.commandId.startsWith('group-presence-'));
        const connectBIndex = commands.findIndex((command) => command.agentId === 'agent-b' && command.command.kind === 'rtc.connect');
        expect(presenceReads).toHaveLength(4);
        expect(commands.indexOf(presenceReads[1])).toBeLessThan(connectBIndex);
        expect(commands.find((command) => lifecycleOperation(command) === 'connect')).toMatchObject({
            command: {
                request: {
                    body: {
                        expectedFormationEpoch: 1,
                        expectedLayout: {
                            groupRevision: 8,
                            presenceRevision: 3,
                            version: 4,
                            state: 'active'
                        }
                    }
                }
            }
        });
    });
});
