import type {
    AgentSessionTicketRequest,
    AgentSessionTicketResponse,
    AuthSession,
} from '@shared/api/api-config.ts';
import type { RallarBlackBoxProviderMode } from
    '@shared-test/rallar-bb-test/client-defaults.ts';
import type { ControlRunToken } from
    '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxDistributedGroupRef } from
    '@shared-test/rallar-bb-test/distributed-run.ts';
import { issueAgentSessionTicketsAt } from
    '@shared-web/browser/api-integration.ts';
import { createRunnerAgentLaunchUrl } from './runner-agent-launch.ts';

export type BrowserAgentLaunchRequest = Readonly<{
    runId: string;
    agentIds: readonly string[];
    signal?: AbortSignal;
}>;

export type PreparedBrowserAgentCohort = Readonly<{
    runId: string;
    group: RallarBlackBoxDistributedGroupRef;
    providerMode: RallarBlackBoxProviderMode;
    agents: readonly Readonly<{
        agentId: string;
        launchUrl: string;
        expiresAtEpochMs: number;
    }>[];
}>;

export type BrowserAgentLaunchService = Readonly<{
    prepare(input: BrowserAgentLaunchRequest): Promise<PreparedBrowserAgentCohort>;
}>;

type IssueRunToken = (input: Readonly<{
    runId: string;
    agentId: string;
    signal?: AbortSignal;
}>) => Promise<ControlRunToken>;

type IssueAgentTickets = (
    apiBaseUrl: string,
    request: AgentSessionTicketRequest,
    options: Readonly<{ authSession: AuthSession; signal?: AbortSignal }>,
) => Promise<AgentSessionTicketResponse>;

export function createBrowserAgentLaunchService(config: Readonly<{
    origin: string;
    providerMode: RallarBlackBoxProviderMode;
    controlWsUrl: string;
    apiBaseUrl: string;
    group: RallarBlackBoxDistributedGroupRef;
    authSession?: AuthSession;
    issueAgentSessions?: boolean;
    allowAnonymousControlToken?: boolean;
    issueRunToken: IssueRunToken;
    issueAgentTickets?: IssueAgentTickets;
}>): BrowserAgentLaunchService {
    return {
        async prepare(input) {
            const runId = requiredId(input.runId, 'Control run ID');
            const agentIds = validatedAgentIds(input.agentIds);
            const tickets = await issueTickets(config, agentIds, input.signal);
            const tokens = await Promise.all(agentIds.map(async agentId => {
                const token = await config.issueRunToken({
                    runId,
                    agentId,
                    signal: input.signal,
                });
                validateRunToken(
                    token,
                    runId,
                    agentId,
                    config.allowAnonymousControlToken === true,
                );
                return token;
            }));

            return {
                runId,
                group: config.group,
                providerMode: config.providerMode,
                agents: agentIds.map((agentId, index) => {
                    const ticket = tickets.get(agentId);
                    const token = tokens[index];
                    return {
                        agentId,
                        launchUrl: createRunnerAgentLaunchUrl({
                            origin: config.origin,
                            providerMode: config.providerMode,
                            controlWsUrl: config.controlWsUrl,
                            runId,
                            agentId,
                            groupId: config.group.groupId,
                            apiBaseUrl: config.apiBaseUrl,
                            applicationId: config.group.applicationId,
                            workspaceId: config.group.workspaceId,
                            restoreSession: ticket !== undefined,
                            authStorage: ticket ? 'session' : undefined,
                            actor: ticket
                                ? config.authSession?.username
                                : agentId,
                            sessionId: ticket
                                ? ticket.sessionId
                                : `${agentId}-session`,
                            controlToken: token.token,
                            agentSessionTicket: ticket?.ticket,
                        }),
                        expiresAtEpochMs: Math.min(
                            token.expiresAtEpochMs,
                            ticket?.expiresAtEpochMs ?? Number.POSITIVE_INFINITY,
                        ),
                    };
                }),
            };
        },
    };
}

async function issueTickets(
    config: Parameters<typeof createBrowserAgentLaunchService>[0],
    agentIds: readonly string[],
    signal: AbortSignal | undefined,
) {
    if (
        config.providerMode !== 'browser-rallar' ||
        config.issueAgentSessions === false
    ) {
        return new Map<string, AgentSessionTicketResponse['tickets'][number]>();
    }
    if (!config.authSession) {
        throw new Error(
            'Browser-rallar agent launch requires a valid logged-in operator session.',
        );
    }
    const response = await (config.issueAgentTickets ?? issueAgentSessionTicketsAt)(
        config.apiBaseUrl,
        { agentIds },
        { authSession: config.authSession, signal },
    );
    const tickets = new Map(
        response.tickets.map(ticket => [ticket.agentId, ticket] as const),
    );
    if (response.tickets.length !== agentIds.length || tickets.size !== agentIds.length) {
        throw new Error('Agent session ticket response must contain one unique ticket per requested agent.');
    }
    for (const agentId of agentIds) {
        const ticket = tickets.get(agentId);
        if (
            !ticket?.ticket.trim() ||
            !ticket.sessionId.trim() ||
            !Number.isFinite(ticket.expiresAtEpochMs) ||
            ticket.expiresAtEpochMs <= 0
        ) {
            throw new Error(`Missing valid agent session ticket for ${agentId}.`);
        }
    }
    for (const ticket of response.tickets) {
        if (!agentIds.includes(ticket.agentId)) {
            throw new Error(`Agent session ticket response contains unexpected agent ${ticket.agentId}.`);
        }
    }
    return tickets;
}

function validatedAgentIds(values: readonly string[]): readonly string[] {
    if (values.length < 1 || values.length > 6) {
        throw new Error('Browser-agent count must be between 1 and 6.');
    }
    const agentIds = values.map(value => requiredId(value, 'Agent ID'));
    if (new Set(agentIds).size !== agentIds.length) {
        throw new Error('Browser-agent IDs must be unique.');
    }
    return agentIds;
}

function requiredId(value: string, label: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${label} is required.`);
    return trimmed;
}

function validateRunToken(
    token: ControlRunToken,
    runId: string,
    agentId: string,
    allowAnonymous: boolean,
): void {
    if (
        token.runId !== runId ||
        token.agentId !== agentId ||
        (!allowAnonymous && !token.token.trim()) ||
        !Number.isFinite(token.issuedAtEpochMs) ||
        !Number.isFinite(token.expiresAtEpochMs) ||
        token.expiresAtEpochMs <= token.issuedAtEpochMs
    ) {
        throw new Error(
            `Control token response does not match requested run ${runId} and agent ${agentId}.`,
        );
    }
}
