import type { AnalyzeUploadFile } from './recipe-console-analyze-artifacts.ts';
import {
    ANALYZE_AGENT_ID,
    ANALYZE_BASE_EPOCH_MS,
    ANALYZE_CONTROL_RUN_ID,
    ANALYZE_RECIPE_ID,
    ANALYZE_ROUTE,
    createAnalyzeControlRun,
    createAnalyzeDistributedRun,
    createAnalyzeManifest
} from './recipe-console-analyze-run-data.ts';

export const PUBLICATION_ROUTE = ANALYZE_ROUTE;
export const PUBLICATION_AGENT_ID = ANALYZE_AGENT_ID;

const PUBLICATION_COMMAND_ID = 'pose-send';
const PUBLICATION_TOPIC_ID = 'room.pose';
const PUBLICATION_TYPE_ID = 'room.pose.v1';
const PUBLICATION_LANE_KEY = `${PUBLICATION_TOPIC_ID}/${PUBLICATION_TYPE_ID}`;

type PublicationStagingOutcome = 'staged' | 'superseded' | 'expired' | 'refused' | 'cancelled';

export interface PublicationDiagnosticRow {
    readonly outcome: PublicationStagingOutcome | 'opportunity';
    readonly message: string;
    readonly msgId?: string;
    readonly traceId?: string;
}

interface PublicationStagingData {
    readonly kind: 'publication-staging';
    readonly laneKey: string;
    readonly msgId: string;
    readonly traceId: string;
    readonly atMs: number;
    readonly outcome: PublicationStagingOutcome;
    readonly limit?: string;
}

interface PublicationOpportunityData {
    readonly kind: 'publication-opportunity';
    readonly laneKey: string;
    readonly atMs: number;
    readonly selected: number;
    readonly deferred: number;
    readonly expired: number;
    readonly bytes: number;
}

type PublicationEventData = PublicationStagingData | PublicationOpportunityData;

interface PublicationDiagnosticEvent {
    readonly kind: 'diagnostic';
    readonly protocolVersion: 1;
    readonly runId: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly eventId: string;
    readonly atEpochMs: number;
    readonly payload: {
        readonly diagnosticSchemaVersion: 1;
        readonly topic: string;
        readonly diagnosticTypeId: PublicationEventData['kind'];
        readonly severity: 'info' | 'warning';
        readonly transport: 'messages.rtc';
        readonly message: string;
        readonly typeId: string;
        readonly topicId: string;
        readonly data: PublicationEventData;
        readonly source: string;
    };
}

interface PublicationStagingFact {
    readonly outcome: PublicationStagingOutcome;
    readonly msgId: string;
    readonly traceId: string;
    readonly limit?: string;
}

const STAGING_FACTS: readonly PublicationStagingFact[] = [
    { outcome: 'staged', msgId: 'pose-msg-1', traceId: 'pose-trace-1' },
    { outcome: 'staged', msgId: 'pose-msg-2', traceId: 'pose-trace-2' },
    { outcome: 'superseded', msgId: 'pose-msg-1', traceId: 'pose-trace-1' },
    { outcome: 'refused', msgId: 'pose-msg-3', traceId: 'pose-trace-3', limit: 'staged-values' },
    { outcome: 'cancelled', msgId: 'pose-msg-4', traceId: 'pose-trace-4' },
    { outcome: 'expired', msgId: 'pose-msg-5', traceId: 'pose-trace-5' }
];

const OPPORTUNITY = { selected: 1, deferred: 0, expired: 1, bytes: 96 } as const;

const STAGING_MESSAGES: Readonly<Record<PublicationStagingOutcome, string>> = {
    staged: `Publication staged on ${PUBLICATION_LANE_KEY}.`,
    superseded: `Publication superseded on ${PUBLICATION_LANE_KEY}.`,
    expired: `Publication expired on ${PUBLICATION_LANE_KEY}.`,
    refused: `Publication refused on ${PUBLICATION_LANE_KEY}.`,
    cancelled: `Publication cancelled on ${PUBLICATION_LANE_KEY}.`
};

const OPPORTUNITY_MESSAGE = `Publication opportunity on ${PUBLICATION_LANE_KEY}: ` +
    `${OPPORTUNITY.selected} selected, ${OPPORTUNITY.deferred} deferred, ${OPPORTUNITY.expired} expired.`;

/** The Diagnostics metric counts warning and error rows; a refusal is the one warning. */
export const PUBLICATION_WARNING_COUNT = 1;

export const PUBLICATION_DIAGNOSTIC_ROWS: readonly PublicationDiagnosticRow[] = [
    ...STAGING_FACTS.slice(0, 3).map(toStagingRow),
    { outcome: 'opportunity', message: OPPORTUNITY_MESSAGE },
    ...STAGING_FACTS.slice(3).map(toStagingRow)
];

export function createPublicationLooseFiles(): readonly AnalyzeUploadFile[] {
    const analyzeManifest = createAnalyzeManifest();
    const manifest = {
        ...analyzeManifest,
        displayName: 'Paced live channel',
        recipes: analyzeManifest.recipes.map((entry) => ({
            ...entry,
            recipe: { ...entry.recipe, commands: [{ kind: 'health' as const, commandId: PUBLICATION_COMMAND_ID }] }
        }))
    };
    const analyzeRun = createAnalyzeDistributedRun();
    const distributedRun = {
        ...analyzeRun,
        manifest,
        commandLinks: analyzeRun.commandLinks.map((link) => ({ ...link, commandId: PUBLICATION_COMMAND_ID })),
        state: 'passed' as const,
        rollup: {
            state: 'passed' as const,
            ok: true,
            summary: {
                participants: 1,
                readyParticipants: 1,
                passedParticipants: 1,
                failedParticipants: 0,
                recipes: 1,
                passedRecipes: 1,
                failedRecipes: 0,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: 0
            },
            failures: []
        }
    };
    return [
        upload('distributed-run.json', JSON.stringify(distributedRun, null, 2), 'application/json'),
        upload('manifest.json', JSON.stringify(manifest, null, 2), 'application/json'),
        upload('control-run.json', JSON.stringify(createAnalyzeControlRun(), null, 2), 'application/json'),
        upload('results.jsonl', toJsonLines([PUBLICATION_HANDLE_RESULT]), 'application/x-ndjson'),
        upload('events.jsonl', toJsonLines(toDiagnosticEvents()), 'application/x-ndjson')
    ];
}

const PUBLICATION_HANDLE_RESULT = {
    resultKey: `result:${PUBLICATION_COMMAND_ID}`,
    runId: ANALYZE_CONTROL_RUN_ID,
    agentId: ANALYZE_AGENT_ID,
    recipeId: ANALYZE_RECIPE_ID,
    commandId: PUBLICATION_COMMAND_ID,
    status: 'SUCCESS',
    action: 'send',
    transport: 'rtc',
    startedAtEpochMs: ANALYZE_BASE_EPOCH_MS + 300,
    endedAtEpochMs: ANALYZE_BASE_EPOCH_MS + 800,
    durationMs: 500,
    result: {
        commandId: PUBLICATION_COMMAND_ID,
        kind: 'health',
        status: 'ok',
        ok: true,
        startedAtEpochMs: ANALYZE_BASE_EPOCH_MS + 300,
        endedAtEpochMs: ANALYZE_BASE_EPOCH_MS + 800,
        durationMs: 500,
        value: {
            handles: [
                { msgId: 'pose-msg-1', lifecycle: 'superseded' },
                { msgId: 'pose-msg-2', lifecycle: 'transport-accepted' }
            ]
        }
    }
};

function toStagingRow(fact: PublicationStagingFact): PublicationDiagnosticRow {
    return {
        outcome: fact.outcome,
        message: `${STAGING_MESSAGES[fact.outcome]} ${fact.msgId}`,
        msgId: fact.msgId,
        traceId: fact.traceId
    };
}

function toDiagnosticEvents(): readonly PublicationDiagnosticEvent[] {
    return PUBLICATION_DIAGNOSTIC_ROWS.map((row, index) => {
        const fact = STAGING_FACTS.find((candidate) =>
            candidate.msgId === row.msgId && candidate.outcome === row.outcome
        );
        const atMs = ANALYZE_BASE_EPOCH_MS + 400 + index * 50;
        const data: PublicationEventData = fact
            ? {
                kind: 'publication-staging',
                laneKey: PUBLICATION_LANE_KEY,
                msgId: fact.msgId,
                traceId: fact.traceId,
                atMs,
                outcome: fact.outcome,
                ...(fact.limit ? { limit: fact.limit } : {})
            }
            : { kind: 'publication-opportunity', laneKey: PUBLICATION_LANE_KEY, atMs, ...OPPORTUNITY };
        return {
            kind: 'diagnostic',
            protocolVersion: 1,
            runId: ANALYZE_CONTROL_RUN_ID,
            agentId: ANALYZE_AGENT_ID,
            commandId: PUBLICATION_COMMAND_ID,
            eventId: `publication-diagnostic-${index + 1}`,
            atEpochMs: atMs,
            payload: {
                diagnosticSchemaVersion: 1,
                topic: 'alm.publication',
                diagnosticTypeId: data.kind,
                severity: row.outcome === 'refused' ? 'warning' : 'info',
                transport: 'messages.rtc',
                message: row.message,
                typeId: PUBLICATION_TYPE_ID,
                topicId: PUBLICATION_TOPIC_ID,
                data,
                source: 'rallar.browser.messages'
            }
        };
    });
}

function toJsonLines(rows: readonly object[]): string {
    return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function upload(name: string, contents: string, mimeType: string): AnalyzeUploadFile {
    return { name, mimeType, buffer: Buffer.from(contents) };
}
