import {
  ipToInt,
  intToIp,
  expandIPv6,
  formatIPv6WithOffset,
  parseBaseCidr,
  normIp,
  normText,
  keepOrIncoming,
  parseHostCidr,
} from '../renderer/src/services/topology-helpers'

// ---------------------------------------------------------------------------
// ipToInt
// ---------------------------------------------------------------------------
describe('ipToInt', () => {
  it('converts 0.0.0.0 to 0', () => {
    expect(ipToInt('0.0.0.0')).toBe(0)
  })

  it('converts 255.255.255.255 to 4294967295', () => {
    expect(ipToInt('255.255.255.255')).toBe(4294967295)
  })

  it('converts 10.0.0.1 to 167772161', () => {
    expect(ipToInt('10.0.0.1')).toBe(167772161)
  })

  it('converts 192.168.1.1 to 3232235777', () => {
    expect(ipToInt('192.168.1.1')).toBe(3232235777)
  })

  it('returns null for out-of-range octet (999.0.0.0)', () => {
    expect(ipToInt('999.0.0.0')).toBeNull()
  })

  it('returns null for non-numeric input (abc)', () => {
    expect(ipToInt('abc')).toBeNull()
  })

  it('returns null for incomplete address (1.2.3)', () => {
    expect(ipToInt('1.2.3')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// intToIp
// ---------------------------------------------------------------------------
describe('intToIp', () => {
  it('converts 0 to 0.0.0.0', () => {
    expect(intToIp(0)).toBe('0.0.0.0')
  })

  it('converts 4294967295 to 255.255.255.255', () => {
    expect(intToIp(4294967295)).toBe('255.255.255.255')
  })

  it('converts 167772161 to 10.0.0.1', () => {
    expect(intToIp(167772161)).toBe('10.0.0.1')
  })

  it('converts 3232235777 to 192.168.1.1', () => {
    expect(intToIp(3232235777)).toBe('192.168.1.1')
  })
})

// ---------------------------------------------------------------------------
// roundtrip ipToInt <-> intToIp
// ---------------------------------------------------------------------------
describe('ipToInt / intToIp roundtrip', () => {
  it('roundtrips 10.20.30.40', () => {
    expect(intToIp(ipToInt('10.20.30.40')!)).toBe('10.20.30.40')
  })

  it('roundtrips 0.0.0.0', () => {
    expect(intToIp(ipToInt('0.0.0.0')!)).toBe('0.0.0.0')
  })

  it('roundtrips 255.255.255.255', () => {
    expect(intToIp(ipToInt('255.255.255.255')!)).toBe('255.255.255.255')
  })

  it('roundtrips 172.16.254.1', () => {
    expect(intToIp(ipToInt('172.16.254.1')!)).toBe('172.16.254.1')
  })
})

// ---------------------------------------------------------------------------
// expandIPv6
// ---------------------------------------------------------------------------
describe('expandIPv6', () => {
  it('expands 2001:db8::1', () => {
    expect(expandIPv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])
  })

  it('expands ::1 (loopback)', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
  })

  it('expands :: (all-zeros)', () => {
    expect(expandIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('expands fd00::', () => {
    expect(expandIPv6('fd00::')).toEqual([0xfd00, 0, 0, 0, 0, 0, 0, 0])
  })

  it('expands 2001:db8:85a3::8a2e:370:7334', () => {
    expect(expandIPv6('2001:db8:85a3::8a2e:370:7334')).toEqual([
      0x2001, 0xdb8, 0x85a3, 0, 0, 0x8a2e, 0x370, 0x7334,
    ])
  })

  it('expands full form 2001:0db8:0000:0000:0000:0000:0000:0001', () => {
    expect(expandIPv6('2001:0db8:0000:0000:0000:0000:0000:0001')).toEqual([
      0x2001, 0xdb8, 0, 0, 0, 0, 0, 1,
    ])
  })

  it('always returns an array of length 8', () => {
    const cases = ['::', '::1', 'fd00::', '2001:db8::1', 'fe80::1%eth0'.split('%')[0]]
    for (const c of cases) {
      expect(expandIPv6(c)).toHaveLength(8)
    }
  })
})

// ---------------------------------------------------------------------------
// formatIPv6WithOffset
// ---------------------------------------------------------------------------
describe('formatIPv6WithOffset', () => {
  const base2001 = expandIPv6('2001:db8::')
  const baseFd00 = expandIPv6('fd00::')

  it('offset 0 returns base address compressed', () => {
    expect(formatIPv6WithOffset(base2001, 0)).toBe('2001:db8::')
  })

  it('offset 1 appends ::1', () => {
    expect(formatIPv6WithOffset(base2001, 1)).toBe('2001:db8::1')
  })

  it('offset 255 appends ::ff', () => {
    expect(formatIPv6WithOffset(base2001, 255)).toBe('2001:db8::ff')
  })

  it('offset 65536 crosses a 16-bit group boundary', () => {
    expect(formatIPv6WithOffset(base2001, 65536)).toBe('2001:db8::1:0')
  })

  it('fd00:: offset 1 gives fd00::1', () => {
    expect(formatIPv6WithOffset(baseFd00, 1)).toBe('fd00::1')
  })

  it('fd00:: offset 2 gives fd00::2', () => {
    expect(formatIPv6WithOffset(baseFd00, 2)).toBe('fd00::2')
  })

  it('consecutive offsets produce sequential addresses', () => {
    const results: string[] = []
    for (let i = 0; i < 5; i++) {
      results.push(formatIPv6WithOffset(base2001, i))
    }
    // Each address should be unique
    expect(new Set(results).size).toBe(5)
    // Verify the exact sequence
    expect(results).toEqual([
      '2001:db8::',
      '2001:db8::1',
      '2001:db8::2',
      '2001:db8::3',
      '2001:db8::4',
    ])
  })

  it('does not mutate the base array', () => {
    const original = [...base2001]
    formatIPv6WithOffset(base2001, 42)
    expect(base2001).toEqual(original)
  })
})

// ---------------------------------------------------------------------------
// parseBaseCidr
// ---------------------------------------------------------------------------
describe('parseBaseCidr', () => {
  it('parses 10.0.0.0/8 correctly', () => {
    const { networkStart, networkEnd } = parseBaseCidr('10.0.0.0/8')
    expect(networkStart).toBe(ipToInt('10.0.0.0'))
    // /8 has 2^24 = 16777216 addresses, end = start + 16777215
    expect(networkEnd).toBe(ipToInt('10.0.0.0')! + 16777215)
    expect(networkEnd).toBe(ipToInt('10.255.255.255'))
  })

  it('parses 192.168.0.0/24 correctly', () => {
    const { networkStart, networkEnd } = parseBaseCidr('192.168.0.0/24')
    expect(networkStart).toBe(ipToInt('192.168.0.0'))
    expect(networkEnd).toBe(ipToInt('192.168.0.255'))
  })

  it('parses 172.16.0.0/16 correctly', () => {
    const { networkStart, networkEnd } = parseBaseCidr('172.16.0.0/16')
    expect(networkStart).toBe(ipToInt('172.16.0.0'))
    expect(networkEnd).toBe(ipToInt('172.16.255.255'))
  })

  it('parses 192.168.1.0/30 (smallest allowed)', () => {
    const { networkStart, networkEnd } = parseBaseCidr('192.168.1.0/30')
    expect(networkStart).toBe(ipToInt('192.168.1.0'))
    // /30 has 4 addresses: .0, .1, .2, .3
    expect(networkEnd).toBe(ipToInt('192.168.1.3'))
  })

  it('throws on invalid string "invalid"', () => {
    expect(() => parseBaseCidr('invalid')).toThrow()
  })

  it('throws on prefix > 30 ("10.0.0.0/33")', () => {
    expect(() => parseBaseCidr('10.0.0.0/33')).toThrow()
  })

  // /31 is now valid (RFC 3021 point-to-point, added for auto-assign subnet size picker)
  it('accepts prefix 31 ("10.0.0.0/31") — RFC 3021', () => {
    expect(() => parseBaseCidr('10.0.0.0/31')).not.toThrow()
  })

  it('throws on prefix 32 ("10.0.0.0/32")', () => {
    expect(() => parseBaseCidr('10.0.0.0/32')).toThrow()
  })

  it('throws on missing prefix ("10.0.0.0")', () => {
    expect(() => parseBaseCidr('10.0.0.0')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// normIp
// ---------------------------------------------------------------------------
describe('normIp', () => {
  it('strips CIDR suffix from 10.0.0.1/32', () => {
    expect(normIp('10.0.0.1/32')).toBe('10.0.0.1')
  })

  it('strips CIDR suffix and trims whitespace', () => {
    expect(normIp(' 192.168.1.1/24 ')).toBe('192.168.1.1')
  })

  it('returns empty string for empty input', () => {
    expect(normIp('')).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(normIp(undefined)).toBe('')
  })

  it('returns IP unchanged when no CIDR suffix is present', () => {
    expect(normIp('10.0.0.1')).toBe('10.0.0.1')
  })

  it('trims whitespace even without CIDR suffix', () => {
    expect(normIp('  10.0.0.1  ')).toBe('10.0.0.1')
  })
})

// ---------------------------------------------------------------------------
// normText
// ---------------------------------------------------------------------------
describe('normText', () => {
  it('trims and lowercases a normal string', () => {
    expect(normText('  Hello World  ')).toBe('hello world')
  })

  it('returns empty string for undefined', () => {
    expect(normText(undefined)).toBe('')
  })

  it('returns empty string for empty input', () => {
    expect(normText('')).toBe('')
  })

  it('passes through already-clean string', () => {
    expect(normText('hello')).toBe('hello')
  })

  it('trims tabs and newlines', () => {
    expect(normText('\t Hello \n')).toBe('hello')
  })
})

// ---------------------------------------------------------------------------
// keepOrIncoming
// ---------------------------------------------------------------------------
describe('keepOrIncoming', () => {
  it('returns incoming when non-empty', () => {
    expect(keepOrIncoming('new', 'old')).toBe('new')
  })

  it('returns fallback when incoming is empty string', () => {
    expect(keepOrIncoming('', 'old')).toBe('old')
  })

  it('returns fallback when incoming is whitespace-only', () => {
    expect(keepOrIncoming('   ', 'old')).toBe('old')
  })

  it('returns fallback when incoming is undefined', () => {
    expect(keepOrIncoming(undefined, 'old')).toBe('old')
  })

  it('returns undefined when both are undefined', () => {
    expect(keepOrIncoming(undefined, undefined)).toBeUndefined()
  })

  it('trims incoming value', () => {
    expect(keepOrIncoming('  new  ', 'old')).toBe('new')
  })

  it('returns incoming even when fallback is undefined', () => {
    expect(keepOrIncoming('new', undefined)).toBe('new')
  })
})

// ---------------------------------------------------------------------------
// parseHostCidr
// ---------------------------------------------------------------------------
describe('parseHostCidr', () => {
  it('parses 172.16.0.0/16 correctly', () => {
    const { networkStart, networkEnd } = parseHostCidr('172.16.0.0/16')
    expect(networkStart).toBe(ipToInt('172.16.0.0'))
    expect(networkEnd).toBe(ipToInt('172.16.255.255'))
  })

  it('parses 10.0.0.0/8 correctly', () => {
    const { networkStart, networkEnd } = parseHostCidr('10.0.0.0/8')
    expect(networkStart).toBe(ipToInt('10.0.0.0'))
    expect(networkEnd).toBe(ipToInt('10.255.255.255'))
  })

  it('parses 192.168.1.0/24 correctly', () => {
    const { networkStart, networkEnd } = parseHostCidr('192.168.1.0/24')
    expect(networkStart).toBe(ipToInt('192.168.1.0'))
    expect(networkEnd).toBe(ipToInt('192.168.1.255'))
  })

  it('parses /32 (single host) — allowed unlike parseBaseCidr', () => {
    const { networkStart, networkEnd } = parseHostCidr('10.0.0.1/32')
    expect(networkStart).toBe(ipToInt('10.0.0.1'))
    expect(networkEnd).toBe(ipToInt('10.0.0.1'))
  })

  it('parses /31 (point-to-point) — allowed unlike parseBaseCidr', () => {
    const { networkStart, networkEnd } = parseHostCidr('10.0.0.0/31')
    expect(networkStart).toBe(ipToInt('10.0.0.0'))
    expect(networkEnd).toBe(ipToInt('10.0.0.1'))
  })

  it('parses 0.0.0.0/0 (entire IPv4 space)', () => {
    const { networkStart, networkEnd } = parseHostCidr('0.0.0.0/0')
    expect(networkStart).toBe(0)
    expect(networkEnd).toBe(4294967295)
  })

  it('throws on invalid string "invalid"', () => {
    expect(() => parseHostCidr('invalid')).toThrow()
  })

  it('throws on prefix > 32', () => {
    expect(() => parseHostCidr('10.0.0.0/33')).toThrow()
  })

  it('throws on negative prefix', () => {
    expect(() => parseHostCidr('10.0.0.0/-1')).toThrow()
  })

  it('throws on invalid base IP', () => {
    expect(() => parseHostCidr('999.0.0.0/8')).toThrow()
  })

  it('trims whitespace from input', () => {
    const { networkStart } = parseHostCidr('  10.0.0.0/24  ')
    expect(networkStart).toBe(ipToInt('10.0.0.0'))
  })
})

// ---------------------------------------------------------------------------
// Edge cases for existing functions
// ---------------------------------------------------------------------------
describe('ipToInt edge cases', () => {
  it('returns null for too many octets (1.2.3.4.5)', () => {
    expect(ipToInt('1.2.3.4.5')).toBeNull()
  })

  it('handles leading zeros in octets (010.000.000.001)', () => {
    // JavaScript Number('010') = 10 (not octal), so should parse as 10.0.0.1
    expect(ipToInt('010.000.000.001')).toBe(ipToInt('10.0.0.1'))
  })
})

describe('parseBaseCidr edge cases', () => {
  it('parses 0.0.0.0/0 (entire IPv4 space)', () => {
    const { networkStart, networkEnd } = parseBaseCidr('0.0.0.0/0')
    expect(networkStart).toBe(0)
    expect(networkEnd).toBe(4294967295)
  })
})

describe('formatIPv6WithOffset edge cases', () => {
  it('large offset wrapping multiple 16-bit groups', () => {
    const base = expandIPv6('2001:db8::')
    // offset = 0x10001 should go to group[6]=1, group[7]=1
    const result = formatIPv6WithOffset(base, 0x10001)
    expect(result).toBe('2001:db8::1:1')
  })

  it('very large offset filling multiple groups', () => {
    const base = expandIPv6('2001:db8::')
    // offset = 0xFFFF * 2 + 1 = 131071
    const result = formatIPv6WithOffset(base, 131071)
    expect(result).toBe('2001:db8::1:ffff')
  })
})

describe('expandIPv6 edge cases', () => {
  it('handles full form without :: (8 groups)', () => {
    const result = expandIPv6('1:2:3:4:5:6:7:8')
    expect(result).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

describe('intToIp edge cases', () => {
  it('handles very large 32-bit value', () => {
    expect(intToIp(0xFFFFFFFF)).toBe('255.255.255.255')
  })
})

describe('normIp edge cases', () => {
  it('passes through IPv6-like input without modification', () => {
    expect(normIp('2001:db8::1')).toBe('2001:db8::1')
  })

  it('strips prefix from IPv6 CIDR', () => {
    expect(normIp('fd00::1/128')).toBe('fd00::1')
  })
})
