import { describe, expect, it } from 'vitest'
import { getHawlHomePage, setHawlHomePage } from './hawl-page'

describe('hawl home page switch', () => {
  it('starts on Needs you and switches to Agents and back', () => {
    expect(getHawlHomePage()).toBe('needs')
    setHawlHomePage('agents')
    expect(getHawlHomePage()).toBe('agents')
    setHawlHomePage('needs')
    expect(getHawlHomePage()).toBe('needs')
  })
})
