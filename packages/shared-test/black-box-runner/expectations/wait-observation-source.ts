/** An owned observation producer that must settle before a complete-window verdict. */
export interface WaitObservationSource {
    stop(): Promise<void>;
}
