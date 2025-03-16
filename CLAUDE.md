# CLAUDE.md - Coding Assistant Guidelines

## Project Overview
SnowGlider is a simple Three.js animation/game project with HTML/JS implementation. The core files are:
- `index.html` - Main entry point and UI
- `snowglider.js` - Game logic and Three.js implementation
- `utils.js` - Utility functions and helpers

## Commands
- Run locally: Open `index.html` in a browser or use a simple HTTP server
- No formal build/test/lint process (simple JS project)

## Code Style Guidelines
- **Indentation**: 2 spaces
- **Semicolons**: Required at end of statements
- **Naming**: camelCase for variables, functions, methods
- **Functions**: Use function declarations with descriptive names
- **Documentation**: JSDoc-style comments for functions
- **Classes**: ES6 class syntax
- **Dependencies**: Three.js loaded via CDN
- **Error Handling**: Simple validation with boundary checks
- **Performance**: Use delta time capping, optimize collision detection

## Best Practices
- Separate concerns between main logic and utilities
- Use descriptive function/variable names
- Follow established patterns in existing code
- Maintain game state consistently
- Properly clean up Three.js objects when no longer needed