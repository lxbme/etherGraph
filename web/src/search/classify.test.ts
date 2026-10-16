import { classifyInput } from './classify'

const A = '0x' + 'ab'.repeat(20)
const H = '0x' + 'cd'.repeat(32)

describe('classifyInput', () => {
  it('trims and classifies', () => {
    expect(classifyInput(` ${A.toUpperCase().replace('0X', '0x')} `)).toBe('address')
    expect(classifyInput(H)).toBe('tx')
    expect(classifyInput(' vitalik.eth ')).toBe('ens')
  })
  it('rejects bad lengths and junk', () => {
    expect(classifyInput('0x' + 'a'.repeat(63))).toBe('invalid')
    expect(classifyInput('0x' + 'g'.repeat(40))).toBe('invalid')
    expect(classifyInput('')).toBe('invalid')
    expect(classifyInput('hello')).toBe('invalid')
  })
})
