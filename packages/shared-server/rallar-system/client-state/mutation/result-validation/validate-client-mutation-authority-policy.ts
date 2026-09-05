import {
    toClientMutationValidationIssue,
    type ClientMutationValidationIssue
} from '../../validation/client-mutation-rejection.ts';
import type {
    ClientMutationCommand,
    ClientMutationRead,
    ClientMutationSystemAuthority
} from '../client-mutation-contracts.ts';

export function validateClientMutationAuthorityPolicy(
    command: ClientMutationCommand,
    read: ClientMutationRead
): readonly ClientMutationValidationIssue[] {
    const authority = command.authority;
    if (authority.kind === 'system') {
        return validateSystemClientMutationAuthority(command, read, authority);
    }
    const issues: ClientMutationValidationIssue[] = [];
    if (command.operation === 'expireSession') {
        issues.push(issue(
            'command.operation',
            'Issued-session authority cannot expire client sessions.'
        ));
    }
    if (authority.operation !== command.operation) {
        issues.push(issue(
            'command.authority.operation',
            'Client mutation authority operation differs from the command.'
        ));
    }
    if (authority.applicationId !== command.aggregateRef.applicationId) {
        issues.push(issue(
            'command.authority.applicationId',
            'Client mutation authority application differs from the command.'
        ));
    }
    if (authority.workspaceId !== command.aggregateRef.workspaceId) {
        issues.push(issue(
            'command.authority.workspaceId',
            'Client mutation authority workspace differs from the command.'
        ));
    }
    if (authority.principalId !== command.aggregateRef.principalId) {
        issues.push(issue(
            'command.authority.principalId',
            'Client mutation authority principal differs from the command.'
        ));
    }
    const session = read.authoritySession;
    if (!session) {
        issues.push(issue(
            'read.authoritySession',
            'Authenticated client authority session is missing.'
        ));
    }
    else {
        if (session.clientId !== authority.principalId) {
            issues.push(issue(
                'read.authoritySession.clientId',
                'Durable client authority principal differs from the command authority.'
            ));
        }
        if (session.sessionId !== authority.sessionId) {
            issues.push(issue(
                'read.authoritySession.sessionId',
                'Durable client authority session differs from the command authority.'
            ));
        }
        if (session.issuedAtEpochMs !== authority.sessionIssuedAtEpochMs) {
            issues.push(issue(
                'read.authoritySession.issuedAtEpochMs',
                'Durable client authority issuance differs from the command authority.'
            ));
        }
        if (session.expiresAtEpochMs !== authority.sessionExpiresAtEpochMs) {
            issues.push(issue(
                'read.authoritySession.expiresAtEpochMs',
                'Durable client authority expiry differs from the command authority.'
            ));
        }
        if (session.expiresAtEpochMs <= command.facts.nowEpochMs) {
            issues.push(issue(
                'read.authoritySession.expiresAtEpochMs',
                'Durable client authority session is expired.'
            ));
        }
    }
    issues.push(...validateIssuedClientMutationActor(command, authority.principalId, authority.sessionId));
    return issues;
}

function validateSystemClientMutationAuthority(
    command: ClientMutationCommand,
    read: ClientMutationRead,
    authority: ClientMutationSystemAuthority
): readonly ClientMutationValidationIssue[] {
    const issues: ClientMutationValidationIssue[] = [];
    if (command.operation !== 'expireSession') {
        issues.push(issue('command.operation', 'System authority can only expire client sessions.'));
    }
    if (authority.operation !== command.operation) {
        issues.push(issue('command.authority.operation', 'System authority operation differs from the command.'));
    }
    if (authority.serviceId !== command.facts.serviceId) {
        issues.push(issue('command.authority.serviceId', 'System authority service differs from mutation facts.'));
    }
    if (read.authoritySession !== null) {
        issues.push(issue('read.authoritySession', 'System client mutation must not use an issued session.'));
    }
    if (command.input.actorPrincipalId !== command.aggregateRef.principalId) {
        issues.push(issue('command.input.actorPrincipalId', 'System expiry actor principal differs from the target.'));
    }
    if ('sessionId' in command && command.input.actorSessionId !== command.sessionId) {
        issues.push(issue('command.input.actorSessionId', 'System expiry actor session differs from the target.'));
    }
    if (command.input.reason !== 'expired') {
        issues.push(issue('command.input.reason', 'System expiry reason must be expired.'));
    }
    return issues;
}

function validateIssuedClientMutationActor(
    command: ClientMutationCommand,
    authorityPrincipalId: string,
    authoritySessionId: string
): readonly ClientMutationValidationIssue[] {
    const issues: ClientMutationValidationIssue[] = [];
    if (
        command.input.actorPrincipalId !== null &&
        command.input.actorPrincipalId !== authorityPrincipalId
    ) {
        issues.push(issue(
            'command.input.actorPrincipalId',
            'Client mutation actor principal differs from durable authority.'
        ));
    }
    if (
        command.input.actorSessionId !== null &&
        command.input.actorSessionId !== authoritySessionId
    ) {
        issues.push(issue(
            'command.input.actorSessionId',
            'Client mutation actor session differs from durable authority.'
        ));
    }
    if ('sessionId' in command && command.sessionId !== authoritySessionId) {
        issues.push(issue(
            'command.sessionId',
            'Client mutation session differs from durable authority.'
        ));
    }
    return issues;
}

function issue(path: string, message: string): ClientMutationValidationIssue {
    return toClientMutationValidationIssue(path, message);
}
