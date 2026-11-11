import { cancelled } from './api';
import type { RunEvent } from './types';

// POST streaming needs fetch, since EventSource cannot send the request body.
export async function consumeSse(response: Response, signal: AbortSignal, onEvent: (name: string, data: RunEvent) => void) {
  if (!response.body) throw new Error('服务器没有返回对话内容');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const dispatch = (raw: string) => {
    if (signal.aborted) throw cancelled();
    const lines = raw.split(/\r?\n/);
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || 'message';
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data) onEvent(event, JSON.parse(data) as RunEvent);
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw cancelled();
      const { done, value } = await reader.read();
      if (signal.aborted) throw cancelled();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        dispatch(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (done) { if (buffer.trim()) dispatch(buffer); break; }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
