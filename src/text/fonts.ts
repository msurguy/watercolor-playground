// Catalogue of the bundled single-line (single-stroke) SVG fonts. These are the
// plotter fonts from drawingbots.net (site/components/tools/lib/singleLineFonts.ts),
// trimmed to the text faces; the files live in public/fonts/single-line/.

export interface FontMeta {
  /** Path under fonts/single-line/, without the .svg extension. */
  file: string;
  /** Where the font came from, for the credit line. */
  source: string;
}

const OSKAY = 'https://gitlab.com/oskay/svg-fonts';
const CUTLINGS = 'http://cutlings.wasbo.net/products-fonts/';
const SHRIINIVAS = 'https://github.com/Shriinivas/inkscapestrokefont';
const RELIEF = 'https://github.com/isdat-type/Relief-SingleLine';

export const FONTS: Record<string, FontMeta> = {
  EMSAllure: { file: 'EMS/EMSAllure', source: OSKAY },
  EMSAllureSmooth: { file: 'Cutlings/EMS_Allure_Smooth', source: CUTLINGS },
  EMSBird: { file: 'EMS/EMSBird', source: OSKAY },
  EMSBirdSwashCaps: { file: 'EMS/EMSBirdSwashCaps', source: OSKAY },
  EMSBrush: { file: 'EMS/EMSBrush', source: OSKAY },
  EMSCapitol: { file: 'EMS/EMSCapitol', source: OSKAY },
  EMSCasualHand: { file: 'EMS/EMSCasualHand', source: OSKAY },
  EMSDecorousScript: { file: 'EMS/EMSDecorousScript', source: OSKAY },
  EMSDelight: { file: 'EMS/EMSDelight', source: OSKAY },
  EMSDelightSwashCaps: { file: 'EMS/EMSDelightSwashCaps', source: OSKAY },
  EMSElfin: { file: 'EMS/EMSElfin', source: OSKAY },
  EMSElfinSmooth: { file: 'Cutlings/EMS_Elfin_Smooth', source: CUTLINGS },
  EMSFelix: { file: 'EMS/EMSFelix', source: OSKAY },
  EMSHerculean: { file: 'EMS/EMSHerculean', source: OSKAY },
  EMSInvite: { file: 'EMS/EMSInvite', source: OSKAY },
  EMSLeague: { file: 'EMS/EMSLeague', source: OSKAY },
  EMSLittlePrincess: { file: 'EMS/EMSLittlePrincess', source: OSKAY },
  EMSMistyNight: { file: 'EMS/EMSMistyNight', source: OSKAY },
  EMSNeato: { file: 'EMS/EMSNeato', source: OSKAY },
  EMSNixish: { file: 'EMS/EMSNixish', source: OSKAY },
  EMSNixishItalic: { file: 'EMS/EMSNixishItalic', source: OSKAY },
  EMSOsmotron: { file: 'EMS/EMSOsmotron', source: OSKAY },
  EMSPancakes: { file: 'EMS/EMSPancakes', source: OSKAY },
  EMSPepita: { file: 'EMS/EMSPepita', source: OSKAY },
  EMSQwandry: { file: 'EMS/EMSQwandry', source: OSKAY },
  EMSReadability: { file: 'EMS/EMSReadability', source: OSKAY },
  EMSReadabilityItalic: { file: 'EMS/EMSReadabilityItalic', source: OSKAY },
  EMSSociety: { file: 'EMS/EMSSociety', source: OSKAY },
  EMSSpaceRocks: { file: 'EMS/EMSSpaceRocks', source: OSKAY },
  EMSSwiss: { file: 'EMS/EMSSwiss', source: OSKAY },
  EMSTech: { file: 'EMS/EMSTech', source: OSKAY },
  HersheyCyrillic: { file: 'Hershey/HersheyCyrillic', source: SHRIINIVAS },
  HersheyGothEnglish: { file: 'Hershey/HersheyGothEnglish', source: OSKAY },
  HersheyGothGerman: { file: 'Hershey/HersheyGothGerman', source: OSKAY },
  HersheyGothItalian: { file: 'Hershey/HersheyGothItalian', source: OSKAY },
  'HersheyGreek-1-stroke': { file: 'Hershey/HersheyGreek1stroke', source: SHRIINIVAS },
  HersheyGreekmedium: { file: 'Hershey/HersheyGreekmedium', source: SHRIINIVAS },
  HersheySans1: { file: 'Hershey/HersheySans1', source: OSKAY },
  HersheySansMed: { file: 'Hershey/HersheySansMed', source: OSKAY },
  HersheySansbold: { file: 'Hershey/HersheySansbold', source: SHRIINIVAS },
  'HersheyScript-1-stroke(alt)': { file: 'Hershey/HersheyScript1-stroke(alt)', source: SHRIINIVAS },
  HersheyScript1: { file: 'Hershey/HersheyScript1', source: OSKAY },
  HersheyScript1Smooth: { file: 'Cutlings/HersheyScript1smooth', source: CUTLINGS },
  HersheyScriptMed: { file: 'Hershey/HersheyScriptMed', source: OSKAY },
  HersheySerifBold: { file: 'Hershey/HersheySerifBold', source: OSKAY },
  HersheySerifBoldItalic: { file: 'Hershey/HersheySerifBoldItalic', source: OSKAY },
  HersheySerifMed: { file: 'Hershey/HersheySerifMed', source: OSKAY },
  HersheySerifMedItalic: { file: 'Hershey/HersheySerifMedItalic', source: OSKAY },
  ReliefRegular: { file: 'Relief/ReliefSingleLine-Regular', source: RELIEF },
  CutlingsDualis: { file: 'Cutlings/CutlingsDualis', source: CUTLINGS },
  CutlingsGeometric: { file: 'Cutlings/CutlingsGeometric', source: CUTLINGS },
  CutlingsGeometricRound: { file: 'Cutlings/CutlingsGeometricRound', source: CUTLINGS },
  CutlingsPluralis: { file: 'Cutlings/CutlingsPluralis', source: CUTLINGS },
  CutlingsSingularis: { file: 'Cutlings/CutlingsSingularis', source: CUTLINGS },
  ShriinivasCustom: { file: 'Shriinivas/Custom-Script', source: SHRIINIVAS },
  ShriinivasSquareItalic: { file: 'Shriinivas/Custom-SquareItalic', source: SHRIINIVAS },
  ShriinivasSquareNormal: { file: 'Shriinivas/Custom-SquareNormal', source: SHRIINIVAS },
  RoutedGothic: { file: 'RoutedGothic', source: 'https://github.com/dse/routed-gothic' },
};

export const DEFAULT_FONT = 'EMSAllure';

/**
 * Absolute URL of a file under public/fonts/single-line/. The app is built with a
 * relative base ('./'), so the path is resolved against the page here: left
 * relative, a url() in a CSS custom property resolves against the bundled
 * stylesheet in assets/ instead, which 404s once deployed.
 */
function assetUrl(path: string): string {
  return new URL(`${import.meta.env.BASE_URL}fonts/single-line/${path}`, document.baseURI).href;
}

export function fontUrl(key: string): string {
  return assetUrl(`${FONTS[key].file}.svg`);
}

/** "EMSReadabilityItalic" -> "EMS Readability Italic", keeps parenthesized bits. */
export function fontLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\(/g, ' (')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GROUPS: { label: string; folder: string | null }[] = [
  { label: 'EMS', folder: 'EMS' },
  { label: 'Hershey', folder: 'Hershey' },
  { label: 'Relief', folder: 'Relief' },
  { label: 'Cutlings (smooth)', folder: 'Cutlings' },
  { label: 'Shriinivas', folder: 'Shriinivas' },
  { label: 'Other', folder: null },
];

/** Fonts grouped by source family, in catalogue order. */
export function fontGroups(): { label: string; keys: string[] }[] {
  return GROUPS.map(({ label, folder }) => ({
    label,
    keys: Object.keys(FONTS).filter(k => {
      const f = FONTS[k].file;
      const dir = f.includes('/') ? f.split('/')[0] : null;
      return folder ? dir === folder : dir === null;
    }).sort(),
  })).filter(g => g.keys.length > 0);
}

/* ------------------------------------------------------------ preview atlas */

// Pre-rendered specimen rows (fonts/single-line/font-atlas.png, 260×32 CSS px per
// row at 2× DPR), in this order. Generated by drawingbots' `npm run fonts:atlas`.
const ATLAS_KEYS = [
  'EMSAllure', 'EMSBird', 'EMSBirdSwashCaps', 'EMSBrush', 'EMSCapitol', 'EMSCasualHand', 'EMSDecorousScript',
  'EMSDelight', 'EMSDelightSwashCaps', 'EMSElfin', 'EMSFelix', 'EMSHerculean', 'EMSInvite', 'EMSLeague',
  'EMSLittlePrincess', 'EMSMistyNight', 'EMSNeato', 'EMSNixish', 'EMSNixishItalic', 'EMSOsmotron', 'EMSPancakes',
  'EMSPepita', 'EMSQwandry', 'EMSReadability', 'EMSReadabilityItalic', 'EMSSociety', 'EMSSpaceRocks', 'EMSSwiss',
  'EMSTech', 'HersheyAstrology', 'HersheyCyrillic', 'HersheyGothEnglish', 'HersheyGothGerman', 'HersheyGothItalian',
  'HersheyGreek-1-stroke', 'HersheyGreekmedium', 'HersheyJapanese', 'HersheyMarkers', 'HersheyMath(lower)',
  'HersheyMath(upper)', 'HersheyMeteorology', 'HersheyMusic', 'HersheySans1', 'HersheySansMed', 'HersheySansbold',
  'HersheyScript-1-stroke(alt)', 'HersheyScript1', 'HersheyScriptMed', 'HersheySerifBold', 'HersheySerifBoldItalic',
  'HersheySerifMed', 'HersheySerifMedItalic', 'HersheySymbolic', 'ReliefOrnament', 'ReliefRegular', 'CutlingsDualis',
  'CutlingsGeometric', 'CutlingsGeometricRound', 'CutlingsPluralis', 'CutlingsSingularis', 'EMSAllureSmooth',
  'EMSElfinSmooth', 'HersheyScript1Smooth', 'ShriinivasCustom', 'ShriinivasSquareItalic', 'ShriinivasSquareNormal',
  'RoutedGothic',
];

export const ATLAS = {
  url: assetUrl('font-atlas.png'),
  rowWidth: 260,
  rowHeight: 32,
  /** Row index of a font in the atlas, or -1 when it has no specimen. */
  row: (key: string) => ATLAS_KEYS.indexOf(key),
};
