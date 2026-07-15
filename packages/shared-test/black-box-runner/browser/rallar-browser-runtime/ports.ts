export type BlackBoxRallarGenerationPort = Readonly<{
    generation(): number;
    isCurrent(generation: number): boolean;
}>;
