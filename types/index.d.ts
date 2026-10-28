// approval: a permission prompt is open; question: AskUserQuestion or a plan
// to approve; waiting: the turn ended asking you something; idle: done.
export type Status = 'working' | 'approval' | 'question' | 'waiting' | 'idle'

export type PlanItem = { content: string; status: string }

export type Peer = {
  id: string
  hostId?: string
  title?: string
  cwd: string
  status: Status
  need?: string
  firstAsk?: string
  task?: string
  recap?: string
  plan: PlanItem[]
  files: Array<{ path: string; at: number }>
  since: number
  beat: number
  isEnded?: boolean
}

export type Clash = {
  key: string
  a: string
  b: string
  kind: 'files' | 'task' | 'folder'
  detail: string
}

declare module 'claude-code' {
  interface PluginState {
    'multi-sessions': {
      me: Peer | null
      peers: Peer[]
      isOpen: boolean
      dismissed: string[]
    }
  }
}
