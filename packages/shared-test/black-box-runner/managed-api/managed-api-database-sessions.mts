import postgres from 'postgres';

const APPLICATION_NAME_PARAMETER = 'application_name';
const TERMINATION_TIMEOUT_MS = 15_000;
const TERMINATION_POLL_MS = 25;

/** Names a managed process's database sessions, so a fault finds them among the sessions of its run. */
export function toManagedApiDatabaseUrl(databaseUrl: string, applicationName: string): string {
    const url = new URL(databaseUrl);
    url.searchParams.set(APPLICATION_NAME_PARAMETER, applicationName);
    return url.toString();
}

/** Ends the listed backends and answers, once none of them is a session any more, how many it ended. */
export async function terminatePostgresBackends(
    sql: ReturnType<typeof postgres>,
    pids: readonly number[]
): Promise<number> {
    if (pids.length === 0) {
        return 0;
    }
    const terminations = await sql<{ terminated: boolean; }[]>`
        select pg_terminate_backend(pid) as terminated from pg_stat_activity where pid in ${sql(pids)}
    `;
    const deadline = Date.now() + TERMINATION_TIMEOUT_MS;
    while ((await sql`select pid from pg_stat_activity where pid in ${sql(pids)}`).length > 0) {
        if (Date.now() >= deadline) {
            throw new Error(`PostgreSQL backends ${pids.join(', ')} outlived their termination.`);
        }
        await new Promise((resolve) => setTimeout(resolve, TERMINATION_POLL_MS));
    }
    return terminations.filter(({ terminated }) => terminated).length;
}

/** Ends every database session of the managed process this database URL names; answers how many it ended. */
export async function cutManagedApiDatabaseSessions(databaseUrl: string): Promise<number> {
    const url = new URL(databaseUrl);
    const applicationName = url.searchParams.get(APPLICATION_NAME_PARAMETER);
    if (applicationName === null) {
        throw new Error('A managed API process names its database sessions.');
    }
    url.searchParams.delete(APPLICATION_NAME_PARAMETER);
    const sql = postgres(url.toString(), { max: 1 });
    try {
        const sessions = await sql<{ pid: number; }[]>`
            select pid from pg_stat_activity
            where datname = current_database() and application_name = ${applicationName}
        `;
        return await terminatePostgresBackends(sql, sessions.map(({ pid }) => pid));
    }
    finally {
        await sql.end();
    }
}
