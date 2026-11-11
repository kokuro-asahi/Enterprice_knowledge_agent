export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}
export const cancelled = () => new DOMException('请求已取消', 'AbortError');
export const isCancelled = (error: unknown) => error instanceof Error && error.name === 'AbortError';
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

// Invalidate both pending headers and pending bodies when the login identity changes.
export class ApiClient {
  private version = 0;
  private responses = new WeakMap<Response, number>();
  constructor(private onUnauthorized: () => void) {}
  invalidate() { this.version += 1; }
  async request(path: string, options: RequestInit = {}, handleUnauthorized = true) {
    const version = this.version;
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
    if (version !== this.version) throw cancelled();
    if (response.status === 401 && handleUnauthorized) {
      this.onUnauthorized();
      throw cancelled();
    }
    this.responses.set(response, version);
    return response;
  }
  async read<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (this.responses.get(response) !== this.version) throw cancelled();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new ApiError(`服务响应异常（HTTP ${response.status}），请稍后重试`, response.status); }
    if (!response.ok) throw new ApiError(data.error?.message || `HTTP ${response.status}`, response.status, data.error?.code);
    return data as T;
  }
  async json<T>(path: string, options: RequestInit = {}, handleUnauthorized = true) {
    return this.read<T>(await this.request(path, options, handleUnauthorized));
  }
}
export const jsonBody = (body: unknown, method = 'POST'): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
