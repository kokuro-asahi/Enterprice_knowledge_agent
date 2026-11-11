export interface User { user_id: string; username: string; access_level: number; is_admin: boolean }
export interface Account extends User { is_active: boolean; last_login_at: string | null }
export interface Skill { id: string; name: string; description: string; enabled_by_default: boolean }
export interface Thread { thread_id: string; title: string; agent_role?: string | null }
export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed' }
export interface Content { type: string; text?: string; url?: string; mime_type?: string; file_name?: string }
export interface History {
  messages: { message_id: string; user?: { content: Content[] }; assistant?: { content: Content[] } }[];
  todos?: Todo[];
  run_status?: string;
}
export interface SearchResult {
  title?: string; url?: string; site_name?: string; source_article?: string;
  source_pages?: number[]; file_id?: string; snippet?: string; content?: string;
}
export interface ToolData {
  tool_type?: string; tool_call_id?: string; arguments?: Record<string, unknown>;
  result?: { query?: string; results?: SearchResult[] }; error?: { message?: string };
}
export interface RunEvent extends ToolData {
  thread_id?: string; run_id?: string; status?: string; text?: string; todos?: Todo[];
}
export type Message = { id: string; role: 'user' | 'assistant' | 'error'; text: string }
  | { id: string; role: 'tool'; data: ToolData; status: string };
export const ROLES = [
  ['enterprise_policy_advisor', '企业规章制度顾问'], ['', '自定义 Agent'], ['director', '导演创作助手'],
  ['cinematographer', '摄影指导'], ['art_director', '美术指导'], ['screenwriter', '编剧助手'], ['storyboard_artist', '分镜设计师'],
] as const;
export const LEVELS: Record<number, string> = { 1: '初级', 2: '中级', 3: '高级' };
export const STATUS: Record<string, string> = {
  idle: '等待提问', ready: '准备就绪', running: '正在查询', completed: '已完成', failed: '查询失败',
  unhealthy: '服务异常', offline: '服务未连接', signed_out: '请先登录', loading: '正在加载历史…',
};
export const EXAMPLE_PROMPT = '你是一个专业影视创作助手。回答要简洁，优先给出可执行方案；涉及分镜时输出镜号、景别、镜头运动和画面描述。';
