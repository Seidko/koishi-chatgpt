import { Service, Schema } from 'koishi'
import { type } from 'os'

declare module 'koishi' {
  interface Context {
    llm: LLMService
  }
}

export type uuid = string

export interface Message {
  message: string
  id: uuid
  parent?: uuid
  children?: uuid[]
  role: 'user' | 'model' | 'system'
}

export interface ConvOption {
  model?: string
  expire?: number
  initialPrompts?: string[] | string
}

export type Action = 'next' | 'variant' | 'continue'

export interface Conversation {
  id?: uuid
  model?: string
  expire?: number
  latestId?: string
  messages?: Record<string, Message>
  [isConv]?: boolean
  clear: () => Promise<void>
  retry: () => Promise<Conversation>
  continue: () => Promise<Conversation>
  edit: (prompt: string) => Promise<Conversation>
  ask: (prompt: string, parent?: string) => Promise<Conversation>
  fork: (newConv: Conversation) => Conversation
}

export abstract class LLMService extends Service {
  abstract clear(id: uuid): Promise<void>
  abstract query(id: uuid): Promise<Conversation>
  abstract create(options?: ConvOption): Promise<Conversation>
}

export const isConv = Symbol('is-conversation')

export interface LLMConfig {
  expire?: number
  clear?: boolean
}

export const LLMConfig: Schema<LLMConfig> = Schema.intersect([
  Schema.object({
    clear: Schema.boolean().default(false).description('是否在对话长时间不活跃后删除')
  }).description('LLM 设置'),
  Schema.union([
    Schema.object({
      clear: Schema.union([
        Schema.const(undefined).required(),
        Schema.const(true).required(),
      ]),
    }),
    Schema.object({
      clear: Schema.const(true).required(),
      expire: Schema.number().default(1440).description('不活跃的对话的保存时间，单位为分钟。'),
    }),
  ])
])
