import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    decodeGitHubGitBlob,
    decodeGitHubWorkflowJobPages,
    decodeGitHubWorkflowRunPages
} from '../../../../scripts/governance-decisions/github-governance-api.mjs';
import {
    authenticateGitHubAdministrator,
    authenticateRecordedGitHubAdministrator,
    publishGovernanceDecisionCommit,
    publishImmutableGitBlob
} from '../../../../scripts/governance-decisions/github-governance-publication.mjs';

const fixtureRoots: string[] = [];

afterEach(() => {
    for (const fixtureRoot of fixtureRoots.splice(0)) {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

describe('GitHub governance decision publication', () => {
    it('accepts only the current GitHub user with effective admin permission', () => {
        expect(
            authenticateGitHubAdministrator({
                readCurrentUser: () => ({ login: 'repository-admin', type: 'User' }),
                readPermission: () => ({ permission: 'admin', user: { login: 'repository-admin' } })
            })
        ).toEqual({ login: 'repository-admin', permission: 'admin' });

        for (const permission of ['maintain', 'write', 'read']) {
            expect(() =>
                authenticateGitHubAdministrator({
                    readCurrentUser: () => ({ login: 'repository-admin', type: 'User' }),
                    readPermission: () => ({ permission, user: { login: 'repository-admin' } })
                })
            ).toThrow('current GitHub user must have effective admin repository permission');
        }
    });

    it('publishes exact base64 additions and deletions with expected-head atomicity', () => {
        let observed: unknown;
        const published = publishGovernanceDecisionCommit({
            expectedHeadOid: '1'.repeat(40),
            operation: 'plan.cancel',
            decisionId: '2'.repeat(64),
            additions: [
                { path: 'plans/README.md', content: '# Active adaptive plans\n' },
                { path: 'governance/decisions/receipt.json', content: '{"receipt":true}\n' }
            ],
            deletions: ['plans/blocked-plan.md'],
            writeCommit: (publication: {
                repository: string;
                branchName: string;
                expectedHeadOid: string;
                message: string;
                additions: readonly { path: string; contents: string; }[];
                deletions: readonly { path: string; }[];
            }) => {
                observed = publication;
                return { oid: '3'.repeat(40) };
            }
        });

        expect(published).toEqual({ oid: '3'.repeat(40) });
        expect(observed).toEqual({
            repository: 'intact-software-systems/ar-eye-hunter',
            branchName: 'main',
            expectedHeadOid: '1'.repeat(40),
            message: 'governance(plan.cancel): 222222222222',
            additions: [
                {
                    path: 'plans/README.md',
                    contents: Buffer.from('# Active adaptive plans\n').toString('base64')
                },
                {
                    path: 'governance/decisions/receipt.json',
                    contents: Buffer.from('{"receipt":true}\n').toString('base64')
                }
            ],
            deletions: [{ path: 'plans/blocked-plan.md' }]
        });
    });

    it('fails closed when GitHub returns missing or ambiguous commit evidence', () => {
        const publication = {
            expectedHeadOid: '1'.repeat(40),
            operation: 'plan.cancel',
            decisionId: '2'.repeat(64),
            additions: [],
            deletions: []
        } as const;

        expect(() =>
            publishGovernanceDecisionCommit({
                ...publication,
                writeCommit: () => ({})
            })
        ).toThrow('GitHub did not return one created commit OID');
        expect(() =>
            publishGovernanceDecisionCommit({
                ...publication,
                writeCommit: () => ({ oid: '3'.repeat(40), extraOid: '4'.repeat(40) })
            })
        ).toThrow('GitHub did not return one created commit OID');
    });

    it('uploads exact immutable bytes and rejects ambiguous blob responses', () => {
        const bytes = Buffer.from([0, 1, 2, 255]);
        let observed: unknown;

        expect(
            publishImmutableGitBlob({
                bytes,
                writeBlob: (blob: { content: string; encoding: 'base64'; }) => {
                    observed = blob;
                    return { sha: '5'.repeat(40) };
                }
            })
        ).toEqual({ oid: '5'.repeat(40), byteLength: 4 });
        expect(observed).toEqual({ content: bytes.toString('base64'), encoding: 'base64' });
        expect(
            publishImmutableGitBlob({
                bytes,
                writeBlob: () => ({
                    sha: '6'.repeat(40),
                    url: 'https://api.github.com/repos/owner/repo/git/blobs/oid'
                })
            })
        ).toEqual({ oid: '6'.repeat(40), byteLength: 4 });
        expect(() => publishImmutableGitBlob({ bytes, writeBlob: () => ({ sha: 'not-an-oid' }) })).toThrow('GitHub did not return one created blob OID');
        expect(() =>
            publishImmutableGitBlob({
                bytes,
                writeBlob: () => ({ sha: '6'.repeat(40), extraSha: '7'.repeat(40) })
            })
        ).toThrow('GitHub did not return one created blob OID');
    });

    it('fails closed for missing human identity and mismatched permission identity', () => {
        expect(() =>
            authenticateGitHubAdministrator({
                readCurrentUser: () => ({ login: 'governance-app[bot]', type: 'Bot' }),
                readPermission: () => ({ permission: 'admin' })
            })
        ).toThrow('GitHub did not return one current human user');
        expect(() =>
            authenticateGitHubAdministrator({
                readCurrentUser: () => ({ login: 'repository-admin', type: 'User' }),
                readPermission: () => ({ permission: 'admin', user: { login: 'different-user' } })
            })
        ).toThrow('current GitHub user must have effective admin repository permission');
        expect(() =>
            authenticateGitHubAdministrator({
                readCurrentUser: () => ({ login: 'repository-admin', type: 'User' }),
                readPermission: () => ({ permission: 'admin' })
            })
        ).toThrow('current GitHub user must have effective admin repository permission');
    });

    it('requires remote admin evidence for a workflow-recorded human actor', () => {
        expect(
            authenticateRecordedGitHubAdministrator({
                login: 'repository-admin',
                readPermission: () => ({
                    permission: 'admin',
                    user: { login: 'repository-admin' }
                })
            })
        ).toEqual({ login: 'repository-admin', permission: 'admin' });
        expect(() =>
            authenticateRecordedGitHubAdministrator({
                login: 'repository-admin',
                readPermission: () => ({ permission: 'maintain' })
            })
        ).toThrow('recorded GitHub actor must have effective admin repository permission');
        expect(() =>
            authenticateRecordedGitHubAdministrator({
                login: 'repository-admin',
                readPermission: () => ({ permission: 'admin' })
            })
        ).toThrow('recorded GitHub actor must have effective admin repository permission');
    });

    it('decodes only an exact GitHub Git Database blob response', () => {
        const oid = '7'.repeat(40);
        const content = '# Successor\n';

        expect(
            decodeGitHubGitBlob(oid, {
                sha: oid,
                encoding: 'base64',
                content: Buffer.from(content).toString('base64'),
                size: Buffer.byteLength(content)
            })
        ).toBe(content);

        for (
            const response of [
                {
                    sha: '8'.repeat(40),
                    encoding: 'base64',
                    content: Buffer.from(content).toString('base64'),
                    size: Buffer.byteLength(content)
                },
                { sha: oid, encoding: 'utf-8', content, size: Buffer.byteLength(content) },
                {
                    sha: oid,
                    encoding: 'base64',
                    content: Buffer.from(content).toString('base64'),
                    size: Buffer.byteLength(content) + 1
                },
                { sha: oid, encoding: 'base64', content: 'not-base64!', size: 4 },
                { sha: oid, encoding: 'base64', content: '/w==', size: 1 }
            ]
        ) {
            expect(() => decodeGitHubGitBlob(oid, response)).toThrow(
                'GitHub did not return the exact requested UTF-8 blob'
            );
        }
    });

    it('decodes paginated workflow-attempt jobs without hiding duplicate gate names', () => {
        const first = { id: 1, name: 'Governance Gate / Governance Gate' };
        const second = { id: 2, name: 'Governance Gate / Governance Gate' };

        expect(
            decodeGitHubWorkflowJobPages([
                { total_count: 2, jobs: [first] },
                { total_count: 2, jobs: [second] }
            ])
        ).toEqual([first, second]);
        expect(() => decodeGitHubWorkflowJobPages({ jobs: [first] })).toThrow(
            'GitHub did not return exact workflow job pages'
        );
        expect(() => decodeGitHubWorkflowJobPages([{ total_count: 2, jobs: [first] }])).toThrow(
            'GitHub did not return exact workflow job pages'
        );
    });

    it('decodes every workflow run page without hiding ambiguous admissions', () => {
        const first = { id: 701, run_attempt: 1 };
        const second = { id: 702, run_attempt: 2 };

        expect(
            decodeGitHubWorkflowRunPages([
                { total_count: 2, workflow_runs: [first] },
                { total_count: 2, workflow_runs: [second] }
            ])
        ).toEqual([first, second]);
        expect(() => decodeGitHubWorkflowRunPages({ workflow_runs: [first] })).toThrow(
            'GitHub did not return exact workflow run pages'
        );
        expect(() => decodeGitHubWorkflowRunPages([{ total_count: 2, workflow_runs: [first] }])).toThrow('GitHub did not return exact workflow run pages');
    });

    it('rejects a dirty or stale local checkout before publication', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'governance-publication-'));
        fixtureRoots.push(root);
        const { validateLocalGovernancePublicationState } = await import('../../../../scripts/governance-decisions/github-governance-publication.mjs');

        expect(() =>
            validateLocalGovernancePublicationState({
                request: { expectedHeadOid: '1'.repeat(40) },
                readCheckoutState: () => ({
                    headOid: '1'.repeat(40),
                    remoteMainOid: '1'.repeat(40),
                    status: '?? request.json\n'
                })
            })
        ).toThrow('local governance publication requires a completely clean checkout');
        expect(() =>
            validateLocalGovernancePublicationState({
                request: { expectedHeadOid: '1'.repeat(40) },
                readCheckoutState: () => ({
                    headOid: '1'.repeat(40),
                    remoteMainOid: '2'.repeat(40),
                    status: ''
                })
            })
        ).toThrow('expected head must equal both local HEAD and current remote main');
    });
});
