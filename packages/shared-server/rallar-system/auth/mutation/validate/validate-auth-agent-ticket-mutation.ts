import type {
    AuthMutationCommand,
    AuthMutationComputed,
    AuthMutationRead,
    ConsumeAuthAgentTicketCommand,
    IssueAuthAgentTicketsCommand
} from '../auth-mutation-contracts.ts';
import {
    equalAuthJson,
    toAuthMutationValidationIssue,
    validateIssueSessionRead,
    validateLiveSessionAuthority,
    type AuthMutationValidationIssue
} from './auth-mutation-validation.ts';

type AuthAgentTicketMutationCommand = Extract<
    AuthMutationCommand,
    { kind: 'issue-agent-tickets' | 'consume-agent-ticket'; }
>;

interface ValidateAuthAgentTicketMutationInput {
    readonly kind: AuthAgentTicketMutationCommand['kind'];
    readonly command: AuthAgentTicketMutationCommand;
    readonly read: AuthMutationRead;
    readonly computed: AuthMutationComputed;
}

interface ValidateIssuedAuthAgentTicketInput {
    readonly command: IssueAuthAgentTicketsCommand;
    readonly read: Extract<AuthMutationRead, { kind: 'issue-agent-tickets'; }>;
    readonly computed: AuthMutationComputed;
    readonly index: number;
    readonly seenAgentIds: Set<string>;
    readonly seenSessionIds: Set<string>;
    readonly seenTicketDigests: Set<string>;
}

export function validateAuthAgentTicketMutation(
    validation: ValidateAuthAgentTicketMutationInput
): readonly AuthMutationValidationIssue[] {
    switch (validation.kind) {
        case 'issue-agent-tickets':
            return validateAgentIssueRead(
                validation.command as IssueAuthAgentTicketsCommand,
                validation.read as Extract<AuthMutationRead, { kind: 'issue-agent-tickets'; }>,
                validation.computed
            );
        case 'consume-agent-ticket':
            return validateConsumeAgentTicketRead(
                validation.command as ConsumeAuthAgentTicketCommand,
                validation.read as Extract<AuthMutationRead, { kind: 'consume-agent-ticket'; }>
            );
    }
}

export function validateAgentIssueRead(
    command: IssueAuthAgentTicketsCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-agent-tickets'; }>,
    computed: AuthMutationComputed
): readonly AuthMutationValidationIssue[] {
    const issues = [
        ...validateAgentTicketBatchShape(command, read, computed),
        ...validateLiveSessionAuthority({
            expected: command.authority,
            read: read.authority,
            capturedAtEpochMs: command.capturedAtEpochMs,
            label: 'Agent ticket authority'
        })
    ];
    const seenAgentIds = new Set<string>();
    const seenSessionIds = new Set<string>();
    const seenTicketDigests = new Set<string>();
    for (let index = 0; index < command.tickets.length; index += 1) {
        issues.push(
            ...validateIssuedAuthAgentTicket({
                command,
                read,
                computed,
                index,
                seenAgentIds,
                seenSessionIds,
                seenTicketDigests
            })
        );
    }
    return issues;
}

export function validateConsumeAgentTicketRead(
    command: ConsumeAuthAgentTicketCommand,
    read: Extract<AuthMutationRead, { kind: 'consume-agent-ticket'; }>
): readonly AuthMutationValidationIssue[] {
    if (read.ticket === null) {
        return [toAuthMutationValidationIssue('read.ticket', 'Auth ticket is invalid or consumed', 404)];
    }
    const issues: AuthMutationValidationIssue[] = [];
    const ticket = read.ticket.value;
    if (ticket.expiresAtEpochMs <= command.capturedAtEpochMs) {
        issues.push(toAuthMutationValidationIssue('read.ticket', 'Agent ticket is expired', 410));
    }
    if (
        !read.session ||
        read.session.value.sessionId !== ticket.sessionId ||
        read.session.value.clientId !== ticket.clientId ||
        read.session.value.accessTokenDigest !== ticket.accessTokenDigest
    ) {
        issues.push(toAuthMutationValidationIssue('read.session', 'Agent ticket authority differs', 401));
    }
    return issues;
}

function validateAgentTicketBatchShape(
    command: IssueAuthAgentTicketsCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-agent-tickets'; }>,
    computed: AuthMutationComputed
): readonly AuthMutationValidationIssue[] {
    const issues: AuthMutationValidationIssue[] = [];
    if (command.tickets.length === 0 || command.tickets.length !== computed.sessions.length) {
        issues.push(toAuthMutationValidationIssue('command.tickets', 'Agent ticket batch is invalid'));
    }
    if (
        read.tickets.length !== command.tickets.length ||
        read.expiredTicketEntries.length !== command.tickets.length
    ) {
        issues.push(toAuthMutationValidationIssue('read.tickets', 'Agent ticket read batch is invalid'));
    }
    return issues;
}

function validateIssuedAuthAgentTicket(
    validation: ValidateIssuedAuthAgentTicketInput
): readonly AuthMutationValidationIssue[] {
    const issues: AuthMutationValidationIssue[] = [];
    const ticket = validation.command.tickets[validation.index];
    issues.push(...validateAgentTicketAuthority(ticket, validation.command, validation.index));
    issues.push(...validateAgentTicketLifecycle(ticket, validation.command.capturedAtEpochMs, validation.index));
    issues.push(...validateAgentTicketIdentity(ticket, validation));
    const sessionRead = validation.read.sessions[validation.index];
    if (sessionRead !== undefined) {
        issues.push(
            ...validateIssueSessionRead({
                session: validation.computed.sessions[validation.index]?.session,
                read: { kind: 'issue-session', ...sessionRead },
                path: `read.sessions[${validation.index}]`
            })
        );
    }
    const current = validation.read.tickets[validation.index];
    if (
        current &&
        !equalAuthJson(current.value, validation.computed.agentTickets[validation.index])
    ) {
        issues.push(
            toAuthMutationValidationIssue(
                `read.tickets[${validation.index}]`,
                'Agent ticket digest collision',
                409
            )
        );
    }
    return issues;
}

function validateAgentTicketAuthority(
    ticket: IssueAuthAgentTicketsCommand['tickets'][number],
    command: IssueAuthAgentTicketsCommand,
    index: number
): readonly AuthMutationValidationIssue[] {
    if (
        ticket.clientId !== command.authority.clientId ||
        ticket.username !== command.authority.username
    ) {
        return [
            toAuthMutationValidationIssue(
                `command.tickets[${index}]`,
                'Agent ticket authority differs',
                403
            )
        ];
    }
    return [];
}

function validateAgentTicketLifecycle(
    ticket: IssueAuthAgentTicketsCommand['tickets'][number],
    capturedAtEpochMs: number,
    index: number
): readonly AuthMutationValidationIssue[] {
    if (
        ticket.issuedAtEpochMs !== capturedAtEpochMs ||
        ticket.sessionExpiresAtEpochMs <= capturedAtEpochMs ||
        ticket.ticketExpiresAtEpochMs <= capturedAtEpochMs ||
        ticket.ticketExpiresAtEpochMs > ticket.sessionExpiresAtEpochMs
    ) {
        return [
            toAuthMutationValidationIssue(
                `command.tickets[${index}]`,
                'Agent ticket lifecycle is invalid',
                410
            )
        ];
    }
    return [];
}

function validateAgentTicketIdentity(
    ticket: IssueAuthAgentTicketsCommand['tickets'][number],
    validation: ValidateIssuedAuthAgentTicketInput
): readonly AuthMutationValidationIssue[] {
    const issues: AuthMutationValidationIssue[] = [];
    const path = `command.tickets[${validation.index}]`;
    if (validation.seenAgentIds.has(ticket.agentId)) {
        issues.push(
            toAuthMutationValidationIssue(`${path}.agentId`, 'Agent ticket batch identity is duplicated', 409)
        );
    }
    if (validation.seenSessionIds.has(ticket.sessionId)) {
        issues.push(
            toAuthMutationValidationIssue(`${path}.sessionId`, 'Agent ticket batch identity is duplicated', 409)
        );
    }
    if (validation.seenTicketDigests.has(ticket.ticketDigest)) {
        issues.push(
            toAuthMutationValidationIssue(`${path}.ticketDigest`, 'Agent ticket batch identity is duplicated', 409)
        );
    }
    validation.seenAgentIds.add(ticket.agentId);
    validation.seenSessionIds.add(ticket.sessionId);
    validation.seenTicketDigests.add(ticket.ticketDigest);
    return issues;
}
