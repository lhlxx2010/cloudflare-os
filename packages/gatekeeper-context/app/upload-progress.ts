export type UploadFileStatus = "queued" | "uploading" | "success" | "failure";

export type UploadFileProgress = {
  id: number;
  path: string;
  status: UploadFileStatus;
};

export type UploadBatch = {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  files: UploadFileProgress[];
};

export type UploadBatchTone = "uploading" | "success" | "error";

export function createUploadBatch(paths: string[]): UploadBatch {
  return {
    total: paths.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    files: paths.map((path, id) => ({ id, path, status: "queued" })),
  };
}

export function transitionUploadFile(
  batch: UploadBatch,
  id: number,
  status: Exclude<UploadFileStatus, "queued">,
): UploadBatch {
  const current = batch.files[id];
  if (!current) return batch;

  const valid = status === "uploading"
    ? current.status === "queued"
    : current.status === "uploading";
  if (!valid) return batch;

  const files = [...batch.files];
  files[id] = { ...current, status };
  const settled = status === "success" || status === "failure";
  return {
    ...batch,
    files,
    completed: batch.completed + (settled ? 1 : 0),
    succeeded: batch.succeeded + (status === "success" ? 1 : 0),
    failed: batch.failed + (status === "failure" ? 1 : 0),
  };
}

export function uploadBatchTone(batch: UploadBatch): UploadBatchTone {
  if (batch.completed < batch.total) return "uploading";
  return batch.failed === 0 ? "success" : "error";
}

// File paths are rendered as plain React text, but control characters are replaced so a local file
// name cannot distort the status list or its accessible text.
export function safeUploadPath(path: string): string {
  const safe = Array.from(path, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f ? "�" : character;
  }).join("");
  return safe || "未命名文件";
}
