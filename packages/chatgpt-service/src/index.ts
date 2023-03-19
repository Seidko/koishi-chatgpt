import { Answer, Conversation, GptService, PromptOptions } from '@seidko/gpt-core'
import { Context, Schema, Logger, SessionError } from 'koishi'
import { v4 as uuid, validate } from 'uuid'
import { Page } from 'puppeteer-core'
import { CacheTable, Tables } from '@koishijs/cache'
import { } from 'koishi-plugin-puppeteer'

declare module '@koishijs/cache' {
  interface Tables {
    'chatgpt/cookies': string
    'chatgpt/conversations': Conversation
  }
}

class ChatGptService extends GptService {
  protected page: Page
  protected logger: Logger
  protected cookies: CacheTable<Tables['chatgpt/cookies']>
  protected conv: CacheTable<Tables['chatgpt/conversations']>

  constructor(protected ctx: Context, protected config: ChatGptService.Config) {
    super(ctx, 'gpt')
    ctx.i18n.define('zh', require('./locales/zh-CN.yml'))
    this.logger = ctx.logger('gpt')
    this.cookies = ctx.cache('chatgpt/cookies')
    this.conv = ctx.cache('chatgpt/conversations')
  }

  protected async start(): Promise<void> {
    this.page = await this.ctx.puppeteer.page()
    let sessionToken = await this.cookies.get('session-token')
    if (sessionToken) await this.page.setCookie({
      name: '__Secure-next-auth.session-token',
      value: sessionToken,
      domain: 'chat.openai.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      sameParty: false,
      sourceScheme: 'Secure',
      sourcePort: 443,
    })
    await this.page.evaluateOnNewDocument(`Object.defineProperties(navigator, { webdriver:{ get: () => false } })`)
    await this.page.goto('https://chat.openai.com/chat')
    await this.page.waitForResponse('https://chat.openai.com/api/auth/session', { timeout: 10 * 60 * 1000 })
    const cookies = await this.page.cookies('https://chat.openai.com')
    sessionToken = cookies.find(c => c.name === '__Secure-next-auth.session-token')?.value
    if (!sessionToken) throw new Error('Can not get session token.')
    await this.cookies.set('session-token', sessionToken, 30 * 24 * 60 * 60 * 1000)
    this.logger.info('GPT service load successed.')
  }

  protected async stop(): Promise<void> {
    this.page?.close()
    this.page = undefined
  }

  async ask(prompt: string, options?: PromptOptions): Promise<Answer> {
    let accessToken = await this.cookies.get('access-token')
    if (!accessToken) {
      ({ accessToken } = await this.page.evaluate(() => {
        return fetch('https://chat.openai.com/api/auth/session').then(r => r.json())
      }))
      await this.cookies.set('access-token', accessToken, 60000)
    }

    let conversation_id: string
    let parent_message_id: string
    const promptId = uuid()
    if (options?.persistent) {
      if (validate(options?.id)) conversation_id = options.id
      parent_message_id = await this.conv.get(options?.id).then(c => c?.messages.at(-1).id)
    }

    const body = {
      action: "next",
      conversation_id,
      messages: [
        {
          id: promptId,
          author: {
            role: "user"
          },
          role: "user",
          content: {
            content_type: "text",
            parts: [
              prompt
            ]
          }
        }
      ],
      parent_message_id: parent_message_id || uuid(),
      model: "text-davinci-002-render-sha"
    }

    const res = await this.page.evaluate((body, accessToken) => {
      return new Promise(async (resolve: (value: string) => void, reject) => {
        const decoder = new TextDecoder()
        const res = await fetch('https://chat.openai.com/backend-api/conversation', {
          method: 'POST',
          body: body,
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'text/event-stream',
            'content-type': 'application/json',
          }
        })

        if (!res.ok) return reject(res.status)

        let data: any
        setTimeout(() => resolve(data), 2 * 60 * 1000)
        res.body.pipeTo(new WritableStream({
          write(chunk) {
            const chunks = decoder.decode(chunk).split('\n')
            console.log('Receiving...')
            for (const chunk of chunks) {
              if (!chunk) continue
              if (chunk.startsWith('data: [DONE]')) {
                console.log('Done.')
                return resolve(data)
              }
              try {
                const raw = chunk.replace('data: ', '')
                JSON.parse(raw)
                data = raw
              } catch {}
            }
            
          }
        }))
      })
    }, JSON.stringify(body), accessToken)
      .then(r => JSON.parse(r))
      .catch((e: Error) => {
        if (e.message.includes('429')) throw new SessionError('error.gpt.too-many-requests')
        throw e
      })

    const convId: string = res.conversation_id
    const message: string = res.message.content.parts[0]
    if (options?.persistent) {
      let conv = await this.conv.get(convId) || { messages: [] }
      conv.messages.push(
        { id: promptId, message: prompt, role: 'user' },
        { id: res.message.id, message, role: 'gpt' },
      )
      await this.conv.set(convId, conv)
    }

    return {
      id: convId,
      message,
      async clear() { },
    }
  }

  async clear(id: string): Promise<boolean> {
    return
  }

  async query(id: string): Promise<Conversation> {
    return
  }
}

namespace ChatGptService {
  export interface Config { }
  export const Config: Schema<Config> = Schema.object({})
  export const using = ['puppeteer', 'cache'] as const
}

export default ChatGptService
