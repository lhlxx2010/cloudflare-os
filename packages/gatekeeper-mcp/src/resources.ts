import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

const DESCRIPTION =
  "你提供的 MCP 端点。系统会自动发现工具，写入操作需要批准。";

const HTTPS_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "任意 MCP 服务器",
  description: DESCRIPTION,
};

const HTTP_RESOURCE: SupportedResource = { ...HTTPS_RESOURCE, urlPattern: "http://*" };

export function mcpResources(allowInsecure: boolean): SupportedResource[] {
  return allowInsecure ? [HTTPS_RESOURCE, HTTP_RESOURCE] : [HTTPS_RESOURCE];
}

export function mcpResourceFor(endpoint: string): SupportedResource {
  return new URL(endpoint).protocol === "http:" ? HTTP_RESOURCE : HTTPS_RESOURCE;
}
