import type { ControlRunToken } from
    '@shared-test/rallar-bb-test/control-snapshots.ts';
import { ControlRunManagerHttpError } from '../../control-run-manager.ts';
import type { ControlAuthorizedEndpoint } from './control-authorized-transport.ts';

type IssueRunTokenInput = Readonly<{
    runId: string;
    agentId: string;
    signal?: AbortSignal;
}>;

export type RecipeConsoleControlAgentLaunchApi = Readonly<{
    issueRunToken(input: IssueRunTokenInput): Promise<ControlRunToken>;
}>;

export function createRecipeConsoleControlAgentLaunchApi(input: Readonly<{
    baseUrl: string;
    endpoint: ControlAuthorizedEndpoint;
}>): RecipeConsoleControlAgentLaunchApi {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
    return {
        async issueRunToken(request) {
            const result = await input.endpoint.response(async fetchFn => {
                const path = `/runs/${encodeURIComponent(request.runId)}` +
                    `/agents/${encodeURIComponent(request.agentId)}/tokens`;
                const response = await fetchFn(`${baseUrl}${path}`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: '{}',
                    signal: request.signal,
                });
                if (!response.ok) {
                    throw new ControlRunManagerHttpError(
                        await response.text(),
                        response.status,
                        response.statusText,
                    );
                }
                return await response.json() as unknown;
            }, request.signal);
            return validateControlRunToken(
                result.value,
                request.runId,
                request.agentId,
            );
        },
    };
}

function validateControlRunToken(
    value: unknown,
    runId: string,
    agentId: string,
): ControlRunToken {
    const token = value && typeof value === 'object'
        ? value as Partial<ControlRunToken>
        : undefined;
    if (
        token?.runId !== runId ||
        token.agentId !== agentId ||
        typeof token.token !== 'string' ||
        token.token.trim().length === 0 ||
        typeof token.issuedAtEpochMs !== 'number' ||
        typeof token.expiresAtEpochMs !== 'number' ||
        !Number.isFinite(token.issuedAtEpochMs) ||
        !Number.isFinite(token.expiresAtEpochMs) ||
        token.expiresAtEpochMs <= token.issuedAtEpochMs
    ) {
        throw new Error(
            `Control token response does not match requested run ${runId} and agent ${agentId}.`,
        );
    }
    return token as ControlRunToken;
}
