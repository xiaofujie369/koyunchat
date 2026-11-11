import { useStore } from './store'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

// 所有接口都带登录令牌；401 自动退出登录
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const token = useStore.getState().token
  const opt: RequestInit = { method, headers: { Authorization: 'Bearer ' + token } }
  if (body instanceof FormData) opt.body = body
  else if (body !== undefined) { opt.body = JSON.stringify(body); (opt.headers as Record<string, string>)['Content-Type'] = 'application/json' }
  const r = await fetch(path, opt)
  let data: any = null
  try { data = await r.json() } catch { /* 空响应 */ }
  if (r.status === 401) { useStore.getState().logout(); throw new ApiError('登录已过期', 401) }
  if (!r.ok) throw new ApiError((data && data.error) || '请求失败 ' + r.status, r.status)
  return data as T
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
