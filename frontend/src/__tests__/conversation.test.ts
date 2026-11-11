// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api';
import { Conversation } from '../conversation';

const json = (data: unknown) => new Response(JSON.stringify(data));
const event = (name: string, data = {}) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const encoder = new TextEncoder();
let frames: Map<number, FrameRequestCallback>;
let count: number;
beforeEach(() => {
  frames = new Map(); count = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++count, callback); return count; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());
const tick = () => { for (const callback of [...frames.values()]) callback(0); };
const turn = () => new Promise(resolve => setImmediate(resolve));
function setupStream() {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { output = controller; }, cancel });
  const fetcher = vi.fn(async (path: string, _options?: RequestInit) => path === '/v1/runs' ? new Response(stream) : json({ threads: [] }));
  vi.stubGlobal('fetch', fetcher);
  const conversation = new Conversation(new ApiClient(vi.fn()));
  return { conversation, output, fetcher, cancel, emit: (name: string, data = {}) => output.enqueue(encoder.encode(event(name, data))) };
}

describe('conversation lifecycle', () => {
  it('does not restore default skills over a new-thread selection when loading is slow', async () => {
    let resolveSkills!: (response: Response) => void;
    vi.stubGlobal('fetch', async (path: string) => path === '/v1/skills' ? new Promise<Response>(resolve => { resolveSkills = resolve; }) : json({ threads: [] }));
    const conversation = new Conversation(new ApiClient(vi.fn()));
    const initializing = conversation.initialize();
    conversation.newThread();
    resolveSkills(json({ skills: [{ id: 'enterprise-policy', name: '制度检索', description: '', enabled_by_default: false }] }));
    await initializing;
    expect(conversation.getSnapshot().skills).toHaveLength(1);
    expect(conversation.getSnapshot().selectedSkills).toEqual([]);
  });
  it('batches deltas once per frame and flushes at tool and run boundaries', async () => {
    const { conversation, emit, output } = setupStream();
    const running = conversation.send('请帮我查制度'); await turn();
    emit('run.started', { thread_id: 'thread-1', run_id: 'run-1' });
    emit('message.delta', { text: '## ' }); emit('message.delta', { text: '查询' }); await turn();
    expect(frames.size).toBe(1); expect(conversation.getSnapshot().messages).toHaveLength(1);
    tick(); expect(conversation.getSnapshot().messages.at(-1)).toMatchObject({ text: '## 查询' });
    emit('message.delta', { text: '制度' });
    emit('tool.call.started', { tool_call_id: 'call-1', tool_type: 'search_enterprise_policy', arguments: { query: '请假' } });
    emit('message.delta', { text: '最终结论' });
    emit('run.completed'); output.close(); await running;
    expect(frames.size).toBe(0);
    expect(conversation.getSnapshot()).toMatchObject({ busy: false, status: 'completed', threadId: 'thread-1', runId: 'run-1' });
    expect(conversation.getSnapshot().messages).toMatchObject([{ role: 'user' }, { role: 'assistant', text: '## 查询制度' }, { role: 'tool' }, { role: 'assistant', text: '最终结论' }]);
  });
  it.each(['run.completed', 'run.failed'])('%s preserves unfinished plan steps and the final delta', async terminal => {
    const { conversation, emit, output } = setupStream();
    const running = conversation.send('测试'); await turn();
    emit('run.started', { thread_id: 'current' });
    emit('plan.updated', { thread_id: 'other', todos: [{ content: '旧步骤', status: 'pending' }] });
    emit('plan.updated', { thread_id: 'current', todos: [{ content: '核对依据', status: 'in_progress' }] });
    emit('message.delta', { text: '最后一段' }); emit(terminal); output.close(); await running;
    expect(conversation.getSnapshot().todos).toEqual([{ content: '核对依据', status: 'in_progress' }]);
    expect(conversation.getSnapshot().messages).toContainEqual(expect.objectContaining({ role: 'assistant', text: '最后一段' }));
    expect(conversation.getSnapshot().status).toBe(terminal.slice(4));
  });
  it('updates a tool card in place, hides write_todos, and preserves tool metadata', async () => {
    const { conversation, emit, output } = setupStream();
    const running = conversation.send('测试'); await turn();
    emit('tool.call.started', { tool_call_id: 'plan', tool_type: 'write_todos' });
    emit('tool.call.started', { tool_call_id: 'search', tool_type: 'bocha_search', arguments: { query: '制度' } });
    emit('tool.call.completed', { tool_call_id: 'search', result: { results: [{ title: '结果' }] } });
    emit('run.completed'); output.close(); await running;
    const tools = conversation.getSnapshot().messages.filter(message => message.role === 'tool');
    expect(tools).toHaveLength(1); expect(tools[0]).toMatchObject({ status: 'completed', data: { tool_type: 'bocha_search', result: { results: [{ title: '结果' }] } } });
  });
  it('cancels and clears a pending stream and scheduled text on a new conversation', async () => {
    const { conversation, emit, fetcher, cancel } = setupStream();
    const running = conversation.send('私有消息'); await turn();
    emit('message.delta', { text: '旧回答' }); await turn();
    expect(frames.size).toBe(1); conversation.newThread(); await running; tick();
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce();
    expect(conversation.getSnapshot()).toMatchObject({ messages: [], todos: [], threadId: '', busy: false, selectedSkills: [] });
  });
  it('marks EOF without a terminal event as incomplete and retains received text', async () => {
    const { conversation, emit, output } = setupStream(); const running = conversation.send('测试'); await turn();
    emit('message.delta', { text: '部分回答' }); output.close(); await running;
    expect(conversation.getSnapshot()).toMatchObject({ status: 'failed', busy: false });
    expect(conversation.getSnapshot().messages.at(-1)).toMatchObject({ role: 'error', text: '连接已中断，回答可能不完整，请重试。' });
    expect(conversation.getSnapshot().messages[1]).toMatchObject({ text: '部分回答' });
  });
  it('shows an API error and re-enables the composer', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: '找不到会话' } }), { status: 404 }));
    const conversation = new Conversation(new ApiClient(vi.fn())); await conversation.send('你好');
    expect(conversation.getSnapshot()).toMatchObject({ busy: false, status: 'failed' });
    expect(conversation.getSnapshot().messages.at(-1)).toMatchObject({ role: 'error', text: '找不到会话' });
  });
  it('builds new-thread requests with role, image and skills; existing requests omit new-thread options', async () => {
    const { conversation, emit, output, fetcher } = setupStream();
    conversation.configure({ selectedSkills: ['enterprise-policy'] });
    const running = conversation.send('  你好  ', 'https://example.com/image.png'); await turn();
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ thread_id: null, stream: true, agent_role: 'enterprise_policy_advisor', active_skill_ids: ['enterprise-policy'], content: [{ type: 'text', text: '你好' }, { type: 'image', url: 'https://example.com/image.png' }] });
    expect(body).not.toHaveProperty('user_id');
    emit('run.completed', { thread_id: 'created' }); output.close(); await running;
    const nextFetcher = vi.fn(async (_path: string, _options?: RequestInit) => new Response(event('run.completed'))); vi.stubGlobal('fetch', nextFetcher);
    await conversation.send('继续');
    const next = JSON.parse(String(nextFetcher.mock.calls[0][1]?.body));
    expect(next.thread_id).toBe('created'); expect(next).not.toHaveProperty('active_skill_ids'); expect(next).not.toHaveProperty('agent_role');
  });
  it('validates custom instructions before sending and prevents double submission', async () => {
    const { conversation, fetcher, emit, output } = setupStream(); conversation.configure({ role: '' });
    await conversation.send('测试'); expect(fetcher).not.toHaveBeenCalled();
    conversation.configure({ agentPrompt: '自定义指令' });
    const running = conversation.send('测试'); await conversation.send('重复'); await turn();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ agent_role: null, agent_prompt: '自定义指令' });
    emit('run.completed'); output.close(); await running;
  });
  it('restores chronological history and saved plan, discarding older responses', async () => {
    let oldResolve!: (response: Response) => void;
    vi.stubGlobal('fetch', (path: string) => path.includes('/old/') ? new Promise<Response>(resolve => { oldResolve = resolve; }) : Promise.resolve(json({
      messages: [{ user: { content: [{ type: 'text', text: '第二问' }] } }, { user: { content: [{ type: 'text', text: '第一问' }] }, assistant: { content: [{ type: 'text', text: '第一答' }] } }],
      todos: [{ content: '核对依据', status: 'in_progress' }], run_status: 'completed',
    })));
    const conversation = new Conversation(new ApiClient(vi.fn()));
    const old = conversation.openThread({ thread_id: 'old', title: '旧会话' });
    await conversation.openThread({ thread_id: 'new', title: '新会话' });
    oldResolve(json({ messages: [], todos: [{ content: '旧计划', status: 'pending' }] })); await old;
    expect(conversation.getSnapshot()).toMatchObject({ threadId: 'new', loadingHistory: false, planStatus: 'completed', todos: [{ content: '核对依据', status: 'in_progress' }] });
    expect(conversation.getSnapshot().messages).toMatchObject([{ text: '第一问' }, { text: '第一答' }, { text: '第二问' }]);
  });
  it('does not submit while history is loading', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(r => { resolve = r; })); vi.stubGlobal('fetch', fetcher);
    const conversation = new Conversation(new ApiClient(vi.fn()));
    const history = conversation.openThread({ thread_id: 'thread', title: '' }); await conversation.send('测试');
    expect(fetcher).toHaveBeenCalledTimes(1); resolve(json({ messages: [] })); await history;
  });
});
