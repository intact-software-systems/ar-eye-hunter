import { Project } from 'ts-morph';

export interface DirectWriteFixtureScope {
    readonly root: string;
    readonly wiringModules: readonly string[];
    readonly repositoryContractModules: readonly string[];
    readonly keyModules: readonly string[];
    readonly workTopicConstants: readonly { readonly path: string; readonly name: string; }[];
    readonly schemaTables: readonly string[];
}

export const P_SQL_SQL_SOURCE = `
    export interface PSqlSql {
        <T>(template: TemplateStringsArray, ...values: unknown[]): Promise<T>;
        begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
        savepoint<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
    }
`;

export const ADMISSION_PORT_SOURCES = {
    'packages/shared-server/postgres/p-sql-sql.ts': P_SQL_SQL_SOURCE,
    'packages/shared/alm/al-admission-backend.ts': `
        export interface ALAdmissionBackend {
            read(key: string): Promise<unknown>;
            write<T>(operation: (context: unknown) => Promise<T>): Promise<T>;
        }
    `,
    'packages/shared/alm/al-admission-work-backend.ts': `
        import type { ALAdmissionBackend } from './al-admission-backend.ts';
        export interface ALAdmissionWorkBackend extends ALAdmissionBackend {
            readonly topic: string;
        }
    `,
    'packages/shared/alm/in-memory-admission-backend.ts': `
        import type { ALAdmissionWorkBackend } from './al-admission-work-backend.ts';
        export class InMemoryAdmissionBackend implements ALAdmissionWorkBackend {
            readonly topic = 'memory';
            async read(key: string): Promise<unknown> { return key; }
            async write<T>(operation: (context: unknown) => Promise<T>): Promise<T> { return operation(undefined); }
        }
    `,
    'packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts': `
        import type { ALAdmissionWorkBackend } from '../../../shared/alm/al-admission-work-backend.ts';
        import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
        export namespace PSqlAdmissionWorkBackend {
            export interface Input { readonly sql: PSqlSql; readonly namespace: string; }
        }
        export class PSqlAdmissionWorkBackend implements ALAdmissionWorkBackend {
            readonly topic = 'postgres';
            private readonly sql: PSqlSql;
            constructor(input: PSqlAdmissionWorkBackend.Input) { this.sql = input.sql; }
            async read(key: string): Promise<unknown> { return key; }
            async write<T>(operation: (context: unknown) => Promise<T>): Promise<T> {
                return this.sql.begin(async () => operation(undefined));
            }
        }
    `,
    'packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts': `
        import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
        import { PSqlAdmissionWorkBackend } from './p-sql-admission-work-backend.ts';
        export function createPSqlALInboundRuntimeStores(sql: PSqlSql, storeNamespace: string) {
            const namespace = \`\${storeNamespace}:inbound:admission\`;
            return new PSqlAdmissionWorkBackend({ sql, namespace });
        }
    `,
    'packages/shared/alm/inbound/al-inbound-admission-store.ts': `
        import type { ALAdmissionWorkBackend } from '../al-admission-work-backend.ts';
        class LineLog { write(line: string): void { void line; } }
        export class ALInboundAdmissionStore {
            private readonly log = new LineLog();
            constructor(private readonly backend: ALAdmissionWorkBackend) {}
            async admit(): Promise<void> {
                this.log.write('admitting');
                await this.backend.write(async () => 'admitted');
            }
            async peek(): Promise<unknown> { return this.backend.read('message'); }
        }
    `
} as const;

export function createDirectWriteFixture(sources: Readonly<Record<string, string>>): {
    readonly project: Project;
    readonly scope: DirectWriteFixtureScope;
} {
    const project = new Project({ useInMemoryFileSystem: true });
    for (const [repositoryPath, source] of Object.entries(sources)) {
        project.createSourceFile(`/${repositoryPath}`, source);
    }
    return {
        project,
        scope: {
            root: '/',
            wiringModules: [
                'packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts',
                'packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts'
            ],
            repositoryContractModules: ['packages/shared-server/runtime-state/runtime-state-repository.ts'],
            keyModules: ['packages/shared/alm/outbound/al-outbound-admission-keys.ts'],
            workTopicConstants: [{
                path: 'packages/shared/alm/al-admission-work-backend.ts',
                name: 'AL_ADMISSION_WORK_COMPLETED_RETENTION'
            }],
            schemaTables: ['resource_inbox', 'runtime_state_store']
        }
    };
}
