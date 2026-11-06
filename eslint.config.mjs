import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * Flat ESLint config.
 *
 * eslint-config-next v16 exports native flat configs, so no compatibility
 * layer is needed. `next/core-web-vitals` already includes the base rules.
 */
const config = [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "coverage/**", "supabase/**"],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "no-console": ["warn", { allow: ["error", "warn"] }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];

export default config;
