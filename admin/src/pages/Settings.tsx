import * as React from 'react'
import { Bell, Bot, Send, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Hint, Input, NativeSelect } from '@/components/ui/input'
import { Section } from '@/components/ui/section'
import { Modal } from '@/components/ui/dialog'
import { Table, Td, Th, Tr } from '@/components/ui/table'
import { useStore } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import { fmtSize, fmtTime } from '@/lib/format'
import { BUILTIN_SOUNDS, playSound, soundLabel } from '@/lib/sound'
import type { Row, Sound } from '@/lib/types'

const CLAUDE_MODELS: [string, string][] = [
  ['claude-opus-5-5', 'Claude Opus 5.5 · 推荐（聪明，价格适中）'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 · 均衡（更快，约半价）'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5 · 最快最便宜'],
  ['claude-fable-5-2', 'Claude Fable 5.2 · 最强（最贵）'],
]

export default function Settings() {
  const [f, setF] = React.useState<Row>({})
  const [tg, setTg] = React.useState<Row>({})
  const loadTG = async () => { try { setTg(await api('GET', '/api/telegram/status')) } catch { /* 忽略 */ } }
  React.useEffect(() => { api('GET', '/api/settings').then(setF).catch(e => toast.error(errMsg(e))); loadTG() }, [])
  return (
    <div className="mx-auto max-w-[860px] space-y-3">
      <p className="text-[13px] text-muted-foreground">点击每一项展开设置，标题下面显示的是当前状态。</p>
      <SoundSection />
      <AISection f={f} setF={setF} />
      <TelegramSection f={f} setF={setF} tg={tg} loadTG={loadTG} />
    </div>
  )
}

// ---------- 系统声音 ----------
function SoundSection() {
  const { sounds, soundDefault } = useStore()
  const file = React.useRef<HTMLInputElement>(null), rfile = React.useRef<HTMLInputElement>(null)
  const [name, setName] = React.useState('')
  const [makeDefault, setMakeDefault] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [cur, setCur] = React.useState<{ id: number; name: string } | null>(null)
  const apply = (r: Row) => useStore.getState().set({ sounds: r.sounds || [], soundDefault: r.default || 'turn' })
  const pick = (input: HTMLInputElement | null) => {
    const f = input?.files?.[0]
    if (!f) return null
    if (f.size > 2 * 1024 * 1024) { toast.error('声音文件不能超过 2MB'); return false }
    return f
  }
  const upload = async () => {
    const f = pick(file.current)
    if (f === null) return toast.error('请先选择声音文件')
    if (!f) return
    const fd = new FormData(); fd.append('file', f); fd.append('name', name.trim()); if (makeDefault) fd.append('make_default', '1')
    setBusy(true)
    try { apply(await api('POST', '/api/sounds', fd)); setName(''); setMakeDefault(false); file.current!.value = ''; toast.success('已上传') } catch (e) { toast.error(errMsg(e)) }
    setBusy(false)
  }
  const saveEdit = async () => {
    const f = pick(rfile.current)
    if (f === false) return
    const fd = new FormData(); fd.append('name', cur!.name.trim()); if (f) fd.append('file', f)
    setBusy(true)
    try { apply(await api('PUT', '/api/sounds/' + cur!.id, fd)); setCur(null); toast.success('已保存') } catch (e) { toast.error(errMsg(e)) }
    setBusy(false)
  }
  const del = async (x: Sound) => {
    if (!confirm('删除提示音「' + x.name + '」？正在使用它的客服会自动改用系统默认声音。')) return
    try { apply(await api('DELETE', '/api/sounds/' + x.id)); toast.success('已删除') } catch (e) { toast.error(errMsg(e)) }
  }
  const setDefault = async (k: string) => {
    try { await api('PUT', '/api/settings', { sound_default: k }); useStore.getState().set({ soundDefault: k }); toast.success('已设为默认：' + soundLabel(k)); playSound(k) } catch (e) { toast.error(errMsg(e)) }
  }
  return (
    <Section id="sound" icon={<Bell />} title="系统声音设置" summary={`默认提示音：${soundLabel(soundDefault)} · 已上传 ${sounds.length} 个`}>
      <Hint className="mt-0 mb-3">从电脑上传提示音（mp3 / m4a / wav / ogg，最大 2MB，建议 1–3 秒）。设为默认后，所有客服没有单独选择时都会听到这个声音；客服也可以在「个人设置」里自己选。</Hint>
      <Table>
        <thead><tr><Th className="w-14">默认</Th><Th>名称</Th><Th>大小</Th><Th>更新时间</Th><Th /></tr></thead>
        <tbody>
          {sounds.map(x => (
            <Tr key={x.id}>
              <Td><input type="radio" name="sound-default" checked={soundDefault === 's:' + x.id} onChange={() => setDefault('s:' + x.id)} /></Td>
              <Td>{x.name}</Td><Td className="text-xs">{fmtSize(x.size)}</Td><Td className="text-xs">{fmtTime(x.updated_at)}</Td>
              <Td className="whitespace-nowrap"><Button size="xs" variant="outline" onClick={() => playSound('s:' + x.id)}>试听</Button> <Button size="xs" variant="outline" onClick={() => setCur({ id: x.id, name: x.name })}>修改</Button> <Button size="xs" variant="danger" onClick={() => del(x)}>删除</Button></Td>
            </Tr>
          ))}
          {BUILTIN_SOUNDS.map(([k, t]) => (
            <Tr key={k}>
              <Td><input type="radio" name="sound-default" checked={soundDefault === k} onChange={() => setDefault(k)} /></Td>
              <Td>{t} <Badge>内置</Badge></Td><Td className="text-xs text-faint">-</Td><Td className="text-xs text-faint">-</Td>
              <Td><Button size="xs" variant="outline" onClick={() => playSound(k)}>试听</Button></Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <div className="mt-4 flex flex-wrap items-center gap-2.5 rounded-xl border border-dashed p-3">
        <Input className="w-60" value={name} onChange={e => setName(e.target.value)} placeholder="声音名称（可选，默认用文件名）" />
        <input ref={file} type="file" accept=".mp3,.m4a,.wav,.ogg,audio/*" className="max-w-60 text-xs" />
        <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={makeDefault} onChange={e => setMakeDefault(e.target.checked)} />设为默认</label>
        <Button onClick={upload} disabled={busy}><Upload />{busy ? '上传中…' : '上传提示音'}</Button>
      </div>
      {cur && (
        <Modal title="修改提示音" onClose={() => setCur(null)} footer={<><Button variant="outline" onClick={() => setCur(null)}>取消</Button><Button onClick={saveEdit} disabled={busy}>保存</Button></>}>
          <Field label="名称"><Input value={cur.name} onChange={e => setCur({ ...cur, name: e.target.value })} /></Field>
          <Field label="替换声音文件（不选则只改名称）"><input ref={rfile} type="file" accept=".mp3,.m4a,.wav,.ogg,audio/*" className="text-xs" /></Field>
        </Modal>
      )}
    </Section>
  )
}

// ---------- AI ----------
function AISection({ f, setF }: { f: Row; setF: (f: Row) => void }) {
  const setAi = (v: boolean) => useStore.getState().set({ ai: v })
  const [models, setModels] = React.useState<string[]>([])
  const [sel, setSel] = React.useState('claude-opus-5-5')
  const [custom, setCustom] = React.useState('')
  const [fetching, setFetching] = React.useState(false)
  const [fetchMsg, setFetchMsg] = React.useState('')
  const [testing, setTesting] = React.useState(false)
  const [testMsg, setTestMsg] = React.useState('')
  React.useEffect(() => { if (f.ai_model !== undefined) setSel(f.ai_model || 'claude-opus-5-5') }, [f.ai_model])
  const known = CLAUDE_MODELS.map(m => m[0])
  const pool = [...models, ...(f.ai_model && !models.includes(f.ai_model) ? [f.ai_model] : [])].filter(m => !known.includes(m))
  const chosen = sel === '__custom' ? custom.trim() : sel
  const proto = (f.ai_provider || (/^claude/i.test(chosen) ? 'anthropic' : 'openai')) === 'anthropic' ? 'Claude 协议' : 'OpenAI / GPT 协议'
  const up = (k: string, v: string) => setF({ ...f, [k]: v })

  const save = async () => {
    if (sel === '__custom' && !custom.trim()) { toast.error('请输入模型名'); return false }
    try {
      const r = await api('PUT', '/api/settings', { ai_base_url: f.ai_base_url || '', ai_api_key: f.ai_api_key || '', ai_model: chosen, ai_provider: f.ai_provider || '', ai_effort: f.ai_effort || '' })
      setF(r); setAi(!!r.ai_key_hint); toast.success('已保存'); return true
    } catch (e) { toast.error(errMsg(e)); return false }
  }
  const fetchModels = async () => {
    setFetching(true); setFetchMsg('')
    try { const r = await api('POST', '/api/settings/ai-models', { ai_base_url: f.ai_base_url || '', ai_api_key: f.ai_api_key || '' }); setModels(r.models); setFetchMsg('✅ 获取到 ' + r.models.length + ' 个模型，请在下拉框里选择') }
    catch (e) { setFetchMsg('❌ ' + errMsg(e)) }
    setFetching(false)
  }
  const test = async () => {
    setTesting(true); setTestMsg('')
    if (await save()) { try { const r = await api('POST', '/api/settings/ai-test'); setTestMsg('✅ ' + r.text) } catch (e) { setTestMsg('❌ ' + errMsg(e)) } }
    setTesting(false)
  }
  const summary = f.ai_key_hint ? `${f.ai_model || 'claude-opus-5-5'} · ${f.ai_base_url ? '中转接口' : '官方接口'} · Key ${f.ai_key_hint.replace('已设置 ', '')}` : '未配置 API Key'
  return (
    <Section id="ai" icon={<Bot />} title="AI 设置" summary={summary} badge={<Badge tone={f.ai_key_hint ? 'ok' : 'default'}>{f.ai_key_hint ? '已配置' : '未配置'}</Badge>}>
      <Field label="接口地址" hint="用中转站（比如 sub2api）就填中转站地址，后面带不带 /v1 都可以"><Input value={f.ai_base_url || ''} onChange={e => up('ai_base_url', e.target.value)} placeholder="留空 = Claude 官方接口" /></Field>
      <Field label="API Key" hint={f.ai_key_hint ? f.ai_key_hint + '，留空保持不变，填 - 清除' : '填官方或中转站给你的 Key'}>
        <Input type="password" autoComplete="off" value={f.ai_api_key || ''} onChange={e => up('ai_api_key', e.target.value)} placeholder={f.ai_key_hint || 'sk-…'} /></Field>
      <Field label={<>模型 <Badge tone="accent" className="ml-1">使用 {proto}</Badge></>} hint={fetchMsg || '点「获取模型列表」会读取中转站支持的全部模型（Claude 和 GPT 都会列出来）'}>
        <div className="flex gap-2">
          <NativeSelect value={sel} onChange={e => setSel(e.target.value)}>
            <optgroup label="Claude 模型（推荐）">{CLAUDE_MODELS.map(m => <option key={m[0]} value={m[0]}>{m[1]}</option>)}</optgroup>
            {pool.some(m => /^claude/i.test(m)) && <optgroup label="Claude 模型（中转站提供）">{pool.filter(m => /^claude/i.test(m)).map(m => <option key={m} value={m}>{m}</option>)}</optgroup>}
            {pool.some(m => !/^claude/i.test(m)) && <optgroup label="GPT / 其他模型">{pool.filter(m => !/^claude/i.test(m)).map(m => <option key={m} value={m}>{m}</option>)}</optgroup>}
            <option value="__custom">✏️ 手动输入模型名…</option>
          </NativeSelect>
          <Button variant="outline" onClick={fetchModels} disabled={fetching}>{fetching ? '获取中…' : '获取模型列表'}</Button>
        </div>
        {sel === '__custom' && <Input className="mt-2" value={custom} onChange={e => setCustom(e.target.value)} placeholder="输入模型名，例如 gpt-6-sol" />}
      </Field>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="接口协议" hint="自动识别：模型名以 claude 开头用 Claude 协议，其他用 OpenAI 协议">
          <NativeSelect value={f.ai_provider || ''} onChange={e => up('ai_provider', e.target.value)}><option value="">自动识别（推荐）</option><option value="anthropic">Claude 协议</option><option value="openai">OpenAI / GPT 协议</option></NativeSelect></Field>
        <Field label="思考强度"><NativeSelect value={f.ai_effort || ''} onChange={e => up('ai_effort', e.target.value)}><option value="">low（默认，回复最快）</option><option value="medium">medium（更仔细）</option><option value="high">high（最准确，较慢较贵）</option></NativeSelect></Field>
      </div>
      <div className="flex flex-wrap items-center gap-2"><Button onClick={save}>保存</Button><Button variant="outline" onClick={test} disabled={testing}>{testing ? '测试中…' : '测试连接'}</Button><span className="text-xs text-muted-foreground">{testMsg}</span></div>
    </Section>
  )
}

// ---------- Telegram ----------
function TelegramSection({ f, setF, tg, loadTG }: { f: Row; setF: (f: Row) => void; tg: Row; loadTG: () => void }) {
  const save = async () => {
    try {
      setF(await api('PUT', '/api/settings', { tg_bot_token: f.tg_bot_token || '', tg_support_chat_id: f.tg_support_chat_id || '', console_url: location.origin + location.pathname.replace(/\/$/, '') }))
      toast.success('已保存'); setTimeout(loadTG, 2500)
    } catch (e) { toast.error(errMsg(e)) }
  }
  const chats: Row[] = tg.chats || []
  const state = tg.running ? '运行中 @' + tg.bot : tg.configured ? '异常' : '未配置'
  const summary = tg.running ? `机器人 @${tg.bot} · 发现 ${chats.length} 个群${f.tg_support_chat_id ? ' · 已设客服接待群' : ''}` : tg.configured ? '机器人连接异常：' + (tg.error || '未知原因') : '未配置机器人'
  return (
    <Section id="telegram" icon={<Send />} title="Telegram 互通" summary={summary} badge={<Badge tone={tg.running ? 'ok' : tg.configured ? 'bad' : 'default'}>{state}</Badge>}>
      <Field label="Bot Token" hint={tg.error ? <span className="text-bad">{tg.error}</span> : f.tg_token_hint ? f.tg_token_hint + '，留空保持不变，填 - 清除' : '在 @BotFather 创建一个专用机器人'}>
        <Input type="password" autoComplete="off" value={f.tg_bot_token || ''} onChange={e => setF({ ...f, tg_bot_token: e.target.value })} placeholder={f.tg_token_hint || '123456:ABC…'} /></Field>
      <Field label="客服接待群（可选）" hint="网页客服的每个会话会自动在这个群建立一个话题，客服可以直接在 TG 回复访客，发送 /close 结束会话，/note 写内部备注">
        <NativeSelect value={f.tg_support_chat_id || ''} onChange={e => setF({ ...f, tg_support_chat_id: e.target.value })}>
          <option value="">不使用</option>{chats.map(c => <option key={c.id} value={c.id}>{c.title}（{c.id}）{c.is_forum ? ' · 话题模式' : ' · 普通群（建议开启话题）'}</option>)}
        </NativeSelect></Field>
      <Field label="机器人发现的群组">
        <Table>
          <thead><tr><Th>群组</Th><Th>Chat ID</Th><Th>类型</Th></tr></thead>
          <tbody>
            {chats.map(c => <Tr key={c.id}><Td>{c.title}</Td><Td className="font-mono text-xs">{c.id}</Td><Td>{c.is_forum ? '话题群' : c.type}</Td></Tr>)}
            {!chats.length && <Tr><Td colSpan={3} className="py-6 text-center text-faint">还没有群组。把机器人拉进群并在群里发一条消息，然后点刷新</Td></Tr>}
          </tbody>
        </Table>
      </Field>
      <div className="flex gap-2"><Button onClick={save}>保存</Button><Button variant="outline" onClick={loadTG}>刷新</Button></div>
      <ol className="mt-4 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
        <li>在 Telegram 找 @BotFather → /newbot 创建机器人，复制 Token 填到上面</li>
        <li>@BotFather → /setprivacy → 选择机器人 → Disable（机器人才能看到群里所有消息）</li>
        <li>把机器人拉进群并设为管理员（需要“删除消息”权限；客服接待群还需要“管理话题”权限）</li>
        <li>在每个群里随便发一条消息，回来点「刷新」就能看到群组</li>
        <li>社区群聊 → 群设置 → 「互通 Telegram 群组」选择对应的群</li>
      </ol>
    </Section>
  )
}
