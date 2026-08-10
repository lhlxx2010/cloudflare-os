import { Lock, MagnifyingGlass, WarningCircle } from '@phosphor-icons/react'
import { useEffect, useId, useRef } from 'react'
import {
  getOpenGadgetErrorCode,
  OPEN_GADGET_ERROR_CODES,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './WorkshopControls'

export type WorkspaceOpenFailureKind = 'access-denied' | 'not-found' | 'unexpected'

const CONTENT = {
  'access-denied': {
    title: '你无权访问此工作区',
    message: '请让工作区所有者授予你访问权限，然后重试。',
    Icon: Lock,
    retryable: true,
  },
  'not-found': {
    title: '未找到工作区',
    message: '链接可能不正确，或者该工作区已被删除。',
    Icon: MagnifyingGlass,
    retryable: false,
  },
  unexpected: {
    title: '无法加载此工作区',
    message: '请重试。如果问题仍然存在，请返回工作区列表。',
    Icon: WarningCircle,
    retryable: true,
  },
} as const

export function classifyWorkspaceOpenFailure(error: unknown): WorkspaceOpenFailureKind {
  switch (getOpenGadgetErrorCode(error)) {
    case OPEN_GADGET_ERROR_CODES.workspaceAccessDenied:
      return 'access-denied'
    case OPEN_GADGET_ERROR_CODES.workspaceNotFound:
      return 'not-found'
    default:
      return 'unexpected'
  }
}

type Props = {
  kind: WorkspaceOpenFailureKind
  onRetry: () => void
  onGoToWorkspaces: () => void
}

export default function WorkspaceOpenErrorPage({ kind, onRetry, onGoToWorkspaces }: Props) {
  const { title, message, Icon, retryable } = CONTENT[kind]
  const titleId = useId()
  const descriptionId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  return (
    <div className="flex min-h-screen items-center justify-center bg-kumo-base px-6 py-12">
      <section
        aria-atomic="true"
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-live="polite"
        className="themed-compact-shadow w-full max-w-md rounded-2xl border border-kumo-line bg-kumo-base px-6 py-8 text-center"
      >
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-kumo-line bg-kumo-tint text-kumo-subtle">
          <Icon aria-hidden="true" size={20} weight="bold" />
        </div>
        <h1
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
          className="mt-5 text-[20px] leading-7 font-semibold tracking-[-0.35px] text-kumo-default outline-none"
        >
          {title}
        </h1>
        <p
          id={descriptionId}
          className="mt-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle"
        >
          {message}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <WorkshopButton
            tone={retryable ? 'secondary' : 'primary'}
            className="!h-9"
            onClick={onGoToWorkspaces}
          >
            前往工作区列表
          </WorkshopButton>
          {retryable && (
            <WorkshopButton tone="primary" onClick={onRetry}>
              重试
            </WorkshopButton>
          )}
        </div>
      </section>
    </div>
  )
}
