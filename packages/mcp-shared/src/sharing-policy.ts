// An MCP binding is owner-only: `addObserver` refuses unconditionally. MCP has no per-record
// authorization to consult, and holding a connection to the same origin proves only that a person
// can authenticate to the service, not that they may read what this Gadget read on its owner's
// credentials. Writes are still allowed, since writing back to the server the data came from
// discloses it to nobody new. See the README for the alternatives that were rejected.

/**
 * Explains, to whoever tried to open a Gadget they do not own, why they cannot.
 *
 * @param source How to name the thing that was read from: a hostname for a bare endpoint, a gateway
 * name for a portal. Interpolated into a sentence, so it should read as a noun phrase.
 */
export function observerRefusalMessage(source: string): string {
  return `从 ${source} 读取数据的工作区只能由其所有者打开，因为无法检查其他人是否有权查看其读取的内容。` +
    `请改为将其发布为蓝图，让每个人连接自己的账户。`;
}
