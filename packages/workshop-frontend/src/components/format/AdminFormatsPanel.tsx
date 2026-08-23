// Admin panel for the deployment's standard output formats.
//
// A format is an ordinary blueprint the deployment has *promoted*: offered as "New Slides" and
// listed first for the agent. Promoting changes four surfaces the admin can't see from here, so
// the panel previews the buttons users will get and the literal line the model will read.
//
// Presentation is never authored from scratch: a promoted blueprint arrives with its own noun,
// plural and icon, and clearing an override falls back to it.

import { useEffect, useMemo, useState } from 'react'
import { Button, DropdownMenu, Input, Switch, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowDown, ArrowUp, CaretDown, CaretRight, Plus, Sparkle, Trash, Warning } from '@phosphor-icons/react'
import type {
  AdminApi,
  AdminFormat,
  BlueprintOutput,
  OutputIcon,
} from '@gadgets/workshop-shared/api'
import { OUTPUT_ICONS } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import { useAuthenticatedApi } from '../../AuthContext'
import { MENU_CONTENT } from '../menuStyles'
import { FORMAT_ICONS, GENERIC_OUTPUT } from './formats'
import { FormatGlyph, FormatPreview } from './FormatVisuals'
import { isImeComposing } from '../../keyboardEvent'

// A blueprint the admin could promote. `declared` is what it says it produces, when we know --
// known for the deployment's featured blueprints, unknown for the admin's own published ones.
type Promotable = { id: string; title: string; declared?: BlueprintOutput }

const ICON_LABELS: Record<OutputIcon, string> = {
  fileText: '文档',
  gridNine: '网格',
  presentation: '演示文稿',
  appWindow: '应用窗口',
  flowArrow: '流程',
  kanban: '看板',
  chartBar: '图表',
  table: '表格',
  notebook: '笔记本',
  listChecks: '任务清单',
}

export default function AdminFormatsPanel({
  admin,
  formats,
  onChanged,
}: {
  admin: RpcStub<AdminApi>
  formats: AdminFormat[]
  /**
   * Re-fetch after a mutation. Formats are edited rarely, so re-reading beats an optimistic local
   * copy that could disagree about order.
   */
  onChanged: () => Promise<void>
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<Promotable[]>([])

  useEffect(() => {
    let cancelled = false
    Promise.all([authenticatedApi.listFeaturedBlueprints(), authenticatedApi.listOwnBlueprints()])
      .then(([featured, own]) => {
        if (cancelled) return
        const byId = new Map<string, Promotable>()
        for (const b of featured) {
          byId.set(b.id, { id: b.id, title: b.metadata.title, declared: b.metadata.output })
        }
        for (const b of own) {
          if (!byId.has(b.id)) byId.set(b.id, { id: b.id, title: b.title })
        }
        setCandidates([...byId.values()])
      })
      .catch((err) => console.error('Failed to list promotable blueprints:', err))
    return () => {
      cancelled = true
    }
  }, [authenticatedApi])

  const promoted = useMemo(() => new Set(formats.map((f) => f.blueprintId)), [formats])
  const available = candidates.filter((c) => !promoted.has(c.id))
  const offered = formats.filter((f) => f.enabled && f.output && !f.missing)

  // Every mutation funnels through here, so the panel can't issue overlapping writes and always
  // re-reads the authoritative order afterwards.
  const mutate = async (op: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await op()
      await onChanged()
    } catch (err) {
      console.error('Format update failed:', err)
      toasts.add({ title: '无法更新标准格式', variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const move = (index: number, delta: number) => {
    const order = formats.map((f) => f.blueprintId)
    const target = index + delta
    if (target < 0 || target >= order.length) return
    ;[order[index], order[target]] = [order[target], order[index]]
    return mutate(() => admin.setFormatOrder(order))
  }

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
      <h2 className="mb-1 text-lg font-semibold text-kumo-strong">标准格式</h2>
      <p className="mb-5 text-sm text-kumo-subtle">
        提升后的蓝图会在用户开始创作时以名称显示（如“新建文档”“新建幻灯片”），
        同时会提示智能体优先使用该蓝图，而不是从头构建同类内容。
      </p>

      <PreviewStrip formats={offered} />

      {formats.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="mb-5 flex flex-col gap-2">
          {formats.map((format, i) => (
            <FormatRow
              key={format.blueprintId}
              format={format}
              busy={busy}
              open={expanded === format.blueprintId}
              onToggle={() =>
                setExpanded((id) => (id === format.blueprintId ? null : format.blueprintId))
              }
              isFirst={i === 0}
              isLast={i === formats.length - 1}
              onMove={(delta) => move(i, delta)}
              onPatch={(patch) => mutate(() => admin.updateFormat(format.blueprintId, patch))}
              onRemove={() => mutate(() => admin.removeFormat(format.blueprintId))}
            />
          ))}
        </div>
      )}

      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Button variant="secondary" disabled={busy || available.length === 0}>
              <Plus size={14} className="mr-1.5" />
              提升蓝图
            </Button>
          }
        />
        <DropdownMenu.Content className={MENU_CONTENT}>
          <p className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
            设为标准格式
          </p>
          {available.map((candidate) => (
            <DropdownMenu.Item
              key={candidate.id}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-kumo-tint"
              onClick={() => mutate(() => admin.promoteFormat(candidate.id))}
            >
              <FormatGlyph output={candidate.declared} size="lg" className="shrink-0 text-kumo-subtle" />
              <span className="min-w-0">
                <span className="block truncate text-[13px] text-kumo-default">
                  {candidate.title || '未命名蓝图'}
                </span>
                <span className="block truncate text-[11px] text-kumo-inactive">
                  {candidate.declared
                    ? `生成${candidate.declared.plural}`
                    : '未声明格式，需要由你命名。'}
                </span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  )
}

// What users will actually get, drawn with the same components the real surfaces use.
function PreviewStrip({ formats }: { formats: AdminFormat[] }) {
  return (
    <div className="mb-5 rounded-lg border border-dashed border-kumo-line bg-kumo-tint/40 p-4">
      <p className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        用户将看到
      </p>
      {formats.length === 0 ? (
        <p className="text-[13px] italic text-kumo-inactive">
          暂无内容。用户只会看到“新建工作区”。
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {formats.map((format) => (
            <span
              key={format.blueprintId}
              className="flex items-center gap-2 rounded-full border border-kumo-line bg-kumo-base px-3.5 py-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default"
            >
              <FormatGlyph output={format.output} size="md" className="text-kumo-subtle" />
              新建{format.output!.noun}
            </span>
          ))}
        </div>
      )}
      <p className="mt-2.5 text-[12px] leading-4 text-kumo-subtle">
        将按此顺序显示在编辑器的“+”菜单、命令面板和空白的“输出”页面中。
      </p>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="mb-5 rounded-lg border border-kumo-line bg-kumo-base px-4 py-5 text-center">
      <p className="text-sm font-medium text-kumo-default">还没有标准格式</p>
      <p className="mx-auto mt-1 max-w-md text-[13px] leading-[18px] text-kumo-subtle">
        提升一个蓝图，使其在用户开始创作时按名称显示，并让智能体优先使用该蓝图，
        而不是从头构建同类内容。
      </p>
    </div>
  )
}

function FormatRow({
  format,
  busy,
  open,
  onToggle,
  isFirst,
  isLast,
  onMove,
  onPatch,
  onRemove,
}: {
  format: AdminFormat
  busy: boolean
  open: boolean
  onToggle: () => void
  isFirst: boolean
  isLast: boolean
  onMove: (delta: number) => void
  onPatch: (patch: Parameters<AdminApi['updateFormat']>[1]) => void
  onRemove: () => void
}) {
  const needsNaming = !format.missing && !format.output

  return (
    <div className="group rounded-lg border border-kumo-line bg-kumo-base">
      <div className="flex items-center gap-3 p-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
        >
          {format.missing ? (
            <span
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-tint text-kumo-danger"
              title="此蓝图已不存在"
            >
              <Warning size={16} />
            </span>
          ) : (
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-fill text-kumo-subtle">
              <FormatGlyph output={format.output} size="lg" />
            </span>
          )}

          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-kumo-default">
                {format.output ? `新建${format.output.noun}` : format.blueprintTitle || format.blueprintId}
              </span>
              {format.bundled && <Badge>内置</Badge>}
              {!format.enabled && !format.missing && <Badge>已关闭</Badge>}
              {needsNaming && <Badge tone="warn">需要命名</Badge>}
            </span>
            <span className="mt-0.5 block truncate text-xs text-kumo-subtle">
              {format.missing
                ? '蓝图已删除，请移除此条目。'
                : needsNaming
                ? '此蓝图未声明生成内容，请先命名再提供给用户。'
                : `${format.blueprintTitle} · 在“输出”页面的${format.output!.plural}分类下显示`}
            </span>
          </span>

          <span className="shrink-0 text-kumo-inactive">
            {open ? <CaretDown size={13} /> : <CaretRight size={13} />}
          </span>
        </button>

        {/* Reorder stays out of the way until the row is hovered or opened: order matters, but not
            on every glance. */}
        <div
          className={`flex shrink-0 items-center gap-1 transition-opacity ${
            open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
          }`}
        >
          <IconButton label="上移" disabled={busy || isFirst} onClick={() => onMove(-1)}>
            <ArrowUp size={13} />
          </IconButton>
          <IconButton label="下移" disabled={busy || isLast} onClick={() => onMove(1)}>
            <ArrowDown size={13} />
          </IconButton>
        </div>

        <Switch
          checked={format.enabled}
          disabled={busy || format.missing}
          onCheckedChange={(enabled) => onPatch({ enabled })}
        />
      </div>

      {open && (
        <div className="flex flex-col gap-4 border-t border-kumo-line px-3 py-4">
          {format.missing ? (
            <p className="text-[13px] text-kumo-subtle">
              此格式对应的蓝图已被删除，因此不会再向任何人提供。请移除此条目。
            </p>
          ) : (
            <>
              <Fieldset
                title="展示方式"
                detail={
                  '字段留空时将使用蓝图声明的名称。' +
                  (format.bundled
                    ? '内置蓝图的声明名称可能随部署更新而变化；你在此输入的值会保持不变。'
                    : '') +
                  '此设置仅适用于之后生成的输出；现有输出仍保留创建时的名称。'
                }
              >
                <div className="flex items-center gap-4">
                  <div className="grid flex-1 gap-2 sm:grid-cols-[auto_1fr_1fr]">
                    {/* Fields read from `output` when the presentation resolves, and otherwise
                        from whatever has been filled in so far. `output` is all-or-nothing -- it
                        is undefined until noun, plural and icon are all present -- so reading only
                        from it made an admin naming an undeclared blueprint watch each value they
                        saved vanish from the form. */}
                    <IconPicker
                      icon={format.output?.icon ?? format.overrides?.icon}
                      declaredIcon={format.declared?.icon}
                      disabled={busy}
                      onPick={(icon) => onPatch({ overrides: { icon } })}
                    />
                    <OverrideField
                      label="名称"
                      value={format.output?.noun ?? format.overrides?.noun ?? ''}
                      declared={format.declared?.noun}
                      disabled={busy}
                      onCommit={(noun) => onPatch({ overrides: { noun } })}
                    />
                    <OverrideField
                      label="复数名称"
                      value={format.output?.plural ?? format.overrides?.plural ?? ''}
                      declared={format.declared?.plural}
                      disabled={busy}
                      onCommit={(plural) => onPatch({ overrides: { plural } })}
                    />
                  </div>

                  {/* The icon also decides the thumbnail drawing, so show the drawing next to the
                      picker: choosing "table" over "presentation" changes what these look like on
                      the Outputs page, and that shouldn't be discovered there. */}
                  <figure className="hidden shrink-0 flex-col items-center gap-1.5 sm:flex">
                    <FormatPreview output={format.output} width={112} />
                    <figcaption className="text-[10px] uppercase tracking-[0.06em] text-kumo-inactive">
                      在“输出”页面
                    </figcaption>
                  </figure>
                </div>
              </Fieldset>

              <Fieldset
                title="智能体如何选择"
                detail="标准格式会优先列在智能体目录中，如下方条目所示。蓝图自身的描述会提供主要信息；仅当智能体需要知道何时应优先选择此格式时，才添加提示。"
              >
                <OverrideField
                  label="提示"
                  placeholder="例如：面向客户的演示文稿优先使用此格式"
                  value={format.agentHint}
                  disabled={busy}
                  onCommit={(agentHint) => onPatch({ agentHint: agentHint ?? '' })}
                />
                {/* The literal catalog entry, including the blueprint's own description: the hint is
                    only its last line, and showing the label alone made an empty hint look like the
                    agent had been told nothing. Mirrors #listStandardFormats in overseer.ts. */}
                {format.output && (
                  <p className="mt-2 flex items-start gap-1.5 rounded-md bg-kumo-tint/60 px-2.5 py-2 font-mono text-[11px] leading-4 text-kumo-subtle">
                    <Sparkle size={12} className="mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      <span className="block">
                        “{format.output.noun}”——此部署中的标准格式
                        {format.agentHint ? ` -- ${format.agentHint}` : ''}
                      </span>
                      {format.blueprintDescription && (
                        <span className="mt-0.5 block text-kumo-inactive">
                          {format.blueprintDescription}
                        </span>
                      )}
                    </span>
                  </p>
                )}
              </Fieldset>

              {/* A bundled format has no remove button: the deployment put the entry there, so
                  withdrawing it is the switch above, which keeps the name, hint and position for
                  when it comes back. Removing would discard all three to reach the same visible
                  result. The backend refuses it too -- this is an RPC. */}
              <div className="flex items-end justify-between gap-4 border-t border-kumo-line pt-3">
                <p className="text-[12px] leading-4 text-kumo-subtle">
                  {(format.enabled
                    ? '关闭后，此格式将从上述菜单和智能体目录中移除。已用它生成的输出仍可正常使用。'
                    : '当前已从上述菜单和智能体目录中隐藏。') +
                    (format.bundled
                      ? '它随部署提供，因此无论是否启用都会保留在此列表中。'
                      : '')}
                </p>
                {!format.bundled && (
                  <Button variant="secondary" disabled={busy} onClick={onRemove}>
                    <Trash size={13} className="mr-1.5" />
                    停止提供
                  </Button>
                )}
              </div>
            </>
          )}

          {format.missing && (
            <div className="flex justify-end">
              <Button variant="secondary" disabled={busy} onClick={onRemove}>
                <Trash size={13} className="mr-1.5" />
                移除
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Fieldset({
  title,
  detail,
  children,
}: {
  title: string
  detail: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="text-[13px] font-medium text-kumo-default">{title}</p>
      <p className="mb-2 mt-0.5 text-[12px] leading-4 text-kumo-subtle">{detail}</p>
      {children}
    </div>
  )
}

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warn' }) {
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${
        tone === 'warn' ? 'bg-kumo-danger/10 text-kumo-danger' : 'bg-kumo-fill text-kumo-subtle'
      }`}
    >
      {children}
    </span>
  )
}

// A field that either overrides the blueprint or defers to it. Committing an empty value, or one
// equal to the blueprint's, sends null to clear the override rather than freezing today's
// blueprint text into the config.
function OverrideField({
  label,
  value,
  declared,
  placeholder,
  disabled,
  onCommit,
}: {
  label: string
  value: string
  declared?: string
  placeholder?: string
  disabled?: boolean
  onCommit: (value: string | null) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed === value.trim()) return
    onCommit(!trimmed || trimmed === declared ? null : trimmed)
  }

  const overridden = declared !== undefined && draft.trim() !== '' && draft.trim() !== declared

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        {label}
        {overridden && (
          <span className="ml-1 normal-case tracking-normal text-kumo-subtle">（已覆盖）</span>
        )}
      </span>
      <Input
        value={draft}
        placeholder={placeholder ?? declared}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (isImeComposing(e)) return
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(value)
        }}
      />
    </label>
  )
}

function IconPicker({
  icon: selected,
  declaredIcon,
  disabled,
  onPick,
}: {
  // The icon in effect, which the admin may have set on a format whose presentation is otherwise
  // still incomplete.
  icon?: OutputIcon
  declaredIcon?: OutputIcon
  disabled?: boolean
  onPick: (icon: OutputIcon | null) => void
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        图标
      </span>
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              disabled={disabled}
              aria-label="选择图标"
              className="grid h-9 w-9 cursor-pointer place-items-center rounded-lg border border-kumo-line bg-kumo-base text-kumo-subtle transition-colors hover:text-kumo-default disabled:cursor-default"
            >
              <FormatGlyph output={selected && { ...GENERIC_OUTPUT, icon: selected }} size="lg" />
            </button>
          }
        />
        <DropdownMenu.Content className={MENU_CONTENT}>
          <div className="grid grid-cols-5 gap-1 p-1">
            {OUTPUT_ICONS.map((icon) => {
              const Icon = FORMAT_ICONS[icon]
              const active = selected === icon
              return (
                <button
                  key={icon}
                  type="button"
                  aria-label={ICON_LABELS[icon]}
                  onClick={() => onPick(icon === declaredIcon ? null : icon)}
                  className={`grid h-8 w-8 cursor-pointer place-items-center rounded-md transition-colors ${
                    active ? 'bg-kumo-fill text-kumo-strong' : 'text-kumo-subtle hover:bg-kumo-tint'
                  }`}
                >
                  <Icon size={16} />
                </button>
              )
            })}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu>
    </label>
  )
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-fill hover:text-kumo-default disabled:cursor-default disabled:opacity-40"
    >
      {children}
    </button>
  )
}
