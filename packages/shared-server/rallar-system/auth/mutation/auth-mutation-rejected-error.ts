export class AuthMutationRejectedError extends Error {
  readonly code = 'auth-mutation-rejected';

  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'AuthMutationRejectedError';
  }
}
