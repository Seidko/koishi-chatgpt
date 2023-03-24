import { Schema, Context } from 'koishi'
import {} from '@seidko/gpt-core'
import {} from '@koishijs/cache'

declare module '@koishijs/cache' {
  interface Tables {
    'gpt-chatbot/conv': string
  }
}

export const using = ['gpt', 'cache'] as const
export const name = 'gpt-chatbot'
export interface Config {}
export const Config: Schema<Config> = Schema.object({})

export async function apply(ctx: Context) {
  const cache = ctx.cache('gpt-chatbot/conv')
  const convId = await cache.get('conversation-id')
  const conv = convId ? await ctx.gpt.query(convId) : await ctx.gpt.create()

  ctx.command('gpt.chat <prompt:text>')
    .action(async ({ session }, prompt) => {
      const { latestMessage: { message, id } } = await conv.ask(prompt, await cache.get(session.uid))
      await cache.set(session.uid, id)
      return message
    })

  ctx.command('gpt.ask <prompt:text>')
  .action((_, prompt) => conv.ask(prompt).then(a => a.latestMessage.message))

  ctx.command('gpt.clear')
  .action(async ({ session }) => {
    await cache.delete(session.uid)
  })
}
