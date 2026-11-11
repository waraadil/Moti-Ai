/**
 * Environment barrel.
 *
 * Only public accessors are re-exported here, so importing `@/lib/env` from a
 * Client Component can never pull in server-only configuration. Server code that
 * needs secrets imports `@/lib/env/server` explicitly.
 */

export {
  getPublicEnv,
  isPublicEnvConfigured,
  EnvValidationError,
  type PublicEnv,
  __resetPublicEnvCacheForTests,
} from "./public";
