/**
 * A value a validator is still checking. Unlike `JsonWireValue` it proves nothing about JSON safety, and it admits
 * `undefined` because validators also check in-memory candidates before they are serialized.
 */
export type ValidationValue =
    | null
    | boolean
    | number
    | string
    | readonly ValidationValue[]
    | ValidationRecord
    | undefined;

export interface ValidationRecord {
    readonly [key: string]: ValidationValue;
}
