// 接口返回的数据结构（字段和后端 JSON 保持一致）
export type Row = Record<string, any>
export interface User { id: number; email: string; name: string; role: 'admin' | 'agent'; avatar?: string; online?: boolean; last_seen?: number; disabled?: number }
export interface Site { id: number; name: string; color: string; site_key: string; ai_mode: string; [k: string]: any }
export interface Attachment { url: string; name?: string; size?: number; type?: string }
export interface Msg { id: number; conversation_id: number; sender_type: 'visitor' | 'agent' | 'ai' | 'note' | 'system'; sender_id: number; sender_name: string; body: string; attachment: Attachment | null | ''; created_at: number }
export interface Conv { id: number; site_id: number; visitor_id: string; status: 'open' | 'closed'; assignee_id: number; ai_paused: number; last_msg: string; last_at: number; unread: number; rating: number; visitor_name?: string; visitor_email?: string; site_name?: string; assignee_name?: string; online?: boolean; [k: string]: any }
export interface Live { id: string; site_id: number; name?: string; email?: string; ext?: any; ip: string; country?: string; region?: string; city?: string; device?: string; os?: string; browser?: string; url?: string; title?: string; connected_at: number; page_since?: number; visits?: number; pages?: number; chatting?: boolean; conversation_id?: number; [k: string]: any }
export interface Channel { id: number; name: string; kind: 'public' | 'private' | 'dm'; topic?: string; unread?: number; last_at?: number; last_msg?: string; peer_id?: number; members?: (Omit<User, 'role'> & { role?: string })[]; my_role?: string; [k: string]: any }
export interface TeamMsg { id: number; channel_id: number; user_id: number; user_name: string; body: string; attachment: Attachment | null | ''; created_at: number }
export interface Room { id: number; name: string; kind: 'public' | 'private'; description?: string; color?: string; member_count?: number; readonly?: number; slow_mode?: number; tg_chat_id?: string; pinned?: Row | null; [k: string]: any }
export interface Sound { id: number; name: string; url: string; size: number; updated_at: number }
