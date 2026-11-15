import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IdleScheduler, type IdleTaskConfig } from '../src/scheduler.ts'

const MIN = 60_000
const NOW = Date.UTC(2026, 11, 16, 1, 0, 0)

/** A fake agents registry + controllable clock: person activity and dispatched sessions are driven by hand. */
function host(config: Partial<IdleTaskConfig> = {}, dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-idle-'))) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const ctxHandlers = new Map<string, Set<(p: unknown) => void>>()
  const fullConfig: IdleTaskConfig = {
    checkSeconds: 30, quietMinutes: 10, maxConcurrent: 1, maxRuntimeMinutes: 120, maxPerDay: 3, enabled: true, ...config,
  }
  const created: { id: string; followup: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }[] = []
  const agents = {
    create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      const on = (event: string, cb: (p: unknown) => void) => {
        (listeners.get(`${sessionId}:${event}`) ?? listeners.set(`${sessionId}:${event}`, new Set()).get(`${sessionId}:${event}`)!).add(cb)
        return () => listeners.get(`${sessionId}:${event}`)?.delete(cb)
      }
      const agent = { id: sessionId, followup: vi.fn(), cancel: vi.fn(), on }
      created.push(agent)
      return { agent, dispose: async () => {} }
    }),
    get: (id: string) => created.find(a => a.id === id) as never,
  }
  let clock = NOW
  const scheduler = new IdleScheduler({
    agents: agents as never,
    now: () => clock,
    onAgentEvent: cb => {
      (ctxHandlers.get('agent/status') ?? ctxHandlers.set('agent/status', new Set()).get('agent/status')!).add(cb as never)
      return () => ctxHandlers.get('agent/status')?.delete(cb as never)
    },
    dataDir,
    config: () => fullConfig,
  })
  /** A person agent emits activity at the given clock moment (default: now). */
  const personAct = (at = clock): void => { clock = at; for (const cb of ctxHandlers.get('agent/status') ?? []) cb({ agent: { id: 'person-session' } }) }
  const advanceTo = (at: number): void => { clock = at }
  const tick = (): void => scheduler.tick(clock)
  /** The dispatched idle session's own status stream goes idle (the model finished its goal). */
  const finish = (sessionId: string): void => { for (const cb of listeners.get(`${sessionId}:agent/status`) ?? []) cb({ status: 'idle' }) }
  const fail = (sessionId: string, message: string): void => { for (const cb of listeners.get(`${sessionId}:agent/error`) ?? []) cb({ error: message }) }
  return { scheduler, agents, created, personAct, advanceTo, tick, finish, fail, dataDir, config: fullConfig }
}

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

describe('the idle scheduler', () => {
  it('does not dispatch while a person is active, then dispatches after the quiet window', async () => {
    const h = host()
    h.personAct(NOW)  // person active right now
    h.scheduler.enqueue('polish the docs', 'iterate until the docs are consistent')
    h.advanceTo(NOW + 5 * MIN)
    h.tick(); await flush()
    expect(h.agents.create).not.toHaveBeenCalled()  // inside the quiet window
    h.advanceTo(NOW + 11 * MIN)
    h.tick(); await flush()
    expect(h.agents.create).toHaveBeenCalledTimes(1)
    expect(h.agents.create.mock.calls[0]![0].sessionId).toMatch(/^idle-/)
    expect(h.scheduler.list()[0]!.state).toBe('running')
  })

  it('a finished idle session completes the task', async () => {
    const h = host()
    h.scheduler.enqueue('polish the docs', 'do the thing')
    h.advanceTo(NOW + 11 * MIN)
    h.tick(); await flush()
    h.finish(h.created[0]!.id)
    await flush()
    const task = h.scheduler.list()[0]!
    expect(task.state).toBe('done')
    expect(task.doneReason).toContain('session completed')
  })

  it('a session error fails the task with the error text', async () => {
    const h = host()
    h.scheduler.enqueue('polish', 'do it')
    h.advanceTo(NOW + 11 * MIN)
    h.tick(); await flush()
    h.fail(h.created[0]!.id, 'model exploded')
    await flush()
    const task = h.scheduler.list()[0]!
    expect(task.state).toBe('failed')
    expect(task.lastError).toContain('model exploded')
  })

  it('enforces the concurrent cap: the second task waits until the first finishes', async () => {
    const h = host({ maxConcurrent: 1 })
    h.scheduler.enqueue('task a', 'a')
    h.scheduler.enqueue('task b', 'b')
    h.advanceTo(NOW + 11 * MIN)
    h.tick(); await flush()
    expect(h.agents.create).toHaveBeenCalledTimes(1)
    h.advanceTo(NOW + 12 * MIN)
    h.tick(); await flush()
    expect(h.agents.create).toHaveBeenCalledTimes(1)
    h.finish(h.created[0]!.id)
    await flush()
    h.advanceTo(NOW + 13 * MIN)
    h.tick(); await flush()
    expect(h.agents.create).toHaveBeenCalledTimes(2)
  })

  it('enforces the daily budget: exhausted tasks stay queued until the next day', async () => {
    const h = host({ maxPerDay: 1 })
    h.scheduler.enqueue('task a', 'a')
    h.advanceTo(NOW + 11 * MIN)
    h.tick(); await flush()
    h.finish(h.created[0]!.id)
    await flush()
    h.scheduler.enqueue('task b', 'b')
    h.advanceTo(NOW + 20 * MIN)
    h.tick(); await flush()
    expect(h.agents.create).toHaveBeenCalledTimes(1)  // same calendar day as task a's start
    h.advanceTo(Date.UTC(2026, 11, 17, 1, 0))  // next day
    h.tick(); await flush()
    expect(h.agents.create).toHaveBeenCalledTimes(2)
  })

  it('hard-stops a task at its runtime cap', async () => {
    const h = host({ maxRuntimeMinutes: 30 })
    h.scheduler.enqueue('long haul', 'keep going forever')
    h.advanceTo(NOW + 11 * MIN)
    h.tick(); await flush()
    h.advanceTo(NOW + 45 * MIN)  // 34 min past dispatch: over the 30-minute cap
    h.tick(); await flush()
    const task = h.scheduler.list()[0]!
    expect(task.state).toBe('stopped')
    expect(task.doneReason).toContain('hard stop after 30 minutes')
    expect(h.created[0]!.cancel).toHaveBeenCalled()
  })

  it('re-queues tasks that were mid-run when the host stopped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-idle-'))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify([
      { id: 'abc12345', title: 'goal', prompt: 'iterate', state: 'running', createdAt: '2026-11-16T01:00:00Z', round: 1 },
    ]))
    const h = host({}, dir)
    const task = h.scheduler.list()[0]!
    expect(task.id).toBe('abc12345')
    expect(task.state).toBe('queued')  // re-queued, not stuck running forever
    // and it dispatches again on the next idle pass
    h.advanceTo(NOW + 11 * MIN)
    h.tick(); await flush()
    expect(h.created.length).toBe(1)
  })

  it('does nothing while disabled', async () => {
    const h = host({ enabled: false })
    h.scheduler.enqueue('task', 'x')
    h.advanceTo(NOW + 11 * MIN)
    h.tick(); await flush()
    expect(h.agents.create).not.toHaveBeenCalled()
  })

  it('does not count its own dispatched sessions as person activity', async () => {
    const h = host({ maxConcurrent: 2 })
    h.scheduler.enqueue('task a', 'a')
    h.scheduler.enqueue('task b', 'b')
    h.personAct(NOW)
    h.advanceTo(NOW + 11 * MIN)
    h.tick(); await flush()  // quiet: task 1 dispatches (its own events must not refresh the person clock)
    h.advanceTo(NOW + 13 * MIN)
    h.tick(); await flush()
    expect(h.created.length).toBe(2)  // both tasks ran even though only one person act ever happened
  })
})
