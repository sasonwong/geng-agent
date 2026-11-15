/**
 * A tool definition is a plain object: `registerTool` takes whatever it is handed, and the
 * schema is ordinary JSON Schema. Writing it literally instead of through a builder keeps
 * the extensions free of run-time imports, which is what lets them load under a pi binary
 * that has no `node_modules` next to it.
 *
 * The type is here so a typo in the shape is a compile error in the editor, not a waking
 * that exits before it can speak.
 */
export interface Tool<P = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  // Each tool names its own parameters at the call site: the schema is still the runtime
  // truth, but `params.messages` now gets a type instead of `any`.
  execute: (
    id: string,
    params: P,
  ) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
}

export function tool<P = Record<string, unknown>>(t: Tool<P>): Tool<P> {
  return t;
}
