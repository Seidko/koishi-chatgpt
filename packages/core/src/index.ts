import { Service, Schema } from 'koishi'

declare module 'koishi' {
  interface Context {
    gpt: GptService
  }
}

export type PromptOptions = {
  persistent?: false
} | {
  id?: string  // conversation uuid
  persistent: true // is a one-time conversation? default is true
}

export interface Answer {
  id: string
  message: string
  clear?: () => Promise<void>
}

export interface Message {
  message: string
  id: string
  role: 'user' | 'gpt'
}

export interface Conversation {
  messages: Message[]
  expire?: Date | number // mark the time to be expired
}

export abstract class GptService extends Service {
  abstract ask(prompt: string, options?: PromptOptions): Promise<Answer>
  abstract clear(id: string): Promise<void>
  abstract query(id: string): Promise<Conversation> 
}

export interface GptConfig {
  expire: number
}

export const GptConfig: Schema<GptConfig> = Schema.object({
  expire: Schema.number().default(24 * 60).description('对话的过期时间，单位为分钟，标记为永久的对话不受影响'),
}).description('GPT 设置')
