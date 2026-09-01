// Stryker — Mutationstests fuer das Frontend.
//
// Zweck: Stryker beschaedigt den Code absichtlich (aus `+` wird `-`, aus `>`
// wird `>=`) und prueft, ob ein Test daraufhin rot wird. Das ist der einzige
// ehrliche Nachweis, dass eine Suite PRUEFT statt nur mitzulaufen.
//
// ⚠ STAND 01.09.2026 — NOCH NICHT LAUFFAEHIG. Grund ist TypeScript 7.0.2:
//    1. Strykers tsconfig-Vorverarbeitung ruft `ts.parseConfigFileTextToJson`,
//       eine API, die TS 7 nicht mehr hat → TypeError. Deshalb zeigt
//       `tsconfigFile` unten bewusst auf eine Datei, die es nicht gibt: das
//       ueberspringt die Vorverarbeitung und beseitigt diesen Absturz.
//    2. Danach scheitert Stryker im naechsten Schritt daran, dass in seiner
//       Sandbox der initiale Testlauf rot ist — obwohl `npm test` ausserhalb
//       838 von 838 Tests gruen faehrt. Ursache noch nicht eingegrenzt
//       (Verdacht: der `@`-Alias und das `__APP_VERSION__`-define aus
//       vite.config.ts ueberleben die Sandbox-Kopie nicht).
//
// Konfiguration und `npm run mutation` bleiben stehen, weil beides richtig ist
// und ohne Aenderung greift, sobald Punkt 2 geloest oder Stryker mit TS 7
// umgehen kann. Wer es heute braucht: erst Punkt 2 klaeren.
//
// Laeuft bewusst NICHT in der CI — ein Lauf dauert ein Vielfaches der Suite.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  coverageAnalysis: 'perTest',

  // Siehe Punkt 1 oben: absichtlich ein nicht existierender Pfad.
  tsconfigFile: 'tsconfig.stryker-nicht-vorhanden.json',

  mutate: [
    'src/**/*.ts',
    'src/**/*.tsx',
    '!src/**/*.test.ts',
    '!src/**/*.test.tsx',
    '!src/setupTests.ts',
    '!src/vite-env.d.ts',
    // Von shadcn generiert, nicht von Hand gepflegt — Mutationen darin sagen
    // nichts ueber die Qualitaet der eigenen Tests aus.
    '!src/components/ui/**',
  ],
};
