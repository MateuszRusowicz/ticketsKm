import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // A leading underscore marks something deliberately unused: the
    // `_prev` state argument every server action must accept, and the
    // destructure-to-omit pattern in tests. Without this the codebase
    // accumulates warnings for values that are unused on purpose.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Scoped to shared components rather than to app/ pages: Server
    // Components legitimately import server modules, and flagging them
    // would train everyone to disable the rule. `import 'server-only'` is
    // the real enforcement — this rule just shortens the feedback loop for
    // the case that actually goes wrong, a client component reaching into
    // lib/server.
    files: ["src/components/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/server/*", "**/lib/server/*"],
              message:
                "Server-only modules must not be imported from components. " +
                "Move shared types to src/lib/shared/, or import this in a Server Component only.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
