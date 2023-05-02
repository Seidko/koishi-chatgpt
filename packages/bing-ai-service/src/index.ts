import { Conversation, LLMService, Instance, Message, AskOptions } from '@seidko/koishi-plugin-gpt'
import { Context, Schema, SessionError, Time, Quester, h } from 'koishi'
import { v4 as uuid } from 'uuid'
import type { Page } from 'koishi-plugin-puppeteer'
import type { Argument, Response } from './types'

declare module '@seidko/koishi-plugin-gpt' {
  interface Conversation {
    clientId: string
    convSig: string
    traceId: string
    invocationId?: number
  }
}

declare module 'koishi' {
  interface Tables {
    bing_ai_messages: Message & { conversationId: string }
    bing_ai_conversations: Conversation
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

    ctx.database.extend('bing_ai_conversations', {
      id: {
        type: 'char',
        length: 128,
        nullable: false,
      },
      expire: 'time',
      latestId: 'char',
      model: 'string',
      clientId: 'string',
      convSig: 'string',
      messages: 'list',
      invocationId: 'unsigned',
      traceId: {
        type: 'char',
        length: 32,
      },
    }, {
      autoInc: false,
    })

    ctx.database.extend('bing_ai_messages', {
      conversationId: {
        type: 'char',
        length: 128,
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

  protected serial(object: any): string {
    return JSON.stringify(object) + DELIMITER
  }

  async instance(): Promise<Instance> {
    let cookies: string
    if (this.config.usingPuppeteer) {
      let page: Page
      try {
        page = await this.ctx.puppeteer.page()
        await page.evaluateOnNewDocument('Object.defineProperties(navigator, { webdriver:{ get: () => false } })')
        await page.goto('https://www.bing.com/search?q=Bing+AI&showconv=1&FORM=hpcodx')
        await page.waitForResponse('https://b.clarity.ms/collect', { timeout: 10 * Time.minute })
        cookies = await page.cookies('https://www.bing.com')
          .then(c => c.map(c => `${c.name}=${c.value}`).join('; '))
      } finally {
        page?.close()
      }
    } else {
      try {
        cookies = JSON.parse(this.config.cookies)
          .filter((c: any) => c.session !== true)
          .map((c: any) => `${c.name}=${c.value}`).join('; ')
        // this.ctx.scope.update({})
      } catch {
        this.logger.error('Cannot parse cookies.')
      }
    }

    this.logger.info('Bing AI instance create successed.')
    return new BingInstance(this.ctx, cookies)
  }

  async saveConv(conv: Conversation) {
    await this.ctx.database.upsert('bing_ai_conversations', [conv])
  }

  async saveMsg(messages: Message[] | Message, convId: string) {
    if (!Array.isArray(messages)) messages = [messages]
    await this.ctx.database.upsert(
      'bing_ai_messages',
      messages.map((v: Message & { conversationId: string }) => {
        v.conversationId = convId
        return v
      })
    )
  }

  async ask(prompt: string, conv: Conversation): Promise<Message> {
    const ws = this.http.ws('wss://sydney.bing.com/sydney/ChatHub')
    return new Promise((resolve, reject) => {

      ws.once('open', async () => {
        ws.send(this.serial({
          protocol: 'json',
          version: 1,
        }))

        await new Promise(resolve => ws.once('message', resolve))

        ws.send(this.serial({ type: 6 }))
        const dispose = this.ctx.setInterval(() => ws.send(this.serial({ type: 6 })), 20 * Time.second)

        const options: Argument = require('./precise')
        options.arguments[0].traceId = conv.traceId
        options.arguments[0].message.timestamp = new Date().toISOString()
        options.arguments[0].message.text = prompt
        options.arguments[0].conversationSignature = conv.convSig
        options.arguments[0].participant.id = conv.clientId
        options.arguments[0].conversationId = conv.id
        options.invocationId = `${conv.invocationId}`
        options.arguments[0].isStartOfSession = conv.invocationId < 1
        ws.send(this.serial(options))

        ws.send(this.serial({ type: 6 }))
        const dispose = this.ctx.setInterval(() => ws.send(this.serial({ type: 6 })), 20 * Time.second)

        ws.on('message', async raw => {
          try {
            const parsed: Response[] = raw.toString('utf-8')
              .split(DELIMITER)
              .filter(Boolean)
              .map(s => JSON.parse(s))

            for (const data of parsed) {
              if (data.type === 2) {
                switch (data.item.result.value) {
                  case 'Success': break
                  case 'Forbidden': throw new SessionError('error.llm.forbidden')
                  case 'UnauthorizedRequest': throw new SessionError('error.llm.authorize-failed')
                  case 'ProcessingMessage': throw new SessionError('error.llm.busy')
                  default: throw new SessionError('error.llm.unknown', [data.item.result.value])
                }
                const message = data.item.messages.find(v => v.author === 'user')
                const awnser = data.item.messages.find(v => v.suggestedResponses)

                const temp = {
                  id: awnser.messageId,
                  message: (awnser.adaptiveCards[0].body[0] as any).text,
                  role: 'model',
                  parent: message.messageId,
                } as const

                await this.saveMsg([
                  {
                    id: message.messageId,
                    role: 'user',
                    message: prompt,
                    parent: conv.latestId,
                    children: [awnser.messageId]
                  },
                  temp
                ], conv.id)

                conv.invocationId++
                conv.latestId = awnser.messageId
                conv.messages.push(message.messageId, awnser.messageId)
                await this.saveConv(conv)

                resolve(temp)
                ws.close()
                dispose()
              }
            }
          } catch (e) {
            reject(e)
            ws.close()
            dispose()
          }
        })
      })
    })
  }


  async create(cookie: string, model = 'balanced'): Promise<Conversation> {
    const data = await this.http.get('https://www.bing.com/turing/conversation/create', {
      headers: { cookie }
    })

    switch (data.result.value) {
      case 'Forbidden': throw new SessionError('error.llm.forbidden')
      case 'UnauthorizedRequest': throw new SessionError('error.llm.authorize-failed')
      case 'Success': break
      default: throw new SessionError('error.llm.unknown')
    }

    return {
      id: data.conversationId,
      convSig: data.conversationSignature,
      clientId: data.clientId,
      traceId: uuid().replace(/\-/g, ''),
      invocationId: 0,
      messages: [],
      model,
    }
  }

}

class BingInstance extends Instance {
  constructor(ctx: Context, protected cookies: string) {
    super(ctx, 'bing')
  }

  async queryConv(id: string): Promise<Conversation> {
    const [conv] = await this.ctx.database.get('bing_ai_conversations', { id })
    return conv
  }

  async queryMsg(id: string): Promise<Message & { conversationId: string }> {
    const [message] = await this.ctx.database.get('bing_ai_messages', { id })
    return message
  }

  async ask(options: AskOptions): Promise<Message> {
    const service = this.ctx.llm.get('bing') as BingService
    const { prompt, conversationId, model, parent } = options
    let conv: Conversation

    if (conversationId) {
      conv = await this.queryConv(conversationId)
    } else if (parent) {
      const message = await this.queryMsg(parent)
      conv = await this.queryConv(message.conversationId)
    } else {
      conv = await service.create(this.cookies, model)
    }

    return service.ask(prompt, conv)
  }

  render(type: 'text', text: string): string
  render(type: 'markdown', text: string): string
  render(type: 'element', text: string): h[]
  render(type: 'image', text: string): h
  render(type: 'text' | 'markdown' | 'element' | 'image', text: string): string | h | h[] {
    switch (type) {
      case 'markdown': return text.replace(/\[\^\d+\^\]\[(\d+)\]/g, '[$1]')
      // case 'markdown': return text.replace(/\[\^\d+\^\]\[(\d+)\]/g, '<sup>[$1]</sup>')
      case 'image': return h('html', h('pre', text))
      case 'element': return h('markdown', this.render('markdown', text))
      case 'text':
      default: return text
    }
  }
}

namespace BingService {
  export interface Config {
    usingPuppeteer?: boolean
    cookies?: string
  }

  export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
      usingPuppeteer: Schema.boolean().default(false).description('是否使用puppeteer来获取cookies？'),
    }),
    Schema.union([
      Schema.object({
        usingPuppeteer: Schema.const(false),
        cookies: Schema.string().description('cookies').role('textarea'),
      }),
      Schema.object({}),
    ]),
  ])

  export const using = ['database', 'llm']
}

export default BingService
