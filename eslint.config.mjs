import tseslint from "@electron-toolkit/eslint-config-ts";
import eslintPluginSvelte from "eslint-plugin-svelte";
import { defineConfig } from "eslint/config";

export default defineConfig(
  // `nicegal-server` is the Rust search core's own tree, with its own tooling — not this frontend's
  // code, and not part of the electron-vite build either.
  { ignores: ["**/node_modules", "**/dist", "**/out", "**/.venv/**", "nicegal-server"] },
  tseslint.configs.recommended,
  eslintPluginSvelte.configs["flat/recommended"],
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    files: ["**/*.{tsx,svelte}"],
    rules: {
      "svelte/no-unused-svelte-ignore": "off",
    },
  },
);
