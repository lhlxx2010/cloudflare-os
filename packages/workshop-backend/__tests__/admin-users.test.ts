import { describe, expect, it } from "vitest";
import { getAdminUsernames, getSharedModelAdmin } from "../src/admin-users.js";

function env(values: {ADMINS?: string[] | string; SHARED_MODEL_ADMIN?: string}) {
  return values;
}

describe("administrator identity configuration", () => {
  it("accepts both array and local JSON-string ADMINS bindings", () => {
    expect(getAdminUsernames(env({ADMINS: ["admin", "lhlxx2010"]})))
        .toEqual(["admin", "lhlxx2010"]);
    expect(getAdminUsernames(env({ADMINS: '["admin","lhlxx2010"]'})))
        .toEqual(["admin", "lhlxx2010"]);
  });

  it("uses the explicit shared-model administrator instead of administrator ordering", () => {
    expect(getSharedModelAdmin(env({
      ADMINS: ["admin", "lhlxx2010"],
      SHARED_MODEL_ADMIN: "lhlxx2010",
    }))).toBe("lhlxx2010");
  });

  it("preserves the old per-user behavior when sharing is not configured", () => {
    expect(getSharedModelAdmin(env({ADMINS: ["admin"]}))).toBeUndefined();
  });

  it("fails closed when the shared-model source is not an administrator", () => {
    expect(() => getSharedModelAdmin(env({
      ADMINS: ["admin"],
      SHARED_MODEL_ADMIN: "ordinary-user",
    }))).toThrow("SHARED_MODEL_ADMIN must name an account listed in ADMINS");
  });
});
