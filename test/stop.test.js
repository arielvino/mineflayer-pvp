/* eslint-env node */
const { test } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { PVP } = require('../lib/PVP')

// A PVP on a stub bot. The constructor needs a real registry for Movements, so skip it.
function makePvp () {
  const bot = new EventEmitter()
  bot.pathfinder = { stop () {}, setGoal () {}, setMovements () {} }
  const pvp = Object.create(PVP.prototype)
  pvp.bot = bot
  pvp.movements = undefined
  pvp.followRange = 2
  return { bot, pvp }
}

// GoalFollow reads the target's position.
const entity = (id) => ({ id, position: { x: 0, y: 0, z: 0 } })

test('stoppedAttacking names the target that stopped', async () => {
  const { bot, pvp } = makePvp()
  const a = entity(1)
  const b = entity(2)
  const stopped = []
  bot.on('stoppedAttacking', (target) => stopped.push(target))

  await pvp.attack(a)
  const stopping = pvp.stop() // waits for path_stop
  await pvp.attack(b) // a new attack starts before it arrives
  bot.emit('path_stop')
  await stopping

  assert.strictEqual(pvp.target, b)
  assert.deepStrictEqual(stopped, [a], 'the late event must say it was a that stopped')
})

test('a stop() that times out keeps other path_stop listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bot, pvp } = makePvp()
  const other = () => {}
  bot.on('path_stop', other)

  await pvp.attack(entity(1))
  const stopping = pvp.stop()
  t.mock.timers.tick(5000)
  await stopping

  assert.deepStrictEqual(bot.listeners('path_stop'), [other])
})

test('forceStop() also names the target', async () => {
  const { bot, pvp } = makePvp()
  const a = entity(1)
  const stopped = []
  bot.on('stoppedAttacking', (target) => stopped.push(target))
  await pvp.attack(a)
  pvp.forceStop()
  assert.deepStrictEqual(stopped, [a])
})
