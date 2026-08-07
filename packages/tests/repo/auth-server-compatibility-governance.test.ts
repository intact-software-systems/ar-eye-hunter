import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readAuthCompatibilityExportViolations,
  readModuleReferences,
} from './auth-server-compatibility-governance-validation.ts';
import {
  authCompatibilityConsumerInventory,
  readAuthCompatibilityConsumers,
  readAuthCompatibilityIdentityConsumers,
} from './auth-server-compatibility-consumer-inventory.ts';

const validationPath = 'packages/tests/repo/auth-server-compatibility-governance-validation.ts';

it('requires fail-closed compatibility exports and consumer discovery', () => {
  expect(existsSync(path.join(process.cwd(), validationPath)), validationPath).toBe(true);
});

it('locks every runtime and type export to its direct canonical owner', () => {
  expect(readAuthCompatibilityExportViolations(readRepositorySource)).toEqual([]);
});

describe('compatibility export mutation fixtures', () => {
  it('rejects export kind, target, and second-hop changes', () => {
    const wrapper = 'packages/shared-server/rallar-system/services/AppAuthInboxService.ts';
    const canonical = 'packages/shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
    const mutations = [
      new Map([
        [
          wrapper,
          readRepositorySource(wrapper).replace(
            'export { AppAuthInboxService }',
            'export type { AppAuthInboxService }',
          ),
        ],
      ]),
      new Map([
        [
          wrapper,
          readRepositorySource(wrapper).replace(
            "'../auth/inbox/app-auth-inbox-service.ts'",
            "'../auth/inbox/auth-app-inbox-routing.ts'",
          ),
        ],
      ]),
      new Map([[canonical, "export { AppAuthInboxService } from './second-hop.ts';"]]),
    ];

    for (const overrides of mutations) {
      expect(readAuthCompatibilityExportViolations(withOverrides(overrides))).not.toEqual([]);
    }
  });
});

describe('compatibility consumer scanner fixtures', () => {
  it.each(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])(
    'discovers static, dynamic, and require references in .%s',
    (extension) => {
      const source = [
        "import value from './static.ts';",
        "const dynamic = import('./dynamic.ts');",
        "const required = require('./required.ts');",
      ].join('\n');

      expect(readModuleReferences(`fixture.${extension}`, source)).toEqual([
        { kind: 'static', requiresRuntimeIdentity: true, specifier: './static.ts' },
        { kind: 'dynamic', requiresRuntimeIdentity: true, specifier: './dynamic.ts' },
        { kind: 'require', requiresRuntimeIdentity: true, specifier: './required.ts' },
      ]);
    },
  );

  it('discovers type-only and import-equals references explicitly', () => {
    const source = [
      "import type { Value } from './type-only.ts';",
      "import RequiredValue = require('./import-equals.ts');",
    ].join('\n');

    expect(readModuleReferences('fixture.ts', source)).toEqual([
      { kind: 'static', requiresRuntimeIdentity: false, specifier: './type-only.ts' },
      { kind: 'import-equals', requiresRuntimeIdentity: true, specifier: './import-equals.ts' },
    ]);
  });

  it('fails closed for malformed and unsupported source files', () => {
    expect(() => readModuleReferences('fixture.ts', 'import {')).toThrow(/fixture\.ts/);
    expect(() => readModuleReferences('fixture.vue', 'const value = 1;')).toThrow(/unsupported/i);
  });

  it('keeps all consumers and runtime-identity consumers explicit', () => {
    const consumers = readAuthCompatibilityConsumers();
    const identityConsumers = readAuthCompatibilityIdentityConsumers();
    for (const inventory of authCompatibilityConsumerInventory) {
      expect(consumers.get(inventory.compatibilityPath)).toEqual(inventory.consumers);
      expect(identityConsumers.get(inventory.compatibilityPath)).toEqual(
        inventory.identityConsumers,
      );
    }
  });
});

function readRepositorySource(filePath: string): string {
  return readFileSync(path.join(process.cwd(), filePath), 'utf8');
}

function withOverrides(overrides: ReadonlyMap<string, string>): (filePath: string) => string {
  return (filePath) => overrides.get(filePath) ?? readRepositorySource(filePath);
}
