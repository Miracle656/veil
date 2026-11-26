const JSDOMEnvironment = require('jest-environment-jsdom').default

/**
 * jsdom captures the process timezone when its context is created, so a test
 * cannot switch TZ at runtime. This environment pins the zone before that, and
 * restores the previous zone on teardown so later suites are unaffected.
 */
module.exports = class DstEnvironment extends JSDOMEnvironment {
  constructor(...args) {
    const previousTz = process.env.TZ
    process.env.TZ = 'America/New_York'
    super(...args)
    this.previousTz = previousTz
  }

  async teardown() {
    await super.teardown()
    if (this.previousTz === undefined) delete process.env.TZ
    else process.env.TZ = this.previousTz
  }
}
