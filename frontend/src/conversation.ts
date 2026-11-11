import { ApiClient, errorMessage, isCancelled, jsonBody } from './api';
import { consumeSse } from './sse';
import { Store } from './store';
import type { Content, History, Message, RunEvent, Skill, Thread, Todo } from './types';

interface ConversationState {
  messages: Message[]; todos: Todo[]; planStatus: string; status: string;
  busy: boolean; loadingHistory: boolean; threadId: string; runId: string;
  role: string; agentPrompt: string; skills: Skill[]; selectedSkills: string[]; skillsError: string;
  threads: Thread[]; threadsError: string;
}
export class Conversation extends Store<ConversationState> {
  private controller: AbortController | null = null;
  private lifetime = new AbortController();
  private view = 0;
  private listVersion = 0;
  private sequence = 0;
  private selectionVersion = 0;
  private frame: number | null = null;
  private assistantId: string | null = null;
  private pendingText = '';
  constructor(private api: ApiClient) {
    super({ messages: [], todos: [], planStatus: '', status: 'ready', busy: false, loadingHistory: false,
      threadId: '', runId: '', role: 'enterprise_policy_advisor', agentPrompt: '', skills: [],
      selectedSkills: [], skillsError: '', threads: [], threadsError: '' });
  }
  private get active() { return !this.lifetime.signal.aborted; }
  private id() { return String(++this.sequence); }
  async initialize() {
    await Promise.all([this.loadSkills(), this.loadThreads(), this.checkHealth()]);
  }
  private async checkHealth() {
    try {
      const response = await this.api.request('/health', { signal: this.lifetime.signal });
      if (this.active && this.state.status === 'ready') this.patch({ status: response.ok ? 'ready' : 'unhealthy' });
    } catch (error) {
      if (this.active && !isCancelled(error) && this.state.status === 'ready') this.patch({ status: 'offline' });
    }
  }
  private async loadSkills() {
    const selectionVersion = this.selectionVersion;
    try {
      const data = await this.api.json<{ skills: Skill[] }>('/v1/skills', { signal: this.lifetime.signal });
      if (this.active) this.patch({ skills: data.skills, ...(selectionVersion === this.selectionVersion ? { selectedSkills: data.skills.filter(s => s.enabled_by_default || s.id === 'enterprise-policy').map(s => s.id) } : {}) });
    } catch (error) {
      if (this.active && !isCancelled(error)) this.patch({ skillsError: `技能列表加载失败：${errorMessage(error)}` });
    }
  }
  async loadThreads() {
    const version = ++this.listVersion;
    try {
      const data = await this.api.json<{ threads: Thread[] }>('/v1/threads/mine', { signal: this.lifetime.signal });
      if (this.active && version === this.listVersion) this.patch({ threads: data.threads, threadsError: '' });
    } catch (error) {
      if (this.active && version === this.listVersion && !isCancelled(error)) this.patch({ threadsError: '对话历史加载失败' });
    }
  }
  configure(values: Partial<Pick<ConversationState, 'role' | 'agentPrompt' | 'threadId' | 'selectedSkills'>>) {
    if (this.state.busy || this.state.loadingHistory) return;
    if (values.selectedSkills !== undefined) this.selectionVersion += 1;
    if (values.threadId !== undefined && values.threadId !== this.state.threadId) this.reset();
    this.patch(values);
  }
  reset() {
    this.view += 1;
    this.controller?.abort();
    this.controller = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.pendingText = '';
    this.assistantId = null;
    this.patch({ threadId: '', runId: '', messages: [], todos: [], planStatus: '', busy: false, loadingHistory: false, status: 'idle' });
  }
  newThread() { this.selectionVersion += 1; this.reset(); this.patch({ selectedSkills: [] }); }
  dispose() { this.reset(); this.lifetime.abort(); }
  addError(message: string) { this.append('error', message); }
  private append(role: 'user' | 'assistant' | 'error', text: string) {
    const id = this.id();
    this.patch({ messages: [...this.state.messages, { id, role, text }] });
    return id;
  }
  private setPlan(todos: Todo[] = this.state.todos, status = '') {
    this.patch({ todos: todos.filter(todo => todo && typeof todo.content === 'string' && ['pending', 'in_progress', 'completed'].includes(todo.status)), planStatus: status });
  }
  async openThread(thread: Thread) {
    this.reset();
    const view = this.view;
    const controller = this.controller = new AbortController();
    this.patch({ threadId: thread.thread_id, loadingHistory: true, status: 'loading',
      ...('agent_role' in thread ? { role: thread.agent_role || '' } : {}) });
    try {
      const data = await this.api.json<History>(`/v1/threads/${encodeURIComponent(thread.thread_id)}/messages?page=1&page_size=100`, { signal: controller.signal });
      if (!this.active || view !== this.view) return;
      const messages: Message[] = [];
      for (const pair of [...data.messages].reverse()) {
        for (const role of ['user', 'assistant'] as const) {
          const text = contentText(pair[role]?.content);
          if (text) messages.push({ id: this.id(), role, text });
        }
      }
      this.patch({ messages, status: data.run_status || 'idle' });
      this.setPlan(data.todos || [], data.run_status || '');
    } catch (error) {
      if (this.active && view === this.view && !isCancelled(error)) {
        this.addError(`历史消息加载失败：${errorMessage(error)}`);
        this.patch({ status: 'failed' });
      }
    } finally {
      if (this.active && view === this.view) this.patch({ loadingHistory: false });
    }
  }
  validate() {
    return !this.state.threadId.trim() && !this.state.role && !this.state.agentPrompt.trim()
      ? '新会话使用自定义 Agent 时，需要填写系统指令' : '';
  }
  async send(text: string, imageUrl = '') {
    if (!this.active || this.state.busy || this.state.loadingHistory || (!text.trim() && !imageUrl.trim())) return;
    const error = this.validate();
    if (error) { this.addError(error); return; }
    const content: Content[] = [];
    if (text.trim()) content.push({ type: 'text', text: text.trim() });
    if (imageUrl.trim()) content.push({ type: 'image', url: imageUrl.trim(), mime_type: 'image/png', file_name: imageUrl.split('/').pop() || 'image.png' });
    const threadId = this.state.threadId.trim();
    const body = {
      thread_id: threadId || null, stream: true, content,
      ...(!threadId ? { agent_role: this.state.role || null, ...(!this.state.role ? { agent_prompt: this.state.agentPrompt.trim() } : {}), active_skill_ids: this.state.selectedSkills } : {}),
    };
    const view = ++this.view;
    const controller = this.controller = new AbortController();
    this.assistantId = null;
    this.setPlan([], 'running');
    this.append('user', [text.trim(), imageUrl.trim() && `[image] ${imageUrl.trim()}`].filter(Boolean).join('\n'));
    this.patch({ busy: true, status: 'running' });
    let ended = false;
    try {
      const response = await this.api.request('/v1/runs', { ...jsonBody(body), signal: controller.signal });
      if (!response.ok) await this.api.read(response);
      await consumeSse(response, controller.signal, (name, data) => {
        if (!this.active || view !== this.view || ended) return;
        this.handleEvent(name, data);
        if (name === 'run.completed' || name === 'run.failed') ended = true;
      });
      if (!ended) throw new Error('连接已中断，回答可能不完整，请重试。');
    } catch (error) {
      if (this.active && view === this.view && !isCancelled(error)) {
        this.finishAssistant();
        this.setPlan(undefined, 'failed');
        this.addError(errorMessage(error));
        this.patch({ status: 'failed' });
      }
    } finally {
      if (this.active && view === this.view) {
        this.finishAssistant();
        this.controller = null;
        this.patch({ busy: false });
      }
    }
  }
  private delta(text: string) {
    if (!text) return;
    this.pendingText += text;
    if (this.frame === null) this.frame = requestAnimationFrame(() => this.flush());
  }
  private flush() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (!this.pendingText) return;
    const text = this.pendingText;
    this.pendingText = '';
    if (!this.assistantId) this.assistantId = this.append('assistant', text);
    else this.patch({ messages: this.state.messages.map(message => message.id === this.assistantId && message.role === 'assistant' ? { ...message, text: message.text + text } : message) });
  }
  private finishAssistant() { this.flush(); this.assistantId = null; }
  private metadata(data: RunEvent) {
    this.patch({ ...(data.thread_id ? { threadId: data.thread_id } : {}), ...(data.run_id ? { runId: data.run_id } : {}) });
  }
  private handleEvent(name: string, data: RunEvent) {
    if (name === 'run.started') {
      this.metadata(data);
      this.setPlan([], 'running');
      void this.loadThreads();
    } else if (name === 'plan.updated') {
      if (data.thread_id && data.thread_id !== this.state.threadId) return;
      this.setPlan(data.todos || [], 'running');
    } else if (name === 'message.delta') this.delta(data.text || '');
    else if (name.startsWith('tool.call.')) {
      this.finishAssistant();
      if (data.tool_type === 'write_todos') return;
      const status = name.slice('tool.call.'.length);
      const id = data.tool_call_id ? `tool-${data.tool_call_id}` : `tool-${this.id()}`;
      const previous = this.state.messages.find(message => message.id === id);
      const item: Message = { id, role: 'tool', data: { ...(previous?.role === 'tool' ? previous.data : {}), ...data }, status: status === 'started' ? 'running' : status };
      this.patch({ messages: previous ? this.state.messages.map(message => message.id === id ? item : message) : [...this.state.messages, item] });
    } else if (name === 'run.completed' || name === 'run.failed') {
      this.finishAssistant();
      this.metadata(data);
      const status = name === 'run.completed' ? 'completed' : 'failed';
      this.setPlan(data.todos, status);
      this.patch({ status });
      if (status === 'failed') this.addError(data.error?.message || '运行失败');
      void this.loadThreads();
    }
  }
}
function contentText(content?: Content[]) {
  return (content || []).map(item => item.type === 'text' ? item.text : item.url ? `[image] ${item.url}` : '').filter(Boolean).join('\n');
}
