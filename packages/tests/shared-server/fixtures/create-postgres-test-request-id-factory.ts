const MAX_REQUEST_ID_LENGTH = 128;

export function createPostgresTestRequestIdFactory(
  runNonce = crypto.randomUUID(),
): (semanticId: string) => string {
  const prefix = `postgres-test:${runNonce}:`;

  return (semanticId) => {
    if (semanticId.trim().length === 0) {
      throw new Error("Postgres test request semantic id must be non-empty");
    }

    const requestId = `${prefix}${semanticId}`;
    if (requestId.length > MAX_REQUEST_ID_LENGTH) {
      throw new Error(
        `Postgres test request id must not exceed ${MAX_REQUEST_ID_LENGTH} characters`,
      );
    }
    return requestId;
  };
}
