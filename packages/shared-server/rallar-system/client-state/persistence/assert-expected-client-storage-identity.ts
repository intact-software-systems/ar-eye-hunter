import type { ClientInstanceRef, ClientPrincipalRef, ClientScope, ClientSessionRef } from '@shared/api/client-types.ts';

export function assertExpectedClientStorageIdentity(
    actual: ClientScope | ClientPrincipalRef | ClientInstanceRef | ClientSessionRef,
    expected: ClientScope | ClientPrincipalRef | ClientInstanceRef | ClientSessionRef,
    label: string
): void {
    if (
        actual.applicationId !== expected.applicationId ||
        actual.workspaceId !== expected.workspaceId ||
        ('principalId' in expected &&
            (!('principalId' in actual) || actual.principalId !== expected.principalId)) ||
        ('clientInstanceId' in expected &&
            (!('clientInstanceId' in actual) || actual.clientInstanceId !== expected.clientInstanceId)) ||
        ('sessionId' in expected &&
            (!('sessionId' in actual) || actual.sessionId !== expected.sessionId))
    ) {
        throw new TypeError(`Stored client ${label} identity differs from its canonical slot`);
    }
}
