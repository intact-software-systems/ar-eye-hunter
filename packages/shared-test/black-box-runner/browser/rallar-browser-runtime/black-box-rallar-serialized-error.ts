export interface BlackBoxRallarSerializedError {
    readonly name: string;
    readonly message: string;
    readonly stack: string | undefined;
}

export function toBlackBoxRallarSerializedError(error: Error): BlackBoxRallarSerializedError {
    return { name: error.name, message: error.message, stack: error.stack };
}
