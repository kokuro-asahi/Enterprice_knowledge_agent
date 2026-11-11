import { useSyncExternalStore } from 'react';
import type { Conversation } from '../conversation';
import { EXAMPLE_PROMPT, ROLES, type User } from '../types';

export function Settings({ conversation, user, open, close, newThread, locked }: { conversation: Conversation; user: User; open: boolean; close: () => void; newThread: () => void; locked: boolean }) {
  const state = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
  const disabled = locked || state.busy || state.loadingHistory;
  const hasThread = Boolean(state.threadId.trim());
  const customDisabled = disabled || hasThread || Boolean(state.role);
  return <><aside id="settingsPanel" className={`sidebar settings-sidebar ${open ? 'open' : ''}`} aria-label="Agent 配置" inert={!open || locked}>
    <header className="settings-header"><div><span>WORKSPACE</span><h1>Agent 配置</h1></div><button id="closeSettings" className="close-settings" type="button" aria-label="关闭设置" onClick={close}>×</button></header>
    <section className="settings-intro"><div className="agent-orb"><span>✦</span></div><div><strong>通用 Agent</strong><p>可按任务配置角色、指令和技能。</p></div></section>
    <section className="panel">
      <label><span>User ID</span><input id="userId" value={user.user_id} readOnly /></label>
      <label><span>Thread ID</span><input id="threadId" placeholder="新对话会自动创建" autoComplete="off" value={state.threadId} disabled={disabled} onChange={event => conversation.configure({ threadId: event.target.value })} /></label>
      <label><span>Agent Role</span><select id="agentRole" value={state.role} disabled={disabled || hasThread} onChange={event => conversation.configure({ role: event.target.value })}>{ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className={customDisabled ? 'disabled' : ''}><span>系统指令</span><textarea id="agentPrompt" rows={5} placeholder={hasThread ? '已有会话沿用创建时的系统指令' : state.role ? '选择自定义 Agent 后可填写' : '这里会作为新会话的系统指令'} value={state.agentPrompt} disabled={customDisabled} onChange={event => conversation.configure({ agentPrompt: event.target.value })} /></label>
    </section>
    <section className="panel skill-picker" aria-labelledby="skillPickerLabel"><div className="section-label"><span id="skillPickerLabel">启用技能</span><small>只在新建对话时可选</small></div>
      <div id="skillOptions" className={`skill-options ${hasThread ? 'disabled' : ''}`}>
        {state.skillsError || (!state.skills.length ? '当前没有可用技能。' : state.skills.map(skill => <label className="skill-option" key={skill.id}>
          <input type="checkbox" value={skill.id} checked={state.selectedSkills.includes(skill.id)} disabled={disabled || hasThread} onChange={event => conversation.configure({ selectedSkills: event.target.checked ? [...state.selectedSkills, skill.id] : state.selectedSkills.filter(id => id !== skill.id) })} />
          <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
        </label>))}
      </div>
    </section>
    <section className="panel actions"><button id="newThread" type="button" disabled={locked} onClick={newThread}>开始新的对话</button><button id="fillPrompt" className="secondary-button" type="button" disabled={disabled} onClick={() => { newThread(); conversation.configure({ role: '', agentPrompt: EXAMPLE_PROMPT }); }}>使用示例指令</button></section>
    <section className="panel meta"><div><span>Run</span><strong id="runId">{state.runId || '-'}</strong></div><div><span>状态</span><strong id="configStatus">{state.status}</strong></div></section>
  </aside><div id="settingsBackdrop" className={`settings-backdrop ${open ? 'show' : ''}`} onClick={close} /></>;
}
