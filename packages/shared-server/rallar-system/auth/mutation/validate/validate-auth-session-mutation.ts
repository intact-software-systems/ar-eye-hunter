import type {
    AuthMutationCommand,
    AuthMutationComputed,
    AuthMutationRead,
    IssueAuthSessionCommand,
    LogoutAuthSessionCommand
} from '../auth-mutation-contracts.ts';
import {
    equalAuthJson,
    toAuthMutationTypeValidationIssue,
    toAuthMutationValidationIssue,
    validateIssueSessionRead,
    type AuthMutationValidationIssue
} from './auth-mutation-validation.ts';

type AuthSessionMutationCommand = Extract<AuthMutationCommand, { kind: 'issue-session' | 'logout-session'; }>;

interface ValidateAuthSessionMutationInput {
    readonly kind: AuthSessionMutationCommand['kind'];
    readonly command: AuthSessionMutationCommand;
    readonly read: AuthMutationRead;
    readonly computed: AuthMutationComputed;
}

export function validateAuthSessionMutation(
    validation: ValidateAuthSessionMutationInput
): readonly AuthMutationValidationIssue[] {
    switch (validation.kind) {
        case 'issue-session':
            return validateIssueAuthSession(
                validation.command as IssueAuthSessionCommand,
                validation.read as Extract<AuthMutationRead, { kind: 'issue-session'; }>,
                validation.computed
            );
        case 'logout-session':
            return validateLogoutAuthSession(
                validation.command as LogoutAuthSessionCommand,
                validation.read as Extract<AuthMutationRead, { kind: 'logout-session'; }>
            );
    }
}

function validateIssueAuthSession(
    command: IssueAuthSessionCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-session'; }>,
    computed: AuthMutationComputed
): readonly AuthMutationValidationIssue[] {
    const issues: AuthMutationValidationIssue[] = [];
    const session = computed.sessions[0]?.session;
    if (
        session !== undefined &&
        (
            session.issuedAtEpochMs !== command.capturedAtEpochMs ||
            session.expiresAtEpochMs <= command.capturedAtEpochMs
        )
    ) {
        issues.push(
            toAuthMutationTypeValidationIssue(
                'computed.sessions[0].session',
                'Auth session command lifecycle is invalid'
            )
        );
    }
    issues.push(...validateIssueSessionRead({ session, read, path: 'read.session' }));
    return issues;
}

function validateLogoutAuthSession(
    command: LogoutAuthSessionCommand,
    read: Extract<AuthMutationRead, { kind: 'logout-session'; }>
): readonly AuthMutationValidationIssue[] {
    if (read.bySession === null && read.byToken === null) {
        return [];
    }
    const issues: AuthMutationValidationIssue[] = [];
    if (
        !read.bySession ||
        !read.byToken ||
        !equalAuthJson(read.bySession.value, read.byToken.value)
    ) {
        issues.push(toAuthMutationValidationIssue('read', 'Auth logout indexes are inconsistent', 500));
    }
    if (!read.bySession) {
        return issues;
    }
    const session = read.bySession.value;
    if (
        session.clientId !== command.expected.clientId ||
        session.username !== command.expected.username ||
        session.sessionId !== command.expected.sessionId ||
        session.issuedAtEpochMs !== command.expected.issuedAtEpochMs ||
        session.expiresAtEpochMs !== command.expected.expiresAtEpochMs
    ) {
        issues.push(toAuthMutationValidationIssue('read.bySession', 'Auth logout authority differs', 403));
    }
    return issues;
}
