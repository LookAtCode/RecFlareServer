import { afterEach, beforeEach } from 'vitest'

import { beginTest, endTest } from './cloudflare-test'

beforeEach(beginTest)
afterEach(endTest)
