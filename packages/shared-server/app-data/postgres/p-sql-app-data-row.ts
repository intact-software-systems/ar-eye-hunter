export interface PSqlAppDataRow {
    readonly app_namespace: string;
    readonly store_name: string;
    readonly data_key: string;
    readonly data_value: string;
    readonly schema_version: number | string;
    readonly expire_at_ts: string | Date;
    readonly updated_ts: string | Date;
    readonly revision: number | string;
}
