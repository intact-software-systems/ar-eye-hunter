export type AuthCommandCenterTicket = Readonly<{
    ticket: string;
    sessionId: string;
    expiresAtEpochMs: number;
    issuedAtEpochMs: number;
}>;
