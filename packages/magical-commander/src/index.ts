import { Schema, Context, segment } from 'koishi'
import { } from '@seidko/gpt-core'
import { } from '@koishijs/cache'

export const using = ['gpt'] as const
export const name = 'magical-commander'
export interface Config {
  commands: string[]
}
export const Config: Schema<Config> = Schema.object({
  commands: Schema.array(Schema.string().role('textarea')).description('各指令的说明，将会提供给AI。').default([
    '`help [command:string]` 具有参数`[command:string]`，使用介绍：`你是谁？`、`这是什么？`、`怎么使用？`、`帮助`、`这机器人怎么用啊？`返回`help`，`novelai怎么用？` 返回用户 `help novelai`，注意事项：**如果用户需要帮助，应当返回此指令**'
  ])
})

export async function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh', require('./locales/zh-CN'))

  const conv = await ctx.gpt.create({
    initialPrompts: segment.unescape(ctx.i18n.text('zh', ['magical-commander.initial-prompt'], [config.commands.join('\n')]))
  })

  ctx.middleware(async (session, next) => {
    if (!session.content.startsWith('！')) return next()
    const { latestMessage: { message } } = await conv.ask(segment.unescape(
      ctx.i18n.text('zh', ['magical-commander.using-prompt'], [session.content])
    ))
    const command = message.match(/`(.*)`/)?.[1] ?? message
    await session.execute(command)
  })
}
