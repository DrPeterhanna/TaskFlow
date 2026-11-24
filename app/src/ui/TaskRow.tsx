import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, font, minTouch, radius, space } from '../design/tokens';
import type { TaskItem } from '../store/TaskStore';

export function TaskRow({ task, onToggle, onRemove, doneLabel, openLabel }: {
  task: TaskItem; onToggle: () => void; onRemove: () => void; doneLabel: string; openLabel: string;
}) {
  return (
    <View style={s.row}>
      <Pressable
        accessibilityRole="checkbox" accessibilityState={{ checked: task.done }}
        accessibilityLabel={`${task.title}, ${task.done ? doneLabel : openLabel}`}
        onPress={onToggle} style={s.hit}>
        <View style={[s.box, task.done && s.boxDone]}>{task.done ? <Text style={s.tick}>✓</Text> : null}</View>
      </Pressable>
      <Text style={[s.title, task.done && s.titleDone]} numberOfLines={2}>{task.title}</Text>
      {task.pending ? <View accessibilityLabel="waiting to sync" style={s.dot} /> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={`Delete ${task.title}`} onPress={onRemove} style={s.hit}>
        <Text style={s.x}>×</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.border, paddingHorizontal: space.sm, marginBottom: space.sm, minHeight: minTouch + 8 },
  hit: { minWidth: minTouch, minHeight: minTouch, alignItems: 'center', justifyContent: 'center' },
  box: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: color.textMuted, alignItems: 'center', justifyContent: 'center' },
  boxDone: { backgroundColor: color.success, borderColor: color.success },
  tick: { color: color.onPrimary, fontSize: 15, fontWeight: '700' },
  title: { flex: 1, fontSize: font.body, color: color.text, paddingHorizontal: space.xs },
  titleDone: { color: color.textMuted, textDecorationLine: 'line-through' },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.warning, marginHorizontal: space.sm },
  x: { fontSize: 26, color: color.textMuted },
});
