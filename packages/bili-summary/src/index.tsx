import { Schema, Context, h } from 'koishi'
import { } from '@seidko/koishi-plugin-gpt'
import { PageList, Subtitle, Player } from './types'

export const using = ['llm'] as const
export const name = 'gpt-chatbot'

export interface Config {
  service: string
  session: string
}
export const Config: Schema<Config> = Schema.object({
  service: Schema.string().description('服务名称').required(),
  session: Schema.string().description('SESSDATA cookie').required(),
})

export async function apply(ctx: Context, config: Config) {
  const instance = await ctx.llm.create(config.service)
  let model: string
  const bvpatten = /(?<=BV)[a-z0-9]+?(?=[^a-z0-9]|$)/i
  const avpatten = /(?<=av)\d+?(?=\D|$)/i
  const http = ctx.http.extend({
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
      cookie: `SESSDATA=${config.session}`,
    }
  })

  ctx.command('bilisum <vid:string>')
    .action(async ({ session }, vid) => {
      let match: RegExpExecArray
      let pagelist: PageList
      let vidtype: 'bv' | 'av'
      if (match = bvpatten.exec(vid)) {
        pagelist = await http.get(`https://api.bilibili.com/x/player/pagelist?bvid=BV${match[0]}`)
        vidtype = 'bv'
        vid = match[0]
      } else if (match = avpatten.exec(vid)) {
        pagelist = await http.get(`https://api.bilibili.com/x/player/pagelist?aid=${match[0]}`)
        vidtype = 'av'
        vid = match[0]
      } else return '错误的视频ID'

      let cid: number
      if (pagelist.data.length > 1) {
        await session.send(<>
          <p>本视频有多个分p：</p>
          {pagelist.data.map(({ part }, i) => <p>{i}: {part}</p>)}
          <p>您要进行提取的分p是？（请输入前面的数字）</p>
        </>)
        const page = await session.prompt().then(p => +p)
        if (!pagelist.data[page]) return '错误的分p序号'
        cid = pagelist.data[page].cid
      } else cid = pagelist.data[0].cid

      let wbi: Player
      if (vidtype === 'av') {
        wbi = await http.get(`https://api.bilibili.com/x/player/wbi/v2?aid=${vid}&cid=${cid}`)
      } else if (vidtype === 'bv') {
        wbi = await http.get(`https://api.bilibili.com/x/player/wbi/v2?bvid=${vid}&cid=${cid}`)
      }
      const subtitles = wbi.data.subtitle.subtitles.map(v => ({ lang: v.lan, url: v.subtitle_url }))

      if (!subtitles.length) return '这个视频没有字幕'
      const joined = await http.get<Subtitle>(`https:${subtitles[0].url}`)
        .then(v => {
          let part: string[] = []
          let current = ''
          for (const { content } of v.body) {
            current += content + ' '
            if (current.length > 300) {
              part.push(current)
              current = ''
            }
          }
          if (current) part.push(current)
          return part
        })

      const messages: h[] = []
      let parent: string
      for (const i of joined) {
        const msg = await instance.ask({ prompt: `这是一个视频的字幕，请你根据这个字幕总结一下这个视频：${i}`, parent })
        messages.push(<message>{msg.message}</message>)
        parent = msg.id
      }

      return <message forward>{messages}</message>
    })
}
