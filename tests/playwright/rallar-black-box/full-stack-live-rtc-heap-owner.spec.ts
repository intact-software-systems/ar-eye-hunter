import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { toError } from '@shared/resilience/to-error.ts';

import {
    apiBaseUrl,
    applicationId,
    CONTROL_BASE_URL,
    hasThreeAgentConfig,
    LIVE_RTC_SKIP_MESSAGE,
    LiveRtcAgentTrioStartupFailure,
    openAgentTrio,
    roomSeed,
    workspaceId,
    type LiveRtcAgentTrio
} from './live-rtc-agent-environment.ts';
import { closeLiveRtcBrowserAgentContexts } from './live-rtc-browser-agents.ts';
import { LiveRtcControlClient } from './live-rtc-control-client.ts';
import { createLiveRtcDeliveryOperations } from './live-rtc-delivery-operations.ts';
import { createLiveRtcFormationOperations } from './live-rtc-formation-operations.ts';
import {
    captureLiveRtcHeapSnapshot,
    createLiveRtcHeapDirectory,
    validateLiveRtcHeapDiagnostic,
    type LiveRtcHeapSnapshot
} from './live-rtc-heap-snapshot.ts';

interface HeapOwnerDiagnostic {
    readonly kind: 'diagnostic-only-E3-memory';
    readonly acceptanceEvidence: false;
    readonly sourceCommit: string;
    readonly sourceStatus: string;
    readonly node: string;
    readonly chromium: string;
    readonly runId: string;
    readonly groupId: string;
    readonly directory: string;
    readonly snapshots: LiveRtcHeapSnapshot[];
    readonly errors: string[];
    readonly cleanupErrors: string[];
    completedCycles: number;
    completed: boolean;
}

test('diagnostic-only E3 heap owners at settled cycles 0 and 20', async ({ browser, request }, testInfo) => {
    test.skip(
        process.env.RALLAR_BLACK_BOX_RTC_HEAP_DIAGNOSTIC !== '1',
        'Set RALLAR_BLACK_BOX_RTC_HEAP_DIAGNOSTIC=1 for local heap ownership diagnostics.'
    );
    test.skip(!hasThreeAgentConfig, LIVE_RTC_SKIP_MESSAGE);
    test.setTimeout(1_800_000);
    expect(validateLiveRtcHeapDiagnostic({
        apiMode: process.env.RALLAR_BLACK_BOX_API_MODE,
        baselineId: process.env.RALLAR_BLACK_BOX_RTC_BASELINE_ID,
        workers: testInfo.config.workers,
        retries: testInfo.project.retries
    })).toEqual([]);

    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const sourceStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
    const suffix = `${sourceCommit.slice(0, 12)}-${sourceStatus ? 'dirty' : 'clean'}-${Date.now()}`;
    const directory = createLiveRtcHeapDirectory(process.cwd(), suffix);
    const diagnostic: HeapOwnerDiagnostic = {
        kind: 'diagnostic-only-E3-memory',
        acceptanceEvidence: false,
        sourceCommit,
        sourceStatus,
        node: process.version,
        chromium: browser.version(),
        runId: `rtc-heap-owner-${suffix}`,
        groupId: `${roomSeed}-heap-${suffix}`,
        directory,
        snapshots: [],
        errors: [],
        cleanupErrors: [],
        completedCycles: 0,
        completed: false
    };
    const control = new LiveRtcControlClient({
        request,
        baseUrl: CONTROL_BASE_URL,
        monotonicNow: () => performance.now(),
        epochNow: () => Date.now(),
        diagnosticsOutDir: directory
    });
    const delivery = createLiveRtcDeliveryOperations({
        apiBaseUrl,
        applicationId,
        workspaceId,
        messagesRtcTypeId: 'manual.type',
        messagesRtcTopicId: 'manual.topic',
        formation: createLiveRtcFormationOperations()
    });
    const openHandles: LiveRtcControlClient.Agent[] = [];
    writeDiagnostic(diagnostic);
    try {
        const agents = await openAgentTrio(browser, {
            runId: diagnostic.runId,
            groupId: diagnostic.groupId,
            suffix,
            label: 'heap-owner'
        });
        openHandles.push(...agents);
        await delivery.setupGroupMembership({
            control,
            runId: diagnostic.runId,
            owner: agents[0],
            members: agents,
            groupId: diagnostic.groupId,
            suffix
        });
        const initialFormation = await delivery.runGroupFormation({
            control,
            runId: diagnostic.runId,
            agents,
            transport: 'messages.rtc',
            groupId: diagnostic.groupId,
            suffix: `${suffix}-initial`,
            readinessScope: 'all'
        });
        await captureCheckpoint(diagnostic, agents, 0);

        let currentSessionId = initialFormation.sessions.C;
        for (let cycle = 1; cycle <= 20; cycle += 1) {
            await control.executeOk({
                runId: diagnostic.runId,
                agentId: agents[2].agentId,
                commandId: `heap-close-c-${cycle}-${suffix}`,
                command: { kind: 'close' },
                timeoutMs: 45_000
            });
            await Promise.all(
                agents.slice(0, 2).map((agent) =>
                    control.waitForPeerAbsence({
                        runId: diagnostic.runId,
                        agent,
                        departedPeerIds: [currentSessionId],
                        suffix: `${suffix}-${cycle}`
                    })
                )
            );
            const reconnected = await delivery.reconnectAndWaitForPeerReadiness({
                control,
                runId: diagnostic.runId,
                reconnectingAgent: agents[2],
                survivingAgents: [agents[0], agents[1]],
                survivingSessionIds: [initialFormation.sessions.A, initialFormation.sessions.B],
                transport: 'messages.rtc',
                groupId: diagnostic.groupId,
                suffix: `${suffix}-${cycle}`
            });
            currentSessionId = reconnected.sessionId;
            diagnostic.completedCycles = cycle;
            writeDiagnostic(diagnostic);
        }
        await captureCheckpoint(diagnostic, agents, 20);
        diagnostic.completed = true;
    }
    catch (cause) {
        const failure = toError(cause);
        diagnostic.errors.push(failure.message);
        if (failure instanceof LiveRtcAgentTrioStartupFailure) {
            diagnostic.cleanupErrors.push(...failure.cleanupErrors.map((error) => error.message));
        }
        throw failure;
    }
    finally {
        const cleanupErrors = await closeLiveRtcBrowserAgentContexts(openHandles);
        diagnostic.cleanupErrors.push(...cleanupErrors.map((error) => error.message));
        writeDiagnostic(diagnostic);
        console.info(`Local-only heap diagnostic: ${directory}; completed cycles: ${diagnostic.completedCycles}`);
    }
    expect(diagnostic.cleanupErrors).toEqual([]);
});

async function captureCheckpoint(
    diagnostic: HeapOwnerDiagnostic,
    agents: LiveRtcAgentTrio,
    cycle: 0 | 20
): Promise<void> {
    for (const agent of agents) {
        const snapshot = await captureLiveRtcHeapSnapshot({
            session: await agent.page.context().newCDPSession(agent.page),
            path: join(diagnostic.directory, `${agent.prefix}-cycle-${cycle}.heapsnapshot`),
            pageId: agent.agentId,
            cycle,
            now: () => performance.now()
        });
        diagnostic.snapshots.push(snapshot);
        writeDiagnostic(diagnostic);
        expect(snapshot.captureErrors, `Heap capture failed for ${agent.prefix} at cycle ${cycle}`).toEqual([]);
        expect(snapshot.cleanupErrors, `Heap cleanup failed for ${agent.prefix} at cycle ${cycle}`).toEqual([]);
    }
}

function writeDiagnostic(diagnostic: HeapOwnerDiagnostic): void {
    writeFileSync(join(diagnostic.directory, 'diagnostic.json'), JSON.stringify(diagnostic, null, 2), { mode: 0o600 });
}
