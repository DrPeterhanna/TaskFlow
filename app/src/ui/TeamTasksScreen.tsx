import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, SafeAreaView, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '../design/ThemeContext';
import { fontFamily, minTouch, radius, space, type } from '../design/tokens';
import { isRtl, type Locale } from '../i18n';
import type { MemberRow, OrgAdminApi, UnitRow } from '../shell/orgAdmin';
import type { OrgTaskPriority, OrgTaskRow, OrgTasksApi, OrgTaskStatus } from '../shell/orgTasks';
import type { Membership } from '../shell/shellModel';
import { Button, T } from './primitives';

export function TeamTasksScreen({
  locale,
  membership,
  tasksApi,
  adminApi,
}: {
  locale: Locale;
  membership: Membership;
  tasksApi: OrgTasksApi;
  adminApi: OrgAdminApi;
}) {
  const th = useTheme();
  const ar = locale === 'ar';
  const [tasks, setTasks] = useState<OrgTaskRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'mine' | 'open'>('open');
  const [search, setSearch] = useState('');

  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [priority, setPriority] = useState<OrgTaskPriority>('normal');
  const [selectedUnit, setSelectedUnit] = useState<string>(membership.unit_id ?? '');
  const [selectedAssignee, setSelectedAssignee] = useState<string>(membership.membership_id);

  const load = useCallback(async () => {
    setError(null);
    const [tr, mr, ur] = await Promise.all([tasksApi.list(), adminApi.members(), adminApi.units()]);
    if (tr.ok) setTasks(tr.rows);
    else setError(ar ? 'تعذر تحميل مهام الفريق' : 'Could not load team tasks');
    if (mr.ok) setMembers(mr.rows.filter((m: MemberRow) => m.status === 'active'));
    if (ur.ok) {
      setUnits(ur.rows);
      if (!selectedUnit && ur.rows.length > 0) setSelectedUnit(ur.rows[0]!.id);
    }
    setLoading(false);
  }, [tasksApi, adminApi, ar, selectedUnit]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    const clean = title.trim();
    const targetUnit = selectedUnit || membership.unit_id || units[0]?.id;
    if (!clean || !targetUnit || busy) return;
    const cleanDue = /^\d{4}-\d{2}-\d{2}$/.test(dueDate.trim()) ? dueDate.trim() : null;
    setBusy(true);
    setError(null);
    try {
      const r = await tasksApi.create(clean, targetUnit, selectedAssignee || membership.membership_id, priority, cleanDue);
      if (r.ok) {
        setTitle('');
        setDueDate('');
        setPriority('normal');
        await load();
      } else {
        setError(r.message ?? (ar ? 'تعذر إنشاء المهمة' : 'Could not create task'));
      }
    } finally {
      setBusy(false);
    }
  };

  const cycleStatus = async (item: OrgTaskRow) => {
    const next: OrgTaskStatus =
      item.status === 'todo' ? 'in_progress' : item.status === 'in_progress' ? 'done' : 'todo';
    const r = await tasksApi.setStatus(item.id, next);
    if (r.ok) void load();
  };

  const handleRemove = async (id: string) => {
    const r = await tasksApi.remove(id);
    if (r.ok) void load();
  };

  const todayStr = new Date().toISOString().slice(0, 10);
  const openCount = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').length;
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const overdueCount = tasks.filter(
    (t) => (t.status === 'todo' || t.status === 'in_progress') && t.due_date && t.due_date < todayStr,
  ).length;

  const q = search.trim().toLowerCase();
  const filtered = tasks.filter((t) => {
    if (filter === 'mine' && !t.is_mine) return false;
    if (filter === 'open' && t.status !== 'todo' && t.status !== 'in_progress') return false;
    if (q && !t.title.toLowerCase().includes(q) && !(t.assignee_name ?? '').toLowerCase().includes(q)) return false;
    return true;
  });

  const priorityLabel = (p: OrgTaskPriority) =>
    ar
      ? { low: 'منخفضة', normal: 'عادية', high: 'عالية', urgent: 'عاجلة' }[p]
      : { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' }[p];

  const statusLabel = (st: OrgTaskStatus) =>
    ar
      ? { todo: 'قيد الانتظار', in_progress: 'جاري التنفيذ', done: 'مكتملة', canceled: 'ملغاة' }[st]
      : { todo: 'To Do', in_progress: 'In Progress', done: 'Done', canceled: 'Canceled' }[st];

  return (
    <SafeAreaView style={[s.screen, { backgroundColor: th.bg, direction: isRtl(locale) ? 'rtl' : 'ltr' }]}>
      <View style={s.header}>
        <T variant="display" weight={700} accessibilityRole="header">
          {ar ? `مهام ${membership.org_name}` : `${membership.org_name} Tasks`}
        </T>

        <View style={s.statsRow}>
          <View style={[s.statCard, { backgroundColor: th.surface, borderColor: th.border }]}>
            <T variant="heading" weight={700} color={th.primary}>{openCount}</T>
            <T variant="caption" color={th.textMuted}>{ar ? 'نشطة' : 'Active'}</T>
          </View>
          <View style={[s.statCard, { backgroundColor: th.surface, borderColor: th.border }]}>
            <T variant="heading" weight={700} color={overdueCount > 0 ? th.danger : th.text}>{overdueCount}</T>
            <T variant="caption" color={th.textMuted}>{ar ? 'متأخرة' : 'Overdue'}</T>
          </View>
          <View style={[s.statCard, { backgroundColor: th.surface, borderColor: th.border }]}>
            <T variant="heading" weight={700} color={th.success}>{doneCount}</T>
            <T variant="caption" color={th.textMuted}>{ar ? 'مكتملة' : 'Done'}</T>
          </View>
        </View>

        <View style={s.filterRow}>
          {([
            ['open', ar ? 'النشطة' : 'Active'],
            ['mine', ar ? 'مهامي' : 'Assigned to me'],
            ['all', ar ? 'الكل' : 'All'],
          ] as const).map(([k, lbl]) => (
            <Pressable
              key={k}
              onPress={() => setFilter(k)}
              style={[
                s.chip,
                {
                  backgroundColor: filter === k ? th.primary : th.surface,
                  borderColor: filter === k ? th.primary : th.border,
                  borderWidth: 1,
                },
              ]}
            >
              <T variant="caption" weight={600} color={filter === k ? '#fff' : th.text}>
                {lbl}
              </T>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={[s.composer, { backgroundColor: th.surface, borderColor: th.border }]}>
        <View style={s.row}>
          <TextInput
            value={title}
            onChangeText={setTitle}
            onSubmitEditing={() => void handleCreate()}
            placeholder={ar ? 'مهمة جديدة للفريق...' : 'Assign a new team task...'}
            placeholderTextColor={th.textMuted}
            maxLength={300}
            style={[
              s.input,
              { backgroundColor: th.bg, borderColor: th.borderStrong, color: th.text, fontFamily: fontFamily[400], fontSize: type.body.size },
            ]}
          />
          <Button label={busy ? '...' : ar ? 'إسناد' : 'Assign'} onPress={() => void handleCreate()} />
        </View>

        <View style={s.row}>
          <TextInput
            value={dueDate}
            onChangeText={setDueDate}
            placeholder={ar ? 'تاريخ الاستحقاق YYYY-MM-DD (اختياري)' : 'Due date YYYY-MM-DD (optional)'}
            placeholderTextColor={th.textMuted}
            maxLength={10}
            style={[
              s.smallInput,
              { backgroundColor: th.bg, borderColor: th.border, color: th.text, fontFamily: fontFamily[400] },
            ]}
          />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={ar ? 'بحث...' : 'Search...'}
            placeholderTextColor={th.textMuted}
            maxLength={80}
            style={[
              s.smallInput,
              { backgroundColor: th.bg, borderColor: th.border, color: th.text, fontFamily: fontFamily[400] },
            ]}
          />
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.pillStrip}>
          {(['normal', 'high', 'urgent', 'low'] as OrgTaskPriority[]).map((p) => (
            <Pressable
              key={p}
              onPress={() => setPriority(p)}
              style={[
                s.miniPill,
                {
                  backgroundColor: priority === p ? th.primary : th.bg,
                  borderColor: priority === p ? th.primary : th.border,
                },
              ]}
            >
              <T variant="caption" weight={600} color={priority === p ? '#fff' : th.textMuted}>
                {priorityLabel(p)}
              </T>
            </Pressable>
          ))}
        </ScrollView>

        {members.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.pillStrip}>
            <T variant="caption" color={th.textMuted} style={{ alignSelf: 'center' }}>
              {ar ? 'المكلّف:' : 'Assignee:'}
            </T>
            {members.map((m) => (
              <Pressable
                key={m.membership_id}
                onPress={() => setSelectedAssignee(m.membership_id)}
                style={[
                  s.miniPill,
                  {
                    backgroundColor: selectedAssignee === m.membership_id ? th.primary : th.bg,
                    borderColor: selectedAssignee === m.membership_id ? th.primary : th.border,
                  },
                ]}
              >
                <T variant="caption" weight={600} color={selectedAssignee === m.membership_id ? '#fff' : th.text}>
                  {m.is_me ? (ar ? `${m.display_name} (أنا)` : `${m.display_name} (Me)`) : m.display_name}
                </T>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        {units.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.pillStrip}>
            <T variant="caption" color={th.textMuted} style={{ alignSelf: 'center' }}>
              {ar ? 'الوحدة:' : 'Unit:'}
            </T>
            {units.map((u) => (
              <Pressable
                key={u.id}
                onPress={() => setSelectedUnit(u.id)}
                style={[
                  s.miniPill,
                  {
                    backgroundColor: selectedUnit === u.id ? th.primary : th.bg,
                    borderColor: selectedUnit === u.id ? th.primary : th.border,
                  },
                ]}
              >
                <T variant="caption" weight={600} color={selectedUnit === u.id ? '#fff' : th.text}>
                  {u.name}
                </T>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </View>

      {error ? (
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
          <T color={th.danger}>{error}</T>
        </View>
      ) : null}

      {loading ? (
        <ActivityIndicator style={{ marginTop: space.xxl }} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(x) => x.id}
          refreshing={loading}
          onRefresh={() => void load()}
          contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl }}
          ListEmptyComponent={
            <View style={s.empty}>
              <T variant="heading" weight={600}>
                {ar ? 'لا توجد مهام مطابقة' : 'No matching team tasks'}
              </T>
              <T color={th.textMuted} style={{ textAlign: 'center' }}>
                {ar ? 'أضف مهمة بالأعلى وأسندها لنفسك أو لأحد أعضاء فريقك.' : 'Create a task above and assign it to yourself or a team member.'}
              </T>
            </View>
          }
          renderItem={({ item }) => {
            const isOverdue = (item.status === 'todo' || item.status === 'in_progress') && item.due_date && item.due_date < todayStr;
            return (
              <View style={[s.card, { backgroundColor: th.surface, borderColor: isOverdue ? th.danger : th.border }]}>
                <View style={s.cardTop}>
                  <Pressable onPress={() => void cycleStatus(item)} style={{ flex: 1 }}>
                    <T
                      weight={600}
                      style={item.status === 'done' ? { textDecorationLine: 'line-through', opacity: 0.6 } : undefined}
                    >
                      {item.title}
                    </T>
                  </Pressable>
                  <Pressable onPress={() => void handleRemove(item.id)} hitSlop={8}>
                    <T variant="caption" color={th.danger}>
                      {ar ? 'حذف' : 'Delete'}
                    </T>
                  </Pressable>
                </View>
                <View style={s.metaRow}>
                  <Pressable
                    onPress={() => void cycleStatus(item)}
                    style={[
                      s.badge,
                      {
                        backgroundColor:
                          item.status === 'done'
                            ? th.successBg
                            : item.status === 'in_progress'
                              ? th.warningBg
                              : th.bg,
                      },
                    ]}
                  >
                    <T
                      variant="caption"
                      weight={600}
                      color={
                        item.status === 'done'
                          ? th.success
                          : item.status === 'in_progress'
                            ? th.warning
                            : th.text
                      }
                    >
                      {statusLabel(item.status)}
                    </T>
                  </Pressable>
                  <View style={[s.badge, { backgroundColor: item.priority === 'urgent' || item.priority === 'high' ? th.dangerBg : th.bg }]}>
                    <T variant="caption" weight={600} color={item.priority === 'urgent' || item.priority === 'high' ? th.danger : th.textMuted}>
                      {priorityLabel(item.priority)}
                    </T>
                  </View>
                  {item.due_date ? (
                    <View style={[s.badge, { backgroundColor: isOverdue ? th.dangerBg : th.bg }]}>
                      <T variant="caption" weight={600} color={isOverdue ? th.danger : th.textMuted}>
                        {item.due_date}
                      </T>
                    </View>
                  ) : null}
                  <T variant="caption" color={th.textMuted}>
                    {ar ? `المكلّف: ${item.assignee_name ?? 'غير محدد'}` : `Assignee: ${item.assignee_name ?? 'Unassigned'}`} · {item.unit_name}
                  </T>
                </View>
              </View>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: space.lg, paddingTop: space.xl, gap: space.sm },
  statsRow: { flexDirection: 'row', gap: space.sm },
  statCard: { flex: 1, paddingVertical: space.xs, paddingHorizontal: space.sm, borderRadius: radius.control, borderWidth: 1, alignItems: 'center' },
  filterRow: { flexDirection: 'row', gap: space.sm },
  chip: { borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs },
  composer: { marginHorizontal: space.lg, marginTop: space.md, padding: space.md, borderRadius: radius.control, borderWidth: 1, gap: space.sm },
  row: { flexDirection: 'row', gap: space.sm },
  input: { flex: 1, minWidth: 0, minHeight: minTouch, borderRadius: radius.control, borderWidth: 1, paddingHorizontal: space.md },
  smallInput: { flex: 1, minWidth: 0, height: 36, borderRadius: radius.control, borderWidth: 1, paddingHorizontal: space.sm, fontSize: 13 },
  pillStrip: { gap: space.xs, paddingVertical: 2 },
  miniPill: { borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: space.md, paddingVertical: 4 },
  card: { padding: space.md, borderRadius: radius.control, borderWidth: 1, gap: space.sm },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.sm },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  badge: { borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 },
  empty: { alignItems: 'center', gap: space.sm, marginTop: space.xxl, paddingHorizontal: space.xl },
});
