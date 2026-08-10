// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Close: ({ render }: { render: (props: object) => ReactNode }) => render({}),
    },
  )
  const Select = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    { Option: ({ children }: { children: ReactNode }) => <div>{children}</div> },
  )
  const Collapsible = {
    Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DefaultTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
    DefaultPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  }
  return {
    Dialog,
    Select,
    Collapsible,
    Button: ({ children, loading: _loading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      loading?: boolean
    }) => (
      <button {...props}>{children}</button>
    ),
    Input: ({ label, description, error, ...props }: React.InputHTMLAttributes<HTMLInputElement> & {
      label?: ReactNode
      description?: ReactNode
      error?: ReactNode
    }) => (
      <label>{label}<input {...props} />{error || description}</label>
    ),
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

import AddModelModal from './AddModelModal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AddModelModal edit mode', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
  })

  it('locks the stable ID while editing the provider model ID and secret', async () => {
    const getOwnModel = vi.fn<() => Promise<{
      profile: { type: 'agent', id: string, name: string }
      config: { provider: 'openai', model: string, apiToken: string, apiUrl: string }
    }>>(async () => ({
      profile: { type: 'agent' as const, id: 'daily-builder', name: 'Test model' },
      config: {
        provider: 'openai' as const,
        model: 'gpt-5.6-sol',
        apiToken: 'secret-key',
        apiUrl: 'http://localhost:9999/v1',
      },
    }))
    const updateModel = vi.fn<AuthenticatedApi['updateModel']>(async () => {})
    const api = { getOwnModel, updateModel } as unknown as RpcStub<AuthenticatedApi>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <AddModelModal
        visible
        editingModelId="daily-builder"
        onCancel={vi.fn<() => void>()}
        onSuccess={vi.fn<() => void>()}
        authenticatedApi={api}
        aiConfig={{ enabled: false }}
      />,
    ))

    expect(getOwnModel).toHaveBeenCalledWith('daily-builder')
    const idInput = Array.from(container.querySelectorAll<HTMLInputElement>('input'))
      .find((input) => input.value === 'daily-builder')
    expect(idInput?.disabled).toBe(true)

    const providerModelInput = Array.from(container.querySelectorAll<HTMLInputElement>('input'))
      .find((input) => input.value === 'gpt-5.6-sol')
    expect(providerModelInput?.disabled).toBe(false)

    const tokenInput = Array.from(container.querySelectorAll<HTMLInputElement>('input'))
      .find((input) => input.value === 'secret-key')
    expect(tokenInput?.type).toBe('password')

    const reveal = container.querySelector<HTMLButtonElement>('button[aria-label="显示 API 令牌"]')
    expect(reveal).not.toBeNull()
    await act(async () => reveal!.click())
    expect(tokenInput?.type).toBe('text')
    expect(container.querySelector('button[aria-label="隐藏 API 令牌"]')).not.toBeNull()

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
      setValue?.call(providerModelInput, 'gpt-5.6-luna')
      providerModelInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === '保存更改')
    await act(async () => save!.click())

    expect(updateModel).toHaveBeenCalledWith(
      'daily-builder',
      expect.objectContaining({ id: 'daily-builder' }),
      expect.objectContaining({ model: 'gpt-5.6-luna' }),
    )
  })
})
