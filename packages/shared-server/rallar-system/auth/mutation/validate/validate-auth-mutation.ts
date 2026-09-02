import {
    assertRuntimeStateExpectedRevision,
    assertRuntimeStateUpsertExpectedRevision
} from '../../../../runtime-state/runtime-state-repository.ts';
import {
    validateAppInboxComputedData,
    validateAppInboxComputedProjection
} from '../../../app-inbox/handler/app-inbox-computed-validation.ts';
import { decodePersistedAuthSession } from '../../persistence/persisted-auth-session.ts';
import type {
    AuthComputedSession,
    AuthComputedTicketWrite,
    AuthMutationCommand,
    AuthMutationComputed,
    AuthMutationRead,
    AuthSessionEntries
} from '../auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '../auth-mutation-rejected-error.ts';
import {
    computeAuthAgentSessionWrite,
    computeAuthAgentTicket
} from '../compute/compute-auth-agent-ticket-mutation.ts';
import {
    computeAuthLogoutDeletion,
    computeAuthSessionWrite
} from '../compute/compute-auth-session-mutation.ts';
import {
    computeAuthAgentTicketWrite,
    computeAuthWebSocketTicketWrite
} from '../compute/compute-auth-ticket-write.ts';
import { computeAuthUserRegistrationWrite } from '../compute/compute-auth-user-registration.ts';
import { requireMatchingAuthKind } from './auth-mutation-validation.ts';
import { validateAuthAgentTicketMutation } from './validate-auth-agent-ticket-mutation.ts';
import { validateAuthSessionMutation } from './validate-auth-session-mutation.ts';
import { validateAuthTicketMutation } from './validate-auth-ticket-mutation.ts';
import { validateAuthUserMutation } from './validate-auth-user-mutation.ts';

export function validateAuthMutation(
    command: AuthMutationCommand,
    read: AuthMutationRead,
    computed: AuthMutationComputed
): void {
    requireMatchingAuthKind(command, read);
    const dataIssues = validateAppInboxComputedData(computed, 'computed');
    if (dataIssues.length > 0) {
        throw new AuthMutationRejectedError(dataIssues[0].message);
    }
    if (computed.kind !== command.kind || computed.command !== command || computed.read !== read) {
        throw new AuthMutationRejectedError('Auth computed input identity differs');
    }
    if (command.capturedAtEpochMs < 0) {
        throw new AuthMutationRejectedError('Auth command timestamp is invalid');
    }
    const commandKind = command.kind;
    switch (commandKind) {
        case 'register-user':
            validateAuthUserMutation({ kind: commandKind, command, read });
            break;
        case 'issue-session':
            validateAuthSessionMutation({ kind: commandKind, command, read, computed });
            validateAuthUserMutation({ kind: commandKind, command, read });
            break;
        case 'logout-session':
            validateAuthSessionMutation({ kind: commandKind, command, read, computed });
            break;
        case 'issue-ws-ticket':
        case 'consume-ws-ticket':
            validateAuthTicketMutation({ kind: commandKind, command, read });
            break;
        case 'issue-agent-tickets':
        case 'consume-agent-ticket':
            validateAuthAgentTicketMutation({ kind: commandKind, command, read, computed });
            break;
    }
    if (computed.outcome === 'write') {
        validateAuthMutationStorageRevisions(read, computed);
    }
    validateAuthComputedSessions(command, read, computed);
    validateAuthComputedLogoutDeletion(command, read, computed);
    validateAuthComputedTicketDeletion(read, computed);
    validateAuthComputedTicketWrites(command, read, computed);
    validateAuthComputedUserRegistration(command, computed);
}

function validateAuthComputedLogoutDeletion(
    command: AuthMutationCommand,
    read: AuthMutationRead,
    computed: AuthMutationComputed
): void {
    const expected = command.kind === 'logout-session' && read.kind === 'logout-session'
        ? computeAuthLogoutDeletion(command, read)
        : null;
    const issues = validateAppInboxComputedProjection(
        expected,
        computed.logoutDeletion,
        'computed.logoutDeletion'
    );
    if (issues.length > 0) {
        throw new AuthMutationRejectedError(issues[0].message);
    }
}

function validateAuthComputedTicketWrites(
    command: AuthMutationCommand,
    read: AuthMutationRead,
    computed: AuthMutationComputed
): void {
    const expected = computeExpectedAuthTicketWrites(command, read);
    const issues = validateAppInboxComputedProjection(expected, computed.ticketWrites, 'computed.ticketWrites');
    if (issues.length > 0) {
        throw new AuthMutationRejectedError(issues[0].message);
    }
}

function computeExpectedAuthTicketWrites(
    command: AuthMutationCommand,
    read: AuthMutationRead
): readonly AuthComputedTicketWrite[] {
    if (command.kind === 'issue-ws-ticket' && read.kind === 'issue-ws-ticket') {
        return [
            computeAuthWebSocketTicketWrite(
                command.ticketRecord,
                read.expiredTicketEntry?.revision ?? null
            )
        ];
    }
    else if (command.kind === 'issue-agent-tickets' && read.kind === 'issue-agent-tickets') {
        return command.tickets.map((ticket, index) =>
            computeAuthAgentTicketWrite(
                computeAuthAgentTicket(ticket),
                read.expiredTicketEntries[index]?.revision ?? null
            )
        );
    }
    return [];
}

function validateAuthComputedUserRegistration(
    command: AuthMutationCommand,
    computed: AuthMutationComputed
): void {
    const expected = command.kind === 'register-user'
        ? computeAuthUserRegistrationWrite(command.user)
        : null;
    const issues = validateAppInboxComputedProjection(expected, computed.userRegistration, 'computed.userRegistration');
    if (issues.length > 0) {
        throw new AuthMutationRejectedError(issues[0].message);
    }
}

function validateAuthComputedTicketDeletion(read: AuthMutationRead, computed: AuthMutationComputed): void {
    const expected = (read.kind === 'consume-ws-ticket' || read.kind === 'consume-agent-ticket') && read.ticket
        ? { storageKey: read.ticket.entry.key, expectedRevision: read.ticket.entry.revision }
        : null;
    const issues = validateAppInboxComputedProjection(expected, computed.ticketDeletion, 'computed.ticketDeletion');
    if (issues.length > 0) {
        throw new AuthMutationRejectedError(issues[0].message);
    }
}

function validateAuthComputedSessions(
    command: AuthMutationCommand,
    read: AuthMutationRead,
    computed: AuthMutationComputed
): void {
    let expected: readonly AuthComputedSession[] = [];
    if (command.kind === 'issue-session' && read.kind === 'issue-session') {
        expected = [computeAuthSessionWrite(decodePersistedAuthSession(command.session), read)];
    }
    else if (command.kind === 'issue-agent-tickets' && read.kind === 'issue-agent-tickets') {
        expected = command.tickets.map((ticket, index) => computeAuthAgentSessionWrite(ticket, read.sessions[index]));
    }
    const issues = validateAppInboxComputedProjection(expected, computed.sessions, 'computed.sessions');
    if (issues.length > 0) {
        throw new AuthMutationRejectedError(issues[0].message);
    }
}

function validateAuthMutationStorageRevisions(read: AuthMutationRead, computed: AuthMutationComputed): void {
    switch (read.kind) {
        case 'register-user':
            return;
        case 'issue-session':
            return validateAuthSessionReplacementRevisions(read);
        case 'logout-session':
            if (read.bySession !== null) {
                assertRuntimeStateExpectedRevision(read.bySession.entry.revision);
            }
            if (read.byToken !== null) {
                assertRuntimeStateExpectedRevision(read.byToken.entry.revision);
            }
            return;
        case 'issue-ws-ticket':
            if (read.expiredTicketEntry !== null) {
                assertRuntimeStateUpsertExpectedRevision(read.expiredTicketEntry.revision);
            }
            return;
        case 'consume-ws-ticket':
        case 'consume-agent-ticket':
            if (read.ticket !== null) {
                assertRuntimeStateExpectedRevision(read.ticket.entry.revision);
            }
            return;
        case 'issue-agent-tickets':
            for (let index = 0; index < computed.sessions.length; index += 1) {
                validateAuthSessionReplacementRevisions(read.sessions[index]);
            }
            for (let index = 0; index < computed.agentTickets.length; index += 1) {
                const expired = read.expiredTicketEntries[index];
                if (expired !== null) {
                    assertRuntimeStateUpsertExpectedRevision(expired.revision);
                }
            }
    }
}

function validateAuthSessionReplacementRevisions(read: AuthSessionEntries): void {
    if (read.expiredByTokenEntry !== null) {
        assertRuntimeStateUpsertExpectedRevision(read.expiredByTokenEntry.revision);
    }
    if (read.expiredBySessionEntry !== null) {
        assertRuntimeStateUpsertExpectedRevision(read.expiredBySessionEntry.revision);
    }
}
