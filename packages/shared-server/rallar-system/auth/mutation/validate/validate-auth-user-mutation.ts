import type {
    AuthMutationCommand,
    AuthMutationRead,
    IssueAuthSessionCommand,
    RegisterAuthUserCommand
} from '../auth-mutation-contracts.ts';
import {
    equalAuthJson,
    toAuthMutationValidationIssue,
    type AuthMutationValidationIssue
} from './auth-mutation-validation.ts';

type AuthUserMutationCommand = Extract<AuthMutationCommand, { kind: 'register-user' | 'issue-session'; }>;

interface ValidateAuthUserMutationInput {
    readonly kind: AuthUserMutationCommand['kind'];
    readonly command: AuthUserMutationCommand;
    readonly read: AuthMutationRead;
}

export function validateAuthUserMutation(
    validation: ValidateAuthUserMutationInput
): readonly AuthMutationValidationIssue[] {
    switch (validation.kind) {
        case 'register-user':
            return validateRegisterRead(
                validation.command as RegisterAuthUserCommand,
                validation.read as Extract<AuthMutationRead, { kind: 'register-user'; }>
            );
        case 'issue-session':
            return validateIssueSessionUserAuthority(
                validation.command as IssueAuthSessionCommand,
                validation.read as Extract<AuthMutationRead, { kind: 'issue-session'; }>
            );
    }
}

function validateRegisterRead(
    command: RegisterAuthUserCommand,
    read: Extract<AuthMutationRead, { kind: 'register-user'; }>
): readonly AuthMutationValidationIssue[] {
    const issues: AuthMutationValidationIssue[] = [];
    if (read.byUsername && !equalAuthJson(read.byUsername.value, command.user)) {
        issues.push(toAuthMutationValidationIssue('read.byUsername', 'Auth username already exists', 409));
    }
    if (read.byClientId && !equalAuthJson(read.byClientId.value, command.user)) {
        issues.push(toAuthMutationValidationIssue('read.byClientId', 'Auth client identity already exists', 409));
    }
    if ((read.byUsername === null) !== (read.byClientId === null)) {
        issues.push(toAuthMutationValidationIssue('read', 'Auth user indexes are inconsistent', 500));
    }
    return issues;
}

function validateIssueSessionUserAuthority(
    command: IssueAuthSessionCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-session'; }>
): readonly AuthMutationValidationIssue[] {
    const issues: AuthMutationValidationIssue[] = [];
    if (
        command.session.clientId !== command.authority.clientId ||
        command.session.username.trim().toLowerCase() !== command.authority.normalizedUsername
    ) {
        issues.push(toAuthMutationValidationIssue('command.authority', 'Auth session user authority differs', 403));
    }
    if (command.authority.kind === 'static-client') {
        if (read.userByUsername || read.userByClientId) {
            issues.push(
                toAuthMutationValidationIssue(
                    'read.user',
                    'Static auth session authority conflicts with a registered user',
                    403
                )
            );
        }
        return issues;
    }
    if (
        !read.userByUsername ||
        !read.userByClientId ||
        read.userByUsername.entry.revision !== command.authority.userRevision ||
        read.userByClientId.entry.revision !== command.authority.userRevision ||
        !equalAuthJson(read.userByUsername.value, read.userByClientId.value)
    ) {
        issues.push(
            toAuthMutationValidationIssue('read.user', 'Registered auth user authority is unavailable', 403)
        );
    }
    if (!read.userByUsername) {
        return issues;
    }
    const user = read.userByUsername.value;
    if (
        user.status !== 'active' ||
        user.clientId !== command.authority.clientId ||
        user.normalizedUsername !== command.authority.normalizedUsername ||
        user.clientId !== command.session.clientId ||
        user.username !== command.session.username
    ) {
        issues.push(toAuthMutationValidationIssue('read.user', 'Registered auth user authority differs', 403));
    }
    return issues;
}
