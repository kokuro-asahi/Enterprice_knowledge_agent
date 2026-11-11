import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, isCancelled, jsonBody } from '../api';
import type { Session } from '../session';
import { LEVELS, type Account, type User } from '../types';
import { Dialog } from './Dialog';

interface Props { session: Session; user: User; onClose: () => void; onError: (message: string) => void }
const blank = () => ({ username: '', password: '', access_level: 1, is_admin: false, is_active: true });
export function Accounts({ session, user, onClose, onError }: Props) {
  const [users, setUsers] = useState<Account[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [values, setValues] = useState(blank);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const usernameRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => { mounted.current = false; }, []);
  const close = () => { if (!savingRef.current) onClose(); };
  const handleError = (error: unknown) => {
    if (isCancelled(error)) return;
    if (error instanceof ApiError && error.status === 403 && error.code === 'ACCESS_DENIED') {
      const current = session.getSnapshot().user;
      if (current) session.updateUser({ ...current, is_admin: false });
      onClose(); onError('管理员权限已取消，无法继续管理账号。');
    } else setError(errorMessage(error));
  };
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    const params = new URLSearchParams({ q: query, limit: '20', offset: String(offset) });
    void session.api.json<{ users: Account[]; total: number }>(`/v1/admin/users?${params}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) { setUsers(data.users); setTotal(data.total); } })
      .catch(error => { if (!controller.signal.aborted) { setUsers([]); setTotal(0); handleError(error); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [session, query, offset, reload]);
  const edit = (account: Account | null = null) => {
    if (savingRef.current) return;
    setEditing(account); setValues(account ? { username: account.username, password: '', access_level: account.access_level, is_admin: account.is_admin, is_active: account.is_active } : blank());
    setError(''); usernameRef.current?.focus();
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (savingRef.current || loading) return;
    if (!values.username.trim() || (!editing && !values.password)) { setError('请输入账号和初始密码。'); return; }
    const { password, ...fields } = values;
    const body = { ...fields, username: fields.username.trim(), ...(password ? { password } : {}) };
    savingRef.current = true; setSaving(true); setError(''); setStatus('');
    try {
      const account = await session.api.json<Account>(editing ? `/v1/admin/users/${encodeURIComponent(editing.user_id)}` : '/v1/admin/users', jsonBody(body, editing ? 'PATCH' : 'POST'));
      if (!mounted.current) return;
      if (account.user_id === user.user_id) {
        if (password) { session.signOut('密码已更新，请使用新密码重新登录。'); return; }
        session.updateUser({ user_id: account.user_id, username: account.username, access_level: account.access_level, is_admin: account.is_admin });
      }
      setValues(blank()); setEditing(null); setStatus(editing ? '账号已更新。' : '账号已创建。');
      setOffset(0); setQuery(''); setSearch(''); setReload(value => value + 1);
    } catch (error) { if (mounted.current) handleError(error); }
    finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  };
  const self = editing?.user_id === user.user_id;
  const disabled = saving || loading;
  return <Dialog onClose={close}><section className="admin-card">
    <header className="admin-header"><div><h1 id="adminTitle">账户与权限管理</h1><p>管理登录账号、访问等级和账号状态。</p></div><button id="adminClose" className="close-settings" type="button" aria-label="关闭账户管理" disabled={saving} onClick={close}>×</button></header>
    <p className="admin-notice">访问等级目前仅保存配置，尚未限制知识库检索范围。</p>
    {error && <div className="login-error" role="alert">{error}</div>}<div className="admin-status" role="status">{status}</div>
    <div className="admin-layout"><section className="admin-list" aria-label="账号列表">
      <form className="admin-toolbar" onSubmit={event => { event.preventDefault(); if (!disabled) { setQuery(search.trim()); setOffset(0); setReload(value => value + 1); } }}>
        <input type="search" placeholder="搜索账号" aria-label="搜索账号" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} disabled={saving} />
        <button type="submit" disabled={disabled}>查询</button><button type="button" disabled={disabled} onClick={() => edit()}>新增账号</button>
      </form>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr>{['账号', '访问等级', '身份', '状态', '最近登录', '操作'].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{users.map(account => <tr key={account.user_id}>
          <td>{account.username}</td><td>{LEVELS[account.access_level]}</td><td>{account.is_admin ? '管理员' : '普通用户'}</td><td>{account.is_active ? '启用' : '停用'}</td>
          <td>{account.last_login_at ? new Date(account.last_login_at).toLocaleString('zh-CN', { hour12: false }) : '尚未登录'}</td>
          <td><button type="button" disabled={disabled} onClick={() => edit(account)} aria-label={`编辑 ${account.username}`}>编辑</button></td>
        </tr>)}{!users.length && <tr><td colSpan={6}>{loading ? '正在加载账号…' : '没有匹配的账号'}</td></tr>}</tbody>
      </table></div>
      <div className="admin-pagination"><span>{loading ? '正在加载账号…' : `共 ${total} 个账号 · 第 ${Math.floor(offset / 20) + 1}/${Math.max(1, Math.ceil(total / 20))} 页`}</span><div>
        <button type="button" disabled={disabled || offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button>
        <button type="button" disabled={disabled || offset + 20 >= total} onClick={() => setOffset(offset + 20)}>下一页</button>
      </div></div>
    </section>
    <form id="accountForm" className="account-form" aria-labelledby="accountFormTitle" aria-busy={saving} onSubmit={save}>
      <h2 id="accountFormTitle">{editing ? '编辑账号' : '新增账号'}</h2>
      <label>账号<input ref={usernameRef} required maxLength={100} autoComplete="off" placeholder="请输入登录账号" value={values.username} onChange={event => setValues({ ...values, username: event.target.value })} disabled={disabled} /></label>
      <label>{editing ? '重置密码（选填）' : '初始密码'}<input type="password" required={!editing} maxLength={1024} autoComplete="new-password" placeholder={editing ? '留空则保留原密码' : '请输入初始密码'} value={values.password} onChange={event => setValues({ ...values, password: event.target.value })} disabled={disabled} /></label>
      <label>访问等级<select value={values.access_level} onChange={event => setValues({ ...values, access_level: Number(event.target.value) })} disabled={disabled}>{Object.entries(LEVELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="account-check"><input type="checkbox" checked={values.is_admin} disabled={disabled || self} onChange={event => setValues({ ...values, is_admin: event.target.checked })} />管理员</label>
      <label className="account-check"><input type="checkbox" checked={values.is_active} disabled={disabled || self} onChange={event => setValues({ ...values, is_active: event.target.checked })} />启用账号</label>
      <p className="account-hint">{self ? '不能停用当前账号或取消自己的管理员身份。重置自己的密码后需要重新登录。' : editing ? '用户名修改后保留历史会话。重置密码或停用账号会注销该账号的登录状态。' : '新账号默认使用初级权限。'}</p>
      <div className="account-form-actions"><button type="submit" disabled={disabled}>{saving ? '正在保存…' : editing ? '保存修改' : '创建账号'}</button><button type="button" disabled={disabled} onClick={() => edit()}>{editing ? '取消编辑' : '清空'}</button></div>
    </form></div>
  </section></Dialog>;
}
