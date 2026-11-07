'use strict';
/**
 * Register allocator (Spec §9.1).
 *
 * §9.1 is explicit that the VM "must not silently alias or overwrite live
 * registers". These tests pin that invariant directly: every allocation handed
 * out between a mark and its release must be distinct, and spilling must only
 * begin once the register file is exhausted.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  RegisterAllocator,
  RegisterPressureError,
  REGISTER_FIELD_MAX,
} = require('../../dist/compiler/regalloc.js');

function home(allocation) {
  return allocation.kind === 'register' ? `r${allocation.reg}` : `s${allocation.slot}`;
}

test('allocates registers from zero in order', () => {
  const allocator = new RegisterAllocator({ registerCount: 4, spillCapacity: 0 });
  const homes = [0, 1, 2, 3].map(() => home(allocator.allocate()));
  assert.deepEqual(homes, ['r0', 'r1', 'r2', 'r3']);
  assert.equal(allocator.inUse, 4);
});

test('live allocations are always distinct', () => {
  const allocator = new RegisterAllocator({ registerCount: 8, spillCapacity: 8 });
  const mark = allocator.mark();
  const homes = allocator.allocateMany(12).map(home);
  assert.equal(new Set(homes).size, homes.length, `duplicate home in ${homes.join(', ')}`);
  allocator.release(mark);
});

test('release returns the allocator to the mark and reuses the register', () => {
  const allocator = new RegisterAllocator({ registerCount: 4, spillCapacity: 0 });
  const mark = allocator.mark();
  const first = allocator.allocate();
  allocator.release(mark);
  assert.equal(allocator.inUse, 0);
  assert.deepEqual(home(allocator.allocate()), home(first), 'the released register is reused');
});

test('nested marks release in stack order without disturbing outer allocations', () => {
  const allocator = new RegisterAllocator({ registerCount: 8, spillCapacity: 0 });
  const outer = allocator.mark();
  const kept = allocator.allocate();
  const inner = allocator.mark();
  allocator.allocateMany(3);
  allocator.release(inner);
  assert.equal(allocator.inUse, 1, 'only the outer allocation survives');
  assert.equal(home(allocator.allocate()), 'r1', 'the next allocation follows the survivor');
  allocator.release(outer);
  assert.equal(allocator.inUse, 0);
  assert.equal(home(kept), 'r0');
});

test('releasing to a mark above the current top is refused', () => {
  const allocator = new RegisterAllocator({ registerCount: 4, spillCapacity: 0 });
  const mark = allocator.allocate() && allocator.mark();
  allocator.release(0);
  assert.throws(() => allocator.release(mark), /cannot release to mark/);
});

test('releasing to a negative or non-integer mark is refused', () => {
  const allocator = new RegisterAllocator({ registerCount: 4, spillCapacity: 0 });
  assert.throws(() => allocator.release(-1), RangeError);
  assert.throws(() => allocator.release(0.5), RangeError);
});

test('spilling starts only after the register file is exhausted', () => {
  const allocator = new RegisterAllocator({ registerCount: 2, spillCapacity: 4 });
  assert.deepEqual(
    allocator.allocateMany(6).map(home),
    ['r0', 'r1', 's2', 's3', 's4', 's5'],
    'spill slots begin where the register file ends',
  );
  assert.equal(allocator.inUse, 2, 'spills do not consume registers');
});

test('exhausting both registers and spill slots is a compile error, not an alias', () => {
  const allocator = new RegisterAllocator({ registerCount: 2, spillCapacity: 1 });
  allocator.allocateMany(3);
  assert.throws(
    () => allocator.allocate(),
    (error) =>
      error instanceof RegisterPressureError &&
      error.registerCount === 2 &&
      error.spillCapacity === 1,
  );
});

test('spillSlotsUsed and slotCount report the frame requirement', () => {
  const allocator = new RegisterAllocator({ registerCount: 4, spillCapacity: 4 });
  assert.equal(allocator.spillSlotsUsed, 0);
  assert.equal(allocator.slotCount(), 4);
  // Six allocations from a four-register file spill into slots 4 and 5. A spill
  // slot indexes frame slots, where 0..registerCount-1 are the registers
  // themselves (Spec §9.1); it is not an offset past the register file.
  allocator.allocateMany(6);
  assert.equal(allocator.spillSlotsUsed, 2);
  assert.equal(allocator.slotCount(), 6, 'slots are registers plus spills');
});

test('peakInUse records the highest simultaneous register pressure', () => {
  const allocator = new RegisterAllocator({ registerCount: 8, spillCapacity: 0 });
  const mark = allocator.mark();
  allocator.allocateMany(5);
  allocator.release(mark);
  allocator.allocateMany(2);
  assert.equal(allocator.peakInUse, 5);
  assert.equal(allocator.inUse, 2);
});

test('spill slots are reused across sibling expressions, so pressure is per-expression', () => {
  const allocator = new RegisterAllocator({ registerCount: 1, spillCapacity: 1 });
  for (let i = 0; i < 3; i++) {
    const mark = allocator.mark();
    assert.deepEqual(allocator.allocateMany(2).map(home), ['r0', 's1']);
    allocator.release(mark);
  }
  assert.equal(allocator.spillSlotsUsed, 1, 'one spill slot serves every sibling expression');
  assert.equal(allocator.inUse, 0, 'a released expression leaves no register held');
});

test('a nested release keeps the outer spill live', () => {
  const allocator = new RegisterAllocator({ registerCount: 4, spillCapacity: 4 });
  const outer = allocator.mark();
  allocator.allocateMany(6); // r0..r3, s4, s5
  const inner = allocator.mark(); // 6
  allocator.allocateMany(2); // s6, s7
  allocator.release(inner);
  assert.equal(allocator.spillSlotsUsed, 4, 'the outer expression still holds s4..s5 (plus s6..s7 peak)');
  assert.deepEqual(
    allocator.allocateMany(2).map(home),
    ['s6', 's7'],
    'the inner spill slots are reclaimed and handed out again in order',
  );
  // The slots handed out are distinct from the outer ones: reclaiming the inner
  // scope must not rewind past the outer expression's live spills.
  assert.notEqual(allocator.spillSlotsUsed, 2, 'the outer spills were not returned to the pool');
  allocator.release(inner);
  allocator.release(outer);
  assert.deepEqual(
    allocator.allocateMany(6).map(home),
    ['r0', 'r1', 'r2', 'r3', 's4', 's5'],
    'released slots are reused in order, registers first',
  );
});

test('spillSlotsUsed reports the peak, so a frame sized for the worst expression is safe', () => {
  const allocator = new RegisterAllocator({ registerCount: 2, spillCapacity: 8 });
  const mark = allocator.mark();
  allocator.allocateMany(4); // r0, r1, s2, s3
  allocator.release(mark);
  allocator.allocateMany(2);
  assert.equal(allocator.spillSlotsUsed, 2, 'the peak survives the release');
  assert.equal(allocator.slotCount(), 4);
});

test('an invalid registerCount is refused at construction', () => {
  for (const registerCount of [0, -1, 1.5, REGISTER_FIELD_MAX + 1]) {
    assert.throws(
      () => new RegisterAllocator({ registerCount, spillCapacity: 0 }),
      RangeError,
      `registerCount ${registerCount} must be refused`,
    );
  }
});

test('an invalid spillCapacity is refused at construction', () => {
  for (const spillCapacity of [-1, 1.5]) {
    assert.throws(
      () => new RegisterAllocator({ registerCount: 4, spillCapacity }),
      RangeError,
      `spillCapacity ${spillCapacity} must be refused`,
    );
  }
});

test('allocateMany refuses a negative count instead of returning a short list', () => {
  const allocator = new RegisterAllocator({ registerCount: 4, spillCapacity: 0 });
  assert.throws(() => allocator.allocateMany(-1), RangeError);
});
