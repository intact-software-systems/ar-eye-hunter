export type ApiJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly ApiJsonValue[]
    | ApiJsonObject;

export interface ApiJsonObject {
    readonly [key: string]: ApiJsonValue;
}

/** A JSON object rather than an array, a scalar or null; its members are left for the caller to judge. */
export function isApiJsonObject(value: unknown): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
