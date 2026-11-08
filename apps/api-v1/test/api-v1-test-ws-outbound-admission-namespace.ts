import { toServerWsQBoxALOutboundAdmissionNamespace } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';

/** The admission namespace of the one WS runtime the api-v1 and Relic servers compose, `default-qbox-server`. */
export const API_V1_TEST_WS_OUTBOUND_ADMISSION_NAMESPACE = toServerWsQBoxALOutboundAdmissionNamespace(
    'default-qbox-server'
);
