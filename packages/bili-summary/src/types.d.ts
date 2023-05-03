export interface PageList {
  code: number
  data: {
    cid: number
    page: number
    part: string
  }[]
}

export interface Player {
  data: {
    subtitle: {
      subtitles: {
        lan: string
        subtitle_url: string
      }[]
    }
  }
}

export interface Subtitle {
  body: {
    content: string
  }[]
}
