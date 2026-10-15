import 'vitest'
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

type AsymmetrischerMatcher = { asymmetricMatch(actual: unknown): boolean }

// #553: Vitest 5 trennt Rueckgabe R und Subjekt T. jest-dom/vitest 7.0.1 verwendet
// noch Assertion<T> und bindet dadurch die Rueckgabe an das Subjekt.
// Der oeffentliche Matchers-Einstieg reicht void bzw. Promise<void> an alle Paketmatcher.
declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends TestingLibraryMatchers<AsymmetrischerMatcher, R> {}
}
