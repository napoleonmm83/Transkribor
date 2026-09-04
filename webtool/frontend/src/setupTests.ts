import '@testing-library/jest-dom/vitest'

// ponytail: jsdom lacks ResizeObserver/scrollIntoView; cmdk (SpeakerCombobox) needs stubs to mount.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
Element.prototype.scrollIntoView ??= () => {}
