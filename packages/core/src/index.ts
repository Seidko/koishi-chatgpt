import { h, Context } from 'koishi'
import { Service, Schema, Logger } from 'koishi'

declare module 'koishi' {
  interface Context {
    llm: LLMCoreService
  }
}

const logger = new Logger('llm')

export interface AskOptions {
  prompt: string
  parent?: string
  conversationId?: string
  model?: string
}

export interface Message {
  message: string
  id: string
  parent?: string
  children?: string[]
  role: 'user' | 'model' | 'system'
}

export interface Conversation {
  id?: string
  model?: string
  expire?: Date
  latestId?: string
  messages?: string[]
}

export abstract class Instance {
  constructor(protected ctx: Context, public name: string) { }
  abstract ask(option: AskOptions): Promise<Message>
  abstract queryMsg(messageId: string): Promise<Message>
  abstract queryConv(conversationId: string): Promise<Conversation>
  abstract render(type: 'text', text: string): string
  abstract render(type: 'markdown', text: string): string
  abstract render(type: 'element', text: string): h[]
  abstract render(type: 'image', text: string): h
}

export abstract class LLMService {
  protected logger: Logger

  constructor(public ctx: Context, public name: string) {
    this.logger = logger
    let dispose: () => boolean

    ctx.on('ready', () => {
      dispose = ctx.llm.register(name, this)
    })

    ctx.on('dispose', () => {
      dispose()
    })
  }

  abstract instance(model?: string): Promise<Instance>
}

class LLMCoreService extends Service {
  protected registry: Map<string, LLMService>

  constructor(ctx: Context) {
    ctx.i18n.define('zh', require('./locales/zh-CN'))
    super(ctx, 'llm')
    this.registry = new Map()
  }

  get(service: string) {
    return this.registry.get(service)
  }

  register(name: string, service: LLMService) {
    if (this.registry.get(name)) {
      logger.warn(`Duplicate llm implement detected: ${name}`)
    }
    this.registry.set(name, service)

    return () => this.registry.delete(name)
  }

  create(service: string, model?: string): Promise<Instance> {
    const serv = this.registry.get(service)
    return serv.instance(model)
  }
}

namespace LLMCoreService {
  export const Config = Schema.intersect([
    Schema.object({})
  ])
}

export default LLMCoreService
