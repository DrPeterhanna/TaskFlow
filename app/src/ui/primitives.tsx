import React from 'react';
import { Pressable, Text, type TextProps, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../design/ThemeContext';
import { fontFamily, minTouch, radius, space, type } from '../design/tokens';

export function T({ variant = 'body', weight = 400, color, style, ...rest }: TextProps & {
  variant?: keyof typeof type; weight?: 400 | 500 | 600 | 700; color?: string;
}) {
  const th = useTheme();
  const v = type[variant];
  return <Text {...rest} style={[{ fontFamily: fontFamily[weight], fontSize: v.size, lineHeight: v.line, color: color ?? th.text }, style as TextStyle]} />;
}

export function Button({ label, onPress, kind = 'primary', accessibilityLabel }: {
  label: string; onPress: () => void; kind?: 'primary' | 'secondary'; accessibilityLabel?: string;
}) {
  const th = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} onPress={onPress}
      style={({ pressed }): ViewStyle => ({
        minHeight: minTouch, minWidth: 72, paddingHorizontal: space.lg, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center',
        backgroundColor: kind === 'primary' ? (pressed ? th.primaryPressed : th.primary) : th.surface,
        borderWidth: kind === 'primary' ? 0 : 1, borderColor: th.borderStrong,
      })}>
      <T weight={600} color={kind === 'primary' ? th.onPrimary : th.primary}>{label}</T>
    </Pressable>
  );
}
