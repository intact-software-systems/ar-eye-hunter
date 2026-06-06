import type { RallarAiSchemaRegistryEntry } from './rallar-ai-types.ts';
import { hashRallarAiSchema } from './rallar-ai-hashing.ts';

export class RallarAiSchemaRegistry {
    private readonly entries = new Map<string, RallarAiSchemaRegistryEntry>();

    register(entry: RallarAiSchemaRegistryEntry): this {
        this.entries.set(toSchemaKey(entry.schemaId, entry.schemaVersion), {
            ...entry,
            schemaHash: entry.schemaHash ?? hashRallarAiSchema(entry.schema),
        });
        return this;
    }

    require(
        schemaId: string,
        schemaVersion: string,
    ): RallarAiSchemaRegistryEntry {
        const entry = this.lookup(schemaId, schemaVersion);
        if (!entry) {
            throw new Error(
                `RallarAI schema is not registered: ${schemaId}@${schemaVersion}`,
            );
        }
        return entry;
    }

    lookup(
        schemaId: string,
        schemaVersion: string,
    ): RallarAiSchemaRegistryEntry | undefined {
        return this.entries.get(toSchemaKey(schemaId, schemaVersion));
    }

    isCompatible(
        schemaId: string,
        fromVersion: string,
        toVersion: string,
    ): boolean {
        if (fromVersion === toVersion) {
            return true;
        }
        const target = this.lookup(schemaId, toVersion);
        return target?.compatibleWith?.includes(fromVersion) ?? false;
    }

    list(): readonly RallarAiSchemaRegistryEntry[] {
        return [...this.entries.values()].sort((left, right) =>
            toSchemaKey(left.schemaId, left.schemaVersion).localeCompare(
                toSchemaKey(right.schemaId, right.schemaVersion),
            )
        );
    }
}

export function createRallarAiSchemaRegistry(): RallarAiSchemaRegistry {
    return new RallarAiSchemaRegistry();
}

export function toRallarAiSchemaKey(
    schemaId: string,
    schemaVersion: string,
): string {
    return toSchemaKey(schemaId, schemaVersion);
}

function toSchemaKey(schemaId: string, schemaVersion: string): string {
    return `${schemaId}@${schemaVersion}`;
}
