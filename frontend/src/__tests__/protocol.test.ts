// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api';
import { Session } from '../session';
import { consumeSse } from '../sse';
import { renderMarkdown } from '../markdown';

afterEach(() => vi.unstubAllGlobals());
const user = { user_id: 'alice', username: 'alice', access_level: 2, is_admin: false };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe('session and API isolation', () => {
  it('restores a cookie session without requesting other users', async () => {
    const fetcher = vi.fn(async () => json(user)); vi.stubGlobal('fetch', fetcher);
    const session = new Session(); await session.restore();
    expect(session.getSnapshot().user).toEqual(user);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/v1/auth/me', expect.objectContaining({ credentials: 'same-origin' }));
  });
  it('401 during startup unlocks login without an error', async () => {
    vi.stubGlobal('fetch', async () => json({}, 401));
    const session = new Session(); await session.restore();
    expect(session.getSnapshot()).toMatchObject({ user: null, checking: false, error: '' });
  });
  it('submits the exact password, trims the username, and keeps only user metadata', async () => {
    const fetcher = vi.fn(async (_path: string, _options?: RequestInit) => json({ user, access_token: 'never-store' })); vi.stubGlobal('fetch', fetcher);
    const session = new Session(); session.signOut(); await session.login(' alice ', '  exact password  ');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ username: 'alice', password: '  exact password  ' });
    expect(JSON.stringify(session.getSnapshot())).not.toContain('never-store');
  });
  it('retains the credential error without requesting workspace data', async () => {
    const fetcher = vi.fn(async () => json({ error: { message: '账号或密码错误' } }, 401)); vi.stubGlobal('fetch', fetcher);
    const session = new Session(); session.signOut(); await session.login('alice', 'bad');
    expect(session.getSnapshot()).toMatchObject({ user: null, busy: false, error: '账号或密码错误' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('logout clears identity, and a network failure allows retry', async () => {
    vi.stubGlobal('fetch', async () => json(user));
    const session = new Session(); await session.restore();
    vi.stubGlobal('fetch', async () => { throw new Error('网络异常'); });
    await session.logout();
    expect(session.getSnapshot()).toMatchObject({ user, loggingOut: false, error: '退出失败：网络异常' });
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 })); await session.logout();
    expect(session.getSnapshot().user).toBeNull();
  });
  it.each([200, 401])('discards old headers (HTTP %s) without logging out the next user', async status => {
    const pending = deferred<Response>(); const unauthorized = vi.fn();
    vi.stubGlobal('fetch', () => pending.promise);
    const api = new ApiClient(unauthorized);
    const result = api.json('/v1/threads/mine');
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    api.invalidate(); pending.resolve(json({ private: true }, status)); await rejection;
    expect(unauthorized).not.toHaveBeenCalled();
  });
  it('discards a response body which resolves after identity changes', async () => {
    const body = deferred<string>();
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: () => body.promise }));
    const api = new ApiClient(vi.fn()); const response = await api.request('/v1/threads/mine');
    const result = api.read(response); const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    api.invalidate(); body.resolve('{"private":true}'); await rejection;
  });
  it('invalid JSON reports a readable response error', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>Gateway error</html>', { status: 502 }));
    await expect(new ApiClient(vi.fn()).json('/v1/skills')).rejects.toThrow('服务响应异常（HTTP 502）');
  });
});

describe('SSE transport', () => {
  it('handles split UTF-8, CRLF, multiline data, comments, and a final event without a separator', async () => {
    const wire = ': heartbeat\r\n\r\nevent: message.delta\r\ndata: {\r\ndata: "text": "审批结论"}\r\n\r\nevent: run.completed\ndata: {}';
    const bytes = new TextEncoder().encode(wire);
    const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
    const events: unknown[] = [];
    await consumeSse(new Response(stream), new AbortController().signal, (name, data) => events.push([name, data]));
    expect(events).toEqual([['message.delta', { text: '审批结论' }], ['run.completed', {}]]);
  });
  it('cancels a pending reader and rejects after an abort', async () => {
    const cancelled = vi.fn();
    const controller = new AbortController();
    const stream = new ReadableStream({ cancel: cancelled });
    const result = consumeSse(new Response(stream), controller.signal, vi.fn());
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejection; expect(cancelled).toHaveBeenCalledOnce();
  });
  it('releases the reader if an event is malformed', async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: message.delta\ndata: invalid\n\n')); } });
    await expect(consumeSse(new Response(stream), new AbortController().signal, vi.fn())).rejects.toThrow();
    expect(stream.locked).toBe(false);
  });
});

describe('existing Markdown behavior', () => {
  it('renders every prefix of a streamed policy answer without hanging', () => {
    const answer = '## 审批结论\n\n**结论：** 需要审批。\n\n- 查询请假制度\n\n1. 提交申请\n\n> 参考条款\n\n| 部门 | 审批人 |\n| --- | --- |\n| 法务 | 领导 |\n\n```text\n审批流程\n```\n\n---\n请核对来源。';
    for (let end = 0; end <= answer.length; end++) renderMarkdown(answer.slice(0, end));
    for (const tag of ['<h2>', '<strong>', '<ul>', '<ol>', '<blockquote>', '<table>', '<pre>', '<hr>']) expect(renderMarkdown(answer)).toContain(tag);
  });
  it.each(['# ', '## ', '- ', '* ', '+ ', '1. ', '123. ', '  -\t'])('consumes incomplete marker %j', marker => {
    expect(renderMarkdown('结论\n' + marker)).toContain(marker);
  });
  it('escapes HTML and prevents attribute injection and executable Markdown URLs', () => {
    const html = renderMarkdown('<script>危险</script> [链接](javascript:alert(1)) [安全](https://example.com)');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.com"'); expect(html).toContain('rel="noopener noreferrer"');
    expect(renderMarkdown('```x" onmouseover="alert(1)\ncode\n```')).not.toContain(' onmouseover="');
  });
});
