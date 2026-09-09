import type { RallarBlackBoxTestRecord } from '../types.ts';

const AGENT_RESUME_STORAGE_KEY = 'rallar-bb-agent-resume';

export type AgentResumeWriteStatus = 'written' | 'failed' | 'unavailable';

export interface AgentResumeRecord {
    readonly runId: string;
    readonly agentId: string;
    readonly completedCommandIds: readonly string[];
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
    catch (_error) {
        return 'failed';
    }
}

export function takeAgentResumeRecord(
    runId: string,
    agentId: string
): AgentResumeRecord | undefined {
    const raw = takeStoredResumeRecord();
    if (raw === undefined) {
        return undefined;
    }

    const record = toResumeRecord(raw);
    return record?.runId === runId && record.agentId === agentId ? record : undefined;
}

function takeStoredResumeRecord(): string | undefined {
    const storage = globalThis.sessionStorage;
    if (!storage) {
        return undefined;
    }

    try {
        const raw = storage.getItem(AGENT_RESUME_STORAGE_KEY);
        storage.removeItem(AGENT_RESUME_STORAGE_KEY);
        return raw ?? undefined;
    }
    catch (_error) {
        return undefined;
    }
}

function toResumeRecord(raw: string): AgentResumeRecord | undefined {
    try {
        return decodeAgentResumeRecord(JSON.parse(raw));
    }
    catch (_error) {
        return undefined;
    }
}

function decodeAgentResumeRecord(value: unknown): AgentResumeRecord | undefined {
    if (!isResumeRecordShape(value)) {
        return undefined;
    }

    const { runId, agentId, completedCommandIds } = value;
    if (
        typeof runId !== 'string' ||
        typeof agentId !== 'string' ||
        !Array.isArray(completedCommandIds)
    ) {
        return undefined;
    }

    return {
        runId,
        agentId,
        completedCommandIds: completedCommandIds.filter((id): id is string => typeof id === 'string')
    };
}

function isResumeRecordShape(value: unknown): value is RallarBlackBoxTestRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
