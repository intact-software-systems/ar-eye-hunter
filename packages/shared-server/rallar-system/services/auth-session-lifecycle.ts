export function requireIssueSessionLifecycle(
    capturedAtEpochMs: number,
    session: Readonly<{
        issuedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>,
): void {
    if (
        session.issuedAtEpochMs !== capturedAtEpochMs ||
        session.expiresAtEpochMs <= capturedAtEpochMs
    ) {
        throw new TypeError('Auth session command lifecycle is invalid');
    }
}
