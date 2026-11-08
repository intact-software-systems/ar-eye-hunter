import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';

import { validateWsOutboxInsert } from '../../../app-outbox/app-outbox-insert.ts';
import type {
    AuthMutationCommand,
    AuthMutationComputed,
    AuthMutationFacts,
    AuthMutationRead,
    IssueAuthSessionCommand,
    LogoutAuthSessionCommand
} from '../auth-mutation-contracts.ts';
import { toAuthLogoutOutbox } from '../compute/to-auth-logout-outbox.ts';
import { toAuthLogoutProvenanceFacts } from '../compute/to-auth-logout-provenance-facts.ts';
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
    readonly facts: AuthMutationFacts;
    readonly computed: AuthMutationComputed;
}

interface ValidateLogoutAuthSessionInput {
    readonly command: LogoutAuthSessionCommand;
    readonly read: Extract<AuthMutationRead, { kind: 'logout-session'; }>;
    readonly computed: AuthMutationComputed;
    readonly facts: AuthMutationFacts;
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
            return validateLogoutAuthSession({
                command: validation.command as LogoutAuthSessionCommand,
                read: validation.read as Extract<AuthMutationRead, { kind: 'logout-session'; }>,
                computed: validation.computed,
                facts: validation.facts
            });
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

function validateLogoutAuthSession(input: ValidateLogoutAuthSessionInput): readonly AuthMutationValidationIssue[] {
    const { command, read, computed, facts } = input;
    if (read.bySession === null && read.byToken === null) {
        return [];
    }
    const issues: AuthMutationValidationIssue[] = [...validateLogoutOutbox(command, computed, facts)];
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

function validateLogoutOutbox(
    command: LogoutAuthSessionCommand,
    computed: AuthMutationComputed,
    facts: AuthMutationFacts
): readonly AuthMutationValidationIssue[] {
    const candidate = computed.persistence.logoutOutbox;
    if (candidate === null) {
        return [];
    }
    const entry = toAuthLogoutOutbox(command, facts);
    const expected = {
        entry,
        admissionNamespace: null,
        provenance: toAuthLogoutProvenanceFacts(command, decodePersistedALMessage(entry.resource))
    };
    return validateWsOutboxInsert(expected, candidate)
        .map((issue) => toAuthMutationTypeValidationIssue(issue.path, issue.message));
}
