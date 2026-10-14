import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type { RallarBlackBoxEventHistory } from '../../../shared-test/rallar-bb-test/runtime/event-history.ts';
import type { RtcBaselineJson } from '../contracts/rtc-baseline-contracts.ts';
import {
    isRtcB06EventHistoryEqual
} from './to-rtc-b06-event-history.ts';
import {
    RTC_B06_JOURNAL_EVENT_KINDS,
    toRtcB06JournalHealth,
    toRtcB06JournalRow,
    toRtcB06JournalRuntimeRow
} from './to-rtc-b06-journal-runtime-row.ts';
import type { RtcB06BrowserRecordingReading } from './validate-rtc-b06-browser-recording.ts';
import { validateRtcB06JournalBoundaries } from './validate-rtc-b06-journal-evidence.ts';

export interface RtcB06JournalAgentProof {
    readonly agentId: string;
    readonly runId: string;
    readonly admissionCommandId: string;
    readonly healthCommandId: string;
    readonly initialHistory: RallarBlackBoxEventHistory;
    readonly terminalHistory: RallarBlackBoxEventHistory;
    readonly capturedRows: number;
    readonly countsAfterFirstHealth: RallarBlackBoxEventHistory['countsByKind'];
}

export interface RtcB06JournalProof {
    readonly bytes: number;
    readonly rows: number;
    readonly agents: readonly RtcB06JournalAgentProof[];
}

interface JournalAgentState {
    readonly boundary: RtcB06BrowserRecordingReading;
    readonly counts: Record<keyof RallarBlackBoxEventHistory['countsByKind'], number>;
    nextOrdinal: number;
    admissionFound: boolean;
    terminalFound: boolean;
}

const maximumRowBytes = 1024 * 1024;

export async function readRtcB06Journal(
    chunks: AsyncIterable<Uint8Array>,
    boundaries: readonly RtcB06BrowserRecordingReading[]
): Promise<Either<string, RtcB06JournalProof>> {
    const issues = validateRtcB06JournalBoundaries(boundaries);
    if (issues.length > 0) {
        return Either.ofLeft(issues.join('; '));
    }
    const journal = new RtcB06Journal(boundaries);
    try {
        for await (const chunk of chunks) {
            const appended = journal.append(chunk);
            if (appended.left !== undefined || appended.right !== null) {
                return appended.left !== undefined ? Either.ofLeft(appended.left) : Either.ofRight(appended.right!);
            }
        }
        return Either.ofLeft('journal-incomplete');
    }
    catch (cause) {
        return Either.ofLeft(`journal-read-failed: ${toError(cause).message}`);
    }
}

class RtcB06Journal {
    readonly #agents: JournalAgentState[];
    readonly #pending = new Uint8Array(maximumRowBytes);
    readonly #decoder = new TextDecoder('utf-8', { fatal: true });
    #pendingBytes = 0;
    #bytes = 0;
    #rows = 0;

    constructor(boundaries: readonly RtcB06BrowserRecordingReading[]) {
        this.#agents = boundaries.map((boundary) => {
            const capture = boundary.initialHistory.capture;
            if (capture.status !== 'continuous') {
                throw new Error('Journal construction requires admitted capture.');
            }
            return {
                boundary,
                counts: { event: 0, diagnostic: 0, message: 0, stats: 0, report: 0, result: 0, state: 0 },
                nextOrdinal: capture.start.ordinal,
                admissionFound: false,
                terminalFound: false
            };
        });
    }

    append(chunk: Uint8Array): Either<string, RtcB06JournalProof | null> {
        for (const byte of chunk) {
            this.#bytes++;
            if (byte !== 10) {
                if (this.#pendingBytes === maximumRowBytes) {
                    return Either.ofLeft('journal-row-too-large');
                }
                this.#pending[this.#pendingBytes++] = byte;
                continue;
            }
            const decoded = toRtcB06JournalRow(this.#decoder.decode(this.#pending.subarray(0, this.#pendingBytes)));
            this.#pendingBytes = 0;
            if (decoded.left !== undefined) {
                return Either.ofLeft(decoded.left);
            }
            const issue = this.#appendRow(decoded.right!);
            if (issue !== undefined) {
                return Either.ofLeft(issue);
            }
            this.#rows++;
            if (this.#agents.every((agent) => agent.terminalFound)) {
                return Either.ofRight({
                    bytes: this.#bytes,
                    rows: this.#rows,
                    agents: this.#agents.map(toJournalAgentProof)
                });
            }
        }
        return Either.ofRight(null);
    }

    #appendRow(row: Readonly<Record<string, RtcBaselineJson>>): string | undefined {
        const agent = this.#agents.find((candidate) => candidate.boundary.agentId === row.agentId);
        if (agent === undefined) {
            return 'journal-wrong-agent';
        }
        if (row.kind === 'step-result') {
            return this.#appendHealthMarker(agent, row);
        }
        const runtimeRow = toRtcB06JournalRuntimeRow(row, agent.boundary);
        if (runtimeRow.left !== undefined) {
            return runtimeRow.left;
        }
        if (runtimeRow.right == null) {
            return undefined;
        }
        const sequence = runtimeRow.right;
        const last = agent.boundary.currentHistory;
        if (
            sequence.runtimeId !== last.runtimeId || sequence.generation !== last.generation ||
            sequence.ordinal !== agent.nextOrdinal
        ) {
            return 'journal-ordinal-or-owner-mismatch';
        }
        agent.nextOrdinal++;
        if (sequence.ordinal > agent.boundary.initialHistory.totalEvents && sequence.ordinal <= last.totalEvents) {
            agent.counts[sequence.kind]++;
        }
        return undefined;
    }

    #appendHealthMarker(agent: JournalAgentState, row: Readonly<Record<string, RtcBaselineJson>>): string | undefined {
        if (
            typeof row.commandId !== 'string' || row.name !== row.commandId ||
            !['SUCCESS', 'FAILURE'].includes(String(row.status))
        ) {
            return 'journal-malformed-result-marker';
        }
        const boundary = agent.boundary;
        const initial = row.commandId === boundary.admissionCommandId;
        const terminal = row.commandId === boundary.healthCommandId;
        if (!initial && !terminal) {
            return undefined;
        }
        const history = toRtcB06JournalHealth(row);
        const expected = initial ? boundary.initialHistory : boundary.currentHistory;
        if (
            row.status !== 'SUCCESS' || row.action !== 'health' || !isRtcB06EventHistoryEqual(history, expected) ||
            (initial ? agent.admissionFound : agent.terminalFound || !agent.admissionFound)
        ) {
            return 'journal-health-marker-mismatch';
        }
        if (initial) {
            agent.admissionFound = true;
            return undefined;
        }
        if (
            agent.nextOrdinal <= expected.totalEvents ||
            RTC_B06_JOURNAL_EVENT_KINDS.some((kind) =>
                agent.counts[kind] !== expected.countsByKind[kind] - boundary.initialHistory.countsByKind[kind]
            )
        ) {
            return 'journal-incomplete-counts';
        }
        agent.terminalFound = true;
        return undefined;
    }
}

function toJournalAgentProof(agent: JournalAgentState): RtcB06JournalAgentProof {
    const boundary = agent.boundary;
    const capture = boundary.initialHistory.capture;
    if (capture.status !== 'continuous') {
        throw new Error('Journal proof requires admitted capture.');
    }
    return {
        agentId: boundary.agentId,
        runId: boundary.runId,
        admissionCommandId: boundary.admissionCommandId,
        healthCommandId: boundary.healthCommandId,
        initialHistory: boundary.initialHistory,
        terminalHistory: boundary.currentHistory,
        capturedRows: boundary.currentHistory.totalEvents -
            capture.start.ordinal + 1,
        countsAfterFirstHealth: { ...agent.counts }
    };
}
