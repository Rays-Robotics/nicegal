import { readFileSync, existsSync } from "node:fs";
// Run the real controller effects in Node using Svelte's client runtime, without a DOM shim.
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      for (const suffix of [".ts", ".js"]) {
        const candidate = new URL(specifier + suffix, context.parentURL);
        if (existsSync(candidate)) return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts") && !url.includes("node_modules")) {
      const filename = fileURLToPath(url);
      let source = ts.transpileModule(readFileSync(filename, "utf8"), {
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          verbatimModuleSyntax: true,
        },
      }).outputText;
      if (url.endsWith(".svelte.ts"))
        source = compileModule(source, { filename, generate: "client" }).js.code;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
