export const POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_OID = 1114;

export function createPostgresTimestampWithoutTimeZoneTextType() {
    return {
        to: POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_OID,
        from: [POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_OID],
        serialize: (value: string) => value,
        parse: (value: string) => value
    };
}
