import { Bot } from "mineflayer";
import { Movements, Pathfinder, goals } from "mineflayer-pathfinder";
import { Entity } from "prismarine-entity";
import { MaxDamageOffset, TimingSolver } from "./TimingSolver";
import { TaskQueue } from 'mineflayer-utils';

// Critical hits: jump this many ticks before a swing is due, and wait at most this
// many ticks past it for the fall.
const CRIT_JUMP_LEAD = 6;
const CRIT_MAX_HOLD = 8;

/**
 * The main pvp manager plugin class.
 */
export class PVP
{
    private readonly bot: Bot;
    private timeToNextAttack: number = 0;
    private wasInRange: boolean = false;
    private refollowTicks: number = 0;
    private blockingExplosion: boolean = false;
    private critJumpTicks: number = -1;
    private critHoldTicks: number = 0;

    /**
     * The current target. This value should never be assigned to from outside the plugin.
     */
    target?: Entity;

    /**
     * The movements object to pass to pathfinder when creating the follow entity goal. Assign
     * to null in order to avoid passing any movement config to pathfinder. (If you plan on using
     * your own)
     */
    movements?: Movements;

    /**
     * How close the bot will attempt to get to the target when when pursuing it.
     */
    followRange: number = 2;

    /**
     * Spacing for melee: keep the target between near and far blocks away (centre to
     * centre). Closer than near while the next swing isn't ready, back off; the follow
     * goal closes in no nearer than the band's middle. A player reaches ~3 blocks, a
     * zombie-like mob only ~1.4, so a band like [2.2, 2.9] hits without being hit.
     * Undefined: off.
     */
    keepDistance?: [number, number];

    /**
     * How far away the target entity must be to lose the target. Target entities further than this
     * distance from the bot will be considered defeated.
     */
    viewDistance: number = 128;

    /**
     * How close must the bot be to the target in order to try attacking it.
     */
    attackRange: number = 3.0;

    /**
     * The timing solver to use when deciding how long to wait before preforming another attack
     * after finishing an attack.
     *
     * // TODO Check for 'hasAtttackCooldown' feature. If feature not present, default to RandomTicks solver.
     */
    meleeAttackRate: TimingSolver = new MaxDamageOffset();

    /**
     * Whether to time swings as critical hits (x1.5 damage): jump CRIT_JUMP_LEAD ticks
     * before a swing is due and land it on the way down, not sprinting.
     */
    criticalHits: boolean = true;

    /**
     * Whether the shield is up because this plugin raised it (after a swing, or against a creeper).
     */
    private raisedShield: boolean = false;

    /**
     * Creates a new instance of the PVP plugin.
     *
     * @param bot - The bot this plugin is being attached to.
     */
    constructor(bot: Bot)
    {
        this.bot = bot;
        this.movements = new Movements(bot);

        this.bot.on('physicsTick', () => this.update());
        this.bot.on('entityGone', e => { if (e === this.target) this.stop(); })
    }

    /**
     * Causes the bot to begin attacking an entity until it is killed or told to stop.
     *
     * @param target - The target to attack.
     */
    async attack(target: Entity): Promise<void>
    {
        if (target === this.target) return;

        await this.stop();
        this.target = target;
        this.timeToNextAttack = 0;

        if (!this.target) return;

        const pathfinder: Pathfinder = this.bot.pathfinder;
        if (this.movements) pathfinder.setMovements(this.movements);

        pathfinder.setGoal(this.followGoal(this.target), true);

        // @ts-expect-error
        this.bot.emit('startedAttacking');
    }

    /**
     * Stops attacking the current entity.
     */
    async stop(): Promise<void>
    {
        if (this.target == null) return

        // A new attack may start before path_stop arrives, so name the target that stopped.
        const target = this.target;
        this.target = undefined;
        this.lowerShield();

        const pathfinder: Pathfinder = this.bot.pathfinder;
        pathfinder.stop();

        try {
            await this.onceWithTimeout('path_stop', 5000)
        } catch (err) {
            // onceWithTimeout already removed its own listener; other plugins' stay.
            pathfinder.setGoal(null)
        }

        // @ts-expect-error
        this.bot.emit('stoppedAttacking', target);
    }

    /**
     * Resolve if event fires within the timeout. Rejects if the event did not fire within the timeout.
     * @param eventName Event name to listen to
     * @param timeout Timeout in ms
     * @returns {Promise<void>}
     */
    async onceWithTimeout(eventName: string, timeout: number): Promise<void>
    {
        let callback = () => {}
        let timeoutId: NodeJS.Timeout
        const cleanup = (): void => {
            clearTimeout(timeoutId)
            this.bot.removeListener(eventName as any, callback)
        }
        return new Promise((resolve, reject) => {
            callback = (): void => {
                cleanup()
                resolve()
            }
            this.bot.once(eventName as any, callback)
            timeoutId = setTimeout(() => {
                cleanup()
                reject()
            }, timeout)
        })
    }

    /**
     * Stops attacking the current entity. Force stops pathfinder. May result in the bot falling off of things or failing jumps.
     * @returns void
     */
    forceStop(): void
    {
        if (this.target == null) return

        const target = this.target;
        this.target = undefined;
        this.lowerShield();

        const pathfinder: Pathfinder = this.bot.pathfinder;
        pathfinder.setGoal(null);

        // @ts-expect-error
        this.bot.emit('stoppedAttacking', target);
    }

    /**
     * Called each tick to update attack timers.
     */
    private update(): void
    {
        this.checkExplosion();
        this.checkRange();

        // Stopped mid crit jump: don't leave the jump key down.
        if (!this.target && this.critJumpTicks >= 0)
        {
            this.bot.setControlState('jump', false);
            this.critJumpTicks = -1;
        }
        if (!this.target || this.blockingExplosion) return;

        this.critTick();
        this.spacingTick();
        this.timeToNextAttack--;
        if (this.timeToNextAttack === -1)
            this.attemptAttack();
    }

    /**
     * Updates whether the bot is in attack range of the target or not.
     */
    private checkRange(): void
    {
        if (!this.target) return;
        if (this.timeToNextAttack < 0) return;

        const dist = this.target.position.distanceTo(this.bot.entity.position);

        if (dist > this.viewDistance)
        {
            this.stop();
            return;
        }

        const inRange = dist <= this.attackRange;

        // Coming into reach: swing now, or jump now and swing on the way down.
        if (!this.wasInRange && inRange)
        {
            this.timeToNextAttack = 0;
            if (this.canCritJump())
            {
                this.startCritJump();
                this.timeToNextAttack = CRIT_JUMP_LEAD;
            }
        }

        this.wasInRange = inRange;

        // GoalFollow keeps the target's block until the target moves more than followRange
        // from it, and counts as reached within followRange of that block: together that
        // can stop the bot ~4 blocks away, past attackRange. Out of reach with the
        // pathfinder idle, aim the goal at where the target is now (at most every 10 ticks).
        if (!inRange && !this.bot.pathfinder.isMoving() && --this.refollowTicks <= 0)
        {
            this.refollowTicks = 10;
            this.bot.pathfinder.setGoal(this.followGoal(this.target), true);
        }
    }

    private canCritJump(): boolean
    {
        const e = this.bot.entity as any;
        return this.criticalHits && this.critJumpTicks < 0 && e.onGround && !e.isInWater && !e.isInLava;
    }

    private startCritJump(): void
    {
        this.bot.setControlState('jump', true);
        this.critJumpTicks = 0;
    }

    /**
     * Critical hits: a swing lands as a crit while falling, not on the ground and not
     * sprinting. Jump CRIT_JUMP_LEAD ticks before the swing is due (a jump's apex is ~6
     * ticks up), stop sprinting once airborne, and hold a swing that's due while not
     * yet falling for a tick: on the first falling tick the server hasn't counted any
     * fall yet, and the hit lands plain.
     */
    private spacing: boolean = false;

    /** How close the follow goal brings the bot: the middle of keepDistance when set. */
    private followGoal(target: Entity): goals.GoalFollow
    {
        const range = this.keepDistance ? (this.keepDistance[0] + this.keepDistance[1]) / 2 : this.followRange;
        return new goals.GoalFollow(target, range);
    }

    /**
     * Back off while the target is inside keepDistance's near edge and the next swing
     * isn't due, with the pathfinder's goal paused so it doesn't walk us back in.
     */
    private spacingTick(): void
    {
        const target = this.target;
        if (!this.keepDistance || !target)
        {
            if (this.spacing) this.endSpacing();
            return;
        }
        const d = target.position.distanceTo(this.bot.entity.position);
        if (d < this.keepDistance[0] && this.timeToNextAttack > 1)
        {
            if (!this.spacing)
            {
                this.spacing = true;
                this.bot.pathfinder.setGoal(null);
            }
            this.bot.lookAt(target.position.offset(0, target.height * 0.85, 0), true);
            this.bot.setControlState('forward', false);
            this.bot.setControlState('sprint', false);
            this.bot.setControlState('back', true);
        }
        else if (this.spacing) this.endSpacing();
    }

    private endSpacing(): void
    {
        this.spacing = false;
        this.bot.setControlState('back', false);
        if (this.target) this.bot.pathfinder.setGoal(this.followGoal(this.target), true);
    }

    private critTick(): void
    {
        const e = this.bot.entity;
        if (this.critJumpTicks >= 0)
        {
            this.critJumpTicks++;
            if (this.critJumpTicks > 1)
            {
                this.bot.setControlState('jump', false);
                this.bot.setControlState('sprint', false);
                if (e.onGround) this.critJumpTicks = -1;
            }
        }
        else if (this.wasInRange && this.timeToNextAttack === CRIT_JUMP_LEAD && this.canCritJump())
            this.startCritJump();

        if (this.timeToNextAttack !== 0) return;
        if (this.criticalHits && !e.onGround && e.velocity.y > -0.1 && this.critHoldTicks < CRIT_MAX_HOLD)
        {
            this.timeToNextAttack = 1;
            this.critHoldTicks++;
        }
        else this.critHoldTicks = 0;
    }

    /**
     * Blocks a creeper explosion with a shield.
     */
    private checkExplosion() {
        if (!this.target || !this.hasShield()) return;

        if (
            this.target.name &&
            this.target.name === 'creeper' &&
            this.target.metadata[16] &&
            // @ts-ignore
            this.target.metadata[16] === 1
        ) {
            this.blockingExplosion = true;

            this.bot.pathfinder.stop();
            this.bot.lookAt(this.target.position.offset(0, 1, 0), true);
            this.bot.activateItem(true);
            this.raisedShield = true;

            setTimeout(() => {
                this.blockingExplosion = false;
            }, 2000)
        }
    }

    /**
     * Attempts to preform an attack on the target.
     */
    private attemptAttack()
    {
        if (!this.target) return;

        if (!this.wasInRange)
        {
            this.timeToNextAttack = this.meleeAttackRate.getTicks(this.bot);
            return;
        }

        const queue = new TaskQueue()
        const target = this.target;
        const shield = this.hasShield();

        if (shield)
        {
            queue.addSync(() => {
                this.bot.deactivateItem()
                this.raisedShield = false
            })
            queue.add(cb => setTimeout(cb, 100))
        }

        queue.add(cb => {
            if (target !== this.target) throw 'Target changed!';
            this.bot.lookAt(this.target.position.offset(0, this.target.height, 0), true).then(() => cb()).catch(err => cb(err));
        });

        queue.addSync(() => {
            if (target !== this.target) throw 'Target changed!';
            this.bot.attack(this.target);

            // @ts-expect-error
            this.bot.emit('attackedTarget');
        });

        if (shield)
        {
            queue.add(cb => setTimeout(cb, 150))
            queue.addSync(() => {
                if (target !== this.target) throw 'Target changed!';
                if (this.hasShield()) {
                    this.bot.activateItem(true)
                    this.raisedShield = true
                }
            })
        }

        queue.runAll((err) => {
            if (!err)
                this.timeToNextAttack = this.meleeAttackRate.getTicks(this.bot);
        });
    }

    /**
     * Lowers the shield if this plugin raised it, so the bot doesn't walk on blocking after a fight.
     */
    private lowerShield(): void
    {
        if (!this.raisedShield) return;
        this.raisedShield = false;
        if (this.hasShield()) this.bot.deactivateItem();
    }

    /**
     * Check if the bot currently has a shield equipped.
     */
    private hasShield(): boolean
    {
        if (this.bot.supportFeature('doesntHaveOffHandSlot')) return false;

        const slot = this.bot.inventory.slots[this.bot.getEquipmentDestSlot('off-hand')];
        if (!slot) return false;

        return slot.name.includes('shield');
    }
}
