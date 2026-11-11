import { ApiClient, errorMessage, isCancelled, jsonBody } from './api';
import { Store } from './store';
import type { User } from './types';

interface SessionState { user: User | null; checking: boolean; busy: boolean; loggingOut: boolean; error: string; revision: number }
export class Session extends Store<SessionState> {
  readonly api = new ApiClient(() => this.signOut(this.state.user ? '登录已过期或账号已停用，请重新登录。' : ''));
  constructor() { super({ user: null, checking: true, busy: false, loggingOut: false, error: '', revision: 0 }); }
  private enter(user: User) {
    this.api.invalidate();
    this.patch({ user, checking: false, busy: false, loggingOut: false, error: '', revision: this.state.revision + 1 });
  }
  signOut(message = '') {
    this.api.invalidate();
    this.patch({ user: null, checking: false, busy: false, loggingOut: false, error: message, revision: this.state.revision + 1 });
  }
  updateUser(user: User) { this.patch({ user }); }
  async restore() {
    try { this.enter(await this.api.json<User>('/v1/auth/me')); }
    catch (error) {
      if (!isCancelled(error)) this.signOut('暂时无法检查登录状态，请重新登录或稍后重试。');
    }
  }
  async login(username: string, password: string) {
    if (this.state.busy || this.state.checking) return;
    this.patch({ busy: true, error: '' });
    try {
      const data = await this.api.json<{ user: User }>('/v1/auth/login', jsonBody({ username: username.trim(), password }), false);
      // Authentication uses the HttpOnly cookie; never persist the returned token.
      this.enter(data.user);
    } catch (error) {
      if (!isCancelled(error)) this.patch({ busy: false, error: errorMessage(error) });
    }
  }
  async logout() {
    if (this.state.loggingOut) return;
    this.patch({ loggingOut: true, error: '' });
    try { await this.api.json('/v1/auth/logout', { method: 'POST' }); this.signOut(); }
    catch (error) {
      if (!isCancelled(error)) this.patch({ loggingOut: false, error: `退出失败：${errorMessage(error)}` });
    }
  }
}
