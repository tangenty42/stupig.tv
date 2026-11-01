import type { Page } from '@playwright/test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { request } from '@playwright/test'
import { expect, it } from 'vitest'
import { content_mutation, content_query } from '../../tests/support/e2e-browser'

async function endpoint(reply: (attempt: number, request: IncomingMessage, response: ServerResponse) => void) {
  let calls = 0
  const server = createServer((request, response) => reply(++ calls, request, response))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const api = await request.newContext({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
  return { page: { request: api } as Page, calls: () => calls, close: async () => {
    await api.dispose()
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  } }
}

it('retries one reset connection for an idempotent persisted-state read', async () => {
  const fixture = await endpoint((attempt, request, response) => {
    if (attempt === 1)
      request.socket.destroy()
    else
      response.setHeader('content-type', 'application/json').end(JSON.stringify({ result: { data: { markdown: 'renamed reference' } } }))
  })
  try {
    expect(await content_query(fixture.page, 'getStoryBody', { id: 1 })).toEqual({ markdown: 'renamed reference' })
    expect(fixture.calls()).toBe(2)
  }
  finally { await fixture.close() }
})

it('keeps the network retry bounded when both read attempts reset', async () => {
  const fixture = await endpoint((_attempt, request) => request.socket.destroy())
  try {
    await expect(content_query(fixture.page, 'getStoryBody', { id: 1 })).rejects.toThrow('ECONNRESET')
    expect(fixture.calls()).toBe(2)
  }
  finally { await fixture.close() }
})

it('does not retry an HTTP failure from the application', async () => {
  const fixture = await endpoint((_attempt, _request, response) => response.writeHead(500).end())
  try {
    await expect(content_query(fixture.page, 'getStoryBody', { id: 1 })).rejects.toThrow()
    expect(fixture.calls()).toBe(1)
  }
  finally { await fixture.close() }
})

it('does not automatically replay a mutation after an unknown network result', async () => {
  const fixture = await endpoint((_attempt, request) => request.socket.destroy())
  try {
    await expect(content_mutation(fixture.page, 'executeWorkspaceCommand', { id: 1 })).rejects.toThrow('ECONNRESET')
    expect(fixture.calls()).toBe(1)
  }
  finally { await fixture.close() }
})
