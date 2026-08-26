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
