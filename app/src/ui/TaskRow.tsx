import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../design/ThemeContext';
import { minTouch, radius, space } from '../design/tokens';
import type { Strings } from '../i18n';
import type { TaskItem } from '../store/TaskStore';
import { T } from './primitives';

export function TaskRow({ task, t, onToggle, onRemove, onEdit, editLabel }: { task: TaskItem; t: Strings; onToggle: () => void; onRemove: () => void; onEdit?: () => void; editLabel?: string }) {
  const th = useTheme();
  return (
    <View style={[s.row, { backgroundColor: th.surface, borderColor: th.border }]} testID={`task-${task.id}`}>
      <Pressable accessibilityRole="checkbox" aria-checked={task.done} accessibilityState={{ checked: task.done }} accessibilityLabel={t.taskState(task.title, task.done)}
        onPress={onToggle} style={s.hit} testID="toggle">
        <View style={[s.box, { borderColor: task.done ? th.success : th.borderStrong }, task.done && { backgroundColor: th.success }]}>
          {task.done ? <T variant="caption" weight={700} color={th.surface}>✓</T> : null}
        </View>
      </Pressable>
      {/* User-entered text keeps its own language and direction (dir=auto), independent of the UI language. */}
      <T style={[s.title, task.done && { color: th.textMuted, textDecorationLine: 'line-through' }]} numberOfLines={2} {...({ dir: 'auto' } as object)}>{task.title}</T>
      {onEdit ? <Pressable accessibilityRole="button" accessibilityLabel={editLabel} onPress={onEdit} style={s.hit} testID="edit-task">
        <T variant="body" color={th.primary}>✎</T>
      </Pressable> : null}
      {task.pending ? <View accessibilityLabel={t.pendingDot} style={[s.dot, { backgroundColor: th.warning }]} testID="pending-dot" /> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={t.del(task.title)} onPress={onRemove} style={s.hit} testID="delete">
        <T variant="title" color={th.textMuted}>×</T>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.card, borderWidth: 1, paddingHorizontal: space.sm, marginBottom: space.sm, minHeight: minTouch + space.sm },
  hit: { minWidth: minTouch, minHeight: minTouch, alignItems: 'center', justifyContent: 'center' },
  box: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, paddingHorizontal: space.xs },
  dot: { width: 10, height: 10, borderRadius: 5, marginHorizontal: space.sm },
});
