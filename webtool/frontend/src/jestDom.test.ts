import { afterEach, expect, expectTypeOf, it } from 'vitest'

afterEach(() => { document.body.replaceChildren() })

function element() {
  const el = document.createElement('button')
  el.className = 'bereit'
  el.textContent = 'Bericht senden'
  document.body.append(el)
  return el
}

// Vitest transpiliert nur. Der vorhandene Build prueft diese Typassertionen mit tsc (#553).
it('jest-dom typisiert synchrone und negierte Matcher mit void', () => {
  const ergebnis = expect(element()).toBeInTheDocument()
  expectTypeOf(ergebnis).toEqualTypeOf<void>()
  const negativ = expect(document.createElement('span')).not.toBeInTheDocument()
  expectTypeOf(negativ).toEqualTypeOf<void>()
})

it('jest-dom typisiert resolves mit einem awaitbaren Promise<void>', async () => {
  const ergebnis: Promise<void> = expect(Promise.resolve(element())).resolves.toBeInTheDocument()
  await ergebnis
  const negativ: Promise<void> = expect(Promise.resolve(document.createElement('span'))).resolves.not.toBeInTheDocument()
  await negativ
})

it('jest-dom typisiert rejects mit einem awaitbaren Promise<void>', async () => {
  const ergebnis: Promise<void> = expect(Promise.reject(element())).rejects.toHaveClass('bereit')
  await ergebnis
  const negativ: Promise<void> = expect(Promise.reject(document.createElement('span'))).rejects.not.toBeInTheDocument()
  await negativ
})

it('jest-dom behaelt asymmetrische Matcher und gueltige Argumenttypen', () => {
  const el = element()
  expect(el).toHaveAccessibleName(expect.stringContaining('senden'))
  expect(el).toHaveClass(/bereit/)
  const muster = expect.toHaveClass('bereit')
  expect(muster.asymmetricMatch(el)).toBe(true)
  expect(muster.asymmetricMatch(document.createElement('span'))).toBe(false)
  expect([el]).toEqual(expect.arrayContaining([muster]))
  const assertion = expect(el)
  expectTypeOf(assertion.toBeInTheDocument).parameters.toEqualTypeOf<[]>()
  expectTypeOf<number>().not.toExtend<Parameters<typeof assertion.toHaveClass>[0]>()
  expectTypeOf<number>().not.toExtend<Parameters<typeof assertion.toHaveAccessibleName>[0]>()
})
