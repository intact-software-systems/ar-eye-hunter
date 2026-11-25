import {
    expect,
    test,
    type Browser,
    type BrowserContext,
    type Page,
    type TestInfo
} from '@playwright/test';

import {
    createDirectorControl,
    runDirectorOrchestration,
    toDirectorRuntimeEventPayload
} from './director-orchestration-operations.ts';
import { DIRECTOR_ORCHESTRATION_TEST_TIMEOUT_MS } from './director-orchestration-test-timeouts.ts';
import { DIRECTOR_AGENT_PREFIXES } from './director-orchestration-waits.ts';
import {
    cleanupRallarPage,
    exportControlRunArtifacts,
    openBrowserControlAgent,
    readControlRun,
    readFullStackConfig,
    uniqueAgentId,
    uniqueGroupId,
    uniqueRunId
} from './full-stack-helpers.ts';

type AgentPrefix = typeof DIRECTOR_AGENT_PREFIXES[number];

interface AgentHandle {
    context: BrowserContext;
    page: Page;
    prefix: AgentPrefix;
    agentId: string;
    actor: string;
    readonly connection: string;
}

interface OpenAgentsInput {
    readonly browser: Browser;
    readonly runId: string;
    readonly groupId: string;
    readonly testInfo: TestInfo;
}

const config = readFullStackConfig();
const directorEnabled = booleanEnv('RALLAR_BLACK_BOX_DIRECTOR');

const hasDirectorConfig = config.enabled && directorEnabled;

test.describe('full-stack SPA-appointed director orchestration', () => {
    test.skip(
        !hasDirectorConfig,
        'Set RALLAR_BLACK_BOX_FULL_STACK=1 and RALLAR_BLACK_BOX_DIRECTOR=1 to run the full-stack director orchestration scenario.'
    );

    test('appoints A as director, relays B/C intents, snapshots, and marks stale without auto-election', async ({
        browser,
        request
    }, testInfo) => {
        test.setTimeout(DIRECTOR_ORCHESTRATION_TEST_TIMEOUT_MS);

        const runId = uniqueRunId(testInfo);
        const groupId = uniqueGroupId(testInfo);
        const agents = await openAgents({ browser, runId, groupId, testInfo });

        try {
            await runDirectorOrchestration({
                control: createDirectorControl(request, runId),
                room: {
                    apiBaseUrl: config.apiBaseUrl,
                    applicationId: config.applicationId,
                    workspaceId: config.workspaceId,
                    groupId
                },
                agents,
                topicId: `app.black-box.director.${Date.now()}`,
                intentIds: { B: `intent-b-${Date.now()}`, C: `intent-c-${Date.now()}` }
            });

            const run = await readControlRun(request, runId);
            const appointEvents = run.events.filter((event) =>
                toDirectorRuntimeEventPayload(event).topic === 'rallar.browser.director.appointed'
            );
            expect(appointEvents.map((event) => event.agentId)).toEqual([agents[0].agentId]);

            // The bundle keeps the latest 200 events, which the periodic heartbeats and snapshots fill, so the
            // early intent_received events (awaited above) can fall out of it; the later sync requests stay.
            const artifacts = await exportControlRunArtifacts(request, runId);
            expect(JSON.stringify(artifacts)).toContain('rallar.browser.director.sync_request_received');
            expect(JSON.stringify(artifacts)).toContain('rallar.browser.director.snapshot_received');
        }
        finally {
            await closeAgents(agents);
        }
    });
});

function booleanEnv(key: string): boolean {
    const normalized = process.env[key]?.trim().toLowerCase();
    return normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on';
}

async function openAgents(input: OpenAgentsInput): Promise<readonly [AgentHandle, AgentHandle, AgentHandle]> {
    const { browser, runId, groupId, testInfo } = input;
    const users = {
        A: config.userA,
        B: config.userB,
        C: config.userC
    } as const;
    const handles: AgentHandle[] = [];
    try {
        for (const prefix of DIRECTOR_AGENT_PREFIXES) {
            const agentId = uniqueAgentId(testInfo, `director-${prefix.toLowerCase()}`);
            const opened = await openBrowserControlAgent({
                browser,
                config,
                user: users[prefix],
                runId,
                agentId,
                groupId
            });
            handles.push({
                context: opened.context,
                page: opened.page,
                prefix,
                agentId,
                actor: users[prefix].actor,
                connection: `${agentId}-director`
            });
        }
        const [first, second, third] = handles;
        if (!first || !second || !third) {
            throw new Error('The director scenario requires three agents.');
        }
        return [first, second, third];
    }
    catch (error) {
        try {
            await closeAgents(handles);
        }
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Director acquisition and cleanup failed.', {
                cause: error
            });
        }
        throw error;
    }
}

async function closeAgents(agents: readonly AgentHandle[]): Promise<void> {
    await Promise.all(agents.map(async (agent) => {
        try {
            await cleanupRallarPage(agent.page);
        }
        finally {
            await agent.context.close();
        }
    }));
}
