import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';

import {
    openLiveRtcBrowserEntry,
    type LiveRtcBrowserEntryPage,
    type OpenLiveRtcBrowserAgentInput
} from '../../../tests/playwright/rallar-black-box/live-rtc-browser-agents.ts';
import type { FullStackRtcServedBuild } from '../../shared-test/black-box-runner/fixtures/rtc-production/full-stack-rtc-production-proof.ts';

it.each(['valid', 'missing', 'wrong', 'navigation-failed', 'symlink'] as const)(
    'settles original response-byte proof before browser startup can return: %s',
    async (scenario) => {
        const buildRoot = await mkdtemp(join(tmpdir(), 'rtc-browser-entry-'));
        onTestFinished(() => rm(buildRoot, { recursive: true, force: true }));
        const index = Buffer.from('<script src="/assets/entry.js"></script>');
        const script = Buffer.from('export const value = 42;');
        const files = [{ path: 'index.html', sizeBytes: index.length, sha256: createHash('sha256').update(index).digest('hex') }, {
            path: 'assets/entry.js',
            sizeBytes: script.length,
            sha256: createHash('sha256').update(script).digest('hex')
        }];
        const build: FullStackRtcServedBuild = {
            seal: {
                version: 1,
                appServingMode: 'production',
                viteMode: 'production',
                nodeEnvironment: 'production',
                buildTarget: 'es2023',
                baselineId: 'fixture',
                attempt: {
                    workloadId: 'RTC-B06',
                    caseId: 'default',
                    inputKey: 'e3-memory-default',
                    intendedPhase: 'retained',
                    outerOrdinal: 1,
                    environmentId: 'E3-memory',
                    rawResultRelativePath: 'artifacts/staging/a.json'
                },
                buildRoot,
                apiOrigin: 'http://localhost:18080',
                spaOrigin: 'http://localhost:5177',
                git: { headCommit: 'a'.repeat(40), headTree: 'b'.repeat(40), ref: 'codex/fixture', clean: true },
                inputFiles: [],
                files,
                entryFiles: ['assets/entry.js'],
                buildArguments: []
            },
            servedFiles: files
        };
        const input: OpenLiveRtcBrowserAgentInput = {
            config: {
                productionBuild: build,
                spaBaseUrl: build.seal.spaOrigin,
                apiBaseUrl: build.seal.apiOrigin,
                controlWsUrl: 'ws://localhost:8081',
                register: false
            },
            prefix: 'A',
            auth: { kind: 'login', username: 'private-principal', password: 'private-password' },
            runId: 'private-run',
            agentId: 'private-agent',
            actor: 'private-actor',
            connection: 'private-connection',
            groupId: 'private-group'
        };
        let listener: Parameters<LiveRtcBrowserEntryPage['on']>[1] | null = null;
        const bodyReady = Promise.withResolvers<void>();
        let navigationUrl = '';
        const page: LiveRtcBrowserEntryPage = {
            on: (_event, registered) => {
                listener = registered;
            },
            off: (_event, registered) => {
                expect(registered).toBe(listener);
                listener = null;
            },
            goto: async (url) => {
                navigationUrl = url;
                if (scenario === 'navigation-failed') {
                    throw new Error('private-password');
                }
                listener!({
                    url: () => url,
                    status: () => 200,
                    body: async () => {
                        await bodyReady.promise;
                        return scenario === 'wrong' ? Buffer.from('wrong') : index;
                    }
                });
                if (scenario !== 'missing') {
                    listener!({
                        url: () => `${build.seal.spaOrigin}/assets/entry.js`,
                        status: () => 200,
                        body: async () => {
                            await bodyReady.promise;
                            return script;
                        }
                    });
                }
            }
        };
        if (scenario === 'symlink') {
            await writeFile(join(buildRoot, 'unowned.txt'), 'untouched');
            await symlink(join(buildRoot, 'unowned.txt'), join(buildRoot, 'entries.jsonl'));
        }
        let returned = false;
        const opening = openLiveRtcBrowserEntry(
            page,
            input,
            new URLSearchParams({ username: 'private-principal', password: 'private-password', group: 'private-group' })
        );
        opening.then(() => {
            returned = true;
        }, () => {});
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(returned).toBe(false);
        bodyReady.resolve();
        if (scenario !== 'valid') {
            await expect(opening).rejects.toThrow('Original production browser entry could not be verified.');
        }
        else {
            await opening;
            expect(navigationUrl).toContain('private-password');
            const persisted = await readFile(join(buildRoot, 'entries.jsonl'), 'utf8');
            expect(persisted).not.toMatch(/private-|password|username|group/);
            expect(persisted.trim().split('\n').map((line) => JSON.parse(line).path)).toEqual(['index.html', 'assets/entry.js']);
        }
        if (scenario === 'symlink') {
            expect(await readFile(join(buildRoot, 'unowned.txt'), 'utf8')).toBe('untouched');
        }
        expect(listener).toBeNull();
    }
);
