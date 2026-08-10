import { useMemo } from 'react'
import {
  AppWindow,
  ChartLineUp,
  FileText,
  Lightning,
  Presentation,
  type Icon,
} from '@phosphor-icons/react'

// A few example work tasks shown under the Home composer, so a new user immediately sees the kind
// of thing they can ask for. Picking one drops a starter prompt into the composer (it does not
// auto-send) so the user can tweak it before running.
type TaskSuggestion = {
  id: string
  label: string
  description: string
  prompt: string
  icon: Icon
}

// Formats are advertised by example rather than by a row of "Start with Docs" buttons, so the
// first move isn't "pick a file type". The formats themselves are in the composer's `+` menu.
const SUGGESTIONS: TaskSuggestion[] = [
  {
    id: 'one-on-one',
    label: '撰写一对一会谈会前材料',
    description: '包含现状摘要、待检查事项和一个明确诉求的文档',
    icon: FileText,
    prompt:
      '请创建一份文档，帮助我准备下一次与直属下属的一对一会谈：包括当前情况摘要、辅导框架、待检查事项、上次遗留事项，以及一个明确的诉求。',
  },
  {
    id: 'team-meeting',
    label: '制作团队会议演示文稿',
    description: '展示进度、风险和待决事项的幻灯片',
    icon: Presentation,
    prompt:
      '请为我的下一次团队会议制作一份幻灯片：包括当前进展、已交付内容、风险与阻碍，以及需要现场做出的决策。请先询问团队目前在做什么。',
  },
  {
    id: 'insights',
    label: '从数据中发现洞察',
    description: '从电子表格或 CSV 中提炼趋势与建议',
    icon: ChartLineUp,
    prompt:
      '请将我提供的数据集（电子表格、CSV 或粘贴的表格）整理成一份叙述性分析：包括关键趋势、异常情况、这些发现意味着什么，以及具体建议。',
  },
  {
    id: 'workflow',
    label: '自动化工作流程',
    description: '收到新邮件时自动触发智能体',
    icon: Lightning,
    prompt:
      '请创建一个收到新邮件时自动运行的智能体工作流程：读取邮件、判断该如何处理，然后执行操作或起草回复。请询问我要监控哪个收件箱，以及需要处理哪些内容。',
  },
  {
    id: 'app',
    label: '快速构建一个工具',
    description: '小型交互式应用、计算器或仪表盘',
    icon: AppWindow,
    prompt:
      '请构建一个我可以在这里直接使用的小型交互式工具，例如计算器、仪表盘或数据浏览器。先询问我希望它实现什么功能，然后开始创建。',
  },
]

// One row, shared by every suggestion so the list reads as one kind of offer.
function SuggestionRow({
  icon,
  label,
  description,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  description: string
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="press group flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-kumo-tint"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle transition-colors group-hover:text-kumo-default">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
            {label}
          </span>
          <span className="block truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
            {description}
          </span>
        </span>
      </button>
    </li>
  )
}

// How many of the suggestions above to show at once. The list is longer than the page should be:
// four rows is inspiration, seven is a menu to read. Which three appear is chosen per visit, so the
// ones below the fold still get seen -- and so Home doesn't look like it only does one thing.
const VISIBLE_SUGGESTIONS = 3

function pickSuggestions(): TaskSuggestion[] {
  let shuffled = [...SUGGESTIONS]
  for (let i = shuffled.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, VISIBLE_SUGGESTIONS)
}

export default function HomeTaskSuggestions({
  onPick,
}: {
  onPick: (prompt: string) => void
}) {
  // Chosen once per mount: re-rolling on every render would shuffle the list under the pointer.
  const visible = useMemo(pickSuggestions, [])

  return (
    <section aria-label="示例任务" className="flex flex-col gap-1">
      <h3 className="px-1 pb-1 text-[12px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        开始使用
      </h3>
      <ul className="flex flex-col gap-0.5">
        {visible.map((suggestion) => (
          <SuggestionRow
            key={suggestion.id}
            icon={<suggestion.icon size={16} />}
            label={suggestion.label}
            description={suggestion.description}
            onClick={() => onPick(suggestion.prompt)}
          />
        ))}
      </ul>
    </section>
  )
}
