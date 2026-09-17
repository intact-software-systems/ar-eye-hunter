import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestResult } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

const AGENT_RESUME_STORAGE_KEY = 'rallar-bb-agent-resume';

export type AgentResumeWriteStatus = 'written' | 'failed' | 'unavailable';

export interface AgentResumeRecord {
    readonly runId: string;
    readonly agentId: string;
    readonly completedCommandIds: readonly string[];
}

export interface AgentReloadResultInput {
    readonly commandId: string;
    readonly readyTimeoutMs: number;
    readonly written: AgentResumeWriteStatus;
    readonly atEpochMs: number;
}

export function writeAgentResumeRecord(record: AgentResumeRecord): AgentResumeWriteStatus {
    const storage = globalThis.sessionStorage;
    if (!storage) {
        return 'unavailable';
    }

    try {
        storage.setItem(AGENT_RESUME_STORAGE_KEY, JSON.stringify(record));
        return 'written';
    }
    catch {
        return 'failed';
    }
}

/** Taking the record removes it, so a reloaded agent resumes at most once, only into its own run, and never from an unreadable record. */
export function takeAgentResumeRecord(runId: string, agentId: string): AgentResumeRecord | undefined {
    const stored = takeStoredResumeRecord();
    if (stored === undefined) {
        return undefined;
    }

    const record = decodeAgentResumeRecord(stored).right;
    return record?.runId === runId && record.agentId === agentId ? record : undefined;
}

/** Without a persisted resume record the reloaded agent could not report what it already ran, so the command fails. */
export function toAgentReloadResult(input: AgentReloadResultInput): RallarBlackBoxTestResult {
    const base = {
        commandId: input.commandId,
        kind: 'agent.reload',
        startedAtEpochMs: input.atEpochMs,
        endedAtEpochMs: input.atEpochMs,
        durationMs: 0
    } as const;
    return input.written === 'written'
        ? { ...base, status: 'ok', ok: true, value: { reloading: true, readyTimeoutMs: input.readyTimeoutMs } }
        : {
            ...base,
            status: 'failed',
            ok: false,
            error: {
                code: 'RALLAR_BLACK_BOX_AGENT_RELOAD_UNAVAILABLE',
                message: 'Session storage is unavailable, so the agent cannot resume after a reload.',
                details: { sessionStorage: input.written, readyTimeoutMs: input.readyTimeoutMs }
            }
        };
}

function decodeAgentResumeRecord(stored: string): Either<string, AgentResumeRecord> {
    try {
        return decodeAgentResumeRecordValue(JSON.parse(stored));
    }
    catch {
        return Either.ofLeft('The stored agent resume record is not JSON.');
    }
}

function decodeAgentResumeRecordValue(value: unknown): Either<string, AgentResumeRecord> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('The stored agent resume record is not an object.');
    }

    const { runId, agentId, completedCommandIds } = value;
    return typeof runId === 'string' &&
            typeof agentId === 'string' &&
            Array.isArray(completedCommandIds) &&
            completedCommandIds.every((commandId): commandId is string => typeof commandId === 'string')
        ? Either.ofRight({ runId, agentId, completedCommandIds })
        : Either.ofLeft('The stored agent resume record needs a run id, an agent id and completed command ids.');
}

function takeStoredResumeRecord(): string | undefined {
    const storage = globalThis.sessionStorage;
    if (!storage) {
        return undefined;
    }

    try {
        const stored = storage.getItem(AGENT_RESUME_STORAGE_KEY);
        storage.removeItem(AGENT_RESUME_STORAGE_KEY);
        return stored ?? undefined;
    }
    catch {
        return undefined;
    }
}
