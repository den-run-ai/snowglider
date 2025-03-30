# ❄️ SnowGlider ❄️
A cheerful snowman shredding mountain snow powder in a playful Three.js animation. ⛄️🎿

https://den-run-ai.github.io/snowglider/

![SnowGlider Game](https://github.com/user-attachments/assets/b40a1f51-0b57-4d7f-8980-b810a0c179ea)

## Overview
SnowGlider is a Three.js-based skiing game featuring a snowman gliding down a procedurally generated mountain. The game includes realistic physics, terrain generation, tree obstacles, and specialized camera tracking.

## Features
- Smooth snowman skiing with realistic physics and terrain interaction
- Procedurally generated mountain with dynamic terrain features
- Tree obstacle detection with collision physics
- Snow particle effects that respond to speed and turning
- Tracking camera that follows the snowman's movements
- Timer with best time tracking
- Comprehensive test suite for verifying game mechanics

## Project Structure
- `index.html` - Main entry point and HTML structure
- `snowglider.js` - Core game loop and initialization
- `snowman.js` - Snowman model creation and physics
- `mountains.js` - Terrain generation and tree placement
- `camera.js` - Camera management and tracking
- `utils.js` - Utility functions and snow effects
- `tests/` - Testing framework for game components

## Controls
- **Arrow Keys / WASD**: Control snowman direction
- **Space**: Jump
- **Reset Button**: Start a new run

## Testing
The game includes a comprehensive testing framework. Run tests by appending URL parameters:
- `?test=true` - Run basic gameplay tests
- `?test=trees` - Run tree collision tests
- `?test=camera` - Run camera tracking tests
- `?test=regression` - Run regression tests
- `?test=unified` - Run all tests

## Recent Improvements
- Separated snowman functionality into its own module
- Fixed tree collision detection in extended terrain areas
- Improved camera tracking system with smooth transitions
- Added comprehensive test hooks for verifying game mechanics
- Enhanced snow particle effects with improved visuals
