import { expect } from 'vitest'
import * as matchers from '@testing-library/jest-dom/matchers'

// #553: der Paket-Einstieg /vitest erweitert noch Assertion mit einem Typparameter.
// Die Vitest-5-Typen stehen in vitest-jest-dom.d.ts; die Matcherimplementierung bleibt die des Pakets.
expect.extend(matchers)

// ponytail: jsdom lacks ResizeObserver/scrollIntoView; cmdk (SpeakerCombobox) needs stubs to mount.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
Element.prototype.scrollIntoView ??= () => {}
// jsdom hat kein Canvas; thinking-orbs (ThinkingOrb) kommt mit null zurecht, ohne Attrappe
// druckt jsdom je Orb ein „Not implemented: getContext".
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
