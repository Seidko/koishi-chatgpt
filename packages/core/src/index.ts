import { Service, Schema } from 'koishi'

declare module 'koishi' {
  interface Context {
    gpt: GptService
  }
}

export type uuid = string

export interface Message {
  message: string
  id: uuid
  parent?: uuid
  children?: uuid[]
  role: 'user' | 'gpt' | 'system'
}

export interface ConvOption {
  initialPrompts?: string[] | string
  expire?: number // undefined = permanent, null = ephemeral
  model?: string
}

export type Action = 'next' | 'variant' | 'continue'

export interface Conversation {
  readonly model?: string
  readonly id?: uuid
  readonly messages?: Record<string, Message>
  readonly latestMessage?: Message
  readonly expire?: number // undefined = permanent, null = ephemeral
  ask?: (prompt: string, parent?: string) => Promise<Conversation>
  edit?: (prompt: string) => Promise<Conversation>
  retry?: () => Promise<Conversation>
  continue?: () => Promise<Conversation>
  clear?: () => Promise<void>
}

export abstract class GptService extends Service {
  static readonly isConv = Symbol('is-conversation')
  abstract clear(id: uuid): Promise<void>
  abstract query(id: uuid): Promise<Conversation>
  abstract create(options?: ConvOption): Promise<Conversation>
}

export interface GptConfig {
  expire: number
}

export const GptConfig: Schema<GptConfig> = Schema.object({
  expire: Schema.number().default(24 * 60).description('对话的过期时间，单位为分钟，标记为永久的对话不受影响'),
}).description('GPT 设置')
