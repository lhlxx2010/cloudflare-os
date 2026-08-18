/** A specific resource within a connection (channel, doc URL, repo, etc.) */
export interface ConnectionResource {
  id: string
  label: string
  /** e.g. "#general", "https://docs.google.com/...", "org/repo" */
  value: string
  /** Resource type hint */
  type: 'channel' | 'url' | 'repo' | 'project' | 'board' | 'page' | 'file' | 'server' | 'database'
  active: boolean
}

/** Describes what kind of resource input a connection accepts */
export interface ResourceConfig {
  /** What the user adds: channels, URLs, repos, etc. */
  resourceType: 'channel' | 'url' | 'repo' | 'project' | 'board' | 'page' | 'file' | 'server' | 'database'
  /** Placeholder text for the input */
  placeholder: string
  /** Label shown above the input */
  inputLabel: string
  /** Whether the connection offers a browse/search picker (vs. paste-only) */
  browsable: boolean
}

export interface Connection {
  id: string
  name: string
  description: string
  /** SVG path or icon identifier */
  logo: string
  /** Brand color for the logo background */
  color: string
  /** Light tint for background */
  bgColor: string
  connected: boolean
  lastUsed?: string
  /** Configured resources for this connection */
  resources?: ConnectionResource[]
  /** Describes what resources can be added */
  resourceConfig?: ResourceConfig
}

export interface InlineDemo {
  id: string
  label: string
  prompt: string
}

export interface App {
  id: string
  title: string
  description: string
  gradient: string
  updatedAt: string
  status: 'live' | 'draft' | 'building'
  /** Which connections this app uses */
  connectionIds: string[]
}

export interface Template {
  id: string
  title: string
  description: string
  category: 'apps' | 'landing-pages' | 'components' | 'dashboards'
  gradient: string
  author: {
    name: string
    avatar: string
  }
  uses: number
  likes: number
  price: 'Free' | string
}

/**
 * ---------------------
 * Inline demo prompts shown under the chat input
 * ---------------------
 */
export const inlineDemos: InlineDemo[] = [
  {
    id: 'd1',
    label: '汇总频道内容的 Slack 机器人',
    prompt: '构建一个 Slack 机器人，每天汇总未读频道内容',
  },
  {
    id: 'd2',
    label: 'Jira 冲刺仪表板',
    prompt: '创建一个从 Jira 获取数据并展示燃尽图的冲刺仪表板',
  },
  {
    id: 'd3',
    label: 'Discord 内容管理工具',
    prompt: '构建一个支持自动标记和审计日志的 Discord 内容管理工具',
  },
  {
    id: 'd4',
    label: 'Google Sheets 支出追踪器',
    prompt: '创建一个可同步到 Google Sheets 的支出追踪器',
  },
  {
    id: 'd5',
    label: 'GitHub PR 审查仪表板',
    prompt: '构建一个展示多个仓库中待处理审查的 PR 审查仪表板',
  },
]

/**
 * ---------------------
 * Connections (external data sources)
 * ---------------------
 */
export const connections: Connection[] = [
  {
    id: 'slack',
    name: 'Slack',
    description: '频道、消息和话题串',
    logo: 'slack',
    color: '#4A154B',
    bgColor: '#f4ecf5',
    connected: true,
    lastUsed: '2 小时前',
    resourceConfig: {
      resourceType: 'channel',
      placeholder: '#频道名称',
      inputLabel: '添加频道',
      browsable: true,
    },
    resources: [
      { id: 'r-s1', label: '#general', value: '#general', type: 'channel', active: true },
      { id: 'r-s2', label: '#engineering', value: '#engineering', type: 'channel', active: true },
      { id: 'r-s3', label: '#product', value: '#product', type: 'channel', active: false },
    ],
  },
  {
    id: 'discord',
    name: 'Discord',
    description: '服务器、频道和消息',
    logo: 'discord',
    color: '#5865F2',
    bgColor: '#eef0ff',
    connected: true,
    lastUsed: '5 小时前',
    resourceConfig: {
      resourceType: 'server',
      placeholder: '服务器名称或邀请链接',
      inputLabel: '添加服务器',
      browsable: true,
    },
    resources: [
      { id: 'r-d1', label: 'Acme 开发服务器', value: 'acme-dev', type: 'server', active: true },
    ],
  },
  {
    id: 'jira',
    name: 'Jira',
    description: '事务、冲刺和看板',
    logo: 'jira',
    color: '#0052CC',
    bgColor: '#e6efff',
    connected: true,
    lastUsed: '1 天前',
    resourceConfig: {
      resourceType: 'board',
      placeholder: '看板名称或项目键（例如 ENG）',
      inputLabel: '添加看板或项目',
      browsable: true,
    },
    resources: [
      { id: 'r-j1', label: 'ENG 看板', value: 'ENG', type: 'board', active: true },
      { id: 'r-j2', label: 'DESIGN 看板', value: 'DESIGN', type: 'board', active: true },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    description: '云端硬盘、表格、文档和日历',
    logo: 'google',
    color: '#4285F4',
    bgColor: '#e8f0fe',
    connected: true,
    lastUsed: '3 小时前',
    resourceConfig: {
      resourceType: 'url',
      placeholder: '粘贴 Google Docs、Sheets 或 Drive 网址',
      inputLabel: '添加文档',
      browsable: false,
    },
    resources: [
      { id: 'r-g1', label: '第一季度规划文档', value: 'https://docs.google.com/document/d/1a2b3c', type: 'url', active: true },
      { id: 'r-g2', label: '支出追踪器', value: 'https://docs.google.com/spreadsheets/d/4d5e6f', type: 'url', active: true },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: '仓库、议题和拉取请求',
    logo: 'github',
    color: '#24292e',
    bgColor: '#f0f0f0',
    connected: false,
    resourceConfig: {
      resourceType: 'repo',
      placeholder: 'org/repo-name',
      inputLabel: '添加仓库',
      browsable: true,
    },
  },
  {
    id: 'notion',
    name: 'Notion',
    description: '页面、数据库和 Wiki',
    logo: 'notion',
    color: '#000000',
    bgColor: '#f5f5f5',
    connected: false,
    resourceConfig: {
      resourceType: 'page',
      placeholder: '粘贴 Notion 页面网址',
      inputLabel: '添加页面或数据库',
      browsable: false,
    },
  },
  {
    id: 'linear',
    name: 'Linear',
    description: '事务、项目和周期',
    logo: 'linear',
    color: '#5E6AD2',
    bgColor: '#eeeffa',
    connected: false,
    resourceConfig: {
      resourceType: 'project',
      placeholder: '项目名称或标识符',
      inputLabel: '添加项目',
      browsable: true,
    },
  },
  {
    id: 'figma',
    name: 'Figma',
    description: '设计文件和组件',
    logo: 'figma',
    color: '#1d4ed8',
    bgColor: '#eff6ff',
    connected: false,
    resourceConfig: {
      resourceType: 'file',
      placeholder: '粘贴 Figma 文件网址',
      inputLabel: '添加设计文件',
      browsable: false,
    },
  },
]

export const recentConnections = connections.filter((c) => c.connected)

/**
 * ---------------------
 * Recent apps
 * ---------------------
 */
export const recentApps: App[] = [
  {
    id: 'app-1',
    title: 'Slack 频道摘要器',
    description: '使用 Workers AI 将未读 Slack 频道汇总为每日摘要',
    gradient: 'from-[#4A154B] to-[#7C3085]',
    updatedAt: '2 小时前',
    status: 'live',
    connectionIds: ['slack'],
  },
  {
    id: 'app-2',
    title: '冲刺燃尽追踪器',
    description: '获取 Jira 冲刺数据并实时呈现燃尽图',
    gradient: 'from-[#0052CC] to-[#2684FF]',
    updatedAt: '5 小时前',
    status: 'live',
    connectionIds: ['jira'],
  },
  {
    id: 'app-3',
    title: 'Discord 内容管理仪表板',
    description: '自动标记消息并展示 Discord 服务器的审计日志',
    gradient: 'from-[#5865F2] to-[#7983F5]',
    updatedAt: '1 天前',
    status: 'draft',
    connectionIds: ['discord'],
  },
  {
    id: 'app-4',
    title: '支出追踪器',
    description: '追踪支出并自动将总额同步到 Google Sheets',
    gradient: 'from-[#34A853] to-[#4285F4]',
    updatedAt: '2 天前',
    status: 'live',
    connectionIds: ['google'],
  },
  {
    id: 'app-5',
    title: 'PR 审查队列',
    description: '展示所有仓库中的开放拉取请求及其审查状态',
    gradient: 'from-[#24292e] to-[#555]',
    updatedAt: '3 天前',
    status: 'building',
    connectionIds: ['github'],
  },
  {
    id: 'app-6',
    title: '团队站会机器人',
    description: '从 Slack 收集异步站会内容并将摘要发布到 Notion',
    gradient: 'from-blue-700 to-indigo-700',
    updatedAt: '4 天前',
    status: 'live',
    connectionIds: ['slack', 'notion'],
  },
]

/**
 * ---------------------
 * Templates
 * ---------------------
 */
export const templates: Template[] = [
  {
    id: '1',
    title: 'Workers AI 体验场',
    description: '支持流式响应的交互式 AI 模型体验场',
    category: 'apps',
    gradient: 'from-blue-700 via-indigo-700 to-violet-700',
    author: { name: 'cloudflare', avatar: 'CF' },
    uses: 4900,
    likes: 591,
    price: '免费',
  },
  {
    id: '2',
    title: 'SaaS 落地页',
    description: '包含定价和功能展示的现代 SaaS 落地页',
    category: 'landing-pages',
    gradient: 'from-blue-600 via-indigo-600 to-violet-600',
    author: { name: 'designco', avatar: 'DC' },
    uses: 11400,
    likes: 1700,
    price: '免费',
  },
  {
    id: '3',
    title: 'D1 数据库浏览器',
    description: '适用于 Cloudflare D1 的可视化数据库浏览器',
    category: 'apps',
    gradient: 'from-emerald-600 via-teal-600 to-cyan-600',
    author: { name: 'devtools', avatar: 'DT' },
    uses: 2900,
    likes: 737,
    price: '免费',
  },
  {
    id: '4',
    title: 'KV 存储管理器',
    description: '通过简洁界面管理 Workers KV 命名空间',
    category: 'dashboards',
    gradient: 'from-violet-600 via-purple-600 to-fuchsia-600',
    author: { name: 'cloudflare', avatar: 'CF' },
    uses: 919,
    likes: 235,
    price: '免费',
  },
  {
    id: '5',
    title: 'AI Gateway 入门套件',
    description: '通过 Cloudflare 路由和管理 AI API 调用',
    category: 'apps',
    gradient: 'from-gray-800 via-gray-700 to-gray-600',
    author: { name: 'aitools', avatar: 'AI' },
    uses: 1200,
    likes: 235,
    price: '免费',
  },
  {
    id: '6',
    title: 'R2 文件浏览器',
    description: '上传并浏览存储在 Cloudflare R2 中的文件',
    category: 'components',
    gradient: 'from-sky-700 via-blue-700 to-indigo-700',
    author: { name: 'storage', avatar: 'ST' },
    uses: 1600,
    likes: 502,
    price: '免费',
  },
]

export const templateCategories = [
  { id: 'apps', label: '应用和游戏', icon: 'blocks' },
  { id: 'landing-pages', label: '落地页', icon: 'layout' },
  { id: 'components', label: '组件', icon: 'grid' },
  { id: 'dashboards', label: '仪表板', icon: 'bar-chart' },
] as const

export function formatNumber(num: number): string {
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  }
  return num.toString()
}
