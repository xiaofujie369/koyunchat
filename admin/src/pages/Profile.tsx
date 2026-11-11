import * as React from 'react'
import { toast } from 'sonner'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ls, useStore } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import { BUILTIN_SOUNDS, beep, playSound, soundLabel } from '@/lib/sound'
import type { State } from '@/lib/store'

export default function Profile() {
  const { user, sound, soundKind, volume, theme, sounds, soundDefault, set } = useStore()
  const [name, setName] = React.useState(user?.name || '')
  const [oldp, setOldp] = React.useState('')
  const [newp, setNewp] = React.useState('')
  const save = async () => {
    try { set({ user: await api('PUT', '/api/me', { Name: name, OldPassword: oldp, NewPassword: newp }) }); setOldp(''); setNewp(''); toast.success('已保存') } catch (e) { toast.error(errMsg(e)) }
  }
  const setSound = (on: boolean) => { set({ sound: on }); ls.set('kc_sound', on ? '1' : '0'); if (on) setTimeout(() => beep(), 0) }
  const setKind = (k: string) => { set({ soundKind: k }); ls.set('kc_sound_kind', k); playSound(k) }
  const setVol = (v: number) => { set({ volume: v }); ls.set('kc_volume', String(v)) }
  const setTheme = (t: State['theme']) => { set({ theme: t }); ls.set('kc_theme', t) }
  return (
    <div className="mx-auto max-w-[560px] space-y-4">
      <Card>
        <CardHeader>个人资料</CardHeader>
        <CardBody>
          <Field label="名称（访客看到的客服名）"><Input value={name} onChange={e => setName(e.target.value)} /></Field>
          <Field label="原密码"><Input type="password" value={oldp} onChange={e => setOldp(e.target.value)} autoComplete="current-password" /></Field>
          <Field label="新密码（留空不修改）"><Input type="password" value={newp} onChange={e => setNewp(e.target.value)} autoComplete="new-password" /></Field>
          <Button onClick={save}>保存</Button>
        </CardBody>
      </Card>
      <Card>
        <CardHeader>提示音和外观<span className="text-xs font-normal text-faint">只对这个浏览器生效</span></CardHeader>
        <CardBody>
          <label className="mb-4 flex items-center gap-3 text-sm font-medium">消息提示音 <Switch checked={sound} onCheckedChange={setSound} /></label>
          {sound && <>
            <Field label="提示音样式" hint="管理员可以在 系统设置 → 系统声音设置 上传新的提示音">
              <div className="flex gap-2">
                <NativeSelect value={soundKind} onChange={e => setKind(e.target.value)}>
                  <option value="">跟随系统默认（{soundLabel(soundDefault)}）</option>
                  {sounds.length > 0 && <optgroup label="上传的提示音">{sounds.map(x => <option key={x.id} value={'s:' + x.id}>{x.name}</option>)}</optgroup>}
                  <optgroup label="内置提示音">{BUILTIN_SOUNDS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</optgroup>
                </NativeSelect>
                <Button variant="outline" onClick={() => playSound(soundKind)}>试听</Button>
              </div>
            </Field>
            <Field label={`音量 ${volume}%`}><input type="range" min={10} max={100} step={5} value={volume} onChange={e => setVol(Number(e.target.value))} onMouseUp={() => playSound(soundKind)} onTouchEnd={() => playSound(soundKind)} className="w-full accent-[var(--accent)]" /></Field>
          </>}
          <Field label="外观" className="mb-0"><NativeSelect value={theme} onChange={e => setTheme(e.target.value as State['theme'])}><option value="auto">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></NativeSelect></Field>
        </CardBody>
      </Card>
    </div>
  )
}
