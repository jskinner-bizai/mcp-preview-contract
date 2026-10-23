import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/** Attempt both resources even when either close method throws synchronously. */
export async function closeConnections(client, server) {
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => client.close()),
    Promise.resolve().then(() => server.close()),
  ]);
  const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
  if (failures.length) throw new AggregateError(failures, 'Fixture connection cleanup failed');
}

/** Real SDK wire protocol, isolated inside this process; no sockets or profiles. */
export async function connectFixture(name, register) {
  const server = new McpServer({ name, version: '0.1.0' });
  register(server);
  const client = new Client({ name: 'preview-contract-example-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  } catch (connectionError) {
    try { await closeConnections(client, server); }
    catch (cleanupError) {
      throw new AggregateError([connectionError, cleanupError], 'Fixture connection and cleanup failed');
    }
    throw connectionError;
  }
  return { client, close: () => closeConnections(client, server) };
}

export function response(data, rejected = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    ...(rejected ? { isError: true } : {}),
  };
}

export function structured(result) {
  if (!result || typeof result !== 'object' || !result.structuredContent
      || typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent)) {
    throw new TypeError('Example response has no structured object');
  }
  return result.structuredContent;
}

export function preview(token, plan) {
  if (typeof token !== 'string' || !Array.isArray(plan)) throw new TypeError('Example preview is malformed');
  return { token, plan };
}

export const pause = () => new Promise(resolve => setTimeout(resolve, 5));
