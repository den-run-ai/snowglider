// A small real-provider scene for the GPU normal regression. Keep this separate
// from full gameplay captures: this test needs all material variants, not a ski
// run or an external authentication boot.
import * as THREE from 'three';
import { Trees } from '../../src/trees.js';

export async function createWindProbeScene(): Promise<THREE.Scene> {
  Trees.setEzForestEnabled(true);
  const scene = new THREE.Scene();
  Trees.addTrees(scene);
  await Trees.ezForestReady();
  return scene;
}
