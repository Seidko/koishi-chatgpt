import { Schema, Context } from 'koishi'
import {} from '@seidko/gpt-core'

export const using = ['gpt'] as const
export const name = 'chatgpt'
export interface Config {}
export const Config: Schema<Config> = Schema.object({})

export function apply(ctx: Context) {
  ctx.command('gpt <prompt>')
    .action(async ({ }, prompt) => {
      const { message } = await ctx.gpt.ask(prompt)
      return message
    })
}
