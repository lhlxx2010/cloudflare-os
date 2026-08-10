// Deployment administrator identity helpers. Authentication remains environment-driven: these
// values are not part of AdminConfig, so a compromised admin session cannot change who is an
// administrator or whose model credentials are shared deployment-wide.

type AdminIdentityEnv = {
  ADMINS?: string[] | string;
  SHARED_MODEL_ADMIN?: string;
};

/** Parse the deployment's administrator usernames from its Workers binding. */
export function getAdminUsernames(env: AdminIdentityEnv): string[] {
  let admins: unknown = env.ADMINS;
  if (typeof admins === "string") {
    try {
      admins = JSON.parse(admins);
    } catch {
      throw new TypeError("ADMINS must be configured as a JSON array of usernames.");
    }
  }
  if (admins === undefined) return [];
  if (!Array.isArray(admins) || admins.some(name => typeof name !== "string")) {
    throw new TypeError("ADMINS must be configured as an array of usernames.");
  }
  return admins;
}

/**
 * Resolve the administrator whose own model records are shared with every user.
 *
 * The setting is deliberately explicit instead of depending on administrator ordering. A model
 * source must itself be an administrator; otherwise the deployment is misconfigured and sharing
 * fails closed.
 */
export function getSharedModelAdmin(
    env: AdminIdentityEnv): string | undefined {
  let username = env.SHARED_MODEL_ADMIN?.trim();
  if (!username) return undefined;
  if (!getAdminUsernames(env).includes(username)) {
    throw new TypeError("SHARED_MODEL_ADMIN must name an account listed in ADMINS.");
  }
  return username;
}
