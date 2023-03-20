import { Conversation, GptService, GptConfig, Message } from '@seidko/gpt-core'
import { Context, Schema, Logger, SessionError, pick } from 'koishi'
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
    this.config.expire = this.config.expire * 60 * 1000
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

  protected async buildConv(conv: Conversation, message?: Message): Promise<Conversation> {
    const newConv: Conversation = Object.create(conv)
    if (conv[GptService.isConv]) {
      return Object.assign(newConv, message && { latestMessage: message })
    }

    newConv.ask = (prompt, parent) => this.ask(prompt, newConv, parent)
    newConv.clear = () => this.clear(newConv.id)
    newConv.retry = () => {
      const { parent, message } = newConv.messages[newConv.latestMessage.parent]
      return this.ask(message, newConv, parent, 'variant')
    }
    newConv.continue = () => {
      const { parent, message } = newConv.messages[newConv.latestMessage.parent]
      return this.ask(message, newConv, parent, 'continue')
    }
    newConv.edit = (prompt: string) => {
      const { parent } = newConv.messages[newConv.latestMessage.parent]
      return this.ask(prompt, newConv, parent, 'next')
    }

    newConv.toJSON = function() {
      return JSON.stringify(pick(this, ['id', 'latestMessage', 'messages']))
    }

    newConv[ChatGptService.isConv] = true

    return newConv
  }

  protected async deleteConv(id: string) {
    const accessToken = await this.accessToken()
    if (!validate(id)) throw new Error('id is not an uuid.')
    this.page.evaluate(async (id, accessToken) => {
      await fetch(`https://chat.openai.com/backend-api/conversation/${id}`, {
        method: 'PATCH',
        body: '{"is_visible":false}',
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        }
      })
    }, id, accessToken)
  }

  protected async accessToken(): Promise<string> {
    let accessToken = await this.cookies.get('access-token')
    if (!accessToken) {
      accessToken = await this.page.evaluate(() => {
        return fetch('https://chat.openai.com/api/auth/session')
          .then(r => r.json())
          .then(r => r.accessToken)
      })
      await this.cookies.set('access-token', accessToken, 60 * 60 * 1000)
    }

    return accessToken
  }

  protected async ask(
    prompt: string,
    conversation?: Conversation,
    parent?: string,
    action: ChatGptService.Action = 'next',
  ): Promise<Conversation> {
    const accessToken = await this.accessToken()
    const userMessageId = uuid()
    parent = parent || conversation?.latestMessage.id || uuid()

    const body = {
      action,
      conversation_id: conversation?.id,
      messages: [
        {
          id: userMessageId,
          author: {
            role: 'user'
          },
          role: 'user',
          content: {
            content_type: 'text',
            parts: [
              prompt,
            ]
          }
        }
      ],
      parent_message_id: parent,
      model: 'text-davinci-002-render-sha',
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
              } catch { }
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

    const gptMessage: Message = {
      id: res.message.id,
      message: res.message.content.parts[0],
      role: 'gpt',
      parent: userMessageId
    }

    const userMessage: Message = {
      id: userMessageId,
      role: 'user',
      message: prompt,
      parent,
      children: [res.message.id]
    }

    if (!conversation?.[ChatGptService.isConv]) conversation = {
      id: res.conversation_id,
      messages: {},
      latestMessage: gptMessage
    }

    conversation = await this.buildConv(conversation, gptMessage)
    conversation.messages[parent]?.children?.push(userMessageId)
    conversation.messages[userMessageId] = userMessage
    conversation.messages[res.message.id] = gptMessage
    
    await this.conv.set(conversation.id, conversation)
    return conversation
    
  }

  async clear(id: string): Promise<void> {
    await this.conv.delete(id)
    await this.deleteConv(id)
  }

  async create(initialPrompt = ''): Promise<Conversation> {
    return this.ask(initialPrompt)
  }

  async query(id: string): Promise<Conversation> {
    return this.buildConv(await this.conv.get(id))
  }
}

namespace ChatGptService {
  export type Action = 'next' | 'variant' | 'continue'

  export interface Config extends GptConfig { }

  export const Config: Schema<Config> = Schema.intersect([
    GptConfig,
  ])

  export const using = ['puppeteer', 'cache'] as const
}

export default ChatGptService
