export class AuthMutationRejectedError extends Error {
  readonly code = 'auth-mutation-rejected';

  readonly status: number;

  constructor(
    message: string,
    status = 409,
  ) {
    super(message);
    this.status = status;
    this.name = 'AuthMutationRejectedError';
  }
}
