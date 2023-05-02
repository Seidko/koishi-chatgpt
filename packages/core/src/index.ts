import { h, Context } from 'koishi'
import { Service, Schema, Logger } from 'koishi'

declare module 'koishi' {
  interface Context {
    llm: LLMCoreService
  }

  interface Tables {
    gpt_conversaion: Conversation
    gpt_messages: Message & { conversationId: string }
  }

}

const logger = new Logger('llm')

export interface AskOptions {
  prompt: string
  parent?: string
  conversationId?: string
  model?: string
  action?: 'next' | 'variant' | 'continue'
}

export interface Message {
  message: string
  id: string
  parent?: string
  children?: string[]
  role: 'user' | 'model' | 'system'
}

export interface Conversation {
  id: string
  model: string
  latestId?: string
  messages: string[]
}

export abstract class Instance {
  constructor(protected ctx: Context, public name: string) { }
  abstract ask(option: AskOptions): Promise<Message>
  abstract render(type: 'text', text: string): string
  abstract render(type: 'markdown', text: string): string
  abstract render(type: 'element', text: string): h[]
  abstract render(type: 'image', text: string): h

  async queryConv(id: string): Promise<Conversation> {
    const [conv] = await this.ctx.database.get('gpt_conversaion', { id })
    return conv
  }

  async queryMsg(id: string): Promise<Message & { conversationId: string }> {
    const [message] = await this.ctx.database.get('gpt_messages', { id })
    return message
  }
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

  abstract instance(): Promise<Instance>

  async saveConv(conv: Conversation) {
    await this.ctx.database.upsert('gpt_conversaion', [conv])
  }

  protected async saveMsg(messages: Message[] | Message, convId: string) {
    if (!Array.isArray(messages)) messages = [messages]
    await this.ctx.database.upsert(
      'gpt_messages',
      messages.map((v: Message & { conversationId: string }) => {
        v.conversationId = convId
        return v
      })
    )
  }
}

class LLMCoreService extends Service {
  protected registry: Map<string, LLMService>

  constructor(ctx: Context) {
    ctx.i18n.define('zh', require('./locales/zh-CN'))
    super(ctx, 'llm')
    this.registry = new Map()
    ctx.database.extend('gpt_conversaion', {
      id: {
        type: 'char',
        length: 256,
        nullable: false,
      },
      latestId: 'char',
      model: 'string',
      messages: 'list',
    }, {
      autoInc: false,
    })

    ctx.database.extend('gpt_messages', {
      conversationId: {
        type: 'char',
        length: 256,
      },
      children: 'list',
      id: {
        type: 'char',
        length: 36,
        nullable: false,
      },
      message: 'text',
      parent: {
        type: 'char',
        length: 36,
      },
      role: 'string',
    }, {
      autoInc: false,
    })
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

  create(service: string): Promise<Instance> {
    const serv = this.registry.get(service)
    return serv.instance()
  }
}

namespace LLMCoreService {
  export const using = ['database'] as const

  export const Config = Schema.intersect([
    Schema.object({})
  ])
}

export default LLMCoreService
