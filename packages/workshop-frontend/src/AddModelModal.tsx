import { useState, useEffect, useId } from 'react'
import { Dialog, Button, Input, Select, Collapsible, useKumoToastManager } from '@cloudflare/kumo'
import { AiChatAuthorInfo, AiModelConfig, AiModelProvider, AiGatewayInfo, SUGGESTED_MODELS } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { Eye, EyeSlash } from '@phosphor-icons/react'

interface AddModelModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  aiConfig: AiGatewayInfo | null
  editingModelId?: string | null
}

type SelectionType =
  | { type: 'suggested', provider: AiModelProvider, modelId: string, displayName: string }
  | { type: 'custom', provider: AiModelProvider }

const PROVIDER_LABELS: Record<AiModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  cloudflare: 'Cloudflare Workers AI',
  ollama: 'Ollama',
}

// Placeholder hinting at the shape of each provider's API token.
const API_TOKEN_PLACEHOLDERS: Record<AiModelProvider, string> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
  google: 'AIza...',
  cloudflare: 'Cloudflare API 令牌',
  ollama: '（可选）',
}

function ApiTokenField({
  value,
  onChange,
  placeholder,
  description,
  error,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  description: string
  error?: string
}) {
  const [revealed, setRevealed] = useState(false)
  const inputId = useId()

  return (
    <div>
      <label htmlFor={inputId} className="block text-xs font-medium text-kumo-subtle">API 令牌</label>
      <div className="relative mt-1.5">
        <input
          id={inputId}
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="new-password"
          aria-invalid={!!error}
          className={`h-9 w-full rounded-lg border bg-kumo-base px-3 pr-10 text-sm text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] focus:outline-none focus:ring-[3px] ${
            error
              ? 'border-kumo-danger focus:border-kumo-danger focus:ring-kumo-danger/15'
              : 'border-kumo-line focus:border-kumo-ring focus:ring-kumo-ring/15'
          }`}
        />
        <button
          type="button"
          onClick={() => setRevealed((current) => !current)}
          aria-label={revealed ? '隐藏 API 令牌' : '显示 API 令牌'}
          title={revealed ? '隐藏 API 令牌' : '显示 API 令牌'}
          className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
        >
          {revealed ? <EyeSlash size={15} /> : <Eye size={15} />}
        </button>
      </div>
      <p className={`mt-1 text-xs ${error ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>
        {error || description}
      </p>
    </div>
  )
}

// Example used in the custom-model placeholders for providers that have no suggested models
// (currently Ollama, which serves whatever the user has pulled locally).
const FALLBACK_EXAMPLE_MODEL = { modelId: 'gemma4:31b', name: 'Gemma 4 31B' }

// Pick an example model to show in the custom-model placeholders for the given provider.
function exampleModel(provider: AiModelProvider): { modelId: string, name: string } {
  const first = Object.entries(SUGGESTED_MODELS[provider])[0]
  return first ? { modelId: first[0], name: first[1].name } : FALLBACK_EXAMPLE_MODEL
}

// Encode a selection into a string value for the Select component.
function encodeSelection(provider: AiModelProvider, modelId?: string): string {
  return modelId ? `${provider}:${modelId}` : `other-${provider}`
}

// Decode a Select value back into a SelectionType.
function decodeSelection(value: string): SelectionType {
  if (value.startsWith('other-')) {
    return { type: 'custom', provider: value.substring(6) as AiModelProvider }
  }
  const colonIndex = value.indexOf(':')
  const provider = value.substring(0, colonIndex) as AiModelProvider
  const modelId = value.substring(colonIndex + 1)
  const displayName = SUGGESTED_MODELS[provider][modelId].name
  return { type: 'suggested', provider, modelId, displayName }
}

// Build the flat list of options for the Select dropdown.
function buildOptions(gatewayMode: boolean, enabledProviders: Set<string> | null) {
  const options: { value: string; label: string; provider: string }[] = []
  const providerOrder = Object.keys(SUGGESTED_MODELS) as AiModelProvider[]

  for (const provider of providerOrder) {
    if (enabledProviders && !enabledProviders.has(provider)) continue

    // In gateway mode, suggested models are already built-in, so don't list them.
    if (!gatewayMode) {
      for (const [modelId, model] of Object.entries(SUGGESTED_MODELS[provider])) {
        options.push({
          value: encodeSelection(provider, modelId),
          label: model.name,
          provider,
        })
      }
    }

    options.push({
      value: encodeSelection(provider),
      label: `其他 ${PROVIDER_LABELS[provider] || provider}…`,
      provider,
    })
  }

  return options
}

export default function AddModelModal({
  visible,
  onCancel,
  onSuccess,
  authenticatedApi,
  aiConfig,
  editingModelId = null,
}: AddModelModalProps) {
  const toasts = useKumoToastManager()

  const [loading, setLoading] = useState(false)
  const [initializing, setInitializing] = useState(false)
  const [initializationError, setInitializationError] = useState(false)
  const [selection, setSelection] = useState<SelectionType | null>(null)
  const [selectValue, setSelectValue] = useState<string | undefined>(undefined)

  // Form fields (used for custom models)
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [accountId, setAccountId] = useState('')
  const [apiUrl, setApiUrl] = useState('')

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Advanced settings collapsible state
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const gatewayMode = aiConfig?.enabled === true
  const enabledProviders: Set<string> | null = gatewayMode
    ? new Set(aiConfig.enabledProviders)
    : null

  // Reset all state when dialog closes. Clearing the token here is especially important because
  // edit mode temporarily holds the persisted secret in browser memory.
  useEffect(() => {
    if (!visible) {
      setLoading(false)
      setInitializing(false)
      setInitializationError(false)
      setSelection(null)
      setSelectValue(undefined)
      setModelId('')
      setDisplayName('')
      setApiToken('')
      setAccountId('')
      setApiUrl('')
      setErrors({})
      setAdvancedOpen(false)
    }
  }, [visible])

  // Edit mode only loads a model owned by the current user. Shared models that the caller cannot
  // manage never reach this dialog, and the backend independently enforces the same boundary.
  useEffect(() => {
    if (!visible || !editingModelId) return

    let cancelled = false
    setInitializing(true)
    setInitializationError(false)
    authenticatedApi.getOwnModel(editingModelId)
      .then((record) => {
        if (cancelled) return
        if (!record) {
          setInitializationError(true)
          return
        }

        const { profile, config } = record
        const suggested = SUGGESTED_MODELS[config.provider]?.[config.model]
        const nextSelection: SelectionType = suggested
          ? {
              type: 'suggested',
              provider: config.provider,
              modelId: config.model,
              displayName: profile.name,
            }
          : { type: 'custom', provider: config.provider }

        setSelection(nextSelection)
        setSelectValue(encodeSelection(
          config.provider,
          suggested ? config.model : undefined,
        ))
        setModelId(config.model)
        setDisplayName(profile.name)
        setApiToken(config.apiToken)
        setAccountId(config.accountId ?? '')
        setApiUrl(config.apiUrl ?? '')
        setAdvancedOpen(!!config.apiUrl && config.provider !== 'ollama')
      })
      .catch((error) => {
        if (cancelled) return
        console.error('Failed to load model:', error)
        setInitializationError(true)
      })
      .finally(() => {
        if (!cancelled) setInitializing(false)
      })

    return () => { cancelled = true }
  }, [authenticatedApi, editingModelId, visible])

  const handleModelSelect = (value: string) => {
    setSelectValue(value)
    setErrors({})
    const sel = decodeSelection(value)
    setSelection(sel)

    if (sel.type === 'custom') {
      setModelId('')
      setDisplayName('')
    } else {
      setModelId(sel.modelId)
      setDisplayName(sel.displayName)
    }
    setApiToken('')
    setAccountId('')
    setApiUrl(sel.provider === 'ollama' ? 'http://localhost:11434' : '')
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!selection) {
      newErrors.selection = gatewayMode ? '请选择提供商' : '请选择模型'
    }

    if (selection?.type === 'custom' || editingModelId) {
      if (!modelId.trim()) newErrors.modelId = '请输入模型 ID'
      if (!displayName.trim()) newErrors.displayName = '请输入显示名称'
    }

    const isOllama = selection?.provider === 'ollama'
    const isCloudflare = selection?.provider === 'cloudflare'
    const showCredentials = !gatewayMode

    if (showCredentials && selection && !isOllama && !apiToken.trim()) {
      newErrors.apiToken = '请输入 API 令牌'
    }

    if (showCredentials && isCloudflare && !accountId.trim()) {
      newErrors.accountId = '请输入 Cloudflare 账户 ID'
    }

    if (showCredentials && isOllama && !apiUrl.trim()) {
      newErrors.apiUrl = '请输入 Ollama API URL'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      const isSuggested = selection!.type === 'suggested'
      const finalModelId = editingModelId
        ? modelId.trim()
        : isSuggested ? selection!.modelId : modelId.trim()
      const finalDisplayName = editingModelId
        ? displayName.trim()
        : isSuggested ? selection!.displayName : displayName.trim()

      const profile: AiChatAuthorInfo = {
        type: 'agent',
        id: editingModelId ?? finalModelId,
        name: finalDisplayName,
      }

      const config: AiModelConfig = {
        provider: selection!.provider,
        model: finalModelId,
        apiToken: gatewayMode ? '' : apiToken.trim(),
        ...(!gatewayMode && accountId.trim() && { accountId: accountId.trim() }),
        ...(!gatewayMode && apiUrl.trim() && { apiUrl: apiUrl.trim() }),
      }

      if (editingModelId) {
        await authenticatedApi.updateModel(editingModelId, profile, config)
      } else {
        await authenticatedApi.addModel(profile, config)
      }
      toasts.add({
        title: editingModelId ? 'AI 模型更新成功' : 'AI 模型添加成功',
        variant: 'success',
      })
      onSuccess()
    } catch (error: any) {
      console.error(editingModelId ? 'Failed to update model:' : 'Failed to add model:', error)
      toasts.add({ title: editingModelId ? '更新模型失败' : '添加模型失败', variant: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const options = buildOptions(gatewayMode, enabledProviders)
  const showCustomFields = !!selection && (selection.type === 'custom' || !!editingModelId)
  const example = selection ? exampleModel(selection.provider) : null
  const isOllama = selection?.provider === 'ollama'
  const isCloudflare = selection?.provider === 'cloudflare'
  const showCredentials = !gatewayMode

  // Group options by provider for rendering with visual separators.
  const groupedOptions: { provider: string; items: typeof options }[] = []
  for (const opt of options) {
    const last = groupedOptions[groupedOptions.length - 1]
    if (last && last.provider === opt.provider) {
      last.items.push(opt)
    } else {
      groupedOptions.push({ provider: opt.provider, items: [opt] })
    }
  }

  return (
    <Dialog.Root open={visible} onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog className="p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold mb-4">
          {editingModelId ? '编辑 AI 模型' : '添加 AI 模型'}
        </Dialog.Title>

        {initializationError ? (
          <div className="rounded-lg border border-kumo-danger/30 bg-kumo-danger/5 px-4 py-3 text-sm text-kumo-danger">
            无法加载这个模型。它可能已被删除，或不属于当前账户。
          </div>
        ) : (
          <div className={`space-y-4 ${initializing ? 'pointer-events-none opacity-60' : ''}`}>
            {/* Model / Provider selection */}
            <Select
              label={gatewayMode ? '选择提供商' : '选择模型'}
              className="w-full text-sm"
              placeholder={gatewayMode ? '请选择提供商…' : '请选择 AI 模型…'}
              value={selectValue}
              onValueChange={(v) => handleModelSelect(v as string)}
              disabled={initializing || !!editingModelId}
              loading={initializing}
              error={errors.selection}
              renderValue={(v) => {
                const opt = options.find(o => o.value === v)
                return opt?.label ?? String(v)
              }}
            >
              {groupedOptions.map((group, groupIndex) => (
                <div key={group.provider}>
                  {groupIndex > 0 && (
                    <div className="h-px bg-kumo-line my-1 mx-2" />
                  )}
                  <div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle select-none">
                    {PROVIDER_LABELS[group.provider as AiModelProvider] || group.provider}
                  </div>
                  {group.items.map(opt => (
                    <Select.Option key={opt.value} value={opt.value}>
                      {opt.label}
                    </Select.Option>
                  ))}
                </div>
              ))}
            </Select>

          {/* Custom model fields */}
          {showCustomFields && (
            <>
              {editingModelId && (
                <Input
                  label="本地模型 ID"
                  value={editingModelId}
                  disabled
                  description="现有对话使用这个稳定 ID，编辑时不能修改"
                />
              )}
              <Input
                label={editingModelId ? '提供商模型 ID' : '模型 ID'}
                placeholder={`例如：${example!.modelId}`}
                value={modelId}
                onChange={(e) => { setModelId(e.target.value); setErrors(prev => ({ ...prev, modelId: '' })) }}
                error={errors.modelId}
                variant={errors.modelId ? 'error' : 'default'}
                description={editingModelId
                  ? '提供商 API 使用的模型标识符，可以在保持本地 ID 不变的情况下修改'
                  : `提供商指定的模型标识符（例如“${example!.modelId}”）`}
              />

              <Input
                label="显示名称"
                placeholder={`例如：${example!.name}`}
                description="显示在界面中的易读名称"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setErrors(prev => ({ ...prev, displayName: '' })) }}
                error={errors.displayName}
                variant={errors.displayName ? 'error' : 'default'}
              />
            </>
          )}

          {/* Cloudflare account ID (the Workers AI REST endpoint is account-scoped) */}
          {showCredentials && isCloudflare && (
            <Input
              label="Cloudflare 账户 ID"
              placeholder="例如：0123456789abcdef0123456789abcdef"
              description="用于结算 Workers AI 用量的 Cloudflare 账户"
              value={accountId}
              onChange={(e) => { setAccountId(e.target.value); setErrors(prev => ({ ...prev, accountId: '' })) }}
              error={errors.accountId}
              variant={errors.accountId ? 'error' : 'default'}
            />
          )}

          {/* API Token */}
          {showCredentials && selection && (
            <ApiTokenField
              key={`${editingModelId ?? 'new'}:${visible ? 'open' : 'closed'}`}
              placeholder={API_TOKEN_PLACEHOLDERS[selection.provider]}
              description={
                isOllama
                  ? '访问本地 Ollama 时可选填。令牌默认隐藏，可用右侧眼睛查看'
                  : isCloudflare
                  ? '具有 Workers AI 读取和编辑权限的 API 令牌。令牌默认隐藏，可用右侧眼睛查看'
                  : `用于结算的 ${PROVIDER_LABELS[selection.provider]} API 令牌。令牌默认隐藏，可用右侧眼睛查看`
              }
              value={apiToken}
              onChange={(v) => { setApiToken(v); setErrors(prev => ({ ...prev, apiToken: '' })) }}
              error={errors.apiToken}
            />
          )}

          {/* Ollama API URL (always visible for Ollama) */}
          {showCredentials && isOllama && (
            <Input
              label="API URL"
              placeholder="http://localhost:11434"
              description="Ollama 服务器的 URL"
              value={apiUrl}
              onChange={(e) => { setApiUrl(e.target.value); setErrors(prev => ({ ...prev, apiUrl: '' })) }}
              error={errors.apiUrl}
              variant={errors.apiUrl ? 'error' : 'default'}
            />
          )}

          {/* Advanced Settings for non-Ollama, non-Cloudflare providers */}
          {showCredentials && selection && !isOllama && !isCloudflare && (
            <Collapsible.Root
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
            >
              <Collapsible.DefaultTrigger>高级设置</Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <Input
                  label="API URL"
                  placeholder="https://..."
                  description="覆盖默认 API 端点（适用于 Cloudflare AI Gateway 等代理）"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                />
              </Collapsible.DefaultPanel>
            </Collapsible.Root>
          )}
          </div>
        )}

        {/* Footer */}
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close render={(props) => (
            <Button variant="secondary" {...props} disabled={loading || initializing}>
              取消
            </Button>
          )} />
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={loading}
            disabled={!selection || initializing || initializationError}
          >
            {editingModelId ? '保存更改' : '添加模型'}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
