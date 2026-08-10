import { Select, type PortalContainer } from '@cloudflare/kumo'
import { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { ConnectionConfigField } from './ConnectionConfigField'

export interface AiModelConnectionConfigProps {
  availableModels: AiChatAuthorInfo[]
  selectedModelId: string | undefined
  onSelectedModelIdChange: (id: string | undefined) => void
  selectContainer?: PortalContainer
}

export function AiModelConnectionConfig({
  availableModels,
  selectedModelId,
  onSelectedModelIdChange,
  selectContainer,
}: AiModelConnectionConfigProps) {
  return (
    <section className="grid gap-3">
      <ConnectionConfigField
        label="模型"
        description="选择此连接可以使用的模型。"
      >
        <Select
          aria-label="选择 AI 模型"
          className="w-full text-sm [&_button]:!h-9"
          container={selectContainer}
          placeholder="请选择 AI 模型"
          value={selectedModelId}
          onValueChange={(v) => onSelectedModelIdChange(v as string | undefined)}
          renderValue={(id) => availableModels.find((m) => m.id === id)?.name ?? id}
        >
          {availableModels.map(model => (
            <Select.Option key={model.id} value={model.id}>
              {model.name}
            </Select.Option>
          ))}
        </Select>
      </ConnectionConfigField>
    </section>
  )
}
