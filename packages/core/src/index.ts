import { Session, Service } from 'koishi'

export type Awaitable<T> = Promise<T> | T

export interface PromptOptions {
  uuid?: string  // conversation uuid
  ephemeral?: boolean // is a one-time conversation? default is true
}

export interface Answer {
  uuid: string
  text: string
  dispose: () => Awaitable<void>
}

export abstract class GptService extends Service {
  abstract ask(session: Session, prompt: string, options?: PromptOptions): Promise<Answer>
  abstract reset(session: Session): Promise<boolean>
  abstract query(session: Session): Promise<ConversationCache> 
}

export interface ConversationCache {
  uuid: string
  lastMessageUuid: string
  expire?: Date | number // mark the time to be expired
}
