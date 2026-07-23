export function rejectDirectCrdtMutation<T>(): Promise<T> {
  return Promise.reject(
    new Error(
      'Direct PostgreSQL CRDT mutation is disabled; use transaction-bound AppInbox orchestration.',
    ),
  );
}
