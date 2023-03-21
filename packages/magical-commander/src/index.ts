import { Schema, Context } from 'koishi'
import { } from '@seidko/gpt-core'
import { } from '@koishijs/cache'

export const using = ['gpt'] as const
export const name = 'chatgpt'
export interface Config { }
export const Config: Schema<Config> = Schema.object({})

export async function apply(ctx: Context) {
  ctx.i18n.define('zh', require('./locales/zh-CN'))

  const conv = await ctx.gpt.create(ctx.i18n.text('zh', ['magical-commander.initial-prompt'], [`
  help 显示机器人帮助。
  rryth <prompt:text> 指令别名：”AI绘画，人人有图画“，具有参数 prompt:text，为贪婪匹配的文本类型，你需要将可能的参数翻译为英语，然后替换掉<prompt:text>并返回。例如：“AI绘画1girl”，返回“rryth 1girl”。“帮我画一个女孩”，返回“rryth 1girl”
  `]))

  ctx.middleware(async (session, next) => {
    const { latestMessage: { message } } = await conv.ask(session.elements.toString())
    if (message === 'none') return next()
    return session.execute(message, next)
  })
}
