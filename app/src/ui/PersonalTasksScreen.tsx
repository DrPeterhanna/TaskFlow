import React, { useState, useSyncExternalStore } from 'react';
import { FlatList, SafeAreaView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useTheme } from '../design/ThemeContext';
import { fontFamily, minTouch, radius, space, type } from '../design/tokens';
import { isRtl, strings, type Locale } from '../i18n';
import type { TaskStore } from '../store/TaskStore';
import { Button, T } from './primitives';
import { TaskRow } from './TaskRow';

export function PersonalTasksScreen({ store, locale, previewNote, simulateOffline }: {
  store: TaskStore; locale: Locale; previewNote?: boolean; simulateOffline?: { value: boolean; set: (v: boolean) => void };
}) {
  const th = useTheme();
  const st = useSyncExternalStore(store.subscribe, store.getState);
  const t = strings(locale);
  const [draft, setDraft] = useState('');
  const submit = () => { if (draft.trim()) { store.add(draft); setDraft(''); } };
  const status = !st.online ? { text: t.offline, bg: th.warningBg, fg: th.warning }
    : st.waiting > 0 ? { text: t.waiting(st.waiting), bg: th.warningBg, fg: th.warning }
    : { text: t.synced, bg: th.successBg, fg: th.success };
  return (
    <SafeAreaView style={[s.screen, { backgroundColor: th.bg, direction: isRtl(locale) ? 'rtl' : 'ltr' }]}>
      <View style={s.header}>
        <T variant="display" weight={700} accessibilityRole="header">{t.title}</T>
        <View style={[s.chip, { backgroundColor: status.bg }]} accessibilityLiveRegion="polite" testID="sync-chip">
          <T variant="caption" weight={600} color={status.fg}>{status.text}</T>
        </View>
        {st.needAttention > 0 ? (
          <View style={[s.chip, { backgroundColor: th.dangerBg }]} testID="attention-chip"><T variant="caption" weight={600} color={th.danger}>{t.inbox(st.needAttention)}</T></View>
        ) : null}
      </View>
      <View style={s.addRow}>
        <TextInput value={draft} onChangeText={setDraft} onSubmitEditing={submit} placeholder={t.placeholder} placeholderTextColor={th.textMuted}
          accessibilityLabel={t.placeholder} returnKeyType="done" maxLength={300} testID="new-task"
          {...({ dir: 'auto' } as object)}
          style={[s.input, { backgroundColor: th.surface, borderColor: th.borderStrong, color: th.text, fontFamily: fontFamily[400], fontSize: type.body.size }]} />
        <Button label={t.add} onPress={submit} />
      </View>
      <FlatList data={st.tasks} keyExtractor={(x) => x.id} contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl }}
        ListEmptyComponent={<View style={s.empty}><T variant="heading" weight={600}>{t.empty}</T><T color={th.textMuted} style={{ textAlign: 'center' }}>{t.emptyHint}</T></View>}
        renderItem={({ item }) => <TaskRow task={item} t={t} onToggle={() => store.toggle(item.id)} onRemove={() => store.remove(item.id)} />} />
      {previewNote ? (
        <View style={[s.footer, { backgroundColor: th.surface, borderColor: th.border }]}>
          <T variant="caption" color={th.textMuted}>{t.previewNote}</T>
          {simulateOffline ? (
            <View style={s.toggle}>
              <T variant="caption" color={th.textMuted}>{t.simulateOffline}</T>
              <Switch value={simulateOffline.value} onValueChange={simulateOffline.set} accessibilityLabel={t.simulateOffline} testID="offline-switch" />
            </View>) : null}
        </View>) : null}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: space.lg, paddingTop: space.xl, gap: space.sm, alignItems: 'flex-start' },
  chip: { borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs },
  addRow: { flexDirection: 'row', gap: space.sm, padding: space.lg },
  input: { flex: 1, minHeight: minTouch, borderRadius: radius.control, borderWidth: 1, paddingHorizontal: space.md },
  empty: { alignItems: 'center', gap: space.sm, marginTop: space.xxl, paddingHorizontal: space.xl },
  footer: { padding: space.lg, borderTopWidth: 1, gap: space.sm },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
