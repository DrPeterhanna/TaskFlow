import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../design/ThemeContext';
import { radius, space } from '../design/tokens';
import { strings, type Locale } from '../i18n';
import type { StoreState, TaskStore } from '../store/TaskStore';
import { Button, T } from './primitives';

/** Sync details and recovery. Shows what is saved only on this device, what the server refused, and concurrent-edit outcomes. */
export function SyncPanel({ store, st, locale, now = Date.now() }: { store: TaskStore; st: StoreState; locale: Locale; now?: number }) {
  const th = useTheme();
  const x = strings(locale).sync;
  const sync = st.sync;
  if (!sync) return null;
  const retryIn = sync.phase === 'waiting_retry' && sync.nextRetryAt !== null && sync.nextRetryAt > now ? Math.ceil((sync.nextRetryAt - now) / 1000) : null;
  const last = sync.lastSyncedAt ? new Date(sync.lastSyncedAt).toLocaleTimeString(locale) : null;
  return (
    <View style={[s.panel, { backgroundColor: th.surface, borderColor: th.border }]} testID="sync-panel" accessibilityLiveRegion="polite">
      <T variant="heading" weight={600}>{x.title}</T>
      <T testID="sync-phase">{x.phase[sync.phase]}</T>
      {sync.queued > 0 ? <T color={th.textMuted} testID="sync-queued">{x.queued(sync.queued)}</T> : null}
      {retryIn !== null ? <T color={th.textMuted}>{x.retryIn(retryIn)}</T> : null}
      <T color={th.textMuted} variant="caption">{last ? x.lastSynced(last) : x.never}</T>
      <View style={s.row}>
        <Button label={x.retryNow} kind="secondary" onPress={() => store.retryNow?.()} />
        <Button label={x.resync} kind="secondary" onPress={() => store.fullResync?.()} />
      </View>
      <T variant="caption" color={th.textMuted}>{x.resyncHint}</T>
      {(st.inbox ?? []).map((it) => (
        <View key={it.key} style={[s.item, { borderColor: th.borderStrong }]} testID={`inbox-${it.kind}`}>
          {it.kind === 'rejected' ? (<>
            <T>{x.rejected(it.title, x.why[it.code] ?? x.whyOther)}</T>
            <View style={s.row}>
              {it.retryable ? <Button label={x.retry} kind="secondary" onPress={() => store.retryRejected?.(it.seq)} /> : null}
              <Button label={x.discard} kind="secondary" onPress={() => store.discardRejected?.(it.seq)} />
            </View></>) : null}
          {it.kind === 'conflict' ? (<>
            <T>{x.conflict(it.title, it.field, it.mine, it.theirs)}</T>
            <View style={s.row}>
              {it.restorable ? <Button label={x.restore} onPress={() => store.restoreOtherValue?.(it.id)} /> : null}
              <Button label={x.keep} kind="secondary" onPress={() => store.dismissConflict?.(it.id)} />
            </View></>) : null}
          {it.kind === 'deleted_remotely' ? (<>
            <T>{x.deleted(it.title)}</T>
            <View style={s.row}><Button label={x.ok} kind="secondary" onPress={() => store.dismissConflict?.(it.id)} /></View></>) : null}
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  panel: { marginHorizontal: space.lg, marginBottom: space.md, padding: space.lg, borderWidth: 1, borderRadius: radius.control, gap: space.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  item: { borderTopWidth: 1, paddingTop: space.md, gap: space.sm },
});
