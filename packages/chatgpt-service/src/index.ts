import { Conversation, LLMService, LLMConfig, ConvOption, isConv } from '@seidko/llm-core'
import { Context, Schema, SessionError, pick, Time } from 'koishi'
import { v4 as uuid, validate } from 'uuid'
import type { Page } from 'koishi-plugin-puppeteer'
import type { CacheTable, Tables } from '@koishijs/cache'

declare module '@koishijs/cache' {
  interface Tables {
    'chatgpt/cookies': string
  }
}

interface QuestionOptions {
  conversation: ChatGptConversation
  prompt: string
  parent?: string
  action?: 'next' | 'variant' | 'continue'
}


export interface ChatGptConversation extends Conversation {}

export class ChatGptConversation {
  protected service: ChatGptService
  constructor(conv: Partial<ChatGptConversation>, service: ChatGptService) {
    Object.assign(this, conv)
    this.messages ??= {}
    this.service = service
    this[isConv] = true
  }

  fork(newConv: Partial<ChatGptConversation>): ChatGptConversation {
    for (const k in newConv) {
      if (newConv[k] === undefined) delete newConv[k]
    }
    return Object.assign(Object.create(this), newConv)
  }

  toJSON() {
    return JSON.stringify(pick(this, ['id', 'expire', 'latestId', 'model', 'messages']))
  }

  async title(messageId: string): Promise<string> {
    const accessToken = await this.service.accessToken()
    if (!validate(messageId)) throw new Error('id is not an uuid.')
    return this.service.page.evaluate((messageId, accessToken) => {
      return fetch(`ttps://chat.openai.com/backend-api/conversation/gen_title/${this.id}`, {
        method: 'POST',
        body: `{"message_id":"${messageId}"}`,
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        }
      }).then(r => r.json())
        .then(r => r?.title)
    }, messageId, accessToken)
  }

  async clear(): Promise<void> {
    await this.service.clear(this.id)
  }

  async retry(): Promise<ChatGptConversation> {
    const { parent, message: prompt } = this.messages[this.messages[this.latestId].parent]
    return await this.service.ask({ prompt, parent, conversation: this, action: 'variant' })
  }

  async continue(): Promise<ChatGptConversation> {
    const { parent, message: prompt } = this.messages[this.messages[this.latestId].parent]
    return await this.service.ask({ prompt, conversation: this, parent, action: 'continue' })
  }

  async edit(prompt: string): Promise<ChatGptConversation> {
    const { parent } = this.messages[this.messages[this.latestId].parent]
    return await this.service.ask({ prompt, conversation: this, parent, action: 'continue' })
  }

  async ask(prompt: string, parent?: string): Promise<ChatGptConversation> {
    return await this.service.ask({ conversation: this, prompt, parent })
  }

}

class ChatGptService extends LLMService {
  cookies: CacheTable<Tables['chatgpt/cookies']>
  protected conv?: CacheTable<ChatGptConversation>
  page: Page

  constructor(public ctx: Context, public config: ChatGptService.Config) {
    super(ctx, 'chatgpt')
    this.cookies = ctx?.cache('chatgpt/cookies')
  }

  protected async start(): Promise<void> {
    this.page = await this.ctx.puppeteer.page()
    let sessionToken = await this.cookies?.get('session-token')
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
    await this.page.waitForResponse(r => {
      return r.url() === 'https://chat.openai.com/backend-api/accounts/check' && r.status() === 200
    }, { timeout: 10 * Time.minute })
    if (this.cookies) {
      const cookies = await this.page.cookies('https://chat.openai.com')
      sessionToken = cookies.find(c => c.name === '__Secure-next-auth.session-token')?.value
      if (!sessionToken) throw new Error('Can not get session token.')
      await this.cookies.set('session-token', sessionToken, 10 * Time.day)
    }
    this.logger.info('ChatGPT service load successed.')
  }

  protected async stop(): Promise<void> {
    this.page?.close()
    this.page = undefined
  }

  async accessToken(refresh?: boolean): Promise<string> {
    let accessToken = await this.cookies?.get('access-token')
    if (!accessToken || refresh) {
      accessToken = await this.page.evaluate(() => {
        return fetch('https://chat.openai.com/api/auth/session')
          .then(r => r.json())
          .then(r => r.accessToken)
      })
      await this.cookies?.set('access-token', accessToken, Time.minute * 5 )
    }
    await this.page.evaluate(accessToken => {
      return fetch('https://chat.openai.com/backend-api/accounts/check', {
        headers: {
          accept: '*/*',
          authorization: `Bearer ${accessToken}`,
        }
      })
    }, accessToken)
    return accessToken
  }

  async ask(options: QuestionOptions): Promise<ChatGptConversation> {
    let { conversation, parent } = options
    const { action = 'next', prompt } = options
    const { model = 'text-davinci-002-render-sha' } = conversation ?? {}
    const accessToken = await this.accessToken()
    const userMessageId = uuid()
    parent = parent || conversation?.latestId || uuid()

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
      model,
    }

    let res: any

    try {
      res = await this.page.evaluate((body, accessToken) => {
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
    } catch(e) {
      if (e.message.includes('429')) throw new SessionError('error.llm.too-many-requests')
      if (e.message.includes('401')) {
        await this.accessToken(true)
        return this.ask(options)
      }
        throw e
    }

    const gptMessageId: string = res.message.id

    if (!conversation.id) conversation.id = res.conversation_id

    const newConv = conversation.fork({ latestId: gptMessageId })

    newConv.messages[parent]?.children?.push(userMessageId)

    newConv.messages[userMessageId] = {
      id: userMessageId,
      role: 'user',
      message: prompt,
      parent,
      children: [res.message.id]
    }

    newConv.messages[gptMessageId] = {
      id: gptMessageId,
      message: res.message.content.parts[0],
      role: 'model',
      parent: userMessageId
    }

    if (this.conv) {
      const { id, expire } = newConv
      if (expire !== 0) await this.conv.set(id, newConv, expire && expire + Date.now())
    }

    return newConv
  }

  async clear(id: string): Promise<void> {
    await this.conv?.delete(id)
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

  async create(options?: ConvOption): Promise<ChatGptConversation> {
    let { expire = this.config.expire * Time.minute, model } = options ?? {}

    return new ChatGptConversation({ expire, model }, this)
  }

  async query(id: string): Promise<ChatGptConversation> {
    const conv = await this.conv?.get(id)
    if (!conv) return
    return new ChatGptConversation(conv, this)
  }
}

namespace ChatGptService {
  export interface Config extends LLMConfig { }

  export const Config: Schema<Config> = Schema.intersect([
    LLMConfig,
  ])

  export const name = 'chatgpt-service'

  export const using = ['puppeteer']
}

export default ChatGptService
