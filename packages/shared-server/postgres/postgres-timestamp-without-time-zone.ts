export const POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_OID = 1114;

export interface PostgresTimestampWithoutTimeZoneTextType {
    readonly to: number;
    readonly from: number[];
    readonly serialize: (value: string) => string;
    readonly parse: (value: string) => string;
}

export function createPostgresTimestampWithoutTimeZoneTextType(): PostgresTimestampWithoutTimeZoneTextType {
    return {
        to: POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_OID,
        from: [POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_OID],
        serialize: (value: string) => value,
        parse: (value: string) => value
    };
}
