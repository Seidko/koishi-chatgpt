import { Schema, Context } from 'koishi'
import { PromptOptions } from '@seidko/gpt-core'
import {} from '@koishijs/cache'

declare module '@koishijs/cache' {
  interface Tables {
    'gpt-chatbot/conv': string
  }
}

export const using = ['gpt', 'cache'] as const
export const name = 'chatgpt'
export interface Config {}
export const Config: Schema<Config> = Schema.object({})

export function apply(ctx: Context) {
  const conv = ctx.cache('gpt-chatbot/conv')

  ctx.command('gpt.chat <prompt:text>')
    .action(async ({ session }, prompt) => {
      const { message, id } = await ctx.gpt.ask(prompt, {
        persistent: true,
        id: await conv.get(session.uid)
      })

      await conv.set(session.uid, id)
      return message
    })

  ctx.command('gpt.ask <prompt:text>')
  .action((_, prompt) => ctx.gpt.ask(prompt).then(a => a.message))

  ctx.command('gpt.clear')
  .action(async ({ session }) => {
    await ctx.gpt.clear(await conv.get(session.uid))
    await conv.delete(session.uid)
  })
}
