/** Authenticated account and game identity are distinct from transport sessions. */
export interface RelicCommandSender {
    readonly clientId: string;
    readonly playerId: string;
}
