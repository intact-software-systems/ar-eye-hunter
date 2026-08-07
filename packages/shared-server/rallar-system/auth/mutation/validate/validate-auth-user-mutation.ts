import type {
  AuthMutationCommand,
  AuthMutationRead,
  IssueAuthSessionCommand,
  RegisterAuthUserCommand,
} from '../auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '../auth-mutation-rejected-error.ts';
import { equalAuthJson } from './auth-mutation-validation.ts';

type AuthUserMutationCommand = Extract<
  AuthMutationCommand,
  { kind: 'register-user' | 'issue-session' }
>;

interface ValidateAuthUserMutationInput {
  readonly kind: AuthUserMutationCommand['kind'];
  readonly command: AuthUserMutationCommand;
  readonly read: AuthMutationRead;
}

export function validateAuthUserMutation(validation: ValidateAuthUserMutationInput): void {
  switch (validation.kind) {
    case 'register-user':
      return validateRegisterRead(
        validation.command as RegisterAuthUserCommand,
        validation.read as Extract<AuthMutationRead, { kind: 'register-user' }>,
      );
    case 'issue-session':
      return validateIssueSessionUserAuthority(
        validation.command as IssueAuthSessionCommand,
        validation.read as Extract<AuthMutationRead, { kind: 'issue-session' }>,
      );
  }
}

function validateRegisterRead(
  command: RegisterAuthUserCommand,
  read: Extract<AuthMutationRead, { kind: 'register-user' }>,
): void {
  if (read.byUsername && !equalAuthJson(read.byUsername.value, command.user)) {
    throw new AuthMutationRejectedError('Auth username already exists', 409);
  }
  if (read.byClientId && !equalAuthJson(read.byClientId.value, command.user)) {
    throw new AuthMutationRejectedError('Auth client identity already exists', 409);
  }
  if ((read.byUsername === null) !== (read.byClientId === null)) {
    throw new AuthMutationRejectedError('Auth user indexes are inconsistent', 500);
  }
}

function validateIssueSessionUserAuthority(
  command: IssueAuthSessionCommand,
  read: Extract<AuthMutationRead, { kind: 'issue-session' }>,
): void {
  if (
    command.session.clientId !== command.authority.clientId ||
    command.session.username.trim().toLowerCase() !== command.authority.normalizedUsername
  ) {
    throw new AuthMutationRejectedError('Auth session user authority differs', 403);
  }
  if (command.authority.kind === 'static-client') {
    if (read.userByUsername || read.userByClientId) {
      throw new AuthMutationRejectedError(
        'Static auth session authority conflicts with a registered user',
        403,
      );
    }
    return;
  }
  if (
    !read.userByUsername ||
    !read.userByClientId ||
    read.userByUsername.entry.revision !== command.authority.userRevision ||
    read.userByClientId.entry.revision !== command.authority.userRevision ||
    !equalAuthJson(read.userByUsername.value, read.userByClientId.value)
  ) {
    throw new AuthMutationRejectedError('Registered auth user authority is unavailable', 403);
  }
  const user = read.userByUsername.value;
  if (
    user.status !== 'active' ||
    user.clientId !== command.authority.clientId ||
    user.normalizedUsername !== command.authority.normalizedUsername ||
    user.clientId !== command.session.clientId ||
    user.username !== command.session.username
  ) {
    throw new AuthMutationRejectedError('Registered auth user authority differs', 403);
  }
}
