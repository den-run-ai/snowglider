// Snowman geometry/model construction.
import * as THREE from 'three';

// Create Snowman (Three Spheres)
export function createSnowman(scene: THREE.Scene): THREE.Group {
  const group = new THREE.Group();
  const snowMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  const blackMaterial = new THREE.MeshStandardMaterial({ color: 0x000000 });
  const carrotMaterial = new THREE.MeshStandardMaterial({ color: 0xFF6600 });
  const stickMaterial = new THREE.MeshStandardMaterial({ color: 0x8B4513 }); // Brown for sticks
  const hatMaterial = new THREE.MeshStandardMaterial({ color: 0x111111 }); // Dark grey/black for hat
  
  // Bottom sphere
  const bottom = new THREE.Mesh(new THREE.SphereGeometry(2, 24, 24), snowMaterial);
  bottom.position.y = 2;
  bottom.castShadow = true;
  group.add(bottom);
  
  // Middle sphere
  const middle = new THREE.Mesh(new THREE.SphereGeometry(1.5, 24, 24), snowMaterial);
  middle.position.y = 4.5;
  middle.castShadow = true;
  group.add(middle);
  
  // Head sphere
  const head = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 24), snowMaterial);
  head.position.y = 7.0; // Lowered head to sit on middle sphere (4.5 + 1.5 + 1.0)
  head.castShadow = true;
  group.add(head);
  
  // Eyes
  const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 12), blackMaterial);
  leftEye.position.set(0.4, 7.2, 0.8); // Adjusted Y based on new head position
  group.add(leftEye);
  
  const rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 12), blackMaterial);
  rightEye.position.set(-0.4, 7.2, 0.8); // Adjusted Y based on new head position
  group.add(rightEye);
  
  // Carrot nose
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1, 12), carrotMaterial);
  nose.position.set(0, 7.0, 1); // Adjusted Y based on new head position
  nose.rotation.x = Math.PI / 2;
  group.add(nose);
  
  // Buttons (on middle and bottom spheres)
  const buttonGeometry = new THREE.SphereGeometry(0.15, 12, 12);
  const button1 = new THREE.Mesh(buttonGeometry, blackMaterial);
  button1.position.set(0, 5.5, 1.4); // On middle sphere front
  group.add(button1);
  
  const button2 = new THREE.Mesh(buttonGeometry, blackMaterial);
  button2.position.set(0, 4.5, 1.45); // On middle sphere front
  group.add(button2);
  
  const button3 = new THREE.Mesh(buttonGeometry, blackMaterial);
  button3.position.set(0, 3.0, 1.9); // On bottom sphere front
  group.add(button3);
  
  // --- Stick Arms ---
  // Create a function to build a branched arm
  function createBranchArm(isLeft: boolean): THREE.Group {
    const armGroup = new THREE.Group();
    const mainStickLength = 2.5;
    const mainStickRadius = 0.08; // Slightly thinner radius
    const segments = 8; // Segments for the tube

    // Create a slightly irregular path for the main stick
    const pathPoints = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, mainStickLength * 0.4, isLeft ? 0.1 : -0.1), // Slight bend
      new THREE.Vector3(isLeft ? -0.1 : 0.1, mainStickLength * 0.8, 0), // Another slight bend
      new THREE.Vector3(0, mainStickLength, 0) // End point
    ];
    const curve = new THREE.CatmullRomCurve3(pathPoints);

    // Main stick using TubeGeometry
    const mainStickGeom = new THREE.TubeGeometry(curve, segments * 2, mainStickRadius, 5, false); // Fewer radial segments
    const mainStick = new THREE.Mesh(mainStickGeom, stickMaterial);
    // No need to translate geometry origin with TubeGeometry path starting at 0,0,0
    mainStick.rotation.z = isLeft ? -Math.PI / 10 : Math.PI / 10; // Adjusted angle slightly
    mainStick.castShadow = true;
    armGroup.add(mainStick);

    // Small branch 1 (thinner)
    const branch1Length = 0.8;
    const branch1Radius = 0.05;
    const branch1 = new THREE.Mesh(
      new THREE.CylinderGeometry(branch1Radius, branch1Radius * 0.7, branch1Length, 5), // Fewer segments
      stickMaterial
    );
    branch1.geometry.translate(0, branch1Length / 2, 0); // Move origin to base
    // Attach near the first bend point using curve.getPointAt
    const attachPoint1 = curve.getPointAt(0.5); // Get point halfway along the curve
    branch1.position.copy(attachPoint1);
    branch1.rotation.z = isLeft ? -Math.PI / 5 : Math.PI / 5; // Angle outward more
    branch1.rotation.x = Math.PI / 12; // Angle slightly forward
    branch1.castShadow = true;
    mainStick.add(branch1); // Add as child of main stick

    // Small branch 2 (optional, smaller and thinner)
    const branch2Length = 0.5;
    const branch2Radius = 0.04;
    const branch2 = new THREE.Mesh(
      new THREE.CylinderGeometry(branch2Radius, branch2Radius * 0.7, branch2Length, 5), // Fewer segments
      stickMaterial
    );
    branch2.geometry.translate(0, branch2Length / 2, 0); // Move origin to base
    // Attach near the second bend point
    const attachPoint2 = curve.getPointAt(0.8); // Get point further along the curve
    branch2.position.copy(attachPoint2);
    branch2.rotation.z = isLeft ? Math.PI / 4 : -Math.PI / 4; // Angle more sharply
    branch2.rotation.x = -Math.PI / 10; // Angle slightly backward
    branch2.castShadow = true;
    mainStick.add(branch2); // Add as child of main stick

    // Position the entire arm group
    // Attach to middle sphere, slightly adjusted position
    armGroup.position.set(isLeft ? 1.35 : -1.35, 4.9, 0); // Adjusted position slightly
    // Rotate slightly forward and outward
    armGroup.rotation.x = Math.PI / 16; // Less forward tilt
    armGroup.rotation.y = isLeft ? -Math.PI / 8 : Math.PI / 8; // Rotate arms outward more

    return armGroup;
  }

  // Left Arm
  const leftArmGroup = createBranchArm(true);
  group.add(leftArmGroup);

  // Right Arm
  const rightArmGroup = createBranchArm(false);
  group.add(rightArmGroup);
  // --- End Stick Arms ---
  
  // Hat
  const hatBase = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.2, 24), hatMaterial);
  hatBase.position.y = 7.9; // Adjusted Y based on new head position: 7.0 (head_y) + 1.0 (head_r) - 0.1
  hatBase.castShadow = true;
  group.add(hatBase);
  
  const hatTop = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.9, 24), hatMaterial);
  hatTop.position.y = 8.45; // Adjusted Y: 7.9 (base_y) + 0.1 (base_half_h) + 0.45 (new_top_half_h)
  hatTop.castShadow = true;
  group.add(hatTop);
  
  // Add skis
  const skiMaterial = new THREE.MeshStandardMaterial({ color: 0xFF0000 }); // Bright red
  
  // Left ski
  const leftSki = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.2, 6), 
    skiMaterial
  );
  leftSki.position.set(-1, 0.1, 1);
  leftSki.castShadow = true;
  // Add ski tip (angled front)
  const leftSkiTip = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.4, 1),
    skiMaterial
  );
  leftSkiTip.position.set(0, 0.2, 3);
  leftSkiTip.rotation.x = Math.PI / 8; // Angle up slightly
  leftSki.add(leftSkiTip);
  group.add(leftSki);
  
  // Right ski
  const rightSki = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.2, 6),
    skiMaterial
  );
  rightSki.position.set(1, 0.1, 1);
  rightSki.castShadow = true;
  // Add ski tip (angled front)
  const rightSkiTip = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.4, 1),
    skiMaterial
  );
  rightSkiTip.position.set(0, 0.2, 3);
  rightSkiTip.rotation.x = Math.PI / 8; // Angle up slightly
  rightSki.add(rightSkiTip);
  group.add(rightSki);
  
  // Keep references + neutral pose so ski technique (e.g. snowplow wedge) can be shown.
  group.userData = group.userData || {};
  group.userData.leftSki = leftSki;
  group.userData.rightSki = rightSki;
  group.userData.leftSkiBaseX = leftSki.position.x;
  group.userData.rightSkiBaseX = rightSki.position.x;
  
  scene.add(group);
  return group;
}
