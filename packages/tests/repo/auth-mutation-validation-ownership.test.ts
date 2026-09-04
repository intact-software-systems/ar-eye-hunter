import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const privateValidationExports = [
    'equalAuthJson',
    'requireAuthTicket',
    'requireMatchingAuthKind',
    'validateAgentIssueRead',
    'validateAuthMutation',
    'validateConsumeAgentTicketRead',
    'validateIssueSessionRead',
    'validateLiveSessionAuthority'
] as const;
const directValidationImportOwners = [
    {
        ownerPath: 'packages/shared-server/rallar-system/auth/auth-mutation-service.ts',
        source: './mutation/validate/validate-auth-mutation.ts'
    },
    {
        ownerPath: 'packages/shared-server/rallar-system/auth/mutation/compute/compute-auth-agent-ticket-mutation.ts',
        source: '../validate/auth-mutation-validation.ts'
    },
    {
        ownerPath: 'packages/shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts',
        source: '../validate/auth-mutation-validation.ts'
    },
    {
        ownerPath: 'packages/shared-server/rallar-system/auth/mutation/compute/compute-auth-session-mutation.ts',
        source: '../validate/auth-mutation-validation.ts'
    },
    {
        ownerPath: 'packages/shared-server/rallar-system/auth/mutation/compute/compute-auth-ticket-mutation.ts',
        source: '../validate/auth-mutation-validation.ts'
    },
    {
        ownerPath: 'packages/shared-server/rallar-system/auth/mutation/compute/compute-auth-user-registration.ts',
        source: '../validate/auth-mutation-validation.ts'
    }
] as const;

describe('auth mutation validation ownership', () => {
    // Importing the whole package root can exceed the default timeout under a
    // fully parallel suite run; the ownership assertion itself is instant.
    it('keeps validation helpers out of the public package root', { timeout: 20_000 }, async () => {
        const packageRoot = await import(absolute('packages/shared-server/mod.ts'));

        for (const name of privateValidationExports) {
            expect(packageRoot, name).not.toHaveProperty(name);
        }
    });

    it('keeps validation dependencies on canonical module paths', () => {
        for (const { ownerPath, source } of directValidationImportOwners) {
            expect(importSources(absolute(ownerPath)), ownerPath).toContain(source);
        }
    });
});

function absolute(filePath: string): string {
    return path.join(repoRoot, filePath);
}

function importSources(filePath: string): readonly string[] {
    const source = readFileSync(filePath, 'utf8');
    const program = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program;
    return program.body.flatMap((statement) => statement.type === 'ImportDeclaration' ? [statement.source.value] : []);
}
