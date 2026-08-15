import { describe, expect, it } from 'vitest';

import {
  parseApiV1BlackBoxArgs,
  toApiV1BlackBoxEnvironment,
} from '@shared-test/black-box-runner/api-v1-black-box-run.mts';

const managedClusterProfiles = [
  'api-v1-black-box-cluster',
  'api-v1-black-box-crdt',
  'api-v1-black-box-medium-scale',
  'api-v1-black-box-delta-primary',
] as const;

describe('managed API-v1 cluster profile options', () => {
  it.each(managedClusterProfiles)(
    'requires all three managed ports for ordinary profile %s',
    (profile) => {
      expect(() => parseApiV1BlackBoxArgs([`--profile=${profile}`])).toThrow(
        /profile.*secondary-port.*tertiary-port/i,
      );
      expect(() =>
        parseApiV1BlackBoxArgs([`--profile=${profile}`, '--secondary-port=18081']),
      ).toThrow(/secondary-port.*tertiary-port/i);
      expect(() =>
        parseApiV1BlackBoxArgs([`--profile=${profile}`, '--tertiary-port=18082']),
      ).toThrow(/secondary-port.*tertiary-port/i);
    },
  );

  it.each(managedClusterProfiles)(
    'requires Postgres for ordinary managed profile %s',
    (profile) => {
      expect(() =>
        parseApiV1BlackBoxArgs([`--profile=${profile}`, '--backend=pglite-memory']),
      ).toThrow(/profile.*postgres/i);
    },
  );

  it.each(managedClusterProfiles)(
    'accepts one complete pairwise-distinct Postgres triplet for %s',
    (profile) => {
      expect(
        parseApiV1BlackBoxArgs([
          `--profile=${profile}`,
          '--backend=postgres',
          '--port=18080',
          '--secondary-port=18081',
          '--tertiary-port=18082',
        ]),
      ).toMatchObject({
        profile,
        backend: 'postgres',
        port: 18080,
        secondaryPort: 18081,
        tertiaryPort: 18082,
      });
    },
  );

  it.each(
    managedClusterProfiles.flatMap(
      (profile) =>
        [
          [profile, 'secondary duplicates primary', '18080', '18082'],
          [profile, 'tertiary duplicates primary', '18081', '18080'],
          [profile, 'tertiary duplicates secondary', '18081', '18081'],
        ] as const,
    ),
  )('rejects ordinary managed profile %s when %s', (profile, _case, secondary, tertiary) => {
    expect(() =>
      parseApiV1BlackBoxArgs([
        `--profile=${profile}`,
        '--port=18080',
        `--secondary-port=${secondary}`,
        `--tertiary-port=${tertiary}`,
      ]),
    ).toThrow(/differ/i);
  });

  it.each(managedClusterProfiles)(
    'preserves externally managed recipes-only profile %s and supplied URLs',
    (profile) => {
      const options = parseApiV1BlackBoxArgs(['--recipes-only', `--profile=${profile}`]);
      const env = toApiV1BlackBoxEnvironment(options, {
        RALLAR_API_BASE_URL: 'https://primary.example.test',
        RALLAR_WS_BASE_URL: 'wss://primary.example.test',
        RALLAR_API_BASE_URL_SECONDARY: 'https://secondary.example.test',
        RALLAR_WS_BASE_URL_SECONDARY: 'wss://secondary.example.test',
        RALLAR_API_BASE_URL_TERTIARY: 'https://tertiary.example.test',
        RALLAR_WS_BASE_URL_TERTIARY: 'wss://tertiary.example.test',
      });

      expect(options).toMatchObject({ profile, recipesOnly: true });
      expect(env).toMatchObject({
        RALLAR_API_BASE_URL: 'https://primary.example.test',
        RALLAR_WS_BASE_URL: 'wss://primary.example.test',
        RALLAR_API_BASE_URL_SECONDARY: 'https://secondary.example.test',
        RALLAR_WS_BASE_URL_SECONDARY: 'wss://secondary.example.test',
        RALLAR_API_BASE_URL_TERTIARY: 'https://tertiary.example.test',
        RALLAR_WS_BASE_URL_TERTIARY: 'wss://tertiary.example.test',
      });
    },
  );
});
