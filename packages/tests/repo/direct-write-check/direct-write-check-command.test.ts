import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ADMISSION_PORT_SOURCES, APP_INBOX_SHAPED_SOURCES } from './direct-write-check-fixture.ts';

const repoRoot = process.cwd();
const commandPath = path.join(repoRoot, 'scripts/direct-write-check/check-direct-writes.mjs');
const REGISTRY_PATH = 'docs/app-inbox-direct-write-registry.md';
const PINS_PATH = 'scripts/direct-write-check/direct-write-review-pins.json';
const BACKEND_PATH = 'packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
const STORES_PATH = 'packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
const INBOUND_PATH = 'packages/shared/alm/inbound/al-inbound-admission-store.ts';
const WRITER_PATH = 'packages/shared-server/rallar-system/app-inbox/app-inbox-transaction-writer.ts';
const HOLDER_PATH = 'packages/shared-server/rallar-system/holder/write-holder-mutation.ts';
const BASIS = 'Read the construction, the call site and the trigger in the named file.';
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const fixtureRoot of fixtureRoots.splice(0)) {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

describe('direct-write check command', () => {
    it('passes when source and registry agree, and prints the census', () => {
        const root = createTree(baseSources(), baseRegistry());

        const result = runCheck(root);

        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
            'direct-write registry: 1 transport-direct store (1 under review, 0 approved); 7 surfaces'
        );
        expect(result.stdout).toContain('against origin/main: base not available');
        expect(result.stdout.trim().split('\n').at(-1)).toMatch(/^PASS: direct-write check \(\d+ files analysed\)$/u);
    });

    it('does not fire when a branch adds a write inside an AppInbox write(transaction, computed)', () => {
        const root = createTree(
            { ...baseSources(), [HOLDER_PATH]: APP_INBOX_SHAPED_SOURCES[HOLDER_PATH] },
            baseRegistry()
        );

        const result = runCheck(root);

        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
    });

    it('fails naming the fact when a store file adds a write through the backend', () => {
        const storePath = 'packages/shared/alm/outbound/al-outbound-resend-store.ts';
        const root = createTree({
            ...baseSources(),
            [storePath]: `
                import type { ALAdmissionWorkBackend } from '../al-admission-work-backend.ts';
                export class ALOutboundResendStore {
                    constructor(private readonly backend: ALAdmissionWorkBackend) {}
                    async scheduleResend(): Promise<void> { await this.backend.write(async () => 'scheduled'); }
                }
            `
        }, baseRegistry());

        const result = runCheck(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `direct-write.unregistered admissionBackendWrites ${storePath}#ALOutboundResendStore.scheduleResend`
        );
        expect(result.stderr).toContain('the proposal must first say "This writes outside AppInbox"');
        expect(result.stderr).toContain('FAIL: direct-write check (1 finding)');
    });

    it('analyses a write in a folder named generated, in a .mts or .tsx file, and in a new server app', () => {
        const rootWrite = (importPath: string) => `
            import type { PSqlSql } from '${importPath}';
            export async function onDisplayFrame(sql: PSqlSql, key: string): Promise<void> {
                await sql\`insert into runtime_state_store (store_key) values (\${key})\`;
            }
        `;
        const writes = {
            'packages/shared-server/rallar-system/generated/on-display-frame.ts': rootWrite('../../postgres/p-sql-sql.ts'),
            'packages/shared-server/rallar-system/websocket/on-display-frame.mts': rootWrite('../../postgres/p-sql-sql.ts'),
            'packages/shared-server/rallar-system/websocket/on-display-panel.tsx': rootWrite('../../postgres/p-sql-sql.ts'),
            'apps/display-server-v1/src/on-display-frame.ts': rootWrite('../../../packages/shared-server/postgres/p-sql-sql.ts')
        };
        const root = createTree({ ...baseSources(), ...writes }, baseRegistry());

        const result = runCheck(root);

        expect(result.status).toBe(1);
        for (const writePath of Object.keys(writes)) {
            expect(result.stderr).toContain(`direct-write.unregistered sqlWriteFiles ${writePath}\n`);
        }
        expect(result.stderr).toContain('FAIL: direct-write check (4 findings)');
    });

    it('fails naming the entry when its write is removed from the source', () => {
        const sources: Record<string, string> = baseSources();
        delete sources[INBOUND_PATH];
        const root = createTree(sources, baseRegistry());

        const result = runCheck(root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `direct-write.stale-entry admissionBackendWrites ${INBOUND_PATH}#ALInboundAdmissionStore.admit`
        );
    });

    it('fails before any analysis when the registry block is malformed or names a module that does not exist', () => {
        const malformed = createTree(baseSources(), baseRegistry());
        writeFileSync(path.join(malformed, REGISTRY_PATH), '```app-inbox-direct-write-registry-v1\n{ "version": \n```\n');
        const missingModule = createTree(baseSources(), {
            ...baseRegistry(),
            wiringModules: [BACKEND_PATH, 'packages/shared-server/al-runtime/postgres/create-p-sql-al-missing-stores.ts']
        });

        const malformedResult = runCheck(malformed);
        const missingModuleResult = runCheck(missingModule);

        expect(malformedResult.status).toBe(1);
        expect(malformedResult.stderr).toMatch(/^direct-write\.registry-invalid the registry block is not valid JSON/mu);
        expect(`${malformedResult.stdout}${malformedResult.stderr}`).not.toContain('analysed');
        expect(missingModuleResult.status).toBe(1);
        expect(missingModuleResult.stderr).toContain(
            'direct-write.registry-invalid wiringModules names packages/shared-server/al-runtime/postgres/create-p-sql-al-missing-stores.ts, ' +
                'which the analysed source does not hold'
        );
    });

    it('fails before any analysis when the registry moved from the review pins the check reads, or they are missing', () => {
        const registry = baseRegistry();
        const [store] = registry.stores;
        const approval = {
            state: 'approved',
            question: 'This writes outside AppInbox: may the inbound store keep its own transaction?',
            options: ['Keep the direct write.', 'Move the write through AppInbox.'],
            recommended: 'Move the write through AppInbox.',
            costOfAppInbox: 'not measured',
            answer: 'Keep the direct write.',
            answeredOn: '2026-11-28'
        };
        const displayedStore = { ...store, id: 'alm-displayed-record' };
        const displayedWrite = {
            id: 'packages/shared/alm/displayed/al-displayed-record.ts#ALDisplayedRecord.write',
            count: 1,
            class: 'transport-direct',
            basis: BASIS,
            stores: ['alm-displayed-record']
        };
        const approved = createTree(baseSources(), { ...registry, stores: [{ ...store, review: approval }] });
        const fourthStore = createTree(baseSources(), {
            ...registry,
            stores: [store, displayedStore],
            admissionBackendWrites: [...registry.admissionBackendWrites, displayedWrite]
        });
        const reclassed = createTree(baseSources(), {
            ...registry,
            transactionOpeners: registry.transactionOpeners.map((entry) => entry.class === 'app-inbox' ? { ...entry, class: 'passive-statement' } : entry)
        });
        const unpinned = createTree(baseSources(), registry);
        rmSync(path.join(unpinned, PINS_PATH));

        const results = [approved, fourthStore, reclassed, unpinned].map((root) => runCheck(root));

        expect(results.map((result) => result.status)).toEqual([1, 1, 1, 1]);
        expect(results.map((result) => `${result.stdout}${result.stderr}`.includes('analysed'))).toEqual([
            false,
            false,
            false,
            false
        ]);
        expect(results[0]?.stderr).toContain(
            'direct-write.registry-invalid stores: the registry approves [alm-inbound-admission], the review pins approve []'
        );
        expect(results[1]?.stderr).toContain(
            'direct-write.registry-invalid stores: the registry holds [alm-displayed-record under-review, ' +
                'alm-inbound-admission under-review], the review pins hold [alm-inbound-admission under-review]'
        );
        expect(results[1]?.stderr).toContain(
            `direct-write.registry-invalid admissionBackendWrites ${displayedWrite.id}: ` +
                'a transport-direct surface the review pins do not hold'
        );
        expect(results[2]?.stderr).toContain(
            'direct-write.registry-invalid classes: the registry holds ' +
                '{"browser-or-memory":1,"passive-statement":1,"transport-direct":5}, the review pins hold ' +
                '{"app-inbox":1,"browser-or-memory":1,"transport-direct":5}'
        );
        expect(results[3]?.stderr).toContain(`direct-write.registry-invalid ${PINS_PATH} cannot be read as JSON`);
    });

    it('prints each entry that differs from the base registry', () => {
        const root = createCommittedTree();
        const registry = baseRegistry();
        writeTree(root, {
            [REGISTRY_PATH]: toRegistryDocument({
                ...registry,
                transactionOpeners: registry.transactionOpeners.filter((entry) => !entry.id.startsWith(WRITER_PATH))
            }),
            [PINS_PATH]: JSON.stringify({ ...basePins(), classCounts: { 'browser-or-memory': 1, 'transport-direct': 5 } })
        });
        writeTree(root, { [WRITER_PATH]: 'export const retired = true;\n' });

        const result = runCheck(root, 'HEAD');

        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/^against the merge base of HEAD and HEAD \([0-9a-f]{12}\): \+0 -1 ~0$/mu);
        expect(result.stdout).toContain(
            `- transactionOpeners ${WRITER_PATH}#AppInboxTransactionWriter.inTransaction (app-inbox)`
        );
    });

    it('prints a change to a list that decides what the check computes', () => {
        const root = createCommittedTree();
        writeTree(root, {
            [REGISTRY_PATH]: toRegistryDocument({
                ...baseRegistry(),
                wiringModules: [BACKEND_PATH],
                workTopicConstants: [{ path: INBOUND_PATH, name: 'AL_INBOUND_TOPICS' }]
            })
        });

        const result = runCheck(root, 'HEAD');

        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/: \+1 -1 ~0$/mu);
        expect(result.stdout).toContain(`- scope wiringModules ${STORES_PATH}`);
        expect(result.stdout).toContain(`+ scope workTopicConstants ${INBOUND_PATH}#AL_INBOUND_TOPICS`);
    });

    it('compares with the merge base, so an entry the base branch gained since is not shown as removed', () => {
        const root = createCommittedTree();
        git(root, ['branch', 'feature']);
        const registry = baseRegistry();
        writeTree(root, {
            [REGISTRY_PATH]: toRegistryDocument({ ...registry, wiringModules: [...registry.wiringModules, INBOUND_PATH] })
        });
        commitAll(root, 'base branch moves on');
        git(root, ['checkout', '--quiet', 'feature']);

        const result = runCheck(root, 'main');

        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/^against the merge base of main and HEAD \([0-9a-f]{12}\): \+0 -0 ~0$/mu);
    });
});

function baseSources(): Record<string, string> {
    return {
        ...ADMISSION_PORT_SOURCES,
        [WRITER_PATH]: APP_INBOX_SHAPED_SOURCES[WRITER_PATH].replace(
            'import { writeHolderMutation } from \'../holder/write-holder-mutation.ts\';',
            'declare function writeHolderMutation(transaction: PSqlSql, computed: { readonly key: string }): Promise<void>;'
        )
    };
}

function baseRegistry() {
    const transport = { class: 'transport-direct', basis: BASIS, stores: ['alm-inbound-admission'] };
    return {
        version: 1,
        owner: 'Repository-governance maintainers',
        reviewCondition: 'Every under-review store is ruled on at the maintainer revisit.',
        wiringModules: [BACKEND_PATH, STORES_PATH],
        repositoryContractModules: [],
        workTopicConstants: [],
        stores: [{
            id: 'alm-inbound-admission',
            class: 'transport-direct',
            rows: ['The dedup key and owner row of each admitted message in runtime_state_store.'],
            incomingPaths: ['A WebSocket frame admitted by the socket handler.'],
            review: { state: 'under-review', since: '2026-11-27', raised: 'The maintainer revisit of 2026-11-27.' }
        }],
        admissionBackendImplementations: [
            { id: `${BACKEND_PATH}#PSqlAdmissionWorkBackend`, backend: 'postgres', ...transport },
            {
                id: 'packages/shared/alm/in-memory-admission-backend.ts#InMemoryAdmissionBackend',
                backend: 'not-postgres',
                class: 'browser-or-memory',
                basis: BASIS
            }
        ],
        admissionBackendConstructions: [{
            id: `${STORES_PATH}#createPSqlALInboundRuntimeStores`,
            count: 1,
            namespaces: ['`${storeNamespace}:inbound:admission`'],
            ...transport
        }],
        admissionBackendWrites: [{ id: `${INBOUND_PATH}#ALInboundAdmissionStore.admit`, count: 1, ...transport }],
        wiringImports: [{ id: `${STORES_PATH}#import:${BACKEND_PATH}`, ...transport }],
        transactionOpeners: [
            { id: `${WRITER_PATH}#AppInboxTransactionWriter.inTransaction`, count: 1, class: 'app-inbox', basis: BASIS },
            { id: `${BACKEND_PATH}#PSqlAdmissionWorkBackend.write`, count: 1, ...transport }
        ],
        sqlWriteFiles: [],
        nonTransactionHandleFeeds: [],
        repositoryWriteCallers: [],
        queueWriteCallers: [],
        rowFamilies: []
    };
}

function basePins() {
    return {
        approvedStoreIds: [],
        stores: [{ id: 'alm-inbound-admission', state: 'under-review' }],
        transportDirectSurfaces: [
            `admissionBackendConstructions ${STORES_PATH}#createPSqlALInboundRuntimeStores`,
            `admissionBackendImplementations ${BACKEND_PATH}#PSqlAdmissionWorkBackend`,
            `admissionBackendWrites ${INBOUND_PATH}#ALInboundAdmissionStore.admit`,
            `transactionOpeners ${BACKEND_PATH}#PSqlAdmissionWorkBackend.write`,
            `wiringImports ${STORES_PATH}#import:${BACKEND_PATH}`
        ],
        classCounts: { 'app-inbox': 1, 'browser-or-memory': 1, 'transport-direct': 5 }
    };
}

function createTree(sources: Readonly<Record<string, string>>, registry: object): string {
    const root = mkdtempSync(path.join(tmpdir(), 'rallar-direct-write-check-'));
    fixtureRoots.push(root);
    writeTree(root, {
        ...sources,
        'tsconfig.json': JSON.stringify({
            compilerOptions: {
                strict: true,
                noEmit: true,
                target: 'ES2024',
                module: 'ESNext',
                moduleResolution: 'Bundler',
                allowImportingTsExtensions: true
            }
        }),
        'apps/api-v1/prisma/schema.prisma': 'model resource_inbox {\n}\nmodel runtime_state_store {\n}\n',
        [REGISTRY_PATH]: toRegistryDocument(registry),
        [PINS_PATH]: JSON.stringify(basePins(), null, 2)
    });
    return root;
}

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
    for (const [relativePath, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
        writeFileSync(path.join(root, relativePath), content);
    }
}

function toRegistryDocument(registry: object): string {
    return `# Registry\n\n\`\`\`app-inbox-direct-write-registry-v1\n${JSON.stringify(registry, null, 2)}\n\`\`\`\n`;
}

function runCheck(root: string, base = 'origin/main') {
    return spawnSync(process.execPath, [commandPath, '--root', root, '--base', base], { cwd: root, encoding: 'utf8' });
}

function createCommittedTree(): string {
    const root = createTree(baseSources(), baseRegistry());
    git(root, ['init', '--quiet', '--initial-branch', 'main']);
    commitAll(root, 'base');
    return root;
}

function commitAll(root: string, message: string): void {
    git(root, ['add', '.']);
    git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', message]);
}

function git(root: string, args: readonly string[]): void {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
}
