import { describe, expect, it } from 'vitest';

import {
  parseApiV1BlackBoxArgs,
  toApiV1ServerCommand,
} from '@shared-test/black-box-runner/api-v1-black-box-run.mts';

describe('managed API-v1 PGlite lifecycle', () => {
  it('grants managed PGlite servers write permission for their private temporary roots', () => {
    const options = parseApiV1BlackBoxArgs(['--backend=pglite-memory']);

    expect(toApiV1ServerCommand(options)).toContain('--allow-write');
  });
});
