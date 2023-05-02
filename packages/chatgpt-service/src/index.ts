import { Conversation, LLMService, Message, Instance, AskOptions } from '@seidko/koishi-plugin-gpt'
import type { CacheTable, Tables } from '@koishijs/cache'
import { Context, Schema, SessionError, pick, Time, h, Quester } from 'koishi'
import { v4 as uuid, validate } from 'uuid'
import type { Page } from 'koishi-plugin-puppeteer'

declare module '@koishijs/cache' {
  interface Tables {
    'chatgpt/cookies': string
  }
}

class ChatGPTService extends LLMService {
  constructor(ctx: Context, protected config: ChatGPTService.Config) {
    super(ctx, 'chatgpt')
  }
  async instance(): Promise<Instance> {
    // @ts-expect-error
    const cache: CacheTable<Tables['chatgpt/cookies']> = this.ctx.cache('chatgpt/cookies')

    const page = await this.ctx.puppeteer.page()
    let sessionToken = await cache.get('session-token')
    if (sessionToken) await page.setCookie({
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
    await page.evaluateOnNewDocument(`Object.defineProperties(navigator, { webdriver:{ get: () => false } })`)
    await page.goto('https://chat.openai.com/chat')
    await page.waitForResponse(r => {
      return r.url() === 'https://chat.openai.com/backend-api/accounts/check' && r.status() === 200
    }, { timeout: 10 * Time.minute })
    const cookies = await page.cookies('https://chat.openai.com')
    sessionToken = cookies.find(c => c.name === '__Secure-next-auth.session-token')?.value
    if (!sessionToken) throw new Error('Can not get session token.')
    await cache.set('session-token', sessionToken, 10 * Time.day)

    this.logger.info('ChatGPT service load successed.')

    return new ChatGPTInstance(this.ctx, page)
  }

  async accessToken(page: Page, refresh?: boolean): Promise<string> {
    // @ts-expect-error
    const cache: CacheTable<Tables['chatgpt/cookies']> = this.ctx.cache('chatgpt/cookies')

    let accessToken = await cache.get('access-token')
    if (!accessToken || refresh) {
      accessToken = await page.evaluate(() => {
        return fetch('https://chat.openai.com/api/auth/session')
          .then(r => r.json())
          .then(r => r.accessToken)
      })
      await cache?.set('access-token', accessToken, Time.minute * 5)
    }
    await page.evaluate(accessToken => {
      return fetch('https://chat.openai.com/backend-api/accounts/check', {
        headers: {
          accept: '*/*',
          authorization: `Bearer ${accessToken}`,
        }
      })
    }, accessToken)
    return accessToken
  }

  async ask(prompt: string, conv: Conversation, parent: string, action = 'next', page: Page) {
    const accessToken = await this.accessToken(page)
    const userMessageId = uuid()
    parent = parent || conv.latestId || uuid()

    const body = {
      action,
      conversation_id: conv.id,
      messages: [
        {
          id: userMessageId,
          author: {
            role: 'user'
          },
          content: {
            content_type: 'text',
            parts: [
              prompt,
            ]
          }
        }
      ],
      parent_message_id: parent,
      model: conv.model,
      timezone_offset_min: -480,
      history_and_training_disabled: false,
    }

    let res: any

    try {
      res = await page.evaluate((body, accessToken) => {
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
    } catch (e) {
      if (e.message.includes('429')) throw new SessionError('error.llm.too-many-requests')
      if (e.message.includes('401')) {
        await this.accessToken(page, true)
        return this.ask(prompt, conv, parent, action, page)
      }
      throw e
    }

    const gptMessageId: string = res.message.id

    if (!conv.id) conv.id = res.conversation_id

    conv.messages.push(userMessageId, gptMessageId)

    await this.saveConv(conv)

    const [parentMessage] = await this.ctx.database.get('gpt_messages', { id: parent })
    if (parentMessage) {
      parentMessage.children.push(userMessageId)
      await this.saveMsg(parentMessage, conv.id)
    }

    await this.saveMsg({
      id: userMessageId,
      role: 'user',
      message: prompt,
      parent,
      children: [res.message.id]
    }, conv.id)

    const gptMessage = {
      id: gptMessageId,
      message: res.message.content.parts[0],
      role: 'model' as const,
      parent: userMessageId,
      children: [],
    }

    this.saveMsg(gptMessage, conv.id)

    return gptMessage
  }

  async title(convId: string, messageId: string, page: Page): Promise<string> {
    const accessToken = await this.accessToken(page)
    if (!validate(messageId)) throw new Error('id is not an uuid.')
    return page.evaluate((messageId, accessToken) => {
      return fetch(`ttps://chat.openai.com/backend-api/conversation/gen_title/${convId}`, {
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


  async clear(id: string, page: Page): Promise<void> {
    await this.ctx.database.remove('gpt_conversaion', { id })
    await this.ctx.database.remove('gpt_messages', { conversationId: id })
    const accessToken = await this.accessToken(page)
    if (!validate(id)) throw new Error('id is not an uuid.')
    await page.evaluate(async (id, accessToken) => {
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

  create(model = 'text-davinci-002-render-sha'): Conversation {
    return {
      id: undefined,
      messages: [],
      model,
    }
  }
}

export class ChatGPTInstance extends Instance {
  constructor(ctx: Context, protected page: Page) {
    super(ctx, 'chatgpt')
  }

  async ask(options: AskOptions): Promise<Message> {
    const service = this.ctx.llm.get('chatgpt') as ChatGPTService
    const { prompt, conversationId, model, parent, action } = options
    let conv: Conversation

    if (conversationId) {
      conv = await this.queryConv(conversationId)
    } else if (parent) {
      const message = await this.queryMsg(parent)
      conv = await this.queryConv(message.conversationId)
    } else {
      conv = service.create(model)
    }

    return service.ask(prompt, conv, parent, action, this.page)
  }

  async title(convId: string, messageId: string): Promise<string> {
    const service = this.ctx.llm.get('bing') as ChatGPTService
    return service.title(convId, messageId, this.page)
  }

  render(type: 'text', text: string): string
  render(type: 'markdown', text: string): string
  render(type: 'element', text: string): h[]
  render(type: 'image', text: string): h
  render(type: 'text' | 'markdown' | 'element' | 'image', text: string): string | h | h[] {
    switch (type) {
      case 'image': return h('html', h('pre', text))
      case 'element': return h('markdown', text)
      case 'text':
      case 'markdown':
      default: return text
    }
  }
}

namespace ChatGPTService {
  export interface Config { }

  export const Config: Schema<Config> = Schema.object({})

  export const using = ['puppeteer', '__cache__', 'database']
}

export default ChatGPTService
