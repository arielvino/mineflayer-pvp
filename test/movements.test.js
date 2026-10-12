/* eslint-env node */
const { test } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { PVP } = require('../lib/PVP')

// A bot that set its own Movements (no digging, no scaffolding) must keep them through
// a fight: chasing a target with the pathfinder defaults tunnels through walls.
test('attack keeps the movements the bot gave the pathfinder', async () => {
  const bot = new EventEmitter()
  bot.registry = require('prismarine-registry')('1.20.4')
  bot.version = '1.20.4'
  const set = []
  bot.pathfinder = { stop () {}, setGoal () {}, setMovements (m) { set.push(m) } }
  const pvp = new PVP(bot)
  await pvp.attack({ id: 1, position: { x: 0, y: 0, z: 0 } })
  assert.strictEqual(set.length, 0, `pvp replaced the pathfinder movements (canDig ${set[0]?.canDig})`)
})
