/**
 * Environment variables that must never be forwarded into a spawned child
 * process, even though this orchestrator process itself needs them. This is
 * a defense-in-depth measure: without it, an approved shell command (or a
 * provider CLI invoked via cli-exec) could run `env`/`printenv` and echo
 * provider credentials back into its own (approved, logged) output.
 */
const SECRET_ENV_KEY_PATTERN = /(API_KEY|SECRET|TOKEN|PASSWORD|AUTHORIZATION)/i;

/** Returns a copy of process.env with secret-shaped variables stripped. */
export function sanitizedChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_ENV_KEY_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return env;
}
