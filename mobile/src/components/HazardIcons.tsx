import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import type { HazardType } from '../services/SpeechHazardService';

interface HazardGlyphProps {
  type: HazardType;
  size?: number;
  color: string;
}

/**
 * Glyph for each hazard category the app already detects (HAZARD_RULES). Purely visual: 24x24
 * viewBox, 2px round strokes. Keyed by HazardType so a new category without a glyph is a
 * compile error here rather than a silent blank.
 */
const GLYPHS: Record<HazardType, React.ReactNode> = {
  missed_turn: <Path d="M9 21v-8a4 4 0 0 1 4-4h6M15 5l4 4-4 4" />,
  fuel: (
    <>
      <Rect x={4} y={4} width={9} height={17} rx={1.5} />
      <Path d="M13 10h2.5a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 0 3 0V8l-3-3M7 8h3" />
    </>
  ),
  pothole: (
    <>
      <Path d="M3 12h4l1.5 4h7L17 12h4" />
      <Path d="M8.5 16c1 2.2 5.9 2.2 7 0" />
    </>
  ),
  gravel: (
    <>
      <Circle cx={7} cy={16} r={2} />
      <Circle cx={15} cy={17} r={2.5} />
      <Circle cx={11} cy={9} r={2} />
      <Circle cx={18} cy={9} r={1.5} />
    </>
  ),
  roadkill: (
    <>
      <Path d="M4 17c0-3 2-5 5-5h2c2 0 3-1 4-3l1-2 2 1-1 3c2 0 3 2 3 4v2H4z" />
      <Path d="M8 20v-3M16 20v-3" />
    </>
  ),
  obstacle: (
    <>
      <Path d="M12 3l10 18H2L12 3z" />
      <Path d="M12 10v5M12 18h.01" />
    </>
  ),
  police: (
    <>
      <Path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z" />
      <Path d="M12 9l1 2 2 .3-1.5 1.5.4 2.2L12 14l-1.9 1 .4-2.2L9 11.3l2-.3 1-2z" />
    </>
  ),
  accident: (
    <>
      <Circle cx={12} cy={12} r={9} />
      <Path d="M12 7v6M12 16.5h.01" />
    </>
  ),
  slippery: (
    <>
      <Path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z" />
      <Path d="M9.5 15a2.5 2.5 0 0 0 2.5 2.5" />
    </>
  ),
  slow: (
    <>
      <Path d="M4 17a8 8 0 1 1 16 0" />
      <Path d="M12 17l4-5M6.5 12.5h.01M12 9h.01M17.5 12.5h.01" />
    </>
  ),
  stop: (
    <>
      <Path d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7L8.5 3z" />
      <Path d="M8 12h8" />
    </>
  ),
};

export function HazardGlyph({ type, size = 24, color }: HazardGlyphProps) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {GLYPHS[type]}
    </Svg>
  );
}

/** Hazards that mean "stop / someone may be hurt" render red; the rest are amber warnings. */
export const CRITICAL_HAZARDS: ReadonlySet<HazardType> = new Set<HazardType>(['accident', 'stop', 'obstacle']);
