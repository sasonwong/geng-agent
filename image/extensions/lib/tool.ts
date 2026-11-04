/**
 * A tool definition is a plain object: `registerTool` takes whatever it is handed, and the
 * schema is ordinary JSON Schema. Writing it literally instead of through a builder keeps
 * the extensions free of run-time imports, which is what lets them load under a pi binary
 * that has no `node_modules` next to it.
 *
 * The type is here so a typo in the shape is a compile error in the editor, not a waking
 * that exits before it can speak.
 */
export interface Tool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    id: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any,
  ) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
}

export function tool(t: Tool): Tool {
  return t;
}
