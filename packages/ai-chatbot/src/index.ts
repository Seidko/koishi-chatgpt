import { Schema, Context } from 'koishi'
import { } from '@seidko/llm-core'
import { } from '@koishijs/cache'

declare module '@koishijs/cache' {
  interface Tables {
    'ai-chatbot/conv': string
  }
}

export const using = ['llm', 'cache'] as const
export const name = 'ai-chatbot'
export interface Config {
  initialPrompts: string[]
}
export const Config: Schema<Config> = Schema.object({
  initialPrompts: Schema.array(Schema.string().role('textarea'))
    .default([''])
    .description('初始化提示词，给你的机器人创造一个“人设”！')
})

export async function apply(ctx: Context, config: Config) {
  const cache = ctx.cache('ai-chatbot/conv')
  const convId = await cache.get('conversation-id')
  const { initialPrompts } = config
  let conv = convId ? await ctx.llm.query(convId) : await ctx.llm.create({ initialPrompts })

  ctx.command('ai.chat <prompt:text>')
    .action(async ({ session }, prompt) => {
      const newConv = await conv.ask(prompt, await cache.get(session.uid))
      const { id, message } = newConv.messages[newConv.latestId]
      await cache.set(session.uid, id)
      return message
    })

  ctx.command('ai.ask <prompt:text>')
    .action((_, prompt) => conv.ask(prompt).then(c => c.messages[c.latestId].message))

  ctx.command('ai.clear')
    .action(async ({ session }) => {
      await cache.delete(session.uid)
    })

  ctx.command('ai.clear-conv')
    .action(async () => {
      conv = await ctx.llm.create({ initialPrompts })
      await cache.set('conversation-id', conv.id)
    })
}
