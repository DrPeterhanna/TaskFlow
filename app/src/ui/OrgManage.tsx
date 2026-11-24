import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTheme } from '../design/ThemeContext';
import { radius, space } from '../design/tokens';
import { strings, type Locale } from '../i18n';
import { expiryIn, invitableRoles, isLiveInvitation, memberActions, type InvitationRow, type MemberRow, type OrgAdminApi, type Role, type UnitRow } from '../shell/orgAdmin';
import type { Membership } from '../shell/shellModel';
import type { RpcResult } from '../sync/types';
import { ErrorLine, Field, Screen } from './AuthScreens';
import { Button, T } from './primitives';

type ErrKey = 'forbidden' | 'validation' | 'not_found' | 'network' | 'rate_limited' | 'generic';
const errKey = (r: RpcResult & { ok: false }): ErrKey => (['forbidden', 'validation', 'not_found', 'rate_limited'].includes(r.code) ? (r.code as ErrKey) : 'generic');

export function OrgManage({ locale, membership, email, api, onSignOut, onLeft }: {
  locale: Locale; membership: Membership; email: string; api: OrgAdminApi; onSignOut: () => void; onLeft: () => void;
}) {
  const t = strings(locale);
  const th = useTheme();
  const tm = t.org.manage;
  const myRole = membership.role as Role;
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [invites, setInvites] = useState<InvitationRow[] | null>(null);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [err, setErr] = useState<ErrKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | { kind: 'remove'; m: MemberRow } | { kind: 'leave' }>(null);
  const [code, setCode] = useState<string | null>(null);
  const [roleFor, setRoleFor] = useState<MemberRow | null>(null);
  const [role, setRole] = useState<Role>(invitableRoles(myRole)[0] ?? 'member');
  const [unitId, setUnitId] = useState<string>(membership.unit_id ?? '');
  const [maxUses, setMaxUses] = useState('1');
  const [days, setDays] = useState('7');

  const reload = useCallback(async () => {
    const [a, b, c] = await Promise.all([api.members(), api.invitations(), api.units()]);
    if (a.ok && b.ok && c.ok) { setMembers(a.rows); setInvites(b.rows); setUnits(c.rows); setLoadFailed(false); } else setLoadFailed(true);
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);

  const act = async (f: () => Promise<RpcResult>): Promise<RpcResult | null> => {
    if (busy) return null;
    setBusy(true); setErr(null);
    try { const r = await f(); if (!r.ok) setErr(errKey(r)); await reload(); return r; }
    catch { setErr('network'); return null; }
    finally { setBusy(false); }
  };

  const canInvite = invitableRoles(myRole).length > 0 && myRole !== 'member' && myRole !== 'team_leader';
  const unitOptions = units;

  if (code) return (
    <Screen locale={locale}>
      <T variant="display" weight={700} accessibilityRole="header">{tm.codeTitle}</T>
      <T color={th.textMuted}>{tm.codeNote}</T>
      <View style={{ backgroundColor: th.surface, borderRadius: radius.card, padding: space.lg, borderWidth: 1, borderColor: th.borderStrong }}>
        <T variant="title" weight={700} selectable testID="invite-code">{code}</T>
      </View>
      <Button label={tm.done} onPress={() => setCode(null)} />
    </Screen>);

  return (
    <Screen locale={locale}>
      <T variant="display" weight={700} accessibilityRole="header">{membership.org_name}</T>
      <T color={th.textMuted}>{t.org.yourRole}: {t.org.roles[myRole]} · {email}</T>
      <ErrorLine text={err ? tm.errors[err] : null} />
      {loadFailed ? <View style={{ gap: space.sm }}><ErrorLine text={tm.loadError} /><Button label={tm.retry} onPress={() => void reload()} /></View> : null}

      <T variant="heading" weight={600} accessibilityRole="header">{tm.members}</T>
      {(members ?? []).map((m) => {
        const a = memberActions(myRole, m);
        return (
          <View key={m.membership_id} testID={`member-${m.display_name}`} style={{ backgroundColor: th.surface, borderRadius: radius.card, padding: space.md, gap: space.sm, borderWidth: 1, borderColor: th.border }}>
            <T weight={600}>{m.display_name || '—'}{m.is_me ? ` (${tm.you})` : ''}</T>
            <T variant="caption" color={m.status === 'suspended' ? th.warning : th.textMuted}>{t.org.roles[m.role]}{m.status === 'suspended' ? ` · ${tm.suspended}` : ''}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {a.suspend ? <Button kind="secondary" label={tm.suspend} accessibilityLabel={`${tm.suspend} ${m.display_name}`} onPress={() => void act(() => api.setStatus(m.membership_id, 'suspended'))} /> : null}
              {a.reactivate ? <Button kind="secondary" label={tm.reactivate} accessibilityLabel={`${tm.reactivate} ${m.display_name}`} onPress={() => void act(() => api.setStatus(m.membership_id, 'active'))} /> : null}
              {a.setRole ? <Button kind="secondary" label={tm.makeRole} accessibilityLabel={`${tm.makeRole} ${m.display_name}`}
                onPress={() => setRoleFor(roleFor?.membership_id === m.membership_id ? null : m)} /> : null}
              {a.remove ? <Button kind="secondary" label={tm.remove} accessibilityLabel={`${tm.remove} ${m.display_name}`} onPress={() => setConfirm({ kind: 'remove', m })} /> : null}
            </View>
            {roleFor?.membership_id === m.membership_id ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }} testID="role-choices">
                {invitableRoles(myRole).filter((r) => r !== m.role).map((r) => (
                  <Button key={r} label={t.org.roles[r]} accessibilityLabel={`${t.org.roles[r]}: ${m.display_name}`}
                    onPress={() => { setRoleFor(null); void act(() => api.setRole(m.membership_id, r)); }} />))}
                <Button kind="secondary" label={tm.cancel} onPress={() => setRoleFor(null)} />
              </View>) : null}
          </View>);
      })}

      <T variant="heading" weight={600} accessibilityRole="header">{tm.invitations}</T>
      {(invites ?? []).length === 0 && invites ? <T color={th.textMuted}>{tm.noInvites}</T> : null}
      {(invites ?? []).map((i) => {
        const live = isLiveInvitation(i);
        return (
          <View key={i.id} testID={`invite-${i.id}`} style={{ backgroundColor: th.surface, borderRadius: radius.card, padding: space.md, gap: space.xs, borderWidth: 1, borderColor: th.border }}>
            <T weight={600}>{t.org.roles[i.role]} · {tm.invite(i.uses, i.max_uses)}</T>
            <T variant="caption" color={live ? th.success : th.textMuted}>{i.revoked_at ? tm.revoked : live ? tm.live : tm.expired}</T>
            {live ? <Button kind="secondary" label={tm.revoke} onPress={() => void act(() => api.revokeInvitation(i.id))} /> : null}
          </View>);
      })}
      {canInvite ? (
        <View style={{ gap: space.md }}>
          <T variant="heading" weight={600}>{tm.newInvite}</T>
          <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
            {invitableRoles(myRole).map((r) => (
              <Pressable key={r} accessibilityRole="radio" accessibilityState={{ selected: role === r }} accessibilityLabel={t.org.roles[r]} onPress={() => setRole(r)}
                style={{ minHeight: 44, paddingHorizontal: space.lg, justifyContent: 'center', borderRadius: radius.pill, borderWidth: 1, borderColor: role === r ? th.primary : th.borderStrong, backgroundColor: role === r ? th.primary : th.surface }}>
                <T weight={600} color={role === r ? th.onPrimary : th.text}>{t.org.roles[r]}</T>
              </Pressable>))}
          </View>
          <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
            {unitOptions.map((u) => (
              <Pressable key={u.id} accessibilityRole="radio" accessibilityState={{ selected: unitId === u.id }} accessibilityLabel={`${tm.unit} ${u.name}`} onPress={() => setUnitId(u.id)}
                style={{ minHeight: 44, paddingHorizontal: space.lg, justifyContent: 'center', borderRadius: radius.pill, borderWidth: 1, borderColor: unitId === u.id ? th.primary : th.borderStrong, backgroundColor: unitId === u.id ? th.primary : th.surface }}>
                <T weight={600} color={unitId === u.id ? th.onPrimary : th.text}>{u.name}</T>
              </Pressable>))}
          </View>
          <Field label={tm.uses} value={maxUses} onChange={setMaxUses} testID="invite-uses" keyboard="default" />
          <Field label={tm.days} value={days} onChange={setDays} testID="invite-days" keyboard="default" />
          <Button label={tm.create} onPress={() => {
            const n = Number.parseInt(maxUses, 10); const d = Number.parseInt(days, 10);
            if (!unitId || !(n >= 1 && n <= 1000) || !(d >= 1 && d <= 90)) { setErr('validation'); return; }
            void act(() => api.createInvitation(role, unitId, n, expiryIn(d))).then((r) => { if (r?.ok) { const c = (r.data as { code?: string } | null)?.code; if (c) setCode(c); } });
          }} />
        </View>) : null}

      <Button label={tm.leave} kind="secondary" onPress={() => setConfirm({ kind: 'leave' })} />
      <Button label={t.auth.signOut} kind="secondary" onPress={onSignOut} />

      {confirm ? (
        <View accessibilityViewIsModal accessibilityRole="alert" testID="confirm" style={{ backgroundColor: th.warningBg, borderRadius: radius.card, padding: space.lg, gap: space.md }}>
          <T weight={600}>{confirm.kind === 'leave' ? tm.confirmLeave : tm.confirmRemove(confirm.m.display_name)}</T>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button label={tm.confirm} onPress={() => { const c = confirm; setConfirm(null);
              void act(() => (c.kind === 'leave' ? api.leave() : api.setStatus(c.m.membership_id, 'removed'))).then((r) => { if (r?.ok && c.kind === 'leave') onLeft(); }); }} />
            <Button label={tm.cancel} kind="secondary" onPress={() => setConfirm(null)} />
          </View>
        </View>) : null}
    </Screen>
  );
}
