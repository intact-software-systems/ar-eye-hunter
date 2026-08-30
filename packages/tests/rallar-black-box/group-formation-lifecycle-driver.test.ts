import { describe, expect, it } from 'vitest';

import { createGroupFormationLifecycleDriver } from '../../../tests/playwright/rallar-black-box/group-formation-lifecycle-driver.ts';
import type {
    LiveRtcControlClient
} from '../../../tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts';
import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

interface CommandExecution {
    readonly agentId: string;
    readonly commandId: string;
    readonly command: LifecycleDriverCommand;
}

interface LifecycleDriverCommand {
    readonly kind?: string;
    readonly request?: LifecycleHttpRequest;
}

interface LifecycleHttpRequest {
    readonly path?: string;
    readonly body?: unknown;
}

interface GroupFormationTestPage {
    evaluate(pageFunction: () => Promise<void>): Promise<void>;
}

interface GroupFormationTestAgent {
    readonly prefix: 'A' | 'B' | 'C';
    readonly agentId: string;
    readonly actor: string;
    readonly connection: string;
    readonly page: GroupFormationTestPage;
}

function createAgent(prefix: 'A' | 'B' | 'C'): GroupFormationTestAgent {
    return {
        prefix,
        agentId: `agent-${prefix.toLowerCase()}`,
        actor: `actor-${prefix.toLowerCase()}`,
        connection: `connection-${prefix.toLowerCase()}`,
        page: {
            evaluate: async () => undefined
        }
    };
}

function lifecycleOperation(command: CommandExecution): string | undefined {
    return command.command.request?.path?.match(/\/lifecycle\/([^/]+)\//u)?.[1];
}

function successfulResult(value: RtcBaselineJson): LiveRtcControlClient.Result {
    return { ok: true, result: { value } };
}

function readResultValue(
    result: LiveRtcControlClient.Result
): { [key: string]: RtcBaselineJson; } {
    const value = result.result?.value;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
}

describe('group formation lifecycle driver', () => {
    it('waits through a removed layout until the receipt-owned active publication can connect', async () => {
        const commands: CommandExecution[] = [];
        const topologyStates: Array<'removed' | 'active'> = ['removed', 'active'];
        const control = {
            executeOk: async (input: CommandExecution): Promise<LiveRtcControlClient.Result> => {
                commands.push(input);
                if (input.command.kind === 'rtc.connect') {
                    return successfulResult({ sessionId: `session-${input.agentId.slice(-1)}` });
                }
                if (input.command.request?.path?.endsWith('/groups/group')) {
                    return successfulResult({ body: { group: { lifecycleState: 'forming' } } });
                }
                if (lifecycleOperation(input) === 'plan') {
                    return successfulResult({
                        body: {
                            group: { formationEpoch: 1 },
                            causalRevision: { groupRevision: 7 }
                        }
                    });
                }
                return successfulResult({});
            },
            executeResult: async (input: CommandExecution): Promise<LiveRtcControlClient.Result> => {
                commands.push(input);
                if (input.command.request?.path?.endsWith('/groups/group')) {
                    return successfulResult({ body: { causalRevision: { presenceRevision: 3 } } });
                }
                return successfulResult({
                    body: {
                        snapshot: {
                            sourceGroupStateCausalRevision: {
                                groupRevision: 7,
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

        expect(commands.find((command) => lifecycleOperation(command) === 'connect')).toMatchObject({
            command: {
                request: {
                    body: {
                        expectedFormationEpoch: 1,
                        expectedLayout: {
                            groupRevision: 7,
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
