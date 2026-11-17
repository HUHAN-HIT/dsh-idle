/** dsh-idle: an idle-time task scheduler for DeepSeek Harness. Queue goal-oriented tasks; they run autonomously in their own sessions whenever the host is idle. */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IdleScheduler, type IdleTaskConfig } from './scheduler.ts'

/** Minimal structural view of the cordis context this plugin needs (`inject: ['webServer', 'agents']`). */
interface DshCtx {
  readonly agents: import('./scheduler.ts').AgentsRegistry
  readonly webServer: {
    register(entry: { kind: 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }): () => void
  }
  /** Subscribes to host-wide agent events; optional so the plugin degrades gracefully without it. */
  on?(event: string, handler: (payload: unknown) => void): () => void
  effect?(fn: () => void, name?: string): void
}

export const name = 'dsh-idle'
export const inject = ['webServer', 'agents']

const DEFAULT_CONFIG: IdleTaskConfig = {
  checkSeconds: 30,
  quietMinutes: 10,
  maxConcurrent: 1,
  maxRuntimeMinutes: 120,
  maxPerDay: 3,
  enabled: true,
}

function readConfig(): IdleTaskConfig {
  const file = join(homedir(), '.dsh', 'plugins-data', 'dsh-idle', 'config.json')
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<IdleTaskConfig>
    return { ...DEFAULT_CONFIG, ...raw }
  } catch { return DEFAULT_CONFIG }
}

function json(res: unknown, status: number, body: unknown): void {
  const r = res as { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void }
  r.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  r.end(JSON.stringify(body))
}

export function apply(ctx: DshCtx): void {
  console.log(`[dsh-idle] apply: webServer=${String(ctx.webServer !== undefined)} agents=${String(ctx.agents !== undefined)} effect=${String(typeof ctx.effect === 'function')} on=${String(typeof ctx.on === 'function')}`)
  const scheduler = new IdleScheduler({
    agents: ctx.agents,
    onAgentEvent: (handler: (payload: { agent?: { id?: string }; status?: string; error?: unknown }, event: 'agent/status' | 'agent/error') => void, event?: 'agent/status' | 'agent/error') => {
      if (!ctx.on) return () => {}
      return ctx.on(event ?? 'agent/status', (payload: unknown) => handler(payload as { agent?: { id?: string } }, event ?? 'agent/status'))
    },
    dataDir: join(homedir(), '.dsh', 'plugins-data', 'dsh-idle'),
    config: readConfig,
    flush: async session => { const s = (ctx as { sessions?: { flush(x: unknown): Promise<boolean> } }).sessions; if (s) await s.flush(session) },
  })
  scheduler.start()

  const handler = (req: unknown, res: unknown): void => {
    const { method = 'GET', url = '/' } = req as { method?: string; url?: string }
    const path = url.split('?')[0]!
    const readBody = (cb: (body: { title?: string; prompt?: string; maxRuntimeMinutes?: number }) => void): void => {
      const r = req as { on(event: string, cb: (chunk: unknown) => void): void }
      let raw = ''
      r.on('data', chunk => { raw += String(chunk) })
      r.on('end', () => { try { cb(JSON.parse(raw || '{}')) } catch { cb({}) } })
    }
    if (path === '/idle/api/tasks' && method === 'GET') return void json(res, 200, scheduler.list())
    if (path === '/idle/api/tasks' && method === 'POST') {
      return void readBody(body => {
        if (!body.title || !body.prompt) return void json(res, 400, { error: 'title and prompt are required' })
        json(res, 201, scheduler.enqueue(String(body.title), String(body.prompt), body.maxRuntimeMinutes))
      })
    }
    const cancel = path.match(/^\/idle\/api\/tasks\/([\w-]+)\/cancel$/)
    if (cancel && method === 'POST') {
      const ok = scheduler.cancel(cancel[1]!)
      return void json(res, ok ? 200 : 404, { ok })
    }
    if (path === '/idle/api/health') return void json(res, 200, { state: 'ready', plugin: name, tasks: scheduler.list().length })
    json(res, 404, { error: 'unknown operation' })
  }

  ctx.effect?.(() => {
    console.log('[dsh-idle] registering /idle routes')
    ctx.webServer.register({ kind: 'prefix', path: '/idle', handler })
  }, 'dsh-idle: routes')
  console.log('[dsh-idle] apply done')
}
