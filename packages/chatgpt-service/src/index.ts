import { Conversation, LLMService, LLMConfig, Message, ConvOption, Action, isConv } from '@seidko/llm-core'
import { Context, Schema, Logger, SessionError, pick, Time } from 'koishi'
import { v4 as uuid, validate } from 'uuid'
import { CacheTable, Tables } from '@koishijs/cache'
import { Page } from 'koishi-plugin-puppeteer'

declare module '@koishijs/cache' {
  interface Tables {
    'chatgpt/cookies': string
    'chatgpt/conversations': Conversation
  }
}

declare module '@seidko/llm-core' {
  interface Conversation {
    title?: (messageId: string) => Promise<string>
  }
}

interface QuestionOptions {
  conversation?: Conversation
  prompt: string
  parent?: string
  action?: Action
  model?: string
}


interface ChatGptConversation extends Conversation { }

type SerializableConv = Pick<Conversation, 'id' | 'expire' | 'latestId' | 'model' | 'messages'>

class ChatGptConversation {
  protected service: ChatGptService
  constructor(conv: SerializableConv, service: ChatGptService) {
    this.id = conv.id
    this.service = service
    this.model = conv.model
    this.expire = conv.expire
    this.messages = conv.messages
    this.latestId = conv.latestId
    this[isConv] = true
  }

  fork(newConv: Conversation): Conversation {
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

  async retry(): Promise<Conversation> {
    const { parent, message: prompt } = this.messages[this.messages[this.latestId].parent]
    return await this.service.ask({ prompt, parent, conversation: this, action: 'variant' })
  }

  async continue(): Promise<Conversation> {
    const { parent, message: prompt } = this.messages[this.messages[this.latestId].parent]
    return await this.service.ask({ prompt, conversation: this, parent, action: 'continue' })
  }

  async edit(prompt: string): Promise<Conversation> {
    const { parent } = this.messages[this.messages[this.latestId].parent]
    return await this.service.ask({ prompt, conversation: this, parent, action: 'continue' })
  }

  async ask(prompt: string, parent?: string): Promise<Conversation> {
    return await this.service.ask({ conversation: this, prompt, parent })
  }

}

class ChatGptService extends LLMService {
  protected logger: Logger
  cookies: CacheTable<Tables['chatgpt/cookies']>
  conv: CacheTable<Tables['chatgpt/conversations']>
  page: Page

  constructor(protected ctx: Context, protected config: ChatGptService.Config) {
    super(ctx, 'llm')
    ctx.i18n.define('zh', require('./locales/zh-CN.yml'))
    this.logger = ctx.logger('chatgpt')
    this.cookies = ctx?.cache('chatgpt/cookies')
    this.conv = ctx?.cache('chatgpt/conversations')
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
    await this.page.waitForResponse('https://chat.openai.com/api/auth/session', { timeout: 10 * Time.minute })
    if (this.cookies) {
      const cookies = await this.page.cookies('https://chat.openai.com')
      sessionToken = cookies.find(c => c.name === '__Secure-next-auth.session-token')?.value
      if (!sessionToken) throw new Error('Can not get session token.')
      await this.cookies.set('session-token', sessionToken, 30 * Time.day)
    }
    this.logger.info('LLM service load successed.')
  }

  protected async stop(): Promise<void> {
    this.page?.close()
    this.page = undefined
  }

  async accessToken(): Promise<string> {
    let accessToken = await this.cookies?.get('access-token')
    if (!accessToken) {
      accessToken = await this.page.evaluate(() => {
        return fetch('https://chat.openai.com/api/auth/session')
          .then(r => r.json())
          .then(r => r.accessToken)
      })
      await this.cookies?.set('access-token', accessToken, Time.hour)
    }

    return accessToken
  }

  async ask(options: QuestionOptions): Promise<Conversation> {
    let { conversation, parent } = options
    const { action = 'next', model = 'text-davinci-002-render-sha', prompt } = options
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

    const gptMessageId: string = res.message.id

    if (!conversation?.[isConv]) conversation = new ChatGptConversation({
      id: res.conversation_id,
      messages: {},
      model,
      expire: conversation.expire
    }, this)

    conversation.latestId = gptMessageId
    conversation.messages[parent]?.children?.push(userMessageId)

    conversation.messages[userMessageId] = {
      id: userMessageId,
      role: 'user',
      message: prompt,
      parent,
      children: [res.message.id]
    }

    conversation.messages[gptMessageId] = {
      id: gptMessageId,
      message: res.message.content.parts[0],
      role: 'model',
      parent: userMessageId
    }

    if (this.conv) {
      const { id, expire } = conversation
      if (expire !== 0) await this.conv.set(id, conversation, expire && expire + Date.now())
    }

    return conversation
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

  async create(options?: ConvOption): Promise<Conversation> {
    let { expire = this.config.expire * Time.minute, initialPrompts: prompts = [''], model } = options ?? {}
    if (!Array.isArray(prompts)) prompts = [prompts]
    return prompts.reduce(async (previous, prompt) => this.ask({
      prompt,
      conversation: await previous,
      model,
    }), { model, expire } as unknown as Promise<Conversation>)
  }

  async query(id: string): Promise<Conversation> {
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

  export const using = ['puppeteer'] as const
}

export default ChatGptService
