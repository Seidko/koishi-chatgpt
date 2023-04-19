import type { h, Awaitable, Context } from 'koishi'
import type { Buffer } from 'buffer'
import { Service, Schema, Logger } from 'koishi'
import { CacheTable } from '@koishijs/cache'

declare module 'koishi' {
  interface Context {
    llm: LLMCoreService
  }
}

declare module '@koishijs/cache' {
  interface Tables {
    'llm/conversations': Conversation
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
  provider?: string
}

export interface Conversation {
  id?: uuid
  model?: string
  expire?: number
  latestId?: string
  root?: Conversation
  messages?: Record<string, Message>
  [isConv]: true
  clear: () => Promise<void>
  retry?: () => Promise<Conversation>
  continue?: () => Promise<Conversation>
  edit?: (prompt: string) => Promise<Conversation>
  ask: (prompt: string, parent?: string) => Promise<Conversation>
  fork: (newConv: Partial<Conversation>) => Conversation
  renderText: (messageId?: uuid) => string
  renderMarkdown: (messageId?: uuid) => string
  renderElement: (messageId?: uuid) => h[]
  renderImage: (messageId?: uuid) => Promise<Buffer>
}

export class LLMCoreService extends Service {
  registry: Map<string, LLMService>

  constructor(ctx: Context) {
    ctx.i18n.define('zh', require('./locales/zh-CN'))
    super(ctx, 'llm')
    this.registry = new Map()
  }

  protected fork() { }

  register(name: string, service: LLMService) {
    if (this.registry.get(name)) {
      logger.warn(`duplicate llm implement detected: ${name}`)
    }
    this.registry.set(name, service)

    return () => this.registry.delete(name)
  }

  protected getSerive(name?: string) {
    return this.registry.get(name) ?? this.registry.values().next().value as LLMService
  }

  create(options?: ConvOption) {
    return this.getSerive(options?.provider)?.create(options)
  }

  query(id: uuid, provider?: string) {
    return this.getSerive(provider)?.query(id)
  }

  clear(id: uuid, provider?: string) {
    return this.getSerive(provider)?.clear(id)
  }
}

export abstract class LLMService {
  protected logger: Logger
  protected conv?: CacheTable<Conversation>
  constructor(public ctx: Context, name: string) {
    ctx.plugin(LLMCoreService)
    ctx.using(['__cache__'], ctx => this.conv = ctx.cache('llm/conversations'))
    this.logger = logger

    let dispose: () => boolean

    ctx.on('ready', async () => {
      await this.start()
      ctx.using(['llm'], ctx => dispose = ctx.llm.register(name, this))
    })

    ctx.on('dispose', async () => {
      await this.stop()
      dispose?.()
    })
  }

  protected start(): Awaitable<void> { }
  protected stop(): Awaitable<void> { }

  abstract clear(id: uuid): Promise<void>
  abstract query(id: uuid): Promise<Conversation>
  abstract create(options?: ConvOption): Promise<Conversation>
}

export const isConv = Symbol('is-conversation')

const logger = new Logger('llm')

export interface LLMConfig {
  expire?: number
  clear?: boolean
}

export const LLMConfig: Schema<LLMConfig> = Schema.intersect([
  Schema.object({
    clear: Schema.boolean().default(false).description('是否在对话长时间不活跃后删除。')
  }).description('LLM 设置'),
  Schema.union([
    Schema.object({
      clear: Schema.const(true).required(),
      expire: Schema.number().default(1440).description('不活跃的对话的保存时间，单位为分钟。'),
    }),
    Schema.object({}),
  ])
])
