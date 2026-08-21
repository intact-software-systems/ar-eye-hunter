import { describe, expect, it } from 'vitest';
import { uniqueSuffix } from '../../../tests/playwright/rallar-black-box/full-stack-helpers.ts';

describe('full-stack helper identities', () => {
  it('includes a cryptographically generated UUID in each unique suffix', () => {
    expect(uniqueSuffix()).toMatch(
      /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});
