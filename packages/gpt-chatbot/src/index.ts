import { Schema, Context } from 'koishi'
import { Conversation } from '@seidko/llm-core'
import { } from '@koishijs/cache'

declare module '@koishijs/cache' {
  interface Tables {
    'gpt-chatbot/conv': string
  }
}

export const using = ['llm', '__cache__'] as const
export const name = 'gpt-chatbot'

export interface Config {}
export const Config: Schema<Config> = Schema.object({})

export async function apply(ctx: Context, config: Config) {
  const cache = ctx.cache('gpt-chatbot/conv')
  const convId = await cache.get('conversation-id')
  let conv: Conversation

  ctx.command('ai.chat <prompt:text>')
    .action(async ({ session }, prompt) => {
      if (!conv) conv = convId ? await ctx.llm.query(convId) : await ctx.llm.create()

      const newConv = await conv.ask(prompt, await cache.get(session.uid))
      await cache.set(session.uid, newConv.latestId)
      return newConv.renderElement()
    })

  ctx.command('ai.ask <prompt:text>')
    .action(async ({}, prompt) => {
      if (!conv) conv = convId ? await ctx.llm.query(convId) : await ctx.llm.create()
      return conv.ask(prompt).then(c => c.renderElement())
    })

  ctx.command('ai.clear')
    .action(async ({ session }) => {
      await cache.delete(session.uid)
    })

  ctx.command('ai.clear-conv')
    .action(async () => {
      conv = await ctx.llm.create()
      await cache.set('conversation-id', conv.id)
    })
}
