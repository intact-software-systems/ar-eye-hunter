import postgres from 'postgres';

export interface ManagedPostgresRunSelector {
  readonly backend: string;
  readonly clusterOnly: boolean;
  readonly clusterProfile: string;
  readonly recipesOnly: boolean;
}

export function requiresManagedPostgresRunDatabase(selector: ManagedPostgresRunSelector): boolean {
  return (
    selector.backend === 'postgres' &&
    selector.clusterOnly &&
    selector.clusterProfile === 'api-v1-black-box-medium-scale' &&
    !selector.recipesOnly
  );
}

export function toManagedPostgresDatabaseName(runId: string, nonce: string): string {
  const runIdentity = toDatabaseIdentity(runId).slice(0, 36) || 'run';
  const nonceIdentity = nonce
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '')
    .slice(0, 16);
  if (nonceIdentity.length !== 16) {
    throw new Error('Managed PostgreSQL database nonce must contain at least 16 characters.');
  }
  return `rallar_bb_${runIdentity}_${nonceIdentity}`;
}

export function toManagedPostgresDatabaseUrl(databaseUrl: string, databaseName: string): string {
  requireDatabaseName(databaseName);
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Managed PostgreSQL isolation requires a PostgreSQL DATABASE_URL.');
  }
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function withManagedPostgresRunDatabase<T>(
  databaseUrl: string,
  runId: string,
  run: (isolatedDatabaseUrl: string) => Promise<T>,
): Promise<T> {
  const databaseName = toManagedPostgresDatabaseName(runId, crypto.randomUUID());
  const isolatedDatabaseUrl = toManagedPostgresDatabaseUrl(databaseUrl, databaseName);
  const adminSql = postgres(databaseUrl, {
    max: 1,
    connection: { application_name: `${databaseName}_admin` },
  });
  let databaseCreated = false;
  try {
    await adminSql.unsafe(`create database "${databaseName}"`);
    databaseCreated = true;
    return await run(isolatedDatabaseUrl);
  } finally {
    try {
      if (databaseCreated) {
        await adminSql.unsafe(`drop database "${databaseName}" with (force)`);
      }
    } finally {
      await adminSql.end({ timeout: 5 });
    }
  }
}

function toDatabaseIdentity(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
}

function requireDatabaseName(databaseName: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) {
    throw new Error('Managed PostgreSQL database name is invalid.');
  }
}
