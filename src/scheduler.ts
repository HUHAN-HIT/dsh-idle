/**
 * The idle-time scheduler core: a queue of goal-oriented tasks that dispatch into their own
 * harness sessions whenever the host is idle — the off-peak "watchdog" pattern.
 *
 * Semantics:
 * - **Person priority**: dispatching requires the host to be quiet — no non-idle agent activity
 *   within `quietMinutes`. A dispatched idle session runs to completion even if a person then
 *   starts working (sessions are independent); only NEW dispatches wait for quiet.
 * - **Self-terminating tasks**: the prompt is the task's contract ("iterate until the acceptance
 *   gate passes, then stop"). A task ends when its session goes idle, on session error, or at the
 *   `maxRuntimeMinutes` hard stop — whichever comes first.
 * - **Budget**: at most `maxConcurrent` running idle sessions and `maxPerDay` dispatches per
 *   calendar day. Budget-exhausted tasks stay queued until the next day.
 * - State persists to `tasks.json` (mesh-style plugins-data dir); a host restart re-queues tasks
 *   that were mid-run, so goal tasks survive restarts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Minimal structural view of the harness agents registry (`ctx.agents`), as used by dsh-collab. */
export interface AgentsRegistry {
  create(spec: { sessionId: string; cwd?: string; meta?: Record<string, unknown> }): Promise<{
    agent: {
      id: string
      followup(text: string): unknown
      cancel?(...args: unknown[]): unknown
      on(event: string, handler: (payload: unknown) => void): () => void
    }
    dispose?(): Promise<void>
  }>
  get?(id: string): { status?: string } | undefined
}

export interface IdleTaskConfig {
  /** Seconds between host-idle checks. */
  checkSeconds: number
  /** A person counts as active for this many minutes after their last agent event. */
  quietMinutes: number
  /** At most this many idle sessions running at once. */
  maxConcurrent: number
  /** Hard runtime stop per task, in minutes. */
  maxRuntimeMinutes: number
  /** At most this many dispatches per calendar day. */
  maxPerDay: number
  /** Master switch. */
  enabled: boolean
}

export type IdleTaskState = 'queued' | 'running' | 'done' | 'failed' | 'stopped'

export interface IdleTask {
  id: string
  title: string
  prompt: string
  state: IdleTaskState
  createdAt: string
  startedAt?: string
  endedAt?: string
  sessionId?: string
  doneReason?: string
  lastError?: string
  /** Per-task runtime override; defaults to the config's `maxRuntimeMinutes`. */
  maxRuntimeMinutes?: number
  /** Iterations completed, for multi-round goal tasks re-enqueued by an operator. */
  round: number
}

export interface IdleSchedulerHost {
  readonly agents: AgentsRegistry
  /** Subscribes to host-wide agent events (`agent/status`, `agent/error`) for person-activity detection. */
  readonly onAgentEvent: (handler: (payload: { agent?: { id?: string } }) => void) => () => void
  readonly dataDir: string
  readonly config: () => IdleTaskConfig
  /** Injectable clock, so tests can drive quiet windows deterministically. */
  readonly now?: () => number
}

const IDLE_PREFIX = 'idle-'

export class IdleScheduler {
  private readonly tasks = new Map<string, IdleTask>()
  private readonly sessions = new Map<string, { taskId: string; startedAt: number; timer?: ReturnType<typeof setTimeout>; offs: (() => void)[] }>()
  /** Last host-wide agent activity not caused by one of our own idle sessions. */
  private lastPersonActivityAt!: number
  private readonly disposers: (() => void)[] = []
  private timer?: ReturnType<typeof setInterval>
  private loaded = false
  private readonly now: () => number

  constructor(private readonly host: IdleSchedulerHost) {
    this.now = host.now ?? (() => Date.now())
    this.lastPersonActivityAt = this.now()
    this.load()
    // Person-activity detection: any agent event whose id is not one of our dispatched sessions.
    this.disposers.push(this.host.onAgentEvent(payload => {
      const id = payload.agent?.id
      if (id && !this.sessions.has(id)) this.lastPersonActivityAt = this.now()
    }))
  }

  /** Loads persisted tasks; tasks that were mid-run when the host stopped re-enter the queue. */
  private load(): void {
    const file = path.join(this.host.dataDir, 'tasks.json')
    let records: IdleTask[] = []
    try { records = JSON.parse(fs.readFileSync(file, 'utf8')) as IdleTask[] } catch { /* first run */ }
    for (const task of records) {
      if (task.state === 'running') task.state = 'queued' // the session died with the host; the goal survives
      this.tasks.set(task.id, task)
    }
    this.loaded = true
  }

  private save(): void {
    if (!this.loaded) return
    fs.mkdirSync(this.host.dataDir, { recursive: true })
    fs.writeFileSync(path.join(this.host.dataDir, 'tasks.json'), JSON.stringify([...this.tasks.values()], null, 2))
  }

  start(): void {
    this.timer = setInterval(() => {
      try { this.tick() } catch { /* a tick failure must never kill the host's interval */ }
    }, this.host.config().checkSeconds * 1000)
    this.timer.unref?.()
  }

  dispose(): void {
    clearInterval(this.timer)
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const [, live] of this.sessions) for (const off of live.offs) off()
  }

  /** Enqueues a goal-oriented task. The prompt must be self-contained and self-terminating. */
  enqueue(title: string, prompt: string, maxRuntimeMinutes?: number): IdleTask {
    const task: IdleTask = {
      id: randomUUID().slice(0, 8),
      title: title.slice(0, 200),
      prompt: prompt.slice(0, 20_000),
      state: 'queued',
      createdAt: new Date().toISOString(),
      round: 1,
    }
    this.tasks.set(task.id, task)
    if (maxRuntimeMinutes) task.maxRuntimeMinutes = maxRuntimeMinutes
    this.save()
    return task
  }

  cancel(id: string, reason = 'cancelled by operator'): boolean {
    const task = this.tasks.get(id)
    if (!task) return false
    const live = task.sessionId ? this.sessions.get(task.sessionId) : undefined
    if (live) {
      const agent = this.liveAgent(task.sessionId!)
      try { agent?.cancel?.({ kind: 'user' }, { keepInbox: true }) } catch { /* already gone */ }
      this.endSession(task.sessionId!)
    }
    task.state = 'stopped'
    task.doneReason = reason
    task.endedAt = new Date().toISOString()
    this.save()
    return true
  }

  list(): IdleTask[] { return [...this.tasks.values()].sort((a, b) => a.createdAt < b.createdAt ? 1 : -1) }
  status(id: string): IdleTask | undefined { return this.tasks.get(id) }

  /** One scheduling pass; `now` injectable for tests. */
  tick(now = this.now()): void {
    const config = this.host.config()
    if (!config.enabled) return
    this.enforceRuntimeCaps(now, config)
    const running = [...this.sessions.values()]
    if (running.length >= config.maxConcurrent) return
    const personActive = now - this.lastPersonActivityAt < config.quietMinutes * 60_000
    if (personActive) return
    const today = new Date(now).toISOString().slice(0, 10)
    const dispatchedToday = [...this.tasks.values()]
      .filter(task => (task.startedAt ?? '').slice(0, 10) === today).length
    if (dispatchedToday >= config.maxPerDay) return
    const next = [...this.tasks.values()]
      .filter(task => task.state === 'queued')
      .sort((a, b) => a.createdAt < b.createdAt ? -1 : 1)[0]
    if (next) void this.dispatch(next, now)
  }

  private async dispatch(task: IdleTask, now: number): Promise<void> {
    task.state = 'running'
    task.startedAt = new Date(now).toISOString()
    const sessionId = `${IDLE_PREFIX}${task.id}-${task.round}`
    task.sessionId = sessionId
    this.save()
    try {
      const handle = await this.host.agents.create({
        sessionId,
        cwd: process.cwd(),
        // The harness core validates the session header and only accepts origin "subagent" for
        // sessions created through the agents registry (mesh's dispatcher carries the same marker).
        meta: { origin: 'subagent', idleTask: task.id, title: task.title },
      })
      const live: { taskId: string; startedAt: number; timer?: ReturnType<typeof setTimeout>; offs: (() => void)[] } = { taskId: task.id, startedAt: now, offs: [] }
      this.sessions.set(sessionId, live)
      const agent = handle.agent
      const config = this.host.config()
      const runtimeCap = task.maxRuntimeMinutes ?? config.maxRuntimeMinutes
      live.offs.push(agent.on('agent/status', payload => {
        const status = (payload as { status?: string })?.status
        if (status !== 'idle') return
        task.state = 'done'
        task.doneReason = `session completed (round ${task.round})`
        task.endedAt = new Date().toISOString()
        this.endSession(sessionId)
        this.save()
      }))
      live.offs.push(agent.on('agent/error', payload => {
        task.state = 'failed'
        task.lastError = String((payload as { error?: unknown })?.error ?? 'unknown').slice(0, 300)
        task.endedAt = new Date().toISOString()
        this.endSession(sessionId)
        this.save()
      }))
      live.timer = setTimeout(() => {
        try { agent.cancel?.({ kind: 'user' }, { keepInbox: true }) } catch { /* already gone */ }
        task.state = 'stopped'
        task.doneReason = `hard stop after ${runtimeCap} minutes`
        task.endedAt = new Date().toISOString()
        this.endSession(sessionId)
        this.save()
      }, runtimeCap * 60_000)
      live.timer.unref?.()
      void agent.followup(task.prompt)
    } catch (error) {
      task.state = 'failed'
      task.lastError = String(error instanceof Error ? error.message : error).slice(0, 300)
      task.endedAt = new Date().toISOString()
      this.save()
    }
  }

  private enforceRuntimeCaps(now: number, config: IdleTaskConfig): void {
    for (const [sessionId, live] of this.sessions) {
      if (now - live.startedAt >= config.maxRuntimeMinutes * 60_000) {
        const task = this.tasks.get(live.taskId)
        const agent = this.liveAgent(sessionId)
        try { agent?.cancel?.({ kind: 'user' }, { keepInbox: true }) } catch { /* already gone */ }
        if (task) {
          task.state = 'stopped'
          task.doneReason = `hard stop after ${config.maxRuntimeMinutes} minutes`
          task.endedAt = new Date().toISOString()
        }
        this.endSession(sessionId)
        this.save()
      }
    }
  }

  private endSession(sessionId: string): void {
    const live = this.sessions.get(sessionId)
    if (!live) return
    if (live.timer) clearTimeout(live.timer)
    for (const off of live.offs) off()
    this.sessions.delete(sessionId)
  }

  private liveAgent(sessionId: string): { cancel?(...args: unknown[]): unknown } | undefined {
    return (this.host.agents as unknown as { get?: (id: string) => { cancel?(...args: unknown[]): unknown } | undefined }).get?.(sessionId)
  }

  /** Test seam: the person-activity clock, for driving quiet windows deterministically. */
  personQuietFor(now: number): number { return now - this.lastPersonActivityAt }
}
