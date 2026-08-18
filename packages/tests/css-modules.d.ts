// The tests project compiles browser app source that imports CSS modules. Vite supplies these
// declarations at build time via `vite/client`, but that type package cannot be used here: the
// repository resolves two copies of `vite` on machines that have run the Deno tasks, and the
// resulting duplicate-identity conflict is invisible to CI.
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module '*.css' {}
