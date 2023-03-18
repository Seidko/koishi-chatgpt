import { Service } from 'koishi'

declare module 'koishi' {
  interface Context {
    gpt: GptService
  }
}

export type PromptOptions = {
  persistent?: false
} | {
  id: string  // conversation uuid
  persistent: true // is a one-time conversation? default is true
}

export interface Answer {
  id: string
  message: string
  clear(): Promise<void>
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
  abstract clear(id: string): Promise<boolean>
  abstract query(id: string): Promise<Conversation> 
}
