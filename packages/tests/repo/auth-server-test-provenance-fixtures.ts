import {
  AUTH_TEST_PROVENANCE_MANIFEST,
  type AuthTestProvenanceInput,
  type AuthTestProvenanceManifest,
} from './auth-server-test-provenance-validation.ts';

interface FixtureSourceInput {
  readonly importPath: string;
  readonly title: string;
  readonly includeFirstCase: boolean;
  readonly includeSecondCase: boolean;
  readonly includeDescribe: boolean;
}

export function createPassingProvenanceInput(): AuthTestProvenanceInput {
  const predecessorBlobs: Record<string, string> = {};
  const predecessorSources: Record<string, string> = {};
  const finalSources: Record<string, string> = {};

  AUTH_TEST_PROVENANCE_MANIFEST.predecessors.forEach((entry, index) => {
    const title = `preserved case ${index}`;
    predecessorBlobs[entry.path] = entry.blob;
    predecessorSources[entry.path] = toFixtureSource({
      importPath: './fake-runtime-state-repository.ts',
      title,
      includeFirstCase: true,
      includeSecondCase: entry.finalOwners.length === 2,
      includeDescribe: true,
    });
    entry.finalOwners.forEach((owner, ownerIndex) => {
      finalSources[owner] = toFixtureSource({
        importPath: '../fake-runtime-state-repository.ts',
        title,
        includeFirstCase: ownerIndex === 0,
        includeSecondCase: ownerIndex === 1,
        includeDescribe: false,
      });
    });
  });

  return {
    manifest: cloneManifest(),
    snapshot: {
      baseCommit: AUTH_TEST_PROVENANCE_MANIFEST.baseCommit,
      predecessorBlobs,
      predecessorSources,
      finalSources,
    },
  };
}

export function cloneManifest(): AuthTestProvenanceManifest {
  return structuredClone(AUTH_TEST_PROVENANCE_MANIFEST);
}

export function replacePredecessorSource(
  input: AuthTestProvenanceInput,
  source: string,
): AuthTestProvenanceInput {
  const predecessor = input.manifest.predecessors[0];
  return {
    ...input,
    snapshot: {
      ...input.snapshot,
      predecessorSources: {
        ...input.snapshot.predecessorSources,
        [predecessor.path]: source,
      },
    },
  };
}

export function replaceFinalSource(
  input: AuthTestProvenanceInput,
  source: string,
): AuthTestProvenanceInput {
  const owner = input.manifest.predecessors[0].finalOwners[0];
  return {
    ...input,
    snapshot: {
      ...input.snapshot,
      finalSources: {
        ...input.snapshot.finalSources,
        [owner]: source,
      },
    },
  };
}

export function toSingleCaseSource(body: string): string {
  return `
    import { expect, it } from 'vitest';
    it('preserved context', () => {
      ${body}
    }, 500);
  `;
}

function toFixtureSource(input: FixtureSourceInput): string {
  const cases = [
    input.includeFirstCase ? toFixtureCase(input.title) : '',
    input.includeSecondCase ? toFixtureCase(`${input.title} split`) : '',
  ].join('\n');
  const registrations = input.includeDescribe
    ? `describe('removed predecessor ownership', () => { ${cases} });`
    : cases;
  return `
    import { expect, it } from 'vitest';
    import { FakeRuntimeStateRepository } from '${input.importPath}';
    ${registrations}
  `;
}

function toFixtureCase(title: string): string {
  return `
    it('${title}', () => {
      const runtime = new FakeRuntimeStateRepository();
      prepare();
      prepare();
      let count = 0;
      count += 1;
      expect(runtime).toEqual(
        expect.objectContaining({
          duplicate: ['same', 'same'],
          numbers: [7, 7],
          patterns: [/proof/gi, /proof/gi],
        }),
      );
    }, 500);
  `;
}
