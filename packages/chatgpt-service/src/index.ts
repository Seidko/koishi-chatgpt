import { Answer, Conversation, GptService, PromptOptions } from '@seidko/gpt-core'
import { Context, Schema, Logger } from 'koishi'
import { v4 as uuid } from 'uuid'
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
    this.logger = ctx.logger('gpt')
    this.cookies = ctx.cache('chatgpt/cookies')
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

    const body = {
      action: "next",
      messages: [
        {
          id: uuid(),
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
      parent_message_id: uuid(),
      model: "text-davinci-002-render-sha"
    }

    const res = await this.page.evaluate((body, accessToken) => {
      return new Promise(async (resolve: (value: string) => void) => {
        let data: string
        const decoder = new TextDecoder()
        const resp = await fetch('https://chat.openai.com/backend-api/conversation', {
          method: 'POST',
          body: body,
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'text/event-stream',
            'content-type': 'application/json',
          }
        })

        resp.body.pipeTo(new WritableStream({
          write(chunk) {
            const raw = decoder.decode(chunk)
            // console.log(raw, typeof raw)
            if (raw.startsWith('data: [DONE]')) resolve(data.replace('data: ', ''))
            data = raw
          }
        }))
      })
    }, JSON.stringify(body), accessToken).then(d => JSON.parse(d))

    const id: string = res.message.id
    const message: string = res.message.content.parts[0]
    if (options?.persistent) {
      const conv = await this.conv.get(res.message.conversation_id)
      conv.messages.push({ id, message, role: 'gpt' })
    }

    return {
      id, message,
      async clear() { },
    }
    // if (Quester.isAxiosError(err)) {
    //   switch (err.response?.status) {
    //     case 401:
    //       throw new SessionError('commands.chatgpt.messages.unauthorized')
    //     case 404:
    //       throw new SessionError('commands.chatgpt.messages.conversation-not-found')
    //     case 429:
    //       throw new SessionError('commands.chatgpt.messages.too-many-requests')
    //     case 500:
    //     case 503:
    //       throw new SessionError('commands.chatgpt.messages.service-unavailable', [err.response.status])
    //     default:
    //       throw err
    //   }
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
