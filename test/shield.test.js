/* eslint-env node */
const { test } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { PVP } = require('../lib/PVP')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// A PVP on a stub bot with a shield in the off-hand. The constructor needs a real
// registry for Movements, so skip it. calls records shield use in order.
function makePvp () {
  const bot = new EventEmitter()
  const calls = []
  bot.pathfinder = { stop () { setImmediate(() => bot.emit('path_stop')) }, setGoal () {}, setMovements () {} }
  bot.supportFeature = () => false
  bot.getEquipmentDestSlot = () => 45
  bot.inventory = { slots: { 45: { name: 'shield' } } }
  bot.entity = { position: { distanceTo: () => 1 } }
  bot.activateItem = (offHand) => calls.push(offHand ? 'raise' : 'use')
  bot.deactivateItem = () => calls.push('lower')
  bot.attack = () => calls.push('swing')
  bot.lookAt = async () => {}
  const pvp = Object.create(PVP.prototype)
  pvp.bot = bot
  pvp.movements = undefined
  pvp.followRange = 2
  pvp.wasInRange = true
  pvp.meleeAttackRate = { getTicks: () => 10 }
  return { bot, pvp, calls }
}

const entity = (id) => ({ id, height: 1.8, position: { x: 0, y: 0, z: 0, offset () { return this } } })

// One full swing: lower, swing, raise again 150 ms later.
async function swing (pvp) {
  pvp.attemptAttack()
  await sleep(400)
}

test('stop() lowers the shield pvp raised after its last swing', async () => {
  const { pvp, calls } = makePvp()
  await pvp.attack(entity(1))
  await swing(pvp)
  assert.deepStrictEqual(calls, ['lower', 'swing', 'raise'])
  await pvp.stop()
  assert.strictEqual(calls.at(-1), 'lower', 'the shield stays up after the fight')
})

test('forceStop() lowers the shield pvp raised', async () => {
  const { pvp, calls } = makePvp()
  await pvp.attack(entity(1))
  await swing(pvp)
  pvp.forceStop()
  assert.strictEqual(calls.at(-1), 'lower')
})

test('a swing in flight when stop() lands does not raise the shield again', async () => {
  const { pvp, calls } = makePvp()
  await pvp.attack(entity(1))
  await swing(pvp)
  pvp.attemptAttack() // lowers at once, raises again 250 ms later
  await pvp.stop()
  await sleep(400)
  assert.strictEqual(calls.at(-1), 'lower')
  assert.ok(!calls.slice(4).includes('raise'), `raised after stop: ${calls}`)
})

test('stop() leaves alone a shield pvp did not raise', async () => {
  const { pvp, calls } = makePvp()
  await pvp.attack(entity(1)) // no swing yet: any raised shield is the bot's own
  await pvp.stop()
  assert.deepStrictEqual(calls, [])
})
