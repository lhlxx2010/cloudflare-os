import { describe, expect, it } from "vitest";
import {
  createOpenGadgetError,
  getOpenGadgetErrorCode,
  OPEN_GADGET_ERROR_CODES,
} from "@gadgets/workshop-shared/api";

describe("open gadget errors", () => {
  it.each([
    [OPEN_GADGET_ERROR_CODES.workspaceNotFound, "未找到工作区。"],
    [OPEN_GADGET_ERROR_CODES.workspaceAccessDenied, "你无权访问此工作区。"],
  ] as const)(
    "creates an enumerable %s code with a readable message",
    (code, message) => {
      let error = createOpenGadgetError(code);

      expect(error.message).toBe(message);
      expect(error.code).toBe(code);
      expect(Object.keys(error)).toContain("code");
      expect(getOpenGadgetErrorCode(error)).toBe(code);
    },
  );

  it.each(Object.values(OPEN_GADGET_ERROR_CODES))(
    "does not infer %s from an error message",
    (code) => {
      expect(getOpenGadgetErrorCode(new Error(code))).toBeUndefined();
    },
  );

  it("does not classify unexpected errors", () => {
    expect(getOpenGadgetErrorCode(new Error("storage unavailable"))).toBeUndefined();
    expect(getOpenGadgetErrorCode({ code: "UNKNOWN" })).toBeUndefined();
  });
});
