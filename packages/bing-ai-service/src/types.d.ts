export interface Argument {
  arguments: {
    source: 'cib'
    optionsSets: string[]
    allowedMessageTypes: string[]
    sliceIds: string[]
    verbosity: 'verbose'
    traceId: string // changable
    isStartOfSession: boolean // changable
    message: {
      locale: string
      market: string
      region: string
      timestamp: string // changable
      author: 'user'
      inputMethod: 'Keyboard'
      text: string // changable
      messageType: 'Chat'
    }
    conversationSignature: string // changable
    participant: {
      id: string // changable
    }
    conversationId: string // changable
  }[]
  invocationId: string // changable
  target: 'chat'
  type: 4
}

export interface Response {
  type: 2
  invocationId: string
  item: {
    messages: Message[]
    firstNewMessageIndex: number
    conversationId: string
    requestId: string
    conversationExpiryTime: string
    shouldInitiateConversation: boolean
    telemetry: {
      metrics: unknown
      startTime: string
    }
    throttling: {
      maxNumUserMessagesInConversation: number
      numUserMessagesInConversation: number
    }
    result: {
      value: 'Success' | 'Forbidden' | 'UnauthorizedRequest'
      message: string
      serviceVersion: string
    }
  }
}

export interface Message {
  text: string
  hiddenText: string
  author: 'user' | 'bot'
  createAt: string
  timestamp: string
  messageId: string
  requestId: string
  messageType: 'InternalSearchQuery' | 'Suggestion' | 'RenderCardRequest' | 'InternalSearchResult' | 'InternalLoaderMessage'
  offense: 'None' | 'Unknown'
  adaptiveCards: {
    type: 'AdaptiveCard'
    version: '1.0'
    body: ({
      type: 'TextBlock'
      text: string
      warp: boolean
      size: 'small'
    } | {
      type: 'RichTextBlock'
      inlines: {
        type: 'TextRun'
        isSubtle: boolean
        italic: boolean
        text: string
      }[]
    })[]
  }[]
  sourceAttributions: {
    providerDisplayName: string
    seeMoreUrl: string
    imageLink: string
    imageWidth: string
    imageHeight: string
    imageFavicon: string
    searchQuery: string
  }[]
  feedback: {
    tag: unknown
    updateOn: unknown
    type: string
  }
  contentOrigin: 'DeepLeo'
  privacy: unknown
  suggestedResponses: Message[]
  spokenText: string
}[]
