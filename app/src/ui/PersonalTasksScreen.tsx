import React, { useState, useSyncExternalStore } from 'react';
import { FlatList, I18nManager, Pressable, SafeAreaView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { color, font, minTouch, radius, space } from '../design/tokens';
import { isRtl, strings, type Locale } from '../i18n';
import type { TaskStore } from '../store/TaskStore';
import { TaskRow } from './TaskRow';

export function PersonalTasksScreen({ store, locale, preview }: { store: TaskStore; locale: Locale; preview?: boolean }) {
  const st = useSyncExternalStore(store.subscribe, store.getState);
  const t = strings(locale);
  const [draft, setDraft] = useState('');
  const rtl = isRtl(locale);
  const submit = () => { if (draft.trim()) { store.add(draft); setDraft(''); } };
  const status = !st.online ? { text: t.offline, bg: color.warningBg, fg: color.warning }
    : st.waiting > 0 ? { text: t.waiting(st.waiting), bg: color.warningBg, fg: color.warning }
    : { text: t.synced, bg: color.okBg, fg: color.success };
  void I18nManager;
  return (
    <SafeAreaView style={[s.screen, { direction: rtl ? 'rtl' : 'ltr' }]}>
      <View style={s.header}>
        <Text accessibilityRole="header" style={s.h1}>{t.title}</Text>
        <View style={[s.chip, { backgroundColor: status.bg }]} accessibilityLiveRegion="polite">
          <Text style={[s.chipText, { color: status.fg }]}>{status.text}</Text>
        </View>
        {st.needAttention > 0 ? <Pressable accessibilityRole="button" style={[s.chip, { backgroundColor: color.dangerBg }]}><Text style={[s.chipText, { color: color.danger }]}>{t.inbox(st.needAttention)}</Text></Pressable> : null}
      </View>
      <View style={s.addRow}>
        <TextInput value={draft} onChangeText={setDraft} onSubmitEditing={submit} placeholder={t.placeholder} placeholderTextColor={color.textMuted}
          accessibilityLabel={t.placeholder} style={s.input} returnKeyType="done" maxLength={300} />
        <Pressable accessibilityRole="button" onPress={submit} style={s.addBtn}><Text style={s.addText}>{t.add}</Text></Pressable>
      </View>
      <FlatList
        data={st.tasks} keyExtractor={(x) => x.id} contentContainerStyle={{ padding: space.lg }}
        ListEmptyComponent={<Text style={s.empty}>{t.empty}</Text>}
        renderItem={({ item }) => <TaskRow task={item} doneLabel={t.done} openLabel={t.open} onToggle={() => store.toggle(item.id)} onRemove={() => store.remove(item.id)} />} />
      {preview && store.setOnline ? (
        <View style={s.footer}>
          <Text style={s.note}>{t.preview}</Text>
          <View style={s.toggle}><Text style={s.note}>{t.offlineToggle}</Text><Switch value={!st.online} onValueChange={(v) => store.setOnline?.(!v)} /></View>
        </View>) : null}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  header: { paddingHorizontal: space.lg, paddingTop: space.xl, gap: space.sm, alignItems: 'flex-start' },
  h1: { fontSize: font.title, fontWeight: '700', color: color.text },
  chip: { borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 },
  chipText: { fontSize: font.small, fontWeight: '600' },
  addRow: { flexDirection: 'row', gap: space.sm, padding: space.lg },
  input: { flex: 1, minHeight: minTouch, backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.border, paddingHorizontal: space.md, fontSize: font.body, color: color.text },
  addBtn: { minHeight: minTouch, minWidth: 72, borderRadius: radius.md, backgroundColor: color.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  addText: { color: color.onPrimary, fontSize: font.body, fontWeight: '600' },
  empty: { color: color.textMuted, fontSize: font.body, textAlign: 'center', marginTop: space.xl },
  footer: { padding: space.lg, borderTopWidth: 1, borderColor: color.border, backgroundColor: color.surface, gap: space.sm },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  note: { color: color.textMuted, fontSize: font.small },
});
