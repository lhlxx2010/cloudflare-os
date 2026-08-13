// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => {
  const state = {
    vendors: [] as Array<{ id: string, description: Record<string, unknown> }>,
    listModels: vi.fn<() => void>(),
    getAiConfig: vi.fn<() => void>(),
    setPreferredModel: vi.fn<(id: string | null) => void>(),
    completeOnboarding: vi.fn<() => Promise<void>>(async () => {}),
    authenticatedApi: null as unknown as Record<string, unknown>,
  }
  state.authenticatedApi = {
    listGatekeeperVendors: async () => state.vendors,
    subscribeConnectedAccounts: () => Object.assign(
      Promise.resolve({ [Symbol.dispose]() {} }),
      { [Symbol.dispose]() {} },
    ),
    listModels: state.listModels,
    getAiConfig: state.getAiConfig,
    setPreferredModel: state.setPreferredModel,
    completeOnboarding: state.completeOnboarding,
  }
  return state
})

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({
    currentUser: { type: 'user', id: 'new-user', name: 'New user' },
    authenticatedApi: testState.authenticatedApi,
  }),
}))

vi.mock('./ThemeContext', () => ({
  useTheme: () => ({ resolvedThemeMode: 'light' }),
}))

vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Gadgets' }))
vi.mock('./components/SiteLogo', () => ({ default: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('./useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

import OnboardingWizard from './OnboardingWizard'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const localValues = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    clear: () => localValues.clear(),
    getItem: (key: string) => localValues.get(key) ?? null,
    removeItem: (key: string) => localValues.delete(key),
    setItem: (key: string, value: string) => localValues.set(key, String(value)),
  },
})

function slider(container: HTMLElement): HTMLDivElement {
  const result = Array.from(container.querySelectorAll<HTMLDivElement>('div'))
    .find((element) => element.style.transform.startsWith('translateX'))
  if (!result) throw new Error('Onboarding slider not found')
  return result
}

function nextButton(container: HTMLElement): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.includes('下一步'))
  if (!result) throw new Error('Next button not found')
  return result
}

describe('OnboardingWizard steps', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    testState.vendors = []
    localStorage.clear()
    vi.clearAllMocks()
  })

  async function render() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <OnboardingWizard onComplete={vi.fn<() => void>()} />,
    ))
    return container
  }

  it('moves directly from profile to the showcase when there are no connectors', async () => {
    const rendered = await render()

    expect(slider(rendered).children).toHaveLength(2)
    expect(rendered.textContent).not.toContain('连接你的服务')
    await act(async () => nextButton(rendered).click())

    expect(slider(rendered).style.transform).toBe('translateX(-100%)')
    expect(rendered.textContent).toContain('开始创作')
  })

  it('keeps the connectors step when connectors are available', async () => {
    testState.vendors = [{
      id: 'github',
      description: {
        displayName: 'GitHub',
        url: 'https://github.example',
        tagline: 'Code',
        description: 'GitHub connector',
      },
    }]
    const rendered = await render()

    expect(slider(rendered).children).toHaveLength(3)
    expect(rendered.textContent).toContain('连接你的服务')
    await act(async () => nextButton(rendered).click())
    expect(slider(rendered).style.transform).toBe('translateX(-100%)')

    await act(async () => nextButton(rendered).click())
    expect(slider(rendered).style.transform).toBe('translateX(-200%)')
    expect(rendered.textContent).toContain('开始创作')
  })

  it('clears a previous account selection without loading or selecting a model', async () => {
    localStorage.setItem('lastSelectedModel', '__gadgets_no_agent__')
    const rendered = await render()

    await act(async () => nextButton(rendered).click())
    const finish = Array.from(rendered.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('开始创作'))
    await act(async () => finish!.click())

    expect(testState.listModels).not.toHaveBeenCalled()
    expect(testState.getAiConfig).not.toHaveBeenCalled()
    expect(testState.setPreferredModel).not.toHaveBeenCalled()
    expect(testState.completeOnboarding).toHaveBeenCalledOnce()
    expect(localStorage.getItem('lastSelectedModel')).toBeNull()
  })
})
