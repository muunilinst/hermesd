/**
 * The upstream tool schemas as a module, for code that runs on an actor platform.
 * `loadSurface` reads the file at run time, which workerd and Rivet cannot do; a
 * static JSON import is bundled with the code instead. Same file, same bytes.
 */
import data from "../../../contracts/upstream/tool-schemas.json" with { type: "json" };
import type { ToolSchemasSurface } from "./index.ts";

export const TOOL_SCHEMAS = data as unknown as ToolSchemasSurface;
