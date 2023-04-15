import { Conversation, LLMService, LLMConfig, ConvOption, isConv } from '@seidko/llm-core'
import { Context, Schema, SessionError, pick, Time, Quester } from 'koishi'
import { v4 as uuid } from 'uuid'
import type { Page } from 'koishi-plugin-puppeteer'
import type { } from '@koishijs/cache'
import type { Argument, Response } from './types'

export interface BingConversation extends Conversation {
  clientId: string
  convSig: string
  traceId: string
  invocationId: string
}

export class BingConversation {
  protected service: BingService
  constructor(conv: Partial<BingConversation>, service: BingService) {
    Object.assign(this, conv)
    this.messages ??= {}
    this.traceId = uuid().replace(/\-/g, '')
    this.service = service
    this.invocationId = '0'
    this[isConv] = true
  }

  fork(newConv: Partial<BingConversation>): BingConversation {
    for (const k in newConv) {
      if (newConv[k] === undefined) delete newConv[k]
    }
    return Object.assign(Object.create(this), newConv)
  }

  toJSON() {
    return JSON.stringify(pick(this, ['id', 'expire', 'latestId', 'model', 'messages']))
  }

  async clear(): Promise<void> {
    await this.service.clear(this.id)
  }

  async ask(prompt: string): Promise<BingConversation> {
    return await this.service.ask(prompt, this)
  }

}

const DELIMITER = '\x1e'

class BingService extends LLMService {
  http: Quester

  constructor(ctx: Context, protected config: BingService.Config) {
    super(ctx, 'bing')
    this.http = ctx.http.extend({
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36 Edg/111.0.1661.62',
        'x-ms-client-request-id': uuid(),
        'x-ms-useragent': 'azsdk-js-api-client-factory/1.0.0-beta.1 core-rest-pipeline/1.10.0 OS/Win32',
        referer: 'https://www.bing.com/search?q=Bing+AI&showconv=1&FORM=hpcodx',
      }
    })
  }

  protected async start(): Promise<void> {
    const cookies = await this.ctx.cache('default').get('bingai/cookies')
    if (!cookies) {
      if (this.config.usingPuppeteer) {
        this.ctx.using(['puppeteer'], async ctx => {
          let page: Page
          try {
            page = await ctx.puppeteer.page()
            await page.evaluateOnNewDocument('Object.defineProperties(navigator, { webdriver:{ get: () => false } })')
            await page.goto('https://www.bing.com/search?q=Bing+AI&showconv=1&FORM=hpcodx')
            await page.waitForResponse(' https://b.clarity.ms/collect', { timeout: 10 * Time.minute })
            const pageCookies = await page.cookies('https://chat.openai.com')
              .then(c => c.map(c => `${c.name}=${c.value}`).join('; '))
            await ctx.cache('default').set('bingai/cookies', pageCookies, 10 * Time.day)
          } finally {
            page?.close()
          }

          this.logger.info('Bing AI service load successed.')
        })
        return
      } else {
        try {
          const cookies = JSON.parse(this.config.cookies)
            .filter((c: any) => c.session !== true)
            .map((c: any) => `${c.name}=${c.value}`).join('; ')

          if (this.ctx.cache) {
            await this.ctx.cache('default').set('bingai/cookies', cookies, 10 * Time.day)
          }
        } catch {
          this.logger.error('Cannot parse cookies.')
        }
      }
    }

    this.logger.info('Bing AI service load successed.')
  }

  protected serial(object: any): string {
    return JSON.stringify(object) + DELIMITER
  }

  ask(prompt: string, conv: BingConversation): Promise<BingConversation> {
    const ws = this.http.ws('wss://sydney.bing.com/sydney/ChatHub')
    return new Promise(resolve => {

      ws.on('open', async () => {
        ws.send(this.serial({
          protocol: 'json',
          version: 1,
        }))

        await new Promise(resolve => ws.once('message', resolve))

        ws.send(this.serial({ type: 6 }))
        const interval = this.ctx.setInterval(() => ws.send(this.serial({ type: 6 })), 20 * Time.second)

        const options: Argument = require('./precise')
        options.arguments[0].traceId = conv.traceId
        options.arguments[0].message.timestamp = new Date().toISOString()
        options.arguments[0].message.text = prompt
        options.arguments[0].conversationSignature = conv.convSig
        options.arguments[0].participant.id = conv.clientId
        options.arguments[0].conversationId = conv.id
        options.invocationId = conv.invocationId
        ws.send(this.serial(options))

        ws.on('message', raw => {
          const parsed: Response[] = raw.toString('utf-8')
          .split(DELIMITER)
          .filter(Boolean)
          .map(s => JSON.parse(s))

          for (const data of parsed) {
            if (data.type === 2) {
              const message = data.item.messages.find(v => v.author === 'user')
              const awnser = data.item.messages.find(v => v.suggestedResponses)

              const newConv = conv.fork({ latestId: awnser.messageId })

              newConv.messages[message.messageId] = {
                id: message.messageId,
                role: 'user',
                message: prompt,
                parent: conv.latestId,
                children: [awnser.messageId]
              }

              newConv.messages[awnser.messageId] = {
                id: awnser.messageId,
                message: awnser.text,
                role: 'model',
                parent: message.messageId
              }

              resolve(newConv)
              interval()
              ws.close()
            }
          }
        })
      })
    })
  }

  async clear(id: string): Promise<void> {
  }

  async create(options?: ConvOption): Promise<BingConversation> {
    const { model = 'balanced', expire } = options ?? {}
    const cookie = await this.ctx.cache('default').get('bingai/cookies')

    const data = await this.http.get('https://www.bing.com/turing/conversation/create', {
      headers: { cookie }
    })

    let conv = new BingConversation({
      id: data.conversationId,
      convSig: data.conversationSignature,
      clientId: data.clientId,
      model, expire
    }, this)

    return conv
  }

  async query(id: string): Promise<BingConversation> {
    return
  }
}

namespace BingService {
  export interface Config extends LLMConfig {
    usingPuppeteer?: boolean
    cookies?: string
  }

  export const Config: Schema<Config> = Schema.intersect([
    LLMConfig,
    Schema.object({
      usingPuppeteer: Schema.boolean().default(true).description('是否使用puppeteer来获取cookies？'),
    }),
    Schema.union([
      Schema.object({
        usingPuppeteer: Schema.const(false).required(),
        cookies: Schema.string().description('cookies').role('textarea'),
      }),
      Schema.object({}),
    ]),
  ])

  export const using = ['__cache__']
}

export default BingService
