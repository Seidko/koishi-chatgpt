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

export interface Conversation {
  readonly id?: uuid // static
  readonly messages?: Record<string, Message> // static
  readonly latestMessage?: Message
  readonly expire?: number // static
  ask?: (prompt: string, parent?: string) => Promise<Conversation>
  edit?: (prompt: string) => Promise<Conversation>
  retry?: () => Promise<Conversation>
  continue?: () => Promise<Conversation>
  clear?: () => Promise<void>
  toJSON?: () => string
}

export abstract class GptService extends Service {
  static readonly isConv = Symbol('is-conversation')
  abstract clear(id: uuid): Promise<void>
  abstract query(id: uuid): Promise<Conversation>
  abstract create(): Promise<Conversation>
}

export interface GptConfig {
  expire: number
}

export const GptConfig: Schema<GptConfig> = Schema.object({
  expire: Schema.number().default(24 * 60).description('对话的过期时间，单位为分钟，标记为永久的对话不受影响'),
}).description('GPT 设置')
