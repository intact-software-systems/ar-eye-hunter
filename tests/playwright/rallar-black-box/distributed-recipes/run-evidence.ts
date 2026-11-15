import {
    type APIRequestContext,
    type ConsoleMessage,
    type Page,
    type TestInfo
} from '@playwright/test';

import { deriveDistributedRunWarningRegressionReport } from '../../../../apps/rallar-black-box/src/distributed-recipes.ts';
import {
    type ControlDistributedRunSnapshot,
    type ControlRunSnapshot
} from '../../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeControlDistributedRunSnapshot } from '../../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import {
    decodeFiniteNumber,
    decodeNonBlankText,
    decodeRecord
} from '../../../../packages/shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';

import { FULL_STACK_CONTROL_BASE_URL, readControlRun } from '../full-stack-helpers.ts';

interface ConsoleArtifactEntry {
    readonly agentId: string;
    readonly type: 'warning' | 'error' | 'pageerror';
    readonly text: string;
    readonly location?: ReturnType<ConsoleMessage['location']>;
    readonly atEpochMs: number;
    readonly knownHarmless: boolean;
}

interface CompactedRecipeStartResult {
    readonly agentId: string;
    readonly ok: boolean | undefined;
    readonly resultCount: number | undefined;
    readonly failureCount: number | undefined;
    readonly evidenceStatus: string | undefined;
    readonly payloadsOmitted: boolean;
    readonly retainedCommandCount: number | undefined;
}

interface RealtimeLoopStats {
    readonly agentId: string;
    readonly latestLoopCommandId: string | undefined;
    readonly plannedIterations: number | undefined;
    readonly completedIterations: number | undefined;
    readonly sendCount: number | undefined;
    readonly succeeded: number | undefined;
    readonly failed: number | undefined;
}

interface RetainedRealtimeRecipeEvidence {
    readonly compactedStartResults: readonly CompactedRecipeStartResult[];
    readonly loopStats: readonly RealtimeLoopStats[];
}

const HARMLESS_LIVE_CONSOLE_WARNING_PATTERNS: readonly RegExp[] = [
    /Unhandled WS message/i,
    /No callback for typeId/i,
    /Received data channel for different data channel name/i,
    /does not match peerId/i,
    /No channel for peer/i,
    /Ignoring self-connection attempt/i
];

export class DistributedRecipeConsoleRecorder {
    readonly #entries: ConsoleArtifactEntry[] = [];
    readonly #now: () => number;

    constructor(now: () => number) {
        this.#now = now;
    }

    getEntries(): readonly ConsoleArtifactEntry[] {
        return this.#entries;
    }

    watch(page: Page, agentId: string): void {
        page.on('console', (message) => this.observeConsole(message, agentId));
        page.on('pageerror', (error) => {
            this.#entries.push({
                agentId,
                type: 'pageerror',
                text: error.message,
                atEpochMs: this.#now(),
                knownHarmless: false
            });
        });
    }

    private observeConsole(message: ConsoleMessage, agentId: string): void {
        const type = message.type();
        if (type !== 'warning' && type !== 'error') {
            return;
        }
        const text = message.text();
        this.#entries.push({
            agentId,
            type,
            text,
            location: message.location(),
            atEpochMs: this.#now(),
            knownHarmless: isKnownHarmlessConsoleWarning(text)
        });
    }
}

export function toHighSeverityConsoleEntries(
    entries: readonly ConsoleArtifactEntry[]
): readonly ConsoleArtifactEntry[] {
    return entries.filter((entry) => entry.type === 'pageerror' || (entry.type === 'error' && !entry.knownHarmless));
}

function isKnownHarmlessConsoleWarning(text: string): boolean {
    return HARMLESS_LIVE_CONSOLE_WARNING_PATTERNS.some((pattern) => pattern.test(text));
}

export async function attachConsoleArtifacts(
    testInfo: TestInfo,
    entries: readonly ConsoleArtifactEntry[]
): Promise<void> {
    await testInfo.attach('distributed-live-console-warnings.json', {
        body: JSON.stringify(
            {
                entries,
                highSeverityEntries: toHighSeverityConsoleEntries(entries)
            },
            null,
            2
        ),
        contentType: 'application/json'
    });
}

export function toRetainedRealtimeRecipeEvidence(
    run: ControlRunSnapshot,
    distributedRun: ControlDistributedRunSnapshot
): RetainedRealtimeRecipeEvidence {
    return {
        compactedStartResults: toCompactedRecipeStarts(run, distributedRun),
        loopStats: distributedRun.targetAgentIds.map((agentId) => toLatestRealtimeLoopStats(run, agentId))
    };
}

function toCompactedRecipeStarts(
    run: ControlRunSnapshot,
    distributedRun: ControlDistributedRunSnapshot
): readonly CompactedRecipeStartResult[] {
    return distributedRun.commandLinks
        .filter((link) => link.phase === 'start')
        .map((link) => {
            const result = run.results.find((candidate) =>
                candidate.commandId === link.commandId &&
                candidate.agentId === link.agentId
            );
            const value = result ? decodeRecord(result.result?.value) : {};
            return {
                agentId: link.agentId,
                ok: result?.ok,
                resultCount: decodeFiniteNumber(value.resultCount),
                failureCount: decodeFiniteNumber(value.failureCount),
                evidenceStatus: decodeNonBlankText(decodeRecord(value.resultEvidence).status),
                payloadsOmitted: decodeRecord(value.resultEvidence).payloadsOmitted === true,
                retainedCommandCount: Array.isArray(value.results) ? value.results.length : undefined
            };
        });
}

function toLatestRealtimeLoopStats(run: ControlRunSnapshot, agentId: string): RealtimeLoopStats {
    const matchingStats = run.events.flatMap((event) => {
        if (event.agentId !== agentId || event.kind !== 'stats') {
            return [];
        }
        const runtimeEvent = decodeRecord(event.payload);
        const stats = decodeRecord(runtimeEvent.payload);
        const load = decodeRecord(stats.load);
        if (load.latestLoopCommandId !== 'rtc-realtime-position-loop') {
            return [];
        }
        const pacing = decodeRecord(load.latestPacing);
        const sends = decodeRecord(load.latestSends);
        return [{
            agentId,
            latestLoopCommandId: decodeNonBlankText(load.latestLoopCommandId),
            plannedIterations: decodeFiniteNumber(pacing.plannedIterations),
            completedIterations: decodeFiniteNumber(pacing.completedIterations),
            sendCount: decodeFiniteNumber(sends.sendCount),
            succeeded: decodeFiniteNumber(sends.succeeded),
            failed: decodeFiniteNumber(sends.failed)
        }];
    });
    return matchingStats.at(-1) ?? {
        agentId,
        latestLoopCommandId: undefined,
        plannedIterations: undefined,
        completedIterations: undefined,
        sendCount: undefined,
        succeeded: undefined,
        failed: undefined
    };
}

export async function attachDistributedRunSummary(
    request: APIRequestContext,
    testInfo: TestInfo,
    runId: string
): Promise<void> {
    const run = await readControlRun(request, runId);
    const distributedResponse = await request.get(`${FULL_STACK_CONTROL_BASE_URL}/distributed-runs`);
    const distributed = distributedResponse.ok()
        ? decodeDistributedRunList(await distributedResponse.json())
        : undefined;
    await testInfo.attach('distributed-recipe-run-summary.json', {
        body: JSON.stringify(
            {
                runId,
                agents: run.agents.map((agent) => ({
                    agentId: agent.agentId,
                    connected: agent.connected,
                    identity: agent.identity
                })),
                resultCount: run.results.length,
                eventCount: run.events.length,
                distributedRuns: distributed?.filter((item) => item.controlRunId === runId)
                    .map((item) => ({
                        distributedRunId: item.distributedRunId,
                        state: item.state,
                        targets: item.targetAgentIds,
                        failures: item.rollup.failures
                    }))
            },
            null,
            2
        ),
        contentType: 'application/json'
    });
}

export async function attachDistributedWarningRegressionReport(
    testInfo: TestInfo,
    name: string,
    report: ReturnType<typeof deriveDistributedRunWarningRegressionReport>
): Promise<void> {
    await testInfo.attach(`${name}.json`, {
        body: JSON.stringify(report, null, 2),
        contentType: 'application/json'
    });
}

function decodeDistributedRunList(value: unknown): readonly ControlDistributedRunSnapshot[] {
    const entries = decodeRecord(value).distributedRuns;
    if (!Array.isArray(entries)) {
        throw new Error('Distributed run listing omitted its runs.');
    }
    return entries.map((entry) =>
        decodeControlDistributedRunSnapshot(entry).fold(
            (issue) => {
                throw new Error(`Invalid distributed run listing: ${issue}`);
            },
            (snapshot) => snapshot
        )
    );
}
