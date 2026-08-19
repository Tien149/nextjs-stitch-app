import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function resolve(specifier, context, next) {
  if (!specifier.startsWith("@/")) return next(specifier, context);
  const target = new URL("../" + specifier.slice(2), import.meta.url);
  const path = fileURLToPath(target);
  for (const ext of ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
    if (fs.existsSync(path + ext)) return next(target.href + ext, context);
  }
  return next(target.href, context);
}
