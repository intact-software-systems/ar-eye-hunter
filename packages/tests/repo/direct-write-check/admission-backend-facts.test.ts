import { describe, expect, it } from 'vitest';

import { computeAdmissionBackendFacts } from '../../../../scripts/direct-write-check/admission-backend-facts.mjs';
import { ADMISSION_PORT_SOURCES, createDirectWriteFixture } from './direct-write-check-fixture.ts';

const STORE_PATH = 'packages/shared/alm/inbound/al-inbound-admission-store.ts';

interface ConstructionFact {
    readonly id: string;
    readonly namespaces: readonly string[];
}

interface RowFamilyFact {
    readonly id: string;
}

describe('admission backend facts', () => {
    it('names each port implementation, each PostgreSQL construction with its namespace, and each write', () => {
        const facts = computeFixtureFacts(ADMISSION_PORT_SOURCES);

        expect(facts.admissionBackendImplementations).toEqual([
            {
                id: 'packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts#PSqlAdmissionWorkBackend',
                backend: 'postgres'
            },
            { id: 'packages/shared/alm/in-memory-admission-backend.ts#InMemoryAdmissionBackend', backend: 'not-postgres' }
        ]);
        expect(facts.admissionBackendConstructions).toEqual([{
            id: 'packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts#createPSqlALInboundRuntimeStores',
            count: 1,
            namespaces: ['`${storeNamespace}:inbound:admission`']
        }]);
        expect(facts.admissionBackendWrites).toEqual([{ id: `${STORE_PATH}#ALInboundAdmissionStore.admit`, count: 1 }]);
    });

    it('records a fourth file constructing the PostgreSQL backend for a new namespace', () => {
        const facts = computeFixtureFacts({
            ...ADMISSION_PORT_SOURCES,
            'packages/shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts': `
                import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
                import { PSqlAdmissionWorkBackend } from './p-sql-admission-work-backend.ts';
                export function createPSqlALReceiptRecordStores(sql: PSqlSql) {
                    return new PSqlAdmissionWorkBackend({ sql, namespace: 'receipt:record' });
                }
            `
        });

        expect(facts.admissionBackendConstructions.map((fact: ConstructionFact) => [fact.id, fact.namespaces])).toEqual([
            [
                'packages/shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts#createPSqlALReceiptRecordStores',
                ['\'receipt:record\'']
            ],
            [
                'packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts#createPSqlALInboundRuntimeStores',
                ['`${storeNamespace}:inbound:admission`']
            ]
        ]);
    });

    it('changes the construction fact when only the namespace it is given changes', () => {
        const path = 'packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
        const facts = computeFixtureFacts({
            ...ADMISSION_PORT_SOURCES,
            [path]: ADMISSION_PORT_SOURCES[path].replace(':inbound:admission', ':inbound:holder')
        });

        expect(facts.admissionBackendConstructions[0]?.namespaces).toEqual(['`${storeNamespace}:inbound:holder`']);
    });

    it('counts a new write through the port in a store method and ignores reads and unrelated writes', () => {
        const facts = computeFixtureFacts({
            ...ADMISSION_PORT_SOURCES,
            [STORE_PATH]: ADMISSION_PORT_SOURCES[STORE_PATH].replace(
                'async peek(): Promise<unknown> {',
                'async settle(): Promise<void> { await this.backend.write(async () => 1); await this.backend.write(async () => 2); }\n' +
                    'async peek(): Promise<unknown> {'
            )
        });

        expect(facts.admissionBackendWrites).toEqual([
            { id: `${STORE_PATH}#ALInboundAdmissionStore.admit`, count: 1 },
            { id: `${STORE_PATH}#ALInboundAdmissionStore.settle`, count: 2 }
        ]);
    });

    it('records a new class implementing the port', () => {
        const facts = computeFixtureFacts({
            ...ADMISSION_PORT_SOURCES,
            'packages/shared-server/al-runtime/postgres/p-sql-holder-backend.ts': `
                import type { ALAdmissionBackend } from '../../../shared/alm/al-admission-backend.ts';
                import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
                export class PSqlHolderBackend implements ALAdmissionBackend {
                    constructor(private readonly sql: PSqlSql) {}
                    async read(key: string): Promise<unknown> { return key; }
                    async write<T>(operation: (context: unknown) => Promise<T>): Promise<T> { return operation(this.sql); }
                }
            `
        });

        expect(facts.admissionBackendImplementations).toContainEqual({
            id: 'packages/shared-server/al-runtime/postgres/p-sql-holder-backend.ts#PSqlHolderBackend',
            backend: 'postgres'
        });
        expect(facts.admissionBackendImplementations).toHaveLength(3);
    });

    it('records each runtime import of a wiring module and ignores type-only imports', () => {
        const backendPath = 'packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
        const storesPath = 'packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
        const facts = computeFixtureFacts({
            ...ADMISSION_PORT_SOURCES,
            'apps/api-v1/src/composition/create-api-v1-runtime.ts': `
                import { createPSqlALInboundRuntimeStores } from '../../../../packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
                import type { PSqlAdmissionWorkBackend } from '../../../../packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
                export const createRuntime = createPSqlALInboundRuntimeStores;
                export function describeRuntime(backend: PSqlAdmissionWorkBackend): string { return backend.topic; }
            `,
            'packages/shared-server/al-runtime/describe-backend.ts': `
                import { type PSqlAdmissionWorkBackend } from './postgres/p-sql-admission-work-backend.ts';
                export function describeBackend(backend: PSqlAdmissionWorkBackend): string { return backend.topic; }
            `
        });

        expect(facts.wiringImports).toEqual([
            { id: `apps/api-v1/src/composition/create-api-v1-runtime.ts#import:${storesPath}` },
            { id: `${storesPath}#import:${backendPath}` }
        ]);
    });

    it('records each exported key builder of a key module and each retained work topic', () => {
        const keysPath = 'packages/shared/alm/outbound/al-outbound-admission-keys.ts';
        const topicsPath = 'packages/shared/alm/al-admission-work-backend.ts';
        const keys = `
            export function toALOutboundAdmissionNamespace(storeNamespace: string): string { return storeNamespace; }
            export function toALOutboundMessageOwnerKey(namespace: string, msgId: string): string { return namespace + msgId; }
            function toALOutboundPrivateKey(namespace: string): string { return namespace; }
            export function toALOutboundOrderingTrackPrefix(namespace: string): string { return toALOutboundPrivateKey(namespace); }
        `;
        const topics = ADMISSION_PORT_SOURCES[topicsPath] +
            'export const AL_ADMISSION_WORK_COMPLETED_RETENTION = { typeIds: [\'WS_OUTBOX\'], topicIds: [\'AL_OUTBOUND\'] };\n';
        const base = computeFixtureFacts({ ...ADMISSION_PORT_SOURCES, [keysPath]: keys, [topicsPath]: topics });
        const widened = computeFixtureFacts({
            ...ADMISSION_PORT_SOURCES,
            [keysPath]: `${keys}\nexport function toALOutboundResendScheduleKey(namespace: string): string { return namespace; }`,
            [topicsPath]: topics.replace('topicIds: [\'AL_OUTBOUND\']', 'topicIds: [\'AL_OUTBOUND\', \'AL_OUTBOUND_RESEND\']')
        });

        expect(base.rowFamilies).toEqual([
            { id: `${topicsPath}#AL_ADMISSION_WORK_COMPLETED_RETENTION.AL_OUTBOUND` },
            { id: `${topicsPath}#AL_ADMISSION_WORK_COMPLETED_RETENTION.WS_OUTBOX` },
            { id: `${keysPath}#toALOutboundMessageOwnerKey` },
            { id: `${keysPath}#toALOutboundOrderingTrackPrefix` }
        ]);
        expect(widened.rowFamilies.filter((fact: RowFamilyFact) => !base.rowFamilies.some((known: RowFamilyFact) => known.id === fact.id))).toEqual([
            { id: `${topicsPath}#AL_ADMISSION_WORK_COMPLETED_RETENTION.AL_OUTBOUND_RESEND` },
            { id: `${keysPath}#toALOutboundResendScheduleKey` }
        ]);
    });

    it('records an exported key builder in any module under packages/shared/alm, declared as a function or an arrow', () => {
        const facts = computeFixtureFacts({
            ...ADMISSION_PORT_SOURCES,
            'packages/shared/alm/outbound/admission/al-outbound-displayed-keys.ts': `
                export function toALOutboundDisplayedRecipientKey(namespace: string, msgId: string): string { return namespace + msgId; }
            `,
            'packages/shared/alm/inbound/control/al-inbound-control-rows.ts': `
                export const toALInboundControlAcksKey = (namespace: string, msgId: string): string => namespace + msgId;
                const toALInboundControlPrivateKey = (namespace: string): string => namespace;
                export const AL_INBOUND_CONTROL_LIMIT = toALInboundControlPrivateKey('limit').length;
            `,
            'packages/shared-web/browser/alm/al-browser-cache-keys.ts': `
                export function toALBrowserCacheKey(namespace: string): string { return namespace; }
            `
        });

        expect(facts.rowFamilies).toEqual([
            { id: 'packages/shared/alm/inbound/control/al-inbound-control-rows.ts#toALInboundControlAcksKey' },
            { id: 'packages/shared/alm/outbound/admission/al-outbound-displayed-keys.ts#toALOutboundDisplayedRecipientKey' }
        ]);
    });
});

function computeFixtureFacts(sources: Readonly<Record<string, string>>) {
    const { project, scope } = createDirectWriteFixture(sources);
    return computeAdmissionBackendFacts(project, scope);
}
