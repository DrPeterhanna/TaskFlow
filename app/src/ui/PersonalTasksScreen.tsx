import React, { useState, useSyncExternalStore } from 'react';
import { FlatList, SafeAreaView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useTheme } from '../design/ThemeContext';
import { fontFamily, minTouch, radius, space, type } from '../design/tokens';
import { isRtl, strings, type Locale } from '../i18n';
import type { TaskStore } from '../store/TaskStore';
import { Pressable } from 'react-native';
import { Button, T } from './primitives';
import { SyncPanel } from './SyncPanel';
import { TaskRow } from './TaskRow';
import { saveTaskTitle } from '../store/taskTitleEdit';

export function PersonalTasksScreen({ store, locale, previewNote, simulateOffline }: {
  store: TaskStore; locale: Locale; previewNote?: boolean; simulateOffline?: { value: boolean; set: (v: boolean) => void };
}) {
  const th = useTheme();
  const st = useSyncExternalStore(store.subscribe, store.getState);
  const t = strings(locale);
  const [draft, setDraft] = useState('');
  const [panel, setPanel] = useState(false);
  const [writeError, setWriteError] = useState(false);
  const [editing, setEditing] = useState<{ id: string; draft: string; original: string } | null>(null);
  const [editError, setEditError] = useState(false);
  const saveEdit = () => {
    if (!editing) return;
    const result = saveTaskTitle(store, editing.id, editing.draft, editing.original);
    if (result.ok) { setEditing(null); setEditError(false); }
    else setEditError(true); // Keep the draft visible, never discard unsaved user text.
  };
  const submit = () => { if (draft.trim()) { try { store.add(draft); setDraft(''); setWriteError(false); } catch { setWriteError(true); } } };
  const ph = st.sync?.phase;
  const status = ph === 'auth_required' ? { text: t.sync.phase.auth_required!, bg: th.dangerBg, fg: th.danger }
    : ph === 'attention' ? { text: t.sync.phase.attention!, bg: th.dangerBg, fg: th.danger }
    : ph === 'waiting_retry' ? { text: t.sync.phase.waiting_retry!, bg: th.warningBg, fg: th.warning }
    : !st.online ? { text: t.offline, bg: th.warningBg, fg: th.warning }
    : st.waiting > 0 ? { text: t.waiting(st.waiting), bg: th.warningBg, fg: th.warning }
    : { text: t.synced, bg: th.successBg, fg: th.success };
  return (
    <SafeAreaView style={[s.screen, { backgroundColor: th.bg, direction: isRtl(locale) ? 'rtl' : 'ltr' }]}>
      <View style={s.header}>
        <T variant="display" weight={700} accessibilityRole="header">{t.title}</T>
        <Pressable accessibilityRole="button" accessibilityLabel={t.sync.open} onPress={() => setPanel((v) => !v)} disabled={!st.sync} testID="sync-chip-button">
          <View style={[s.chip, { backgroundColor: status.bg }]} accessibilityLiveRegion="polite" testID="sync-chip">
            <T variant="caption" weight={600} color={status.fg}>{status.text}</T>
          </View>
        </Pressable>
        {st.needAttention > 0 ? (
          <View style={[s.chip, { backgroundColor: th.dangerBg }]} testID="attention-chip"><T variant="caption" weight={600} color={th.danger}>{t.inbox(st.needAttention)}</T></View>
        ) : null}
      </View>
      {panel ? <SyncPanel store={store} st={st} locale={locale} /> : null}
      {writeError ? <T style={{ marginHorizontal: space.lg }}>{locale === 'ar' ? 'لم يتم حفظ المهمة. احتفظ بالنص وحاول بعد استعادة التخزين.' : 'Task was not saved. Your text is kept. Try again after storage recovery.'}</T> : null}
      <View style={s.addRow}>
        <TextInput value={draft} onChangeText={setDraft} onSubmitEditing={submit} placeholder={t.placeholder} placeholderTextColor={th.textMuted}
          accessibilityLabel={t.placeholder} returnKeyType="done" maxLength={300} testID="new-task"
          {...({ dir: 'auto' } as object)}
          style={[s.input, { backgroundColor: th.surface, borderColor: th.borderStrong, color: th.text, fontFamily: fontFamily[400], fontSize: type.body.size }]} />
        <Button label={t.add} onPress={submit} />
      </View>
      {editing ? <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.sm }}>
        <T weight={600}>{locale === 'ar' ? 'تعديل المهمة' : 'Edit task'}</T>
        <TextInput value={editing.draft} onChangeText={draft => { setEditing({ ...editing, draft }); setEditError(false); }}
          accessibilityLabel={locale === 'ar' ? 'عنوان المهمة' : 'Task title'} maxLength={300} testID="edit-task-title"
          onSubmitEditing={saveEdit} style={[s.input, { flex: 0, width: '100%', backgroundColor: th.surface, borderColor: th.borderStrong, color: th.text, fontFamily: fontFamily[400], fontSize: type.body.size }]} />
        {editError ? <T color={th.danger}>{locale === 'ar' ? 'لم يتم حفظ التعديل. النص محفوظ هنا. تحقق من العنوان والتخزين ثم حاول مرة أخرى.' : 'Edit was not saved. Your draft is kept here. The task may have changed. Copy your draft before cancelling, or check storage and try again.'}</T> : null}
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Button label={locale === 'ar' ? 'حفظ' : 'Save'} onPress={saveEdit} />
          <Button label={locale === 'ar' ? 'إلغاء' : 'Cancel'} kind="secondary" onPress={() => { setEditing(null); setEditError(false); }} />
        </View>
      </View> : null}
      <FlatList data={st.tasks} keyExtractor={(x) => x.id} contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl }}
        ListEmptyComponent={<View style={s.empty}><T variant="heading" weight={600}>{t.empty}</T><T color={th.textMuted} style={{ textAlign: 'center' }}>{t.emptyHint}</T></View>}
        renderItem={({ item }) => <TaskRow task={item} t={t} editLabel={locale === 'ar' ? `تعديل ${item.title}` : `Edit ${item.title}`}
          onEdit={store.rename ? () => { if (!editing) { setEditing({ id: item.id, draft: item.title, original: item.title }); setEditError(false); } } : undefined} onToggle={() => { try { store.toggle(item.id); } catch { setWriteError(true); } }} onRemove={() => { try { store.remove(item.id); } catch { setWriteError(true); } }} />} />
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
  input: { flex: 1, minWidth: 0, minHeight: minTouch, borderRadius: radius.control, borderWidth: 1, paddingHorizontal: space.md },
  empty: { alignItems: 'center', gap: space.sm, marginTop: space.xxl, paddingHorizontal: space.xl },
  footer: { padding: space.lg, borderTopWidth: 1, gap: space.sm },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
