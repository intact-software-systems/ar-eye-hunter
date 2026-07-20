export type MutationActor =
    | Readonly<{
        kind: 'principal';
        principalId: string;
    }>
    | Readonly<{
        kind: 'session';
        sessionId: string;
        principalId: string;
    }>
    | Readonly<{
        kind: 'service';
        serviceId: string;
    }>;
