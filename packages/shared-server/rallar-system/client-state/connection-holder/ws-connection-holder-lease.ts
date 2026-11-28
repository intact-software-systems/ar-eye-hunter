/** The liveness lease of the process a socket generation's record names as its holder. */
export interface WsConnectionHolderLease {
    readonly holderId: string;
    /** Judged on the database clock by the statement that read it. */
    readonly live: boolean;
}

/** Reads the holder's lease outside the mutation's transaction, in its read phase. */
export interface WsConnectionHolderLeaseReader {
    readHolderLease(holderId: string): Promise<WsConnectionHolderLease>;
}
