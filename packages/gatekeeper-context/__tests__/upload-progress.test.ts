import { describe, expect, it } from "vitest";
import {
  createUploadBatch,
  safeUploadPath,
  transitionUploadFile,
  uploadBatchTone,
} from "../app/upload-progress.js";

describe("upload progress", () => {
  it("moves each file from queued to uploading before it can settle", () => {
    let batch = createUploadBatch(["one.md", "two.md"]);
    expect(batch.files.map((file) => file.status)).toEqual(["queued", "queued"]);

    const ignored = transitionUploadFile(batch, 0, "success");
    expect(ignored).toBe(batch);

    batch = transitionUploadFile(batch, 0, "uploading");
    expect(batch.files.map((file) => file.status)).toEqual(["uploading", "queued"]);
    expect(batch).toMatchObject({ completed: 0, succeeded: 0, failed: 0 });

    batch = transitionUploadFile(batch, 0, "success");
    expect(batch.files.map((file) => file.status)).toEqual(["success", "queued"]);
    expect(batch).toMatchObject({ completed: 1, succeeded: 1, failed: 0 });
    expect(uploadBatchTone(batch)).toBe("uploading");
  });

  it("reports success only after every file succeeds", () => {
    let batch = createUploadBatch(["one.md", "two.md"]);
    batch = transitionUploadFile(batch, 0, "uploading");
    batch = transitionUploadFile(batch, 1, "uploading");
    batch = transitionUploadFile(batch, 1, "success");
    batch = transitionUploadFile(batch, 0, "success");

    expect(batch).toMatchObject({ completed: 2, succeeded: 2, failed: 0 });
    expect(batch.files.map((file) => file.status)).toEqual(["success", "success"]);
    expect(uploadBatchTone(batch)).toBe("success");
  });

  it("keeps successful and failed files separate for a partial failure", () => {
    let batch = createUploadBatch(["good.md", "bad.md", "large.png"]);
    for (const file of batch.files) {
      batch = transitionUploadFile(batch, file.id, "uploading");
    }
    batch = transitionUploadFile(batch, 1, "failure");
    batch = transitionUploadFile(batch, 0, "success");
    batch = transitionUploadFile(batch, 2, "failure");

    expect(batch).toMatchObject({ total: 3, completed: 3, succeeded: 1, failed: 2 });
    expect(batch.files.map((file) => file.status)).toEqual([
      "success",
      "failure",
      "failure",
    ]);
    expect(uploadBatchTone(batch)).toBe("error");
  });

  it("reports an all-failed batch as an error", () => {
    let batch = createUploadBatch(["too-large.bin"]);
    batch = transitionUploadFile(batch, 0, "uploading");
    batch = transitionUploadFile(batch, 0, "failure");

    expect(batch).toMatchObject({ completed: 1, succeeded: 0, failed: 1 });
    expect(uploadBatchTone(batch)).toBe("error");
  });

  it("makes control characters in displayed paths harmless", () => {
    expect(safeUploadPath("folder/line\nbreak.md")).toBe("folder/line�break.md");
    expect(safeUploadPath("\u0000")).toBe("�");
    expect(safeUploadPath("")).toBe("未命名文件");
  });
});
