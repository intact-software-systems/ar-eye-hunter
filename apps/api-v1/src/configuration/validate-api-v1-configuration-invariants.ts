import type {
    ApiV1AppInboxConfiguration,
    ApiV1AuthenticationConfiguration,
    ApiV1BlackBoxConfiguration,
    ApiV1ConfigurationProfile,
    ApiV1DatabaseConfiguration,
    ApiV1HttpConfiguration,
    ApiV1IceConfiguration,
    ApiV1PublicApiConfiguration,
    ApiV1StateApiConfiguration,
    ApiV1TopologyConfiguration
} from './api-v1-configuration.ts';

export interface ApiV1ConfigurationInvariantCollector {
    isValid(...paths: readonly string[]): boolean;
    invariant(path: string, code: string, message: string): void;
}

export interface ValidateApiV1ConfigurationInvariantsInput {
    readonly profileName: ApiV1ConfigurationProfile['name'];
    readonly productionHardening: boolean;
    readonly http: ApiV1HttpConfiguration;
    readonly publicApi: ApiV1PublicApiConfiguration;
    readonly database: ApiV1DatabaseConfiguration;
    readonly authentication: ApiV1AuthenticationConfiguration;
    readonly stateApi: ApiV1StateApiConfiguration;
    readonly topology: ApiV1TopologyConfiguration;
    readonly appInbox: ApiV1AppInboxConfiguration;
    readonly ice: ApiV1IceConfiguration;
    readonly blackBox: ApiV1BlackBoxConfiguration;
}

export function validateApiV1ConfigurationInvariants(
    collector: ApiV1ConfigurationInvariantCollector,
    configuration: ValidateApiV1ConfigurationInvariantsInput
): void {
    const planning = configuration.topology.planning;
    if (
        collector.isValid(
            'topology.planning.meshMinSize',
            'topology.planning.treeMinSize'
        ) && planning.meshMinSize < planning.treeMinSize
    ) {
        collector.invariant(
            'topology.planning.meshMinSize',
            'mesh-before-tree',
            'Mesh minimum size must be greater than or equal to tree minimum size.'
        );
    }
    if (
        collector.isValid(
            'topology.planning.meshParamK',
            'topology.planning.degreeLimit'
        ) && planning.meshParamK > planning.degreeLimit
    ) {
        collector.invariant(
            'topology.planning.meshParamK',
            'mesh-param-exceeds-degree',
            'Mesh parameter K must not exceed the topology degree limit.'
        );
    }
    const queueResilience = configuration.topology.queueResilience;
    if (
        collector.isValid(
            'topology.queueResilience.initialRate',
            'topology.queueResilience.maxRate'
        ) && queueResilience.initialRate > queueResilience.maxRate
    ) {
        collector.invariant(
            'topology.queueResilience.initialRate',
            'initial-rate-exceeds-maximum',
            'Initial queue rate must not exceed the maximum queue rate.'
        );
    }
    const delivery = configuration.topology.delivery;
    if (
        collector.isValid(
            'topology.delivery.heartbeatIntervalMs',
            'topology.delivery.leaseDurationMs'
        ) && delivery.heartbeatIntervalMs >= delivery.leaseDurationMs
    ) {
        collector.invariant(
            'topology.delivery.heartbeatIntervalMs',
            'heartbeat-exceeds-lease',
            'Delivery heartbeat interval must be shorter than the stream lease.'
        );
    }
    if (
        collector.isValid(
            'topology.delivery.pageSize',
            'topology.delivery.maxEntriesPerTurn'
        ) && delivery.pageSize > delivery.maxEntriesPerTurn
    ) {
        collector.invariant(
            'topology.delivery.pageSize',
            'page-exceeds-turn',
            'Delivery page size must not exceed maximum entries per turn.'
        );
    }
    const completionWait = configuration.appInbox.completionWait;
    if (
        collector.isValid(
            'appInbox.completionWait.retryIntervalMs',
            'appInbox.completionWait.maxRetryIntervalMs'
        ) && completionWait.retryIntervalMs > completionWait.maxRetryIntervalMs
    ) {
        collector.invariant(
            'appInbox.completionWait.retryIntervalMs',
            'retry-interval-exceeds-maximum',
            'Initial AppInbox retry interval must not exceed the maximum retry interval.'
        );
    }
    if (
        configuration.topology.replay.queueWorkers === 'disabled' &&
        configuration.database.mode !== 'postgres'
    ) {
        collector.invariant(
            'topology.replay.queueWorkers',
            'disabled-workers-require-postgres',
            'Disabled API queue workers require PostgreSQL delivery.'
        );
    }
    if (
        configuration.blackBox.pgliteEvidence.mode === 'directory' &&
        configuration.database.mode === 'postgres'
    ) {
        collector.invariant(
            'blackBox.pgliteEvidence.mode',
            'pglite-evidence-requires-pglite',
            'PGlite evidence publication requires a PGlite database mode.'
        );
    }
    if (
        collector.isValid('authentication.credentialSecret') &&
        configuration.authentication.credentialSecret.length < 32
    ) {
        collector.invariant(
            'authentication.credentialSecret',
            'auth-secret-strength',
            'Authentication credential secret does not meet the required strength policy.'
        );
    }
    if (configuration.productionHardening) {
        validateProductionHardening(collector, configuration);
    }
    if (configuration.profileName === 'prod') {
        validateConvenientProductionPrivileges(collector, configuration);
    }
}

function validateConvenientProductionPrivileges(
    collector: ApiV1ConfigurationInvariantCollector,
    configuration: ValidateApiV1ConfigurationInvariantsInput
): void {
    const operatorToken = configuration.blackBox.operatorToken;
    if (operatorToken.mode === 'enabled' && operatorToken.allowedClientIds.length === 0) {
        collector.invariant(
            'blackBox.operatorToken.allowedClientIds',
            'production-operator-allowlist-required',
            'Convenient production operator-token issuance requires an explicit client allowlist.'
        );
    }
    const staticClientIds = new Set(
        configuration.authentication.staticClients.map((client) => client.clientId)
    );
    if (
        configuration.authentication.adminClientIds.some((clientId) => staticClientIds.has(clientId))
    ) {
        collector.invariant(
            'authentication.adminClientIds',
            'production-demo-privilege-overlap',
            'Convenient production administrators must not use bundled demo identities.'
        );
    }
    if (
        operatorToken.allowedClientIds.some((clientId) => staticClientIds.has(clientId))
    ) {
        collector.invariant(
            'blackBox.operatorToken.allowedClientIds',
            'production-demo-privilege-overlap',
            'Convenient production operators must not use bundled demo identities.'
        );
    }
}

function validateProductionHardening(
    collector: ApiV1ConfigurationInvariantCollector,
    configuration: ValidateApiV1ConfigurationInvariantsInput
): void {
    if (configuration.database.mode !== 'postgres') {
        collector.invariant(
            'database.mode',
            'hardening-postgres',
            'Production hardening requires PostgreSQL.'
        );
    }
    if (configuration.database.pubSub !== 'postgres') {
        collector.invariant(
            'database.pubSub',
            'hardening-postgres-pub-sub',
            'Production hardening requires PostgreSQL pub/sub.'
        );
    }
    if (!hasExactProtocol(configuration.publicApi.apiBaseUrl, 'https:')) {
        collector.invariant(
            'publicApi.apiBaseUrl',
            'hardening-https-api',
            'Production hardening requires an HTTPS API base URL.'
        );
    }
    if (!hasExactProtocol(configuration.publicApi.wsBaseUrl, 'wss:')) {
        collector.invariant(
            'publicApi.wsBaseUrl',
            'hardening-wss-api',
            'Production hardening requires a WSS base URL.'
        );
    }
    if (
        configuration.http.corsOrigins.length === 0 ||
        configuration.http.corsOrigins.some((origin) => !hasExactProtocol(origin, 'https:'))
    ) {
        collector.invariant(
            'http.corsOrigins',
            'hardening-https-origins',
            'Production hardening requires one or more exact HTTPS origins.'
        );
    }
    if (!configuration.stateApi.strictReadAuthorization) {
        collector.invariant(
            'stateApi.strictReadAuthorization',
            'hardening-strict-state-reads',
            'Production hardening requires strict state-read authorization.'
        );
    }
    if (configuration.authentication.registrationMode !== 'admin') {
        collector.invariant(
            'authentication.registrationMode',
            'hardening-admin-registration',
            'Production hardening requires admin-only registration.'
        );
    }
    if (configuration.authentication.staticClientsMode !== 'disabled') {
        collector.invariant(
            'authentication.staticClientsMode',
            'hardening-static-clients-disabled',
            'Production hardening requires disabled static clients.'
        );
    }
    if (
        configuration.authentication.adminClientIds.length === 0 ||
        configuration.authentication.adminClientIds.some((clientId) => clientId.toLowerCase() === 'admin')
    ) {
        collector.invariant(
            'authentication.adminClientIds',
            'hardening-non-demo-admins',
            'Production hardening requires at least one non-demo administrator identity.'
        );
    }
    if (configuration.ice.mode !== 'metered') {
        collector.invariant(
            'ice.mode',
            'hardening-metered-ice',
            'Production hardening requires Metered ICE.'
        );
    }
    if (
        configuration.blackBox.operatorToken.mode !== 'enabled' ||
        configuration.blackBox.operatorToken.allowedClientIds.length === 0
    ) {
        collector.invariant(
            'blackBox.operatorToken',
            'hardening-operator-token',
            'Production hardening requires an explicit operator-token issuer.'
        );
    }
}

function hasExactProtocol(value: string, protocol: 'https:' | 'wss:'): boolean {
    try {
        return new URL(value).protocol === protocol;
    }
    catch {
        return false;
    }
}
