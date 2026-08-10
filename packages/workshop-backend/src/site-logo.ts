import type { AvatarImage } from "@gadgets/workshop-shared/gatekeeper";
import { MAX_SITE_LOGO_BYTES, MAX_SITE_LOGO_DIMENSION } from "@gadgets/workshop-shared/api";

// Under `/api` so the deployment's existing `run_worker_first: ["/api/*"]` already routes it to the
// Worker: a top-level path would have to be added to every asset-serving config by hand.
/** Public path serving the configured deployment logo. */
export const SITE_LOGO_PATH = "/api/site-logo";

/** Fixed R2 key holding the deployment logo. */
export const SITE_LOGO_R2_KEY = ".site-logo";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Validates the bounded PNG header accepted for deployment logos. */
export function validateSiteLogo(data: Uint8Array): void {
  if (data.byteLength > MAX_SITE_LOGO_BYTES) {
    throw new Error(`站点徽标过大（最大 ${MAX_SITE_LOGO_BYTES} 字节）。`);
  }
  if (data.byteLength < 33 || !PNG_SIGNATURE.every((byte, index) => data[index] === byte) ||
      data[8] !== 0 || data[9] !== 0 || data[10] !== 0 || data[11] !== 13 ||
      String.fromCharCode(...data.subarray(12, 16)) !== "IHDR") {
    throw new Error("站点徽标必须是 PNG 图片。");
  }
  let view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let width = view.getUint32(16);
  let height = view.getUint32(20);
  if (width === 0 || height === 0 ||
      width > MAX_SITE_LOGO_DIMENSION || height > MAX_SITE_LOGO_DIMENSION) {
    throw new Error(`站点徽标的尺寸必须在 1 到 ${MAX_SITE_LOGO_DIMENSION} 像素之间。`);
  }
}

/** Projects configured logo state into its canonical public image URL. */
export function siteLogoImage(configured: boolean): AvatarImage | undefined {
  if (!configured) return undefined;
  return { url: SITE_LOGO_PATH };
}

/** Serves the current logo bytes from R2 as a safely typed public image. */
export async function serveSiteLogo(
    request: Request, bucket: Pick<R2Bucket, "get">): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("不允许使用此请求方法", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  let object = await bucket.get(SITE_LOGO_R2_KEY);
  if (!object) {
    return new Response("未找到", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
