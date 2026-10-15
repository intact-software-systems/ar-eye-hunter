import type { ControlRunState } from './control-service-state.ts';

export interface ValidControlRunTokenInput {
    readonly run: ControlRunState | undefined;
    readonly agentId: string;
    readonly token: string | undefined;
    readonly nowEpochMs: number;
}

/** Whether any token issued to the agent for the run is still within its time to live. */
export function hasActiveControlRunToken(run: ControlRunState | undefined, agentId: string, nowEpochMs: number): boolean {
    return Array.from(run?.tokens.values() ?? [])
        .some((token) => token.agentId === agentId && token.expiresAtEpochMs > nowEpochMs);
}

/** Whether the presented token was issued to this agent for this run and is still within its time to live. */
export function isValidControlRunToken({ run, agentId, token, nowEpochMs }: ValidControlRunTokenInput): boolean {
    const stored = token === undefined ? undefined : run?.tokens.get(token);
    return stored !== undefined && stored.agentId === agentId && stored.expiresAtEpochMs > nowEpochMs;
}
