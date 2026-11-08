// The app owns these fields; THREE.Object3D's open `userData` dictionary does not.
// Keep one checked boundary so model construction and all kernel/pose writes share
// the same contract, while ordinary THREE objects and structural test rigs remain
// valid inputs. Absent state is intentional before the first physics/pose update.
import * as THREE from 'three';
import type { SkiTechnique } from './index.js';

export interface BaseTransform {
  position: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
}

/** Only the transforms the ski pose actually consumes (also supports headless rigs). */
interface SkiPosePart {
  position: { x: number };
  rotation: { y: number; z: number };
}

export interface SnowmanUserData {
  leftSki?: SkiPosePart;
  rightSki?: SkiPosePart;
  leftSkiBaseX?: number;
  rightSkiBaseX?: number;
  parts?: Record<string, THREE.Object3D>;
  partBaseTransforms?: Record<string, BaseTransform>;
  shatterRoots?: THREE.Object3D[];
  flipPivot?: THREE.Object3D;
  technique?: SkiTechnique;
  targetRotationY?: number;
  currentRotX?: number;
  currentRotZ?: number;
  carveCharge?: number;
  lastSteerDir?: number;
  plowCharge?: number;
  playerJump?: boolean;
  freestyleAir?: boolean;
  trickSpin?: number;
  trickFlip?: number;
  trickGrabTime?: number;
  trickGrabArmed?: boolean;
  trickGrabbing?: boolean;
  trickCameraYaw?: number;
  trickSpinApplied?: number;
  trickSpinRate?: number;
  spinLean?: number;
  clearsThisAir?: number;
  clearedObstacles?: Record<string, boolean>;
}

// Cache by BAG identity, not snowman identity: replacing userData must cross the
// boundary again. Weak references require no reset/dispose lifecycle. The model
// registers its checked construction directly; external rigs are validated once.
// After entry this is app-owned mutable state: writers must use the typed contract.
// This is not continuous validation of arbitrary writes through THREE's raw bag.
const knownData = new WeakMap<object, SnowmanUserData>();

export function setSnowmanUserData<T extends THREE.Object3D, D extends SnowmanUserData>(
  snowman: T, data: D
): Omit<T, 'userData'> & { userData: D } {
  knownData.set(data, data);
  return Object.assign(snowman, { userData: data });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function isVector(value: unknown): boolean {
  return isRecord(value) && isNumber(value.x) && isNumber(value.y) && isNumber(value.z);
}
function isSki(value: unknown): boolean {
  return isRecord(value) && isRecord(value.position) && isNumber(value.position.x)
    && isRecord(value.rotation) && isNumber(value.rotation.y) && isNumber(value.rotation.z);
}
function isBaseTransform(value: unknown): boolean {
  return isRecord(value) && isVector(value.position) && isVector(value.scale) && isVector(value.rotation);
}
function isTechnique(value: unknown): boolean {
  return value === 'air' || value === 'glide' || value === 'snowplow' || value === 'skid'
    || value === 'carve' || value === 'parallel' || value === 'tuck' || value === 'hop';
}
// Exhaustive by field: adding a state member requires its boundary validator too.
// Values may be absent until their owning subsystem initializes them.
const fieldValidators = {
  leftSki: isSki,
  rightSki: isSki,
  leftSkiBaseX: isNumber,
  rightSkiBaseX: isNumber,
  parts: (value: unknown) => isRecord(value)
    && Object.values(value).every(part => part instanceof THREE.Object3D),
  partBaseTransforms: (value: unknown) => isRecord(value)
    && Object.values(value).every(isBaseTransform),
  shatterRoots: (value: unknown) => Array.isArray(value)
    && value.every((part: unknown) => part instanceof THREE.Object3D),
  flipPivot: (value: unknown) => value instanceof THREE.Object3D,
  technique: isTechnique,
  targetRotationY: isNumber,
  currentRotX: isNumber,
  currentRotZ: isNumber,
  carveCharge: isNumber,
  lastSteerDir: isNumber,
  plowCharge: isNumber,
  playerJump: (value: unknown) => typeof value === 'boolean',
  freestyleAir: (value: unknown) => typeof value === 'boolean',
  trickSpin: isNumber,
  trickFlip: isNumber,
  trickGrabTime: isNumber,
  trickGrabArmed: (value: unknown) => typeof value === 'boolean',
  trickGrabbing: (value: unknown) => typeof value === 'boolean',
  trickCameraYaw: isNumber,
  trickSpinApplied: isNumber,
  trickSpinRate: isNumber,
  spinLean: isNumber,
  clearsThisAir: isNumber,
  clearedObstacles: (value: unknown) => isRecord(value)
    && Object.values(value).every(seen => typeof seen === 'boolean')
} satisfies { [K in keyof SnowmanUserData]-?: (value: unknown) => boolean };
const validatorEntries = Object.entries(fieldValidators);

function isSnowmanUserData(value: Record<string, unknown>): value is Record<string, unknown> & SnowmanUserData {
  for (const [field, isValid] of validatorEntries) {
    const member = value[field];
    if (member !== undefined && !isValid(member)) return false;
  }
  return true;
}

export function getSnowmanUserData(snowman: THREE.Object3D): SnowmanUserData {
  const data: unknown = snowman.userData;
  // Real THREE objects always have a bag. Keep the historic empty-rig fallback.
  if (data === undefined || data === null) {
    const fresh: SnowmanUserData = {};
    setSnowmanUserData(snowman, fresh);
    return fresh;
  }
  if (!isRecord(data)) throw new TypeError('Snowman userData must be an object');
  const known = knownData.get(data);
  if (known) return known;
  if (!isSnowmanUserData(data)) throw new TypeError('Invalid Snowman userData');
  knownData.set(data, data);
  return data;
}
