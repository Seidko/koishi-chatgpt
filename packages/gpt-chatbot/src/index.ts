import { Schema, Context } from 'koishi'
import { } from '@seidko/koishi-plugin-gpt'
import { CacheTable, Tables } from '@koishijs/cache'

declare module '@koishijs/cache' {
  interface Tables {
    'gpt-chatbot/conv': string
  }
}

export const using = ['llm', '__cache__'] as const
export const name = 'gpt-chatbot'

export interface Config {
  service: string
}
export const Config: Schema<Config> = Schema.object({
  service: Schema.string().description('服务名称').required()
})

export async function apply(ctx: Context, config: Config) {
  // @ts-expect-error
  const cache: CacheTable<Tables['gpt-chatbot/conv']> = ctx.cache('gpt-chatbot/conv')
  const instance = await ctx.llm.create(config.service)
  let model: string

  ctx.command('ai.chat <prompt:text>')
    .action(async ({ session }, prompt) => {
      const parent = await cache.get(session.uid)
      const msg = await instance.ask({ prompt, parent, model })
      await cache.set(session.uid, msg.id)
      return instance.render('element', msg.message)
    })

  ctx.command('ai.ask <prompt:text>')
    .action(async ({}, prompt) => {
      const msg = await instance.ask({ prompt , model })
      return instance.render('element', msg.message)
    })

  ctx.command('ai.model <model:string>')
    .action(async ({}, m) => {
      model = m
      return '模型设置成功！'
    })

  ctx.command('ai.clear')
    .action(async ({ session }) => {
      await cache.delete(session.uid)
      return '清理成功！'
    })
}
