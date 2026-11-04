import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { RideDestination } from './RiderMap';
import { PinIcon } from './HomeIcons';
import { brand, homeRadius, homeType } from '../homeTheme';

interface DestinationSuggestionsProps {
  suggestions: RideDestination[];
  onSelect: (destination: RideDestination) => void;
}

export function DestinationSuggestions({ suggestions, onSelect }: DestinationSuggestionsProps) {
  if (suggestions.length === 0) {
    return null;
  }

  return (
    <View style={styles.list} accessibilityRole="list">
      {suggestions.map((suggestion, index) => {
        const [title, ...rest] = (suggestion.name ?? '').split(', ');
        return (
          <Pressable
            key={`${suggestion.latitude},${suggestion.longitude},${index}`}
            style={({ pressed }) => [
              styles.row,
              index > 0 && styles.rowDivider,
              pressed && styles.rowPressed,
            ]}
            onPress={() => onSelect(suggestion)}
            accessibilityRole="button"
            accessibilityLabel={`Use ${suggestion.name ?? 'this place'}`}
          >
            <PinIcon size={16} color={brand.primary} />
            <View style={styles.textBlock}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              {rest.length > 0 ? (
                <Text style={styles.subtitle} numberOfLines={1}>
                  {rest.join(', ')}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    marginTop: 6,
    backgroundColor: brand.surfaceHigh,
    borderRadius: homeRadius.input,
    borderWidth: 1,
    borderColor: brand.inputBorder,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: brand.inputBorder },
  rowPressed: { backgroundColor: brand.primaryMuted },
  textBlock: { flex: 1 },
  title: { ...homeType.bodyLarge, color: brand.textPrimary },
  subtitle: { ...homeType.bodySmall, color: brand.outline },
});
