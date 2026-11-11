import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { Session } from '../session';
import { Messages } from '../components/Messages';
import { TaskPlan } from '../components/TaskPlan';
import { ToolCard } from '../components/ToolCard';
import type { Message } from '../types';

const alice = { user_id: 'alice-id', username: 'alice', access_level: 2, is_admin: false };
const admin = { ...alice, is_admin: true };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
let session: Session;
beforeEach(() => { session = new Session(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mockApi(override: (path: string, options?: RequestInit) => Response | Promise<Response> | undefined = () => undefined, administrator = false) {
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    const response = override(path, options); if (response) return response;
    if (path === '/v1/auth/me') return json(administrator ? admin : alice);
    if (path === '/v1/skills') return json({ skills: [{ id: 'enterprise-policy', name: '制度检索', description: '查询制度', enabled_by_default: false }] });
    if (path === '/v1/threads/mine') return json({ threads: [{ thread_id: 'saved', title: '已保存的对话' }] });
    if (path.startsWith('/v1/admin/users?')) return json({ users: [], total: 0 });
    return json({});
  });
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
async function workspace() { render(<App session={session} />); await screen.findByRole('button', { name: '退出登录' }); }
async function openAccounts() { await workspace(); await userEvent.click(screen.getByRole('button', { name: '账户管理' })); await waitFor(() => expect(screen.getByRole('button', { name: '创建账号' }).hasAttribute('disabled')).toBe(false)); return screen.getByRole('dialog'); }

it('restores the session, loads my threads and keeps admin controls hidden for ordinary users', async () => {
  const fetcher = mockApi(); await workspace();
  await screen.findByRole('button', { name: '已保存的对话' });
  expect(screen.queryByRole('button', { name: '账户管理' })).toBeNull();
  expect(fetcher.mock.calls.map(([path]) => path)).not.toContain('/v1/threads/users');
  expect(screen.getByRole('textbox', { name: '消息内容' })).toBe(document.activeElement);
});
it('submits credentials, clears password after a failed login, and loads workspace after success', async () => {
  let valid = false;
  const fetcher = mockApi((path) => path === '/v1/auth/me' ? json({}, 401) : path === '/v1/auth/login' ? valid ? json({ user: alice, access_token: 'secret' }) : json({ error: { message: '账号或密码错误' } }, 401) : undefined);
  render(<App session={session} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /登录工作区/ }).hasAttribute('disabled')).toBe(false));
  await userEvent.type(screen.getByLabelText('账号'), 'alice'); await userEvent.type(screen.getByLabelText('密码'), 'bad');
  await userEvent.click(screen.getByRole('button', { name: /登录工作区/ }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '账号或密码错误');
  expect(screen.getByLabelText<HTMLInputElement>('密码').value).toBe('');
  valid = true; await userEvent.type(screen.getByLabelText('密码'), 'right'); await userEvent.click(screen.getByRole('button', { name: /登录工作区/ }));
  await screen.findByRole('button', { name: '退出登录' });
  const login = fetcher.mock.calls.filter(([path]) => path === '/v1/auth/login').at(-1)!;
  expect(JSON.parse(String(login[1]?.body))).toEqual({ username: 'alice', password: 'right' });
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});
it('renders history, disables thread configuration, and resets with the new-chat shortcut', async () => {
  mockApi(path => path.includes('/saved/messages') ? json({ messages: [{ user: { content: [{ type: 'text', text: '旧问题' }] }, assistant: { content: [{ type: 'text', text: '**旧回答**' }] } }], run_status: 'completed', todos: [{ content: '核对依据', status: 'in_progress' }] }) : undefined);
  await workspace(); await userEvent.click(await screen.findByRole('button', { name: '已保存的对话' }));
  await screen.findByText('旧回答'); expect(screen.getByText('未确认完成')).toBeTruthy();
  expect(screen.getByRole('combobox', { name: '选择 Agent 角色' }).hasAttribute('disabled')).toBe(true);
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  expect(screen.queryByText('旧回答')).toBeNull(); expect(screen.queryByText('核对依据')).toBeNull();
  expect(screen.getByRole('combobox', { name: '选择 Agent 角色' }).hasAttribute('disabled')).toBe(false);
});
it('posts a message via Ctrl+Enter and renders streamed Markdown, plan, and search sources', async () => {
  const events = [
    ['run.started', { thread_id: 'new', run_id: 'run' }],
    ['plan.updated', { todos: [{ content: '查询依据', status: 'completed' }] }],
    ['tool.call.completed', { tool_call_id: 'search', tool_type: 'search_enterprise_policy', result: { query: '报销', results: [{ title: '报销规定', source_article: '第三条', source_pages: [4], file_id: 'file-1', content: '提交凭证' }] } }],
    ['message.delta', { text: '## 审批结论\n\n需要提交凭证。' }], ['run.completed', {}],
  ].map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const fetcher = mockApi(path => path === '/v1/runs' ? new Response(events) : undefined);
  await workspace(); const input = screen.getByRole('textbox', { name: '消息内容' });
  await userEvent.type(input, '报销需要什么'); fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  await screen.findByRole('heading', { name: '审批结论' });
  expect(screen.getByText('任务已完成 · 已完成 1/1')).toBeTruthy();
  await userEvent.click(screen.getByText('查看搜索结果'));
  expect(screen.getByText('报销规定')).toBeTruthy(); expect(screen.getByText('第三条 · 页码：4 · file-1')).toBeTruthy();
  expect((input as HTMLTextAreaElement).value).toBe('');
  const run = fetcher.mock.calls.find(([path]) => path === '/v1/runs')!;
  expect(JSON.parse(String(run[1]?.body))).toMatchObject({ active_skill_ids: ['enterprise-policy'], content: [{ type: 'text', text: '报销需要什么' }] });
});
it('clears private workspace data on 401 and allows logging in again', async () => {
  mockApi(path => path.includes('/saved/messages') ? json({}, 401) : undefined);
  await workspace(); await userEvent.type(screen.getByRole('textbox', { name: '消息内容' }), '私有草稿');
  await userEvent.click(await screen.findByRole('button', { name: '已保存的对话' }));
  await screen.findByRole('heading', { name: '登录你的工作区' });
  expect(screen.queryByRole('textbox', { name: '消息内容' })).toBeNull();
  expect(screen.queryByText('私有草稿')).toBeNull(); expect(screen.getByRole('alert').textContent).toContain('登录已过期');
});
it('creates accounts, clears their password and refreshes the list', async () => {
  const fetcher = mockApi((path, options) => path === '/v1/admin/users' && options?.method === 'POST' ? json({ ...alice, user_id: 'new-id', username: 'new-account' }, 201) : undefined, true);
  const dialog = await openAccounts(); const form = within(dialog);
  await userEvent.type(form.getByLabelText('账号'), 'new-account'); await userEvent.type(form.getByLabelText('初始密码'), 'new-password');
  await userEvent.selectOptions(form.getByLabelText('访问等级'), '2'); await userEvent.click(form.getByRole('button', { name: '创建账号' }));
  await screen.findByText('账号已创建。'); expect(form.getByLabelText<HTMLInputElement>('初始密码').value).toBe('');
  const post = fetcher.mock.calls.find(([path, options]) => path === '/v1/admin/users' && options?.method === 'POST')!;
  expect(JSON.parse(String(post[1]?.body))).toEqual({ username: 'new-account', password: 'new-password', access_level: 2, is_admin: false, is_active: true });
});
it('edits stable account IDs without sending an unchanged password', async () => {
  const account = { ...alice, user_id: 'other/id', username: 'old-name', is_active: true, last_login_at: null };
  const fetcher = mockApi((path, options) => path.startsWith('/v1/admin/users?') ? json({ users: [account], total: 1 }) : options?.method === 'PATCH' ? json({ ...account, username: 'new-name' }) : undefined, true);
  const dialog = await openAccounts(); const form = within(dialog);
  await userEvent.click(form.getByRole('button', { name: '编辑 old-name' }));
  await userEvent.clear(form.getByLabelText('账号')); await userEvent.type(form.getByLabelText('账号'), 'new-name');
  await userEvent.click(form.getByRole('button', { name: '保存修改' })); await screen.findByText('账号已更新。');
  const patch = fetcher.mock.calls.find(([, options]) => options?.method === 'PATCH')!;
  expect(patch[0]).toBe('/v1/admin/users/other%2Fid'); expect(JSON.parse(String(patch[1]?.body))).not.toHaveProperty('password');
});
it('prevents disabling self and returns to login after resetting own password', async () => {
  mockApi((path, options) => path.startsWith('/v1/admin/users?') ? json({ users: [{ ...admin, is_active: true, last_login_at: null }], total: 1 }) : options?.method === 'PATCH' ? json(admin) : undefined, true);
  const dialog = await openAccounts(); const form = within(dialog);
  await userEvent.click(form.getByRole('button', { name: '编辑 alice' }));
  expect(form.getByLabelText('管理员').hasAttribute('disabled')).toBe(true); expect(form.getByLabelText('启用账号').hasAttribute('disabled')).toBe(true);
  await userEvent.type(form.getByLabelText('重置密码（选填）'), 'new-password'); await userEvent.click(form.getByRole('button', { name: '保存修改' }));
  await screen.findByRole('heading', { name: '登录你的工作区' });
  expect(screen.getByRole('alert').textContent).toBe('密码已更新，请使用新密码重新登录。');
  expect(screen.queryByRole('heading', { name: '账户与权限管理' })).toBeNull();
});
it('closes management on revoked admin permissions while keeping the session', async () => {
  mockApi(path => path.startsWith('/v1/admin/users?') ? json({ error: { code: 'ACCESS_DENIED', message: '需要管理员权限' } }, 403) : undefined, true);
  await workspace(); await userEvent.click(screen.getByRole('button', { name: '账户管理' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.queryByRole('button', { name: '账户管理' })).toBeNull(); expect(session.getSnapshot().user?.user_id).toBe('alice-id');
  expect(screen.getByText('管理员权限已取消，无法继续管理账号。')).toBeTruthy();
});
it('shows completed and failed plan labels without marking unfinished steps complete', () => {
  const todos = [{ content: '<img onerror=alert(1)>', status: 'in_progress' as const }];
  const view = render(<TaskPlan todos={todos} status="completed" />); expect(screen.getByText('未确认完成')).toBeTruthy();
  view.rerender(<TaskPlan todos={todos} status="failed" />); expect(screen.getByText('未完成')).toBeTruthy();
  expect(view.container.querySelector('img')).toBeNull();
});
it('never renders an executable search-result URL', () => {
  render(<ToolCard status="completed" data={{ tool_type: 'bocha_search', result: { results: [{ title: '恶意链接', url: 'javascript:alert(1)' }] } }} />);
  expect(screen.queryByRole('link', { hidden: true })).toBeNull();
});
it('follows output only while at the bottom, and resumes when the user returns', () => {
  let messages: Message[] = [{ id: '1', role: 'assistant', text: '初始回答' }];
  const view = render(<Messages messages={messages} loading={false} threadId="one" />);
  const node = screen.getByLabelText('对话消息');
  Object.defineProperties(node, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 500, configurable: true } });
  messages = [...messages, { id: '2', role: 'assistant', text: '继续输出' }];
  view.rerender(<Messages messages={messages} loading={false} threadId="one" />); expect(node.scrollTop).toBe(1500);
  node.scrollTop = 400; fireEvent.scroll(node); Object.defineProperty(node, 'scrollHeight', { value: 2500, configurable: true });
  messages = [...messages, { id: '3', role: 'assistant', text: '新的输出' }];
  view.rerender(<Messages messages={messages} loading={false} threadId="one" />); expect(node.scrollTop).toBe(400);
  node.scrollTop = 2000; fireEvent.scroll(node); Object.defineProperty(node, 'scrollHeight', { value: 3000, configurable: true });
  view.rerender(<Messages messages={[...messages, { id: '4', role: 'assistant', text: '最终回答' }]} loading={false} threadId="one" />); expect(node.scrollTop).toBe(2500);
});
