import type { Todo } from '../types';

export function TaskPlan({ todos, status }: { todos: Todo[]; status: string }) {
  if (!todos.length && status !== 'running') return null;
  const completed = todos.filter(todo => todo.status === 'completed').length;
  const ended = status === 'completed' || status === 'failed';
  const progress = `已完成 ${completed}/${todos.length}`;
  const summary = !todos.length ? '正在生成计划…' : status === 'failed' ? `运行中断 · ${progress}` :
    status === 'completed' ? completed === todos.length ? `任务已完成 · ${progress}` : `回答已结束 · 已确认完成 ${completed}/${todos.length}` : progress;
  const labels = { pending: '待执行', in_progress: '执行中', completed: '已完成' };
  return <details id="taskPlan" className="task-plan" open>
    <summary><strong>执行计划</strong><span>{summary}</span></summary>
    <ol className="plan-list" aria-label="执行步骤">{todos.map((todo, index) => {
      const unconfirmed = ended && todo.status !== 'completed';
      return <li key={index} className={`plan-step ${unconfirmed ? 'unconfirmed' : todo.status}`}>
        <span className="plan-step-status">{unconfirmed ? status === 'failed' ? '未完成' : '未确认完成' : labels[todo.status]}</span>
        <span className="plan-step-content">{todo.content}</span>
      </li>;
    })}</ol>
  </details>;
}
