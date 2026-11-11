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
  // Must come last: in flat config the final matching entry wins.
  {
    // CLI scripts write to the terminal by design; the browser-app rule does not
    // apply to them.
    files: ["scripts/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
];

export default config;
